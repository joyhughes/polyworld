// WebGL2 renderer. Every object in the world is an instanced box. Each step
// every agent's point of view is rendered into its own block of an offscreen
// framebuffer (retinaWidth x retinaHeight: one row on the flat world, several
// in a 3D volume), read back once, and fed to the brains — the per-agent POV
// rendering Polyworld uses for vision.

import { P } from './params.js';
import { World } from './world.js';
import { OUT } from './brain.js';
import { canopyRadius, canopyDepth, trunkWidth, sun } from './plants.js';

// Object record, shared by the instance buffer and the vision object texture:
// (x, z, yaw, front) (sx, sy, sz, r) (g, b, centreY, pitch)
const REC = 12;

// Place a unit box (x,z in [-.5,.5], y in [0,1]) by scale, pitch, yaw and centre.
const PLACE = `
vec3 rot(vec3 p, float yaw, float pitch) {
  float cp = cos(pitch), sp = sin(pitch);
  p = vec3(p.x * cp - p.y * sp, p.x * sp + p.y * cp, p.z);
  float c = cos(yaw), s = sin(yaw);
  return vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c);
}`;

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec4 iA;   // x, z, yaw, front-face brightness
layout(location=3) in vec4 iS;   // scale xyz, red
layout(location=4) in vec4 iC;   // green, blue, centre y, pitch
uniform mat4 uVP;
uniform vec3 uSun;     // fixed light when there is no sun model
uniform float uGrav;   // 1 in gravity worlds: light from the local sun at each latitude
uniform vec4 uLat;     // north-edge latitude, south-edge latitude, declination (radians), world size
out vec3 vC;
out vec3 vN;
out vec3 vL;
out float vDay;
${PLACE}
void main() {
  vec3 w = rot((aPos - vec3(0.0, 0.5, 0.0)) * iS.xyz, iA.z, iC.w) + vec3(iA.x, iC.z, iA.y);
  vN = rot(aNrm, iA.z, iC.w);
  vC = vec3(iS.w, iC.x, iC.y) * (aNrm.x > 0.5 ? iA.w : 1.0);
  vL = uSun;
  vDay = 1.0;
  if (uGrav > 0.5) {
    float phi = mix(uLat.x, uLat.y, clamp(w.z / uLat.w, 0.0, 1.0)), decl = uLat.z;
    float e = max(0.05, 1.5707963 - abs(phi - decl));
    vL = vec3(0.0, sin(e), (phi >= decl ? 1.0 : -1.0) * cos(e));
    float h0 = acos(clamp(-tan(phi) * tan(decl), -1.0, 1.0));
    vDay = clamp(h0 * sin(phi) * sin(decl) + cos(phi) * cos(decl) * sin(h0), 0.0, 1.0);
  }
  gl_Position = uVP * vec4(w, 1.0);
}`;

const FS = `#version 300 es
precision mediump float;
in vec3 vC;
in vec3 vN;
in vec3 vL;
in float vDay;
uniform float uLit;
out vec4 o;
void main() {
  float d = 0.45 + 0.55 * max(dot(normalize(vN), vL), 0.0);
  d *= 0.3 + 0.7 * vDay;   // polar night is dark
  o = vec4(vC * mix(1.0, d, uLit), 1.0);
}`;

// Vision pass. One instanced draw renders a range of objects for every agent in
// a grid cell: instance i is object (start + i % len) seen by agent
// (agentStart + i / len). Objects come from a texture (3 RGBA32F texels each),
// agent eyes from another (3 texels each). Each agent's projection is squeezed
// into its own retina block of the framebuffer; fragments outside it are dropped.
const VISION_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
uniform highp sampler2D uObj;   // object records
uniform highp sampler2D uEye;   // (ex, ey, ez, block x) (fwd xyz, tan(hfov/2)) (up xyz, block y)
uniform int uStart, uLen, uAgentStart;
uniform vec2 uFb;               // framebuffer size in pixels
uniform vec2 uRet;              // retina block size in pixels
uniform float uVAspect, uFar, uA, uB;
flat out ivec2 vBlock;
out vec3 vC;
ivec2 tc(int i) { return ivec2(i & 4095, i >> 12); }
${PLACE}
void main() {
  int obj = uStart + gl_InstanceID % uLen;
  int ag = uAgentStart + gl_InstanceID / uLen;
  vec4 o0 = texelFetch(uObj, tc(obj * 3), 0);
  vec4 o1 = texelFetch(uObj, tc(obj * 3 + 1), 0);
  vec4 o2 = texelFetch(uObj, tc(obj * 3 + 2), 0);
  vec4 e0 = texelFetch(uEye, tc(ag * 3), 0);
  vec4 e1 = texelFetch(uEye, tc(ag * 3 + 1), 0);
  vec4 e2 = texelFetch(uEye, tc(ag * 3 + 2), 0);
  vec3 eye = e0.xyz, F = e1.xyz, U = e2.xyz, R = cross(F, U);
  float tanH = e1.w, tanV = tanH * uVAspect;
  vBlock = ivec2(e0.w, e2.w);
  vC = vec3(o1.w, o2.x, o2.y) * (aNrm.x > 0.5 ? o0.w : 1.0);

  // cheap per-object cull: behind the eye, beyond range, or well outside the frustum
  vec3 dc = vec3(o0.x, o2.z, o0.y) - eye;
  float rad = 0.5 * length(o1.xyz);
  float fc = dot(dc, F);
  if (fc < -rad || fc > uFar + rad || abs(dot(dc, R)) > fc * tanH + rad + 0.5
      || abs(dot(dc, U)) > fc * tanV + rad + 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec3 w = rot((aPos - vec3(0.0, 0.5, 0.0)) * o1.xyz, o0.z, o2.w) + vec3(o0.x, o2.z, o0.y);
  vec3 d = w - eye;
  float fwd = dot(d, F);
  vec4 clip = vec4(dot(d, R) / tanH, dot(d, U) / tanV, -uA * fwd + uB, fwd);
  // squeeze the [-1,1] frustum into this agent's block
  vec2 org = vec2(vBlock);
  clip.xy = clip.w * (-1.0 + (2.0 * org + uRet) / uFb) + clip.xy * uRet / uFb;
  gl_Position = clip;
}`;

