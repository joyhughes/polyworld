import { P, WORLDS } from './params.js';
import { World } from './world.js';
import { Renderer } from './gl.js';
import { BrainView, drawMatrix } from './brainview.js';
import { OUTPUT_NAMES } from './genome.js';

const $ = (id) => document.getElementById(id);

const renderer = new Renderer($('gl'));
const brainView = new BrainView($('brainView'));
let world;
let paused = false;
let stepsPerFrame = 10;
let selectedId = null;
const cam = { mode: 'orbit', target: [50, 0, 50], dist: 115, theta: Math.PI / 2, phi: 0.95 };

function newWorld() {
  try {
    localStorage.setItem('pw.layout', $('layout').value);
    localStorage.setItem('pw.size', $('worldSize').value);
  } catch {}
  world = new World($('layout').value, undefined, +$('worldSize').value);
  selectedId = null;
  setCam('orbit');
  cam.target = [world.size / 2, 0, world.size / 2];
  cam.dist = world.size * 1.15;
}

function selected() {
  if (selectedId == null) return null;
  return world.agents.find((a) => a.id === selectedId) || null;
}

let visionOrder = [];  // agent order of the rows in renderer.pixels
function stepOnce() {
  renderer.renderVision(world);
  visionOrder = world.agents.slice();
  world.update(renderer.pixels, renderer.rw);
  brainView.record(selected());
}

// --- controls -----------------------------------------------------------

for (const [k, L] of Object.entries(WORLDS)) {
  const o = document.createElement('option');
  o.value = k;
  o.textContent = L.name;
  $('layout').append(o);
}
$('reset').onclick = newWorld;
$('layout').onchange = newWorld;
$('worldSize').onchange = newWorld;
const setPaused = (p) => { paused = p; $('pause').textContent = p ? 'Run' : 'Pause'; };
$('pause').onclick = () => setPaused(!paused);
$('step').onclick = () => { setPaused(true); stepOnce(); };
const speedLabel = () => { $('speedVal').textContent = `${stepsPerFrame} steps/frame`; };
$('speed').oninput = (e) => { stepsPerFrame = +e.target.value; speedLabel(); };
speedLabel();

function setCam(mode) {
  // Follow / eye need an agent: pick the fittest one if none is selected
  if (mode !== 'orbit' && !selected()) selectFittest();
  if (mode !== 'orbit' && !selected()) mode = 'orbit';
  cam.mode = mode;
  $('camOrbit').classList.toggle('on', mode === 'orbit');
  $('camFollow').classList.toggle('on', mode === 'follow');
  $('camEye').classList.toggle('on', mode === 'eye');
  if (mode === 'follow') { cam.dist = Math.min(cam.dist, 30); }
}
$('camOrbit').onclick = () => setCam('orbit');
$('camFollow').onclick = () => setCam('follow');
$('camEye').onclick = () => setCam('eye');

function openBrain(on = true) {
  if (on && !selected()) selectFittest();
  brainView.toggle(on);
}
$('openBrain').onclick = () => openBrain(true);

function retinaOf(a) {
  const row = a ? visionOrder.indexOf(a) : -1, rw = renderer.rw;
  if (row < 0 || row >= renderer.rows) return null;
  return renderer.pixels.subarray(row * rw * 4, (row + 1) * rw * 4);
}

function selectFittest() {
  let best = null;
  for (const a of world.agents) if (!best || a.fitness() > best.fitness()) best = a;
  if (best) selectedId = best.id;
}

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); setPaused(!paused); }
  else if (e.key === 'f' || e.key === 'F') setCam(cam.mode === 'follow' ? 'orbit' : 'follow');
  else if (e.key === 'e' || e.key === 'E') setCam(cam.mode === 'eye' ? 'orbit' : 'eye');
  else if (e.key === 'n' || e.key === 'N') selectFittest();
  else if (e.key === 'b' || e.key === 'B') openBrain(!brainView.open);
  else if (e.key === 'Escape') { selectedId = null; setCam('orbit'); }
});

