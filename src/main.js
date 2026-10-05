import { P, WORLDS } from './params.js';
import { World } from './world.js';
import { Renderer } from './gl.js';
import { BrainView, drawMatrix } from './brainview.js';
import { OUTPUT_NAMES } from './genome.js';
import { sun } from './plants.js';

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
    localStorage.setItem('pw.dims', $('dims').value);
  } catch {}
  const mode = $('dims').value;
  world = new World($('layout').value, undefined, +$('worldSize').value, mode === '2' ? 2 : 3, mode === 'g');
  applyLatitude();
  $('latRow').hidden = $('season').hidden = !world.gravity;
  document.querySelectorAll('.grav').forEach((el) => { el.hidden = !world.gravity; });
  selectedId = null;
  setCam('orbit');
  cam.target = [world.size / 2, world.height / 3, world.size / 2];
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
  world.update(renderer.pixels, renderer.rw, renderer.rh);
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
$('dims').onchange = newWorld;
const fmtLat = (v) => `${Math.abs(v)}°${v > 0 ? 'N' : v < 0 ? 'S' : ''}`;
// Latitude: one value everywhere, or (round world) a north-south band across the map.
function applyLatitude() {
  const round = $('round').checked;
  $('latSingle').hidden = round;
  $('latBand').hidden = !round;
  $('latVal').textContent = fmtLat(+$('lat').value);
  $('latNVal').textContent = fmtLat(+$('latN').value);
  $('latSVal').textContent = fmtLat(+$('latS').value);
  if (world) {
    world.latitude = +$('lat').value;
    world.latBand = round ? [+$('latN').value, +$('latS').value] : null;
  }
  try {
    localStorage.setItem('pw.lat', JSON.stringify({ lat: $('lat').value, n: $('latN').value, s: $('latS').value, round }));
  } catch {}
}
for (const id of ['round', 'lat', 'latN', 'latS']) $(id).oninput = applyLatitude;
$('round').onchange = applyLatitude;
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

// Agent a's retina block (rw x rh, bottom row first, as GL reads it).
function retinaOf(a) {
  const i = a ? visionOrder.indexOf(a) : -1, block = renderer.rw * renderer.rh * 4;
  if (i < 0 || (i + 1) * block > renderer.pixels.length) return null;
  return renderer.pixels.subarray(i * block, (i + 1) * block);
}

// ImageData of `count` stacked retina blocks, each flipped so up is up.
function retinaImage(first, count) {
  const rw = renderer.rw, rh = renderer.rh, line = rw * 4, src = renderer.pixels;
  const img = new ImageData(rw, Math.max(1, count * rh));
  for (let i = 0; i < count; i++) {
    for (let y = 0; y < rh; y++) {
      const s = ((first + i) * rh + y) * line;
      if (s + line > src.length) return img;
      img.data.set(src.subarray(s, s + line), (i * rh + (rh - 1 - y)) * line);
    }
  }
  return img;
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
    const ray = renderer.pickRay(e.clientX - r.left, e.clientY - r.top);
    if (ray) {
      // nearest agent to the ray; tolerance grows with distance so far-away agents stay clickable
      const { o, d } = ray;
      let best = null, bd = Infinity;
      for (const a of world.agents) {
        const vx = a.x - o[0], vy = (world.dims === 3 ? a.y : a.hgt / 2) - o[1], vz = a.z - o[2];
        const t = vx * d[0] + vy * d[1] + vz * d[2];
        if (t <= 0) continue;
        const px = vx - t * d[0], py = vy - t * d[1], pz = vz - t * d[2];
        const off = Math.sqrt(px * px + py * py + pz * pz), tol = Math.max(1.5, t * 0.025);
        if (off < tol && off / tol < bd) { bd = off / tol; best = a; }
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
    ...(world.plants ? [
      { color: '#c9a36a', values: h.map((s) => (s.treeH || 0) * 5) },
      { color: '#e8e05a', values: h.map((s) => (s.wings || 0) * 100) },
    ] : []),
  ], n);
}