const VISION_FS = `#version 300 es
precision mediump float;
flat in ivec2 vBlock;
in vec3 vC;
uniform highp vec2 uRet;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) - vBlock;
  if (p.x < 0 || p.y < 0 || p.x >= int(uRet.x) || p.y >= int(uRet.y)) discard;
  o = vec4(vC, 1.0);
}`;

function cube() {
  // unit box: x,z in [-.5,.5], y in [0,1]; 6 faces x 2 triangles
  const faces = [
    [[1, 0, 0], [[.5, 0, -.5], [.5, 1, -.5], [.5, 1, .5], [.5, 0, .5]]],
    [[-1, 0, 0], [[-.5, 0, .5], [-.5, 1, .5], [-.5, 1, -.5], [-.5, 0, -.5]]],
    [[0, 1, 0], [[-.5, 1, -.5], [-.5, 1, .5], [.5, 1, .5], [.5, 1, -.5]]],
    [[0, -1, 0], [[-.5, 0, .5], [-.5, 0, -.5], [.5, 0, -.5], [.5, 0, .5]]],
    [[0, 0, 1], [[.5, 0, .5], [.5, 1, .5], [-.5, 1, .5], [-.5, 0, .5]]],
    [[0, 0, -1], [[-.5, 0, -.5], [-.5, 1, -.5], [.5, 1, -.5], [.5, 0, -.5]]],
  ];
  const out = [];
  for (const [n, q] of faces) {
    for (const i of [0, 1, 2, 0, 2, 3]) out.push(...q[i], ...n);
  }
  return new Float32Array(out);
}

// --- column-major mat4 helpers ---------------------------------------------

export function perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

