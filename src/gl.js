// WebGL2 renderer. Every object in the world is an instanced box. Each step
// every agent's point of view is rendered into its own 1-pixel-tall row of an
// offscreen framebuffer (retinaWidth x numAgents), read back once, and fed to
// the brains — the same per-agent POV rendering Polyworld uses for vision.

import { P } from './params.js';
import { World } from './world.js';
import { OUT } from './brain.js';

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec4 iA;   // x, z, yaw, front-face brightness
layout(location=3) in vec3 iS;   // scale
layout(location=4) in vec3 iC;   // colour
uniform mat4 uVP;
out vec3 vC;
out vec3 vN;
void main() {
  float c = cos(iA.z), s = sin(iA.z);
  vec3 p = aPos * iS;
  vec3 w = vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c) + vec3(iA.x, 0.0, iA.y);
  vN = vec3(aNrm.x * c - aNrm.z * s, aNrm.y, aNrm.x * s + aNrm.z * c);
  vC = iC * (aNrm.x > 0.5 ? iA.w : 1.0);
  gl_Position = uVP * vec4(w, 1.0);
}`;

const FS = `#version 300 es
precision mediump float;
in vec3 vC;
in vec3 vN;
uniform float uLit;
out vec4 o;
void main() {
  vec3 L = normalize(vec3(0.4, 1.0, 0.25));
  float d = 0.45 + 0.55 * max(dot(normalize(vN), L), 0.0);
  o = vec4(vC * mix(1.0, d, uLit), 1.0);
}`;

// Vision pass. One instanced draw renders a range of objects for every agent in
// a grid cell: instance i is object (start + i % len) seen by agent
// (agentStart + i / len). Objects come from a texture (3 RGBA32F texels each),
// agent eyes from another (2 texels each). Each agent's projection is squeezed
// into its own framebuffer row, and fragments landing in other rows are dropped.
const VISION_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
uniform highp sampler2D uObj;   // (x, z, yaw, front) (sx, sy, sz, r) (g, b, -, -)
uniform highp sampler2D uEye;   // (ex, ez, cos, sin) (tan(hfov/2), row, -, -)
uniform int uStart, uLen, uAgentStart;
uniform float uRows, uEyeY, uTanV, uFar, uA, uB;
flat out int vRow;
out vec3 vC;
ivec2 tc(int i) { return ivec2(i & 4095, i >> 12); }
void main() {
  int obj = uStart + gl_InstanceID % uLen;
  int ag = uAgentStart + gl_InstanceID / uLen;
  vec4 o0 = texelFetch(uObj, tc(obj * 3), 0);
  vec4 o1 = texelFetch(uObj, tc(obj * 3 + 1), 0);
  vec4 o2 = texelFetch(uObj, tc(obj * 3 + 2), 0);
  vec4 e0 = texelFetch(uEye, tc(ag * 2), 0);
  vec4 e1 = texelFetch(uEye, tc(ag * 2 + 1), 0);
  vRow = int(e1.y);
  vC = vec3(o1.w, o2.x, o2.y) * (aNrm.x > 0.5 ? o0.w : 1.0);

  // cheap per-object cull: behind the eye, beyond range, or well outside the fov
  vec2 dc = o0.xy - e0.xy;
  float fc = dc.x * e0.z + dc.y * e0.w;
  float rc = -dc.x * e0.w + dc.y * e0.z;
  float rad = 0.5 * length(o1.xz);
  if (fc < -rad || fc > uFar + rad || abs(rc) > fc * e1.x + rad + 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float c = cos(o0.z), s = sin(o0.z);
  vec3 p = aPos * o1.xyz;
  vec3 w = vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c) + vec3(o0.x, 0.0, o0.y);
  vec3 d = w - vec3(e0.x, uEyeY, e0.y);
  float fwd = d.x * e0.z + d.z * e0.w;
  float right = -d.x * e0.w + d.z * e0.z;
  vec4 clip = vec4(right / e1.x, d.y / uTanV, -uA * fwd + uB, fwd);
  float row = e1.y;
  clip.y = clip.w * (-1.0 + (2.0 * row + 1.0) / uRows) + clip.y / uRows;
  gl_Position = clip;
}`;

const VISION_FS = `#version 300 es
precision mediump float;
flat in int vRow;
in vec3 vC;
out vec4 o;
void main() {
  if (int(gl_FragCoord.y) != vRow) discard;
  o = vec4(vC, 1.0);
}`;

const STRIDE = 10; // floats per instance

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