// Season dial: the globe seen side-on with the sun to the left (tilted by the
// declination), the latitude band the world covers, and the year.
function drawSeason() {
  const c = $('season'), ctx = c.getContext('2d'), W = c.width, k = W / 150;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.clearRect(0, 0, 150, 170);
  const S = sun(0, world.t), d = S.decl, cx = 75, cy = 75, R = 44, ring = 60;
  ctx.fillStyle = 'rgba(13,14,18,0.75)';
  ctx.beginPath(); ctx.arc(cx, cy, ring + 10, 0, Math.PI * 2); ctx.fill();

  // year ring: northern seasons by quarter, marker at today
  const seasons = [['spring', '#8fd18b'], ['summer', '#e8c35a'], ['autumn', '#e8955a'], ['winter', '#9fc3e8']];
  seasons.forEach(([, col], q) => {
    ctx.strokeStyle = col; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(cx, cy, ring, -Math.PI / 2 + q * Math.PI / 2 + 0.04, -Math.PI / 2 + (q + 1) * Math.PI / 2 - 0.04); ctx.stroke();
  });
  const ang = -Math.PI / 2 + S.phase * Math.PI * 2;
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(cx + Math.cos(ang) * ring, cy + Math.sin(ang) * ring, 4, 0, Math.PI * 2); ctx.fill();

  // globe: night side, then the lit half facing the sun (to the left, raised by the declination)
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = '#1b2230'; ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
  ctx.fillStyle = '#3d6a8a';
  ctx.beginPath(); ctx.arc(cx, cy, R, Math.PI / 2 + d, Math.PI * 1.5 + d, false); ctx.fill();
  // the band of latitudes this world covers
  const yOf = (lat) => cy - R * Math.sin(lat * Math.PI / 180);
  const [n, s] = world.latBand || [world.latitude + 1.5, world.latitude - 1.5];
  ctx.fillStyle = 'rgba(127,209,139,0.22)';
  ctx.fillRect(cx - R, Math.min(yOf(n), yOf(s)), 2 * R, Math.max(2, Math.abs(yOf(s) - yOf(n))));
  ctx.strokeStyle = '#7fd18b'; ctx.lineWidth = 1.5;
  for (const lat of [n, s]) { ctx.beginPath(); ctx.moveTo(cx - R, yOf(lat)); ctx.lineTo(cx + R, yOf(lat)); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 0.75; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#e8c35a';
  ctx.beginPath(); ctx.arc(cx - ring - 2, cy - Math.tan(d) * (ring + 2), 3.5, 0, Math.PI * 2); ctx.fill();

  // season text per hemisphere covered
  ctx.font = '11px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.fillStyle = '#d8dbe2';
  const north = sun(45, world.t).season, south = sun(-45, world.t).season;
  const hi = Math.max(n, s), lo = Math.min(n, s);
  const text = hi > 0 && lo < 0 ? `N ${north} · S ${south}` : hi > 0 ? `${north} (north)` : `${south} (south)`;
  ctx.fillText(text, cx, 160);
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
  if (world.plants) {
    const L = world.plants.list;
    let h = 0, hmax = 0, bark = 0, wings = 0, air = 0, fly = 0;
    for (const p of L) { h += p.h; hmax = Math.max(hmax, p.h); bark += p.bark; }
    for (const a of A) {
      wings += a.traits.wings;
      if (a.y > a.r + 0.3) air++;
      if (a.traits.wings * P.gravity.maxLift > P.gravity.g) fly++;
    }
    const np = L.length || 1, na = A.length || 1;
    items.push(['plants', L.length], ['tree h avg', (h / np).toFixed(2)], ['tree h max', hmax.toFixed(1)],
      ['bark avg', (bark / np).toFixed(2)], ['wings avg', (wings / na).toFixed(3)], ['can fly', fly],
      ['off ground', Math.round((100 * air) / na) + '%'], ['plant eaten', s.meat + s.plant ? Math.round(100 * s.plant / (s.meat + s.plant)) + '%' : '–']);
    let dormant = 0, evergreen = 0, torpid = 0, hib = 0;
    for (const p of L) { if (p.dormant) dormant++; if (p.dormancy < 0.02) evergreen++; }
    for (const a of A) { if (a.torpid) torpid++; if (a.traits.hibernate >= 0) hib++; }
    items.push(['dormant', Math.round((100 * dormant) / np) + '%'], ['evergreen', Math.round((100 * evergreen) / np) + '%'],
      ['hibernating', torpid], ['can hibernate', Math.round((100 * hib) / na) + '%']);
  }
  $('stats').innerHTML = items.map(([k, v]) => `<div><span>${k}</span> ${v}</div>`).join('');
}

function drawWall() {
  const c = $('wall'), n = visionOrder.length;
  const rows = Math.max(1, n * renderer.rh);
  if (c.height !== rows) c.height = rows;
  c.style.height = Math.min(480, Math.max(60, rows * 1.5)) + 'px';
  // one block per agent, agent 0 at the top
  c.getContext('2d').putImageData(retinaImage(0, n), 0, 0);
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
    return { label, bar, fill };
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
  const i = visionOrder.indexOf(a), povC = $('pov'), rh = renderer.rh;
  if (povC.height !== rh) { povC.height = rh; povC.style.height = (rh > 1 ? 64 : 22) + 'px'; }
  if (i >= 0) povC.getContext('2d').putImageData(retinaImage(i, 1), 0, 0);

  // vision neurons: a cols x rows grid per colour channel, stacked red/green/blue
  const pn = $('povN'), rows = b.visRows, maxN = Math.max(...b.visCols);
  if (pn.width !== maxN || pn.height !== 3 * rows) {
    pn.width = maxN; pn.height = 3 * rows; pn.style.height = (rows > 1 ? 60 : 30) + 'px';
  }
  const nctx = pn.getContext('2d');
  nctx.fillStyle = '#0d0e12';
  nctx.fillRect(0, 0, pn.width, pn.height);
  for (let c = 0; c < 3; c++) {
    const cols = b.visCols[c];
    for (let k = 0; k < cols * rows; k++) {
      const kx = k % cols, ky = (k / cols) | 0;
      const v = Math.round(b.state[b.starts[2 + c] + k] * 255);
      nctx.fillStyle = c === 0 ? `rgb(${v},0,0)` : c === 1 ? `rgb(0,${v},0)` : `rgb(0,0,${v})`;
      nctx.fillRect((kx * pn.width) / cols, c * rows + (rows - 1 - ky), pn.width / cols, 1);
    }
  }

  outputBars.forEach((ob, o) => {
    const on = o < b.numOutputs;
    ob.label.hidden = ob.bar.hidden = !on;
    if (on) ob.label.textContent = b.outputNames[o];
    if (on) ob.fill.style.width = a.out[o] * 100 + '%';
  });

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
  const sunInfo = world.gravity ? (() => {
    const S = world.sunAt(cam.target[2]), lat = world.latAt(cam.target[2]);
    return ` · ${world.latBand ? `at ${fmtLat(Math.round(lat))}: ` : ''}${S.season} · sun ${Math.max(0, S.elev * 180 / Math.PI).toFixed(0)}° · light ${S.light.toFixed(2)}`;
  })() : '';
  if (world.gravity && frame % 3 === 0) drawSeason();
  $('hud').innerHTML = `<b>Polyworld</b> · ${world.size}² · step ${world.t}${sunInfo} · ${world.agents.length} agents · ${world.food.length} food`
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
  const dm = localStorage.getItem('pw.dims');
  if (dm === '2' || dm === '3' || dm === 'g') $('dims').value = dm;
  const lt = JSON.parse(localStorage.getItem('pw.lat') || 'null');
  if (lt && typeof lt === 'object') {
    $('lat').value = lt.lat; $('latN').value = lt.n; $('latS').value = lt.s; $('round').checked = !!lt.round;
  }
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