// orbit / pan / zoom / pick
const cv = $('gl');
let drag = null;
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, pan: e.button === 2 || e.shiftKey };
});
cv.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (cam.mode === 'eye') return;
  if (drag.pan) {
    const k = cam.dist * 0.0015;
    const s = Math.sin(cam.theta), c = Math.cos(cam.theta);
    cam.target[0] += (s * dx - c * dy) * k;
    cam.target[2] += (-c * dx - s * dy) * k;
    if (cam.mode === 'follow') setCam('orbit');
  } else {
    cam.theta += dx * 0.006;
    cam.phi = Math.max(0.08, Math.min(1.55, cam.phi + dy * 0.006));
  }
});
cv.addEventListener('pointerup', (e) => {
  if (drag && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) {
    const r = cv.getBoundingClientRect();
    const g = renderer.pickGround(e.clientX - r.left, e.clientY - r.top);
    if (g) {
      // pick radius grows with camera distance so tiny far-away agents stay clickable
      const pr = Math.max(3, cam.dist * 0.03);
      let best = null, bd = pr * pr;
      for (const a of world.agents) {
        const d = (a.x - g[0]) ** 2 + (a.z - g[1]) ** 2;
        if (d < bd) { bd = d; best = a; }
      }
      selectedId = best ? best.id : null;
      if (!best && cam.mode !== 'orbit') setCam('orbit');
    }
  }
  drag = null;
});
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  cam.dist = Math.max(4, Math.min(world.size * 2.6, cam.dist * Math.exp(e.deltaY * 0.001)));
}, { passive: false });

// --- panels ---------------------------------------------------------------

function fitCanvas(c) {
  const w = c.clientWidth;
  if (c.width !== w) c.width = w;
}