export function lookAt(out, ex, ey, ez, cx, cy, cz, upx = 0, upy = 1, upz = 0) {
  let fx = cx - ex, fy = cy - ey, fz = cz - ez;
  let l = Math.hypot(fx, fy, fz);
  fx /= l; fy /= l; fz /= l;
  // s = f x up
  let sx = fy * upz - fz * upy, sy = fz * upx - fx * upz, sz = fx * upy - fy * upx;
  l = Math.hypot(sx, sy, sz) || 1;
  sx /= l; sy /= l; sz /= l;
  // u = s x f
  const ux = sy * fz - sz * fy, uy = sz * fx - sx * fz, uz = sx * fy - sy * fx;
  out[0] = sx; out[1] = ux; out[2] = -fx; out[3] = 0;
  out[4] = sy; out[5] = uy; out[6] = -fy; out[7] = 0;
  out[8] = sz; out[9] = uz; out[10] = -fz; out[11] = 0;
  out[12] = -(sx * ex + sy * ey + sz * ez);
  out[13] = -(ux * ex + uy * ey + uz * ez);
  out[14] = fx * ex + fy * ey + fz * ez;
  out[15] = 1;
  return out;
}

export function mul(out, a, b) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

// Eye position, forward and up vectors (no roll) for an agent.
export function agentEye(a) {
  const cy = Math.cos(a.yaw), sy = Math.sin(a.yaw), cp = Math.cos(a.pitch), sp = Math.sin(a.pitch);
  const f = [cy * cp, sp, sy * cp];
  const u = [-cy * sp, cp, -sy * sp];
  const h = a.len / 2 + 0.02;
  return { e: [a.x + f[0] * h, a.y + f[1] * h, a.z + f[2] * h], f, u };
}

// Write one object record at slot `i` of `d`.
function rec(d, i, x, z, yaw, front, sx, sy, sz, r, g, b, cy, pitch) {
  const o = i * REC;
  d[o] = x; d[o + 1] = z; d[o + 2] = yaw; d[o + 3] = front;
  d[o + 4] = sx; d[o + 5] = sy; d[o + 6] = sz; d[o + 7] = r;
  d[o + 8] = g; d[o + 9] = b; d[o + 10] = cy; d[o + 11] = pitch;
}

function agentRec(d, i, a, dims) {
  let [r, g, b] = a.color();
  if (a.torpid) { r = 0.3 * r + 0.08; g *= 0.3; b = 0.3 * b + 0.12; }   // hibernating: dim and bluish
  rec(d, i, a.x, a.z, a.yaw, a.torpid ? 0.2 : 0.25 + 0.75 * a.out[OUT.light], a.len, a.hgt, a.wid, r, g, b,
    dims === 3 ? a.y : a.hgt / 2, a.pitch);
}

function foodRec(d, i, f, dims, gravity) {
  const h = World.foodHalf(f) * 2;
  if (f.patch === -2) rec(d, i, f.x, f.z, 0, 1, h, h, h, 0.95, 0.6, 0.1, h / 2 + 0.02, 0);   // fruit
  else if (gravity && f.patch === -1) rec(d, i, f.x, f.z, 0, 1, h, 0.4, h, 0.55, 0.12, 0.1, 0.2, 0); // carrion
  else if (dims === 3) rec(d, i, f.x, f.z, 0, 1, h, h, h, 0.15, 0.85, 0.15, f.y, 0);
  else rec(d, i, f.x, f.z, 0, 1, h, 0.6, h, 0.15, 0.85, 0.15, 0.3, 0);
}