export function lookAt(out, ex, ey, ez, cx, cy, cz) {
  let fx = cx - ex, fy = cy - ey, fz = cz - ez;
  let l = Math.hypot(fx, fy, fz);
  fx /= l; fy /= l; fz /= l;
  // s = f x up(0,1,0)
  let sx = -fz, sy = 0, sz = fx;
  l = Math.hypot(sx, sz) || 1;
  sx /= l; sz /= l;
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

export function agentEye(a) {
  const c = Math.cos(a.yaw), s = Math.sin(a.yaw), h = a.len / 2 + 0.02;
  return [a.x + c * h, P.eyeHeight, a.z + s * h, c, s];
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
    for (const n of ['uObj', 'uEye', 'uStart', 'uLen', 'uAgentStart', 'uRows', 'uEyeY', 'uTanV', 'uFar', 'uA', 'uB']) {
      this.vu[n] = gl.getUniformLocation(vp, n);
    }
    this.uVP = gl.getUniformLocation(prog, 'uVP');
    this.uLit = gl.getUniformLocation(prog, 'uLit');

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
    const attr = (loc, n, off) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, STRIDE * 4, off * 4);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr(2, 4, 0);
    attr(3, 3, 4);
    attr(4, 3, 7);
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

    this.inst = new Float32Array(STRIDE * 2048);
    this.proj = new Float32Array(16);
    this.view = new Float32Array(16);
    this.vp = new Float32Array(16);

    this.rw = P.retinaWidth;
    this.allocVision(P.maxAgents + 16);
    this.maxRows = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
  }

  allocVision(rows) {
    const gl = this.gl;
    this.rows = rows;
    if (this.fbo) {
      gl.deleteFramebuffer(this.fbo);
      gl.deleteTexture(this.tex);
      gl.deleteRenderbuffer(this.depth);
    }
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.rw, rows);
    this.depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, this.rw, rows);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.pixels = new Uint8Array(this.rw * rows * 4);
  }

  // Fill the instance buffer. Objects agents can see come first (visionCount);
  // ground, patch markers and the selection marker follow.
  writeInstances(world, selected) {
    const need = (world.agents.length + world.food.length + world.barriers.length + world.patches.length + 4) * STRIDE;
    if (need > this.inst.length) this.inst = new Float32Array(need * 2);
    const d = this.inst;
    let n = 0;
    const put = (x, z, yaw, front, sx, sy, sz, r, g, b) => {
      const o = n * STRIDE;
      d[o] = x; d[o + 1] = z; d[o + 2] = yaw; d[o + 3] = front;
      d[o + 4] = sx; d[o + 5] = sy; d[o + 6] = sz;
      d[o + 7] = r; d[o + 8] = g; d[o + 9] = b;
      n++;
    };
    for (const a of world.agents) {
      const [r, g, b] = a.color();
      put(a.x, a.z, a.yaw, 0.25 + 0.75 * a.out[OUT.light], a.len, a.hgt, a.wid, r, g, b);
    }
    for (const f of world.food) {
      const h = World.foodHalf(f) * 2;
      put(f.x, f.z, 0, 1, h, 0.6, h, 0.15, 0.85, 0.15);
    }
    for (const b of world.barriers) {
      const dx = b.x1 - b.x0, dz = b.z1 - b.z0;
      put((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2, Math.atan2(dz, dx), 1,
        Math.hypot(dx, dz) + b.thick, b.height, b.thick, 0.55, 0.55, 0.6);
    }
    const visionCount = n;
    const S = world.size;
    put(S / 2, S / 2, 0, 1, S, 0.02, S, 0.11, 0.11, 0.13);
    for (const p of world.patches) {
      const [x0, z0, x1, z1] = p.rect;
      if (x1 - x0 >= S && z1 - z0 >= S) continue;
      put((x0 + x1) / 2, (z0 + z1) / 2, 0, 1, x1 - x0, 0.03, z1 - z0, 0.12, 0.17, 0.12);
    }
    if (selected) {
      put(selected.x, selected.z, selected.yaw, 1, 0.25, 3.2, 0.25, 1, 1, 1);
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ib);
    gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, n * STRIDE), gl.DYNAMIC_DRAW);
    return { count: n, visionCount };
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
    const nA = A.length;
    if (!nA) return;
    if (nA > this.rows) this.allocVision(Math.min(this.maxRows, Math.ceil(nA * 1.25)));
    const rows = this.rows;

    // bucket agents and food into vision cells (counting sort, row-major)
    const cell = P.visionRange, nc = Math.max(1, Math.ceil(world.size / cell)), ncells = nc * nc;
    const cellOf = (x, z) => Math.min(nc - 1, Math.max(0, Math.floor(z / cell))) * nc
      + Math.min(nc - 1, Math.max(0, Math.floor(x / cell)));
    const objCount = new Int32Array(ncells + 1), agCount = new Int32Array(ncells + 1);
    const aCell = new Int32Array(nA), fCell = new Int32Array(F.length);
    for (let i = 0; i < nA; i++) { const c = cellOf(A[i].x, A[i].z); aCell[i] = c; objCount[c + 1]++; agCount[c + 1]++; }
    for (let i = 0; i < F.length; i++) { const c = cellOf(F[i].x, F[i].z); fCell[i] = c; objCount[c + 1]++; }
    for (let c = 0; c < ncells; c++) { objCount[c + 1] += objCount[c]; agCount[c + 1] += agCount[c]; }
    const objStart = objCount.slice(), agStart = agCount.slice(); // prefix sums
    const nObj = nA + F.length + B.length;

    if (this.objData.length < nObj * 12 + 4096 * 4) this.objData = new Float32Array(nObj * 24 + 4096 * 4);
    if (this.eyeData.length < nA * 8 + 4096 * 4) this.eyeData = new Float32Array(nA * 16 + 4096 * 4);
    const od = this.objData, ed = this.eyeData;
    const put = (slot, x, z, yaw, front, sx, sy, sz, r, g, b) => {
      const o = slot * 12;
      od[o] = x; od[o + 1] = z; od[o + 2] = yaw; od[o + 3] = front;
      od[o + 4] = sx; od[o + 5] = sy; od[o + 6] = sz; od[o + 7] = r;
      od[o + 8] = g; od[o + 9] = b;
    };
    const fill = objCount; // reuse as running insertion cursor
    for (let i = 0; i < nA; i++) {
      const a = A[i], [r, g, b] = a.color();
      put(fill[aCell[i]]++, a.x, a.z, a.yaw, 0.25 + 0.75 * a.out[OUT.light], a.len, a.hgt, a.wid, r, g, b);
      const e = agCount[aCell[i]]++ * 8, [ex, , ez, c, s] = agentEye(a);
      ed[e] = ex; ed[e + 1] = ez; ed[e + 2] = c; ed[e + 3] = s;
      ed[e + 4] = Math.tan(a.fov / 2); ed[e + 5] = i;
    }
    for (let i = 0; i < F.length; i++) {
      const f = F[i], h = World.foodHalf(f) * 2;
      put(fill[fCell[i]]++, f.x, f.z, 0, 1, h, 0.6, h, 0.15, 0.85, 0.15);
    }
    const barrierStart = nA + F.length;
    B.forEach((b, i) => {
      const dx = b.x1 - b.x0, dz = b.z1 - b.z0;
      put(barrierStart + i, (b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2, Math.atan2(dz, dx), 1,
        Math.hypot(dx, dz) + b.thick, b.height, b.thick, 0.55, 0.55, 0.6);
    });
    this.uploadData(this.objTex, od, nObj * 3, 0);
    this.uploadData(this.eyeTex, ed, nA * 2, 1);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.rw, rows);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.vprog);
    gl.bindVertexArray(this.vvao);
    const u = this.vu, far = P.visionRange, near = P.near;
    gl.uniform1i(u.uObj, 0);
    gl.uniform1i(u.uEye, 1);
    gl.uniform1f(u.uRows, rows);
    gl.uniform1f(u.uEyeY, P.eyeHeight);
    gl.uniform1f(u.uTanV, Math.tan(20 * Math.PI / 180));
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
        draw(barrierStart, B.length, a0, an);
      }
    }
    gl.readPixels(0, 0, this.rw, Math.min(nA, rows), gl.RGBA, gl.UNSIGNED_BYTE, this.pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
  }

  // camera: { mode: 'orbit'|'follow'|'eye', target:[x,y,z], dist, theta, phi }
  renderMain(world, cam, selected) {
    const gl = this.gl, cv = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const { count } = this.writeInstances(world, cam.mode === 'eye' ? null : selected);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.03, 0.03, 0.05, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    const aspect = w / h;

    let eye, centre, fovy = 50 * Math.PI / 180;
    if (cam.mode === 'eye' && selected) {
      const [ex, ey, ez, c, s] = agentEye(selected);
      eye = [ex, ey, ez];
      centre = [ex + c, ey, ez + s];
      fovy = 2 * Math.atan(Math.tan(selected.fov / 2) / aspect);
      gl.uniform1f(this.uLit, 0);
      perspective(this.proj, fovy, aspect, P.near, P.visionRange);
    } else {
      if (cam.mode === 'follow' && selected) {
        cam.target[0] += (selected.x - cam.target[0]) * 0.15;
        cam.target[2] += (selected.z - cam.target[2]) * 0.15;
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
    lookAt(this.view, ...eye, ...centre);
    mul(this.vp, this.proj, this.view);
    gl.uniformMatrix4fv(this.uVP, false, this.vp);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, count);
    gl.bindVertexArray(null);
    this.lastCam = { eye, centre, fovy, aspect };
  }

  // Ray from the main camera through a canvas point, intersected with the ground.
  pickGround(px, py) {
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
    const dx = fx + (rx * nx * c.aspect + ux * ny) * t;
    const dy = fy + uy * ny * t;
    const dz = fz + (rz * nx * c.aspect + uz * ny) * t;
    if (dy >= -1e-6) return null;
    const k = (0.4 - ey) / dy;
    return [ex + dx * k, ez + dz * k];
  }
}