function lineChart(c, series, n) {
  fitCanvas(c);
  const ctx = c.getContext('2d'), W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  if (n < 2) return;
  let max = 1;
  for (const s of series) for (const v of s.values) max = Math.max(max, v);
  ctx.strokeStyle = '#262a33';
  ctx.fillStyle = '#5c6270';
  ctx.font = '10px ui-monospace, monospace';
  ctx.beginPath(); ctx.moveTo(0, H / 2 + 0.5); ctx.lineTo(W, H / 2 + 0.5); ctx.stroke();
  ctx.fillText(Math.round(max), 3, 10);
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    s.values.forEach((v, i) => {
      const x = (i / (n - 1)) * (W - 2) + 1, y = H - 2 - (v / max) * (H - 14);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  }
}

function drawCharts() {
  const h = world.history, n = h.length;
  lineChart($('chart'), [
    { color: '#3d7a45', values: h.map((s) => s.food / 3) },
    { color: '#8a90a0', values: h.map((s) => s.ga) },
    { color: '#e8c35a', values: h.map((s) => s.born) },
    { color: '#7fd18b', values: h.map((s) => s.pop) },
  ], n);
  lineChart($('chart2'), [
    { color: '#5a8de8', values: h.map((s) => s.neurons) },
    { color: '#c58ae8', values: h.map((s) => s.synapses / 20) },
    { color: '#e86a5a', values: h.map((s) => s.generation) },
  ], n);
}

function drawStats() {
  const s = world.stats, A = world.agents;
  let gen = 0, maxGen = 0;
  for (const a of A) { gen += a.generation; maxGen = Math.max(maxGen, a.generation); }
  const items = [
    ['step', world.t], ['agents', A.length], ['food', world.food.length],
    ['born', s.born], ['GA', s.ga], ['elites', world.elites.length],
    ['starved', s.starved], ['old age', s.old], ['killed', s.killed],
    ['gen avg', (gen / (A.length || 1)).toFixed(1)], ['gen max', maxGen],
    ['meat eaten', s.meat + s.plant ? Math.round(100 * s.meat / (s.meat + s.plant)) + '%' : '–'],
    ['speed avg', (A.reduce((t, a) => t + a.speed, 0) / (A.length || 1)).toFixed(3)],
    ['best fit', world.elites.length ? world.elites[0].fitness.toFixed(2) : '–'],
  ];
  $('stats').innerHTML = items.map(([k, v]) => `<div><span>${k}</span> ${v}</div>`).join('');
}

function drawWall() {
  const c = $('wall'), n = visionOrder.length, rw = renderer.rw;
  const rows = Math.max(1, n);
  if (c.height !== rows) c.height = rows;
  c.style.height = Math.min(480, Math.max(60, rows * 1.5)) + 'px';
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(rw, rows);
  // GL row 0 is the bottom of the framebuffer = agent 0; show agent 0 at the top
  img.data.set(renderer.pixels.subarray(0, rw * rows * 4));
  ctx.putImageData(img, 0, 0);
}

let outputBars = null;
function buildOutputBars() {
  const el = $('outputs');
  el.innerHTML = '';
  outputBars = OUTPUT_NAMES.map((name) => {
    const label = document.createElement('div');
    label.textContent = name;
    label.className = 'muted';
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    bar.append(fill);
    const thr = { eat: P.eatThreshold, mate: P.mateThreshold, fight: P.fightThreshold }[name];
    if (thr) {
      const t = document.createElement('div');
      t.className = 'thr';
      t.style.left = thr * 100 + '%';
      bar.append(t);
    }
    el.append(label, bar);
    return fill;
  });
}
buildOutputBars();

function drawAgent() {
  const a = selected();
  $('agentNone').hidden = !!a;
  $('agentPanel').hidden = !a;
  if (!a) {
    if (selectedId != null) $('agentNone').textContent = 'The selected agent has died. Click another, or press N.';
    return;
  }
  const t = a.traits, b = a.brain;
  const info = [
    ['id', a.id], ['generation', a.generation],
    ['age', `${a.age} / ${t.lifespan}`], ['energy', `${a.energy.toFixed(0)} / ${a.maxEnergy.toFixed(0)}`],
    ['size', t.size.toFixed(2)], ['strength', t.strength.toFixed(2)],
    ['max speed', t.maxSpeed.toFixed(2)], ['mate donation', (t.mateEnergy * 100).toFixed(0) + '%'],
    ['neurons', b.numNeurons], ['synapses', b.numSynapses],
    ['internal groups', t.numInternal], ['mutation', (t.mutationRate * 100).toFixed(1) + '%'],
    ['eaten', a.eaten.toFixed(0)], ['offspring', a.offspring],
    ['kills', a.kills], ['fitness', a.fitness().toFixed(2)],
  ];
  $('agentInfo').innerHTML = info.map(([k, v]) => `<div><span>${k}</span> ${v}</div>`).join('');

  // retina row
  const row = visionOrder.indexOf(a), rw = renderer.rw;
  const pov = $('pov').getContext('2d');
  const img = pov.createImageData(rw, 1);
  if (row >= 0 && row < renderer.rows) img.data.set(renderer.pixels.subarray(row * rw * 4, (row + 1) * rw * 4));
  pov.putImageData(img, 0, 0);

  // vision neurons as three rows of cells
  const pn = $('povN'), maxN = Math.max(b.sizes[2], b.sizes[3], b.sizes[4]);
  if (pn.width !== maxN) pn.width = maxN;
  const nctx = pn.getContext('2d');
  nctx.fillStyle = '#0d0e12';
  nctx.fillRect(0, 0, pn.width, 3);
  for (let c = 0; c < 3; c++) {
    const n = b.sizes[2 + c];
    for (let k = 0; k < n; k++) {
      const v = Math.round(b.state[b.starts[2 + c] + k] * 255);
      nctx.fillStyle = c === 0 ? `rgb(${v},0,0)` : c === 1 ? `rgb(0,${v},0)` : `rgb(0,0,${v})`;
      const x0 = (k * pn.width) / n;
      nctx.fillRect(x0, c, pn.width / n, 1);
    }
  }

  for (let o = 0; o < OUTPUT_NAMES.length; o++) outputBars[o].style.width = a.out[o] * 100 + '%';

  drawBrain(b);
}

function drawBrain(b) {
  const c = $('brain');
  fitCanvas(c);
  c.height = c.width;
  drawMatrix(c, b);
}

// --- main loop ------------------------------------------------------------

let frame = 0;
function loop() {
  if (!paused) {
    const t0 = performance.now();
    for (let i = 0; i < stepsPerFrame; i++) {
      stepOnce();
      if (performance.now() - t0 > 40) break;
    }
  }
  if (selectedId != null && !selected() && (cam.mode !== 'orbit' || brainView.open)) {
    // the agent we were riding along with died: hand the camera to the fittest survivor
    selectFittest();
    if (!selected()) setCam('orbit');
  }
  renderer.renderMain(world, cam, selected());
  const s = selected();
  $('hud').innerHTML = `<b>Polyworld</b> · ${world.size}² · step ${world.t} · ${world.agents.length} agents · ${world.food.length} food`
    + (s ? ` · following #${s.id}` : '') + (paused ? ' · <b>paused</b>' : '');
  if (frame % 6 === 0) { drawStats(); drawCharts(); }
  if (frame % 2 === 0) { drawWall(); drawAgent(); }
  brainView.draw(s, retinaOf(s));
  frame++;
  requestAnimationFrame(loop);
}

try {
  const l = localStorage.getItem('pw.layout'), sz = localStorage.getItem('pw.size');
  if (l && WORLDS[l]) $('layout').value = l;
  if (sz && [...$('worldSize').options].some((o) => o.value === sz)) $('worldSize').value = sz;
} catch {}
newWorld();
requestAnimationFrame(loop);

// debugging / headless experiments
window.pw = {
  get world() { return world; },
  renderer,
  brainView,
  run(n) { for (let i = 0; i < n; i++) stepOnce(); return world.t; },
  pause: setPaused,
};