function barrierRec(d, i, b, world) {
  const dx = b.x1 - b.x0, dz = b.z1 - b.z0;
  const h = world.dims === 3 ? world.height : b.height;
  rec(d, i, (b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2, Math.atan2(dz, dx), 1,
    Math.hypot(dx, dz) + b.thick, h, b.thick, 0.55, 0.55, 0.6, h / 2, 0);
}

// Ground. In gravity worlds it is a stack of east-west strips, each white with
// snow in proportion to how cold it is there (temperature lags the sun).
export const GROUND_STRIPS = 32;
export function snowAt(world, z) {
  return Math.min(1, Math.max(0, (0.42 - world.sunAt(z).temp) / 0.25));
}
function groundCount(world) {
  return world.gravity ? GROUND_STRIPS : 1;
}
function groundRecs(d, i, world) {
  const S = world.size;
  if (!world.gravity) {
    rec(d, i, S / 2, S / 2, 0, 1, S, 0.02, S, 0.11, 0.11, 0.13, 0.01, 0);
    return 1;
  }
  const h = S / GROUND_STRIPS;
  for (let k = 0; k < GROUND_STRIPS; k++) {
    const z = (k + 0.5) * h, s = snowAt(world, z);
    rec(d, i + k, S / 2, z, 0, 1, S, 0.02, h, 0.14 + 0.68 * s, 0.12 + 0.72 * s, 0.09 + 0.79 * s, 0.01, 0);
  }
  return GROUND_STRIPS;
}

// A plant is a trunk (once it has one) under a canopy box. Trunks shade from
// green stem to brown bark with the bark gene.
function plantRecCount(p) {
  return p.h - canopyDepth(canopyRadius(p)) > 0.05 ? 2 : 1;
}
function plantRecs(d, i, p) {
  const cr = canopyRadius(p), cd = Math.min(p.h, canopyDepth(cr)), bottom = p.h - cd;
  let n = 0;
  if (bottom > 0.05) {
    const tw = trunkWidth(p), b = p.bark;
    rec(d, i + n++, p.x, p.z, 0, 1, tw, bottom, tw,
      0.3 + 0.15 * b, 0.5 - 0.22 * b, 0.18 - 0.06 * b, bottom / 2, 0);
  }
  // leaves turn as daylight nears the plant's dormancy threshold; dormant plants are bare
  let r = 0.12, g = 0.62, b = 0.16;
  if (p.dormant) { r = 0.34; g = 0.28; b = 0.22; }
  else if (p.dormancy > 0 && p.light !== undefined) {
    const s = Math.min(1, Math.max(0, (p.dormancy + 0.15 - p.light) / 0.15));
    r += (0.85 - r) * s; g += (0.42 - g) * s; b += (0.08 - b) * s;
  }
  rec(d, i + n++, p.x, p.z, p.id, 1, 2 * cr, cd, 2 * cr, r, g, b, bottom + cd / 2, 0);
  return n;
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.canvas = canvas;

    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const link = (vs, fs) => {
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      return prog;
    };
    const prog = (this.prog = link(VS, FS));
    const vp = (this.vprog = link(VISION_VS, VISION_FS));
    this.vu = {};
    for (const n of ['uObj', 'uEye', 'uStart', 'uLen', 'uAgentStart', 'uFb', 'uRet', 'uVAspect', 'uFar', 'uA', 'uB']) {
      this.vu[n] = gl.getUniformLocation(vp, n);
    }
    this.uVP = gl.getUniformLocation(prog, 'uVP');
    this.uLit = gl.getUniformLocation(prog, 'uLit');
    this.uSun = gl.getUniformLocation(prog, 'uSun');
    this.uGrav = gl.getUniformLocation(prog, 'uGrav');
    this.uLat = gl.getUniformLocation(prog, 'uLat');

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, cube(), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);

    this.ib = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ib);
    for (let k = 0; k < 3; k++) {
      gl.enableVertexAttribArray(2 + k);
      gl.vertexAttribPointer(2 + k, 4, gl.FLOAT, false, REC * 4, k * 16);
      gl.vertexAttribDivisor(2 + k, 1);
    }
    gl.bindVertexArray(null);

    // cube-only VAO for the vision pass (no instanced attributes)
    this.vvao = gl.createVertexArray();
    gl.bindVertexArray(this.vvao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
    this.objTex = this.makeDataTex();
    this.eyeTex = this.makeDataTex();
    this.objData = new Float32Array(0);
    this.eyeData = new Float32Array(0);

    this.inst = new Float32Array(REC * 2048);
    this.proj = new Float32Array(16);
    this.view = new Float32Array(16);
    this.vp = new Float32Array(16);

    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.rw = P.retinaWidth;
    this.rh = 1;
    this.fbW = this.fbH = 0;
    this.pixels = new Uint8Array(0); // compact retinas: agent i at i * rw * rh * 4
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
  }

  // Size the vision framebuffer for n agents with rw x rh retinas. Blocks stack
  // vertically, spilling into extra columns past the texture height limit.
  allocVision(n, rh) {
    const gl = this.gl, rw = this.rw;
    const perCol = Math.floor(this.maxTex / rh);
    const cap = Math.ceil(n * 1.25) + 16;
    const cols = Math.ceil(cap / perCol);
    const W = rw * cols, H = Math.min(cap, perCol) * rh;
    this.rh = rh;
    this.perCol = perCol;
    this.cap = cols * perCol;
    if (W === this.fbW && H === this.fbH) return;
    this.fbW = W;
    this.fbH = H;
    if (this.fbo) {
      gl.deleteFramebuffer(this.fbo);
      gl.deleteTexture(this.tex);
      gl.deleteRenderbuffer(this.depth);
    }
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, W, H);
    this.depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, W, H);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.raw = new Uint8Array(W * H * 4);
  }

  // Fill the instance buffer for the main view.
  writeInstances(world, selected) {
    const dims = world.dims, plants = world.plants ? world.plants.list : [];
    const shadows = dims === 3 ? world.agents.length + world.food.length + plants.length + GROUND_STRIPS : 0;
    const need = (world.agents.length + world.food.length + world.barriers.length + world.patches.length
      + 2 * plants.length + shadows + 24) * REC;
    if (need > this.inst.length) this.inst = new Float32Array(need * 2);
    const d = this.inst;
    let n = 0;
    for (const a of world.agents) agentRec(d, n++, a, dims);
    for (const f of world.food) foodRec(d, n++, f, dims, world.gravity);
    for (const p of plants) n += plantRecs(d, n, p);
    for (const b of world.barriers) barrierRec(d, n++, b, world);
    n += groundRecs(d, n, world);
    const S = world.size;
    for (const p of world.patches) {
      const [x0, z0, x1, z1] = p.rect;
      if (x1 - x0 >= S && z1 - z0 >= S) continue;
      rec(d, n++, (x0 + x1) / 2, (z0 + z1) / 2, 0, 1, x1 - x0, 0.03, z1 - z0, 0.12, 0.17, 0.12, 0.015, 0);
    }
    if (world.gravity) {
      // shadows fall away from the sun and lengthen as it gets lower
      // (each from its own latitude's sun)
      const shade = (z) => {
        const S = world.sunAt(z), e = Math.max(0.08, S.elev);
        return { dz: -S.dirZ / Math.tan(e), str: Math.min(3, 1 / Math.sin(Math.max(0.2, e))), snow: snowAt(world, z) };
      };
      for (const p of plants) {
        const cr = canopyRadius(p), mid = p.h - Math.min(p.h, canopyDepth(cr)) / 2, s = shade(p.z);
        const k = 0.06 + 0.4 * s.snow; // shadows on snow are lighter
        rec(d, n++, p.x, p.z + Math.max(-40, Math.min(40, s.dz * mid)), 0, 1, 2 * cr, 0.01, 2 * cr * s.str, k, k, k * 0.8 + 0.05 * s.snow, 0.03, 0);
      }
      for (const a of world.agents) {
        const s = shade(a.z), k = 0.05 + 0.4 * s.snow;
        rec(d, n++, a.x, a.z + Math.max(-40, Math.min(40, s.dz * a.y)), a.yaw, 1, a.len, 0.01, a.wid, k, k, k, 0.035, 0);
      }
    } else if (dims === 3) {
      // shadows on the floor give depth cues; a wire frame marks the volume
      for (const a of world.agents) rec(d, n++, a.x, a.z, a.yaw, 1, a.len, 0.01, a.wid, 0.04, 0.04, 0.05, 0.04, 0);
      for (const f of world.food) {
        const h = World.foodHalf(f) * 2;
        rec(d, n++, f.x, f.z, 0, 1, h, 0.01, h, 0.05, 0.09, 0.05, 0.035, 0);
      }
      const H = world.height, t = 0.15, e = [0.22, 0.24, 0.3];
      for (const [x, z] of [[0, 0], [S, 0], [0, S], [S, S]]) rec(d, n++, x, z, 0, 1, t, H, t, ...e, H / 2, 0);
      for (const y of [H]) {
        rec(d, n++, S / 2, 0, 0, 1, S, t, t, ...e, y, 0);
        rec(d, n++, S / 2, S, 0, 1, S, t, t, ...e, y, 0);
        rec(d, n++, 0, S / 2, 0, 1, t, t, S, ...e, y, 0);
        rec(d, n++, S, S / 2, 0, 1, t, t, S, ...e, y, 0);
      }
    }
    if (selected) {
      const base = dims === 3 ? selected.y + selected.hgt / 2 : 0;
      rec(d, n++, selected.x, selected.z, selected.yaw, 1, 0.25, 3.2, 0.25, 1, 1, 1, base + 1.6, 0);
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ib);
    gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, n * REC), gl.DYNAMIC_DRAW);
    return n;
  }

  makeDataTex() {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    t.h = 0;
    return t;
  }

  // Upload `texels` RGBA32F texels from `data` into a 4096-wide texture.
  uploadData(tex, data, texels, unit) {
    const gl = this.gl, h = Math.max(1, Math.ceil(texels / 4096));
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (h > tex.h) {
      tex.h = h * 2;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 4096, tex.h, 0, gl.RGBA, gl.FLOAT, null);
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 4096, h, gl.RGBA, gl.FLOAT, data, 0);
  }

  renderVision(world) {
    const gl = this.gl, A = world.agents, F = world.food, B = world.barriers;
    const nA = A.length, dims = world.dims;
    if (!nA) return;
    const rh = dims === 3 ? P.retinaHeight3D : 1, rw = this.rw;
    if (rh !== this.rh || nA > this.cap || !this.fbo) this.allocVision(nA, rh);

    // bucket agents and food into vision cells (counting sort, row-major)
    const cell = P.visionRange, nc = Math.max(1, Math.ceil(world.size / cell)), ncells = nc * nc;
    const cellOf = (x, z) => Math.min(nc - 1, Math.max(0, Math.floor(z / cell))) * nc
      + Math.min(nc - 1, Math.max(0, Math.floor(x / cell)));
    const objCount = new Int32Array(ncells + 1), agCount = new Int32Array(ncells + 1);
    const PL = world.plants ? world.plants.list : [];
    const aCell = new Int32Array(nA), fCell = new Int32Array(F.length), pCell = new Int32Array(PL.length);
    for (let i = 0; i < nA; i++) { const c = cellOf(A[i].x, A[i].z); aCell[i] = c; objCount[c + 1]++; agCount[c + 1]++; }
    for (let i = 0; i < F.length; i++) { const c = cellOf(F[i].x, F[i].z); fCell[i] = c; objCount[c + 1]++; }
    let plantRecsTotal = 0;
    for (let i = 0; i < PL.length; i++) {
      const c = cellOf(PL[i].x, PL[i].z), k = plantRecCount(PL[i]);
      pCell[i] = c; objCount[c + 1] += k; plantRecsTotal += k;
    }
    for (let c = 0; c < ncells; c++) { objCount[c + 1] += objCount[c]; agCount[c + 1] += agCount[c]; }
    const objStart = objCount.slice(), agStart = agCount.slice(); // prefix sums
    const nGlobal = B.length + (dims === 3 ? groundCount(world) : 0);   // seen from everywhere
    const nObj = nA + F.length + plantRecsTotal + nGlobal;

    if (this.objData.length < nObj * REC + 4096 * 4) this.objData = new Float32Array(nObj * REC * 2 + 4096 * 4);
    if (this.eyeData.length < nA * 12 + 4096 * 4) this.eyeData = new Float32Array(nA * 24 + 4096 * 4);
    const od = this.objData, ed = this.eyeData;
    const fill = objCount; // reuse as running insertion cursor
    for (let i = 0; i < nA; i++) {
      const a = A[i];
      agentRec(od, fill[aCell[i]]++, a, dims);
      const o = agCount[aCell[i]]++ * 12, { e, f, u } = agentEye(a);
      const bx = Math.floor(i / this.perCol) * rw, by = (i % this.perCol) * rh;
      ed[o] = e[0]; ed[o + 1] = e[1]; ed[o + 2] = e[2]; ed[o + 3] = bx;
      ed[o + 4] = f[0]; ed[o + 5] = f[1]; ed[o + 6] = f[2]; ed[o + 7] = Math.tan(a.fov / 2);
      ed[o + 8] = u[0]; ed[o + 9] = u[1]; ed[o + 10] = u[2]; ed[o + 11] = by;
    }
    for (let i = 0; i < F.length; i++) foodRec(od, fill[fCell[i]]++, F[i], dims, world.gravity);
    for (let i = 0; i < PL.length; i++) fill[pCell[i]] += plantRecs(od, fill[pCell[i]], PL[i]);
    const globalStart = nA + F.length + plantRecsTotal;
    B.forEach((b, i) => barrierRec(od, globalStart + i, b, world));
    if (dims === 3) groundRecs(od, globalStart + B.length, world);
    this.uploadData(this.objTex, od, nObj * 3, 0);
    this.uploadData(this.eyeTex, ed, nA * 3, 1);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.fbW, this.fbH);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.vprog);
    gl.bindVertexArray(this.vvao);
    const u = this.vu, far = P.visionRange, near = P.near;
    gl.uniform1i(u.uObj, 0);
    gl.uniform1i(u.uEye, 1);
    gl.uniform2f(u.uFb, this.fbW, this.fbH);
    gl.uniform2f(u.uRet, rw, rh);
    gl.uniform1f(u.uVAspect, P.retinaVAspect);
    gl.uniform1f(u.uFar, far);
    gl.uniform1f(u.uA, (far + near) / (near - far));
    gl.uniform1f(u.uB, (2 * far * near) / (near - far));
    const draw = (start, len, a0, an) => {
      if (len <= 0) return;
      gl.uniform1i(u.uStart, start);
      gl.uniform1i(u.uLen, len);
      gl.uniform1i(u.uAgentStart, a0);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, len * an);
    };
    for (let cz = 0; cz < nc; cz++) {
      for (let cx = 0; cx < nc; cx++) {
        const c = cz * nc + cx, a0 = agStart[c], an = agStart[c + 1] - a0;
        if (!an) continue;
        const i0 = Math.max(0, cx - 1), i1 = Math.min(nc - 1, cx + 1);
        for (let j = Math.max(0, cz - 1); j <= Math.min(nc - 1, cz + 1); j++) {
          const s0 = objStart[j * nc + i0], s1 = objStart[j * nc + i1 + 1];
          draw(s0, s1 - s0, a0, an);
        }
        draw(globalStart, nGlobal, a0, an);
      }
    }

    // read back, then pack into one compact block per agent
    const cols = Math.ceil(nA / this.perCol);
    const readH = Math.min(nA, this.perCol) * rh;
    gl.readPixels(0, 0, cols * rw, readH, gl.RGBA, gl.UNSIGNED_BYTE, this.raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    const block = rw * rh * 4;
    if (this.pixels.length < nA * block) this.pixels = new Uint8Array(Math.ceil(nA * 1.25) * block);
    if (cols === 1) {
      this.pixels.set(this.raw.subarray(0, nA * block));
    } else {
      const rowBytes = cols * rw * 4, line = rw * 4;
      for (let i = 0; i < nA; i++) {
        const bx = Math.floor(i / this.perCol) * line, by = (i % this.perCol) * rh;
        for (let y = 0; y < rh; y++) {
          const src = (by + y) * rowBytes + bx;
          this.pixels.set(this.raw.subarray(src, src + line), i * block + y * line);
        }
      }
    }
  }

  // camera: { mode: 'orbit'|'follow'|'eye', target:[x,y,z], dist, theta, phi }
  renderMain(world, cam, selected) {
    const gl = this.gl, cv = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    // sky colour from the sun where the camera is looking
    this.sunNow = world.gravity ? world.sunAt(cam.target[2]) : null;
    const count = this.writeInstances(world, cam.mode === 'eye' ? null : selected);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    if (this.sunNow) {
      const l = Math.min(1, this.sunNow.light);
      gl.clearColor(0.03 + 0.05 * l, 0.035 + 0.07 * l, 0.05 + 0.12 * l, 1);
    } else {
      gl.clearColor(0.03, 0.03, 0.05, 1);
    }
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    const aspect = w / h;
    const k = 1 / Math.hypot(0.4, 1, 0.25);
    gl.uniform3f(this.uSun, 0.4 * k, k, 0.25 * k);
    gl.uniform1f(this.uGrav, world.gravity ? 1 : 0);
    if (world.gravity) {
      const [n, s] = world.latBand || [world.latitude, world.latitude];
      gl.uniform4f(this.uLat, n * Math.PI / 180, s * Math.PI / 180, this.sunNow.decl, world.size);
    }

    let eye, centre, up = [0, 1, 0], fovy = 50 * Math.PI / 180;
    if (cam.mode === 'eye' && selected) {
      const { e, f, u } = agentEye(selected);
      eye = e;
      up = u;
      centre = [e[0] + f[0], e[1] + f[1], e[2] + f[2]];
      fovy = 2 * Math.atan(Math.tan(selected.fov / 2) / aspect);
      gl.uniform1f(this.uLit, 0);
      perspective(this.proj, fovy, aspect, P.near, P.visionRange);
    } else {
      if (cam.mode === 'follow' && selected) {
        cam.target[0] += (selected.x - cam.target[0]) * 0.15;
        cam.target[2] += (selected.z - cam.target[2]) * 0.15;
        if (world.dims === 3) cam.target[1] += (selected.y - cam.target[1]) * 0.15;
      }
      const [tx, ty, tz] = cam.target;
      eye = [
        tx + cam.dist * Math.cos(cam.phi) * Math.cos(cam.theta),
        ty + cam.dist * Math.sin(cam.phi),
        tz + cam.dist * Math.cos(cam.phi) * Math.sin(cam.theta),
      ];
      centre = cam.target;
      gl.uniform1f(this.uLit, 1);
      perspective(this.proj, fovy, aspect, 0.1, cam.dist * 2 + world.size * 2);
    }
    lookAt(this.view, ...eye, ...centre, ...up);
    mul(this.vp, this.proj, this.view);
    gl.uniformMatrix4fv(this.uVP, false, this.vp);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, count);
    gl.bindVertexArray(null);
    this.lastCam = { eye, centre, fovy, aspect };
  }

  // World-space ray from the main camera through a canvas point.
  pickRay(px, py) {
    const c = this.lastCam;
    if (!c) return null;
    const cv = this.canvas;
    const nx = (px / cv.clientWidth) * 2 - 1, ny = 1 - (py / cv.clientHeight) * 2;
    const [ex, ey, ez] = c.eye;
    let fx = c.centre[0] - ex, fy = c.centre[1] - ey, fz = c.centre[2] - ez;
    let l = Math.hypot(fx, fy, fz); fx /= l; fy /= l; fz /= l;
    let rx = -fz, rz = fx; l = Math.hypot(rx, rz) || 1; rx /= l; rz /= l;
    const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
    const t = Math.tan(c.fovy / 2);
    const d = [fx + (rx * nx * c.aspect + ux * ny) * t, fy + uy * ny * t, fz + (rz * nx * c.aspect + uz * ny) * t];
    l = Math.hypot(...d);
    return { o: [ex, ey, ez], d: d.map((v) => v / l) };
  }
}
