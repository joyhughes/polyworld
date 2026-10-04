// Brain visualisation: a floating, draggable, resizable window with three views
// of the selected agent's brain — a live network diagram, an activity raster
// over recent steps, and the synapse weight matrix.

import { P } from './params.js';
import { INPUT_NAMES, OUTPUT_NAMES, MAX_INTERNAL, N_IN } from './genome.js';

const HIST = 400; // steps of activity kept for the raster

const EXC = [232, 106, 90];   // excitatory synapse colour
const INH = [90, 141, 232];   // inhibitory synapse colour
const GROUP_TINT = { 2: [255, 80, 70], 3: [80, 230, 90], 4: [90, 130, 255] };

function groupName(g) {
  if (g < N_IN) return INPUT_NAMES[g];
  if (g < N_IN + MAX_INTERNAL) return `group ${g - N_IN + 1}`;
  return OUTPUT_NAMES[g - N_IN - MAX_INTERNAL];
}

function groupOf(b, n) {
  for (let g = b.sizes.length - 1; g >= 0; g--) if (b.sizes[g] && n >= b.starts[g]) return g;
  return 0;
}

// Synapse weight matrix: target rows × source columns, activations in column 0.
export function drawMatrix(c, b, w = c.width, h = c.height) {
  const N = b.numNeurons, ctx = c.getContext('2d');
  const cols = N + 2, cell = Math.min(w / cols, (h - 14) / N);
  ctx.fillStyle = '#0d0e12';
  ctx.fillRect(0, 0, w, h);
  const W = new Float32Array(N * N);
  for (let s = 0; s < b.numSynapses; s++) W[b.to[s] * N + b.from[s]] += b.w[s];
  const img = new ImageData(cols, N);
  const d = img.data;
  for (let r = 0; r < N; r++) {
    const act = Math.round(b.state[r] * 255), o = r * cols * 4;
    d[o] = d[o + 1] = d[o + 2] = act; d[o + 3] = 255;
    for (let k = 0; k < N; k++) {
      const v = W[r * N + k] / P.maxWeight, p = o + (k + 2) * 4;
      if (v > 0) { d[p] = 60 + 195 * v; d[p + 1] = 70 * v; d[p + 2] = 30 * v; }
      else if (v < 0) { d[p] = 30 * -v; d[p + 1] = 90 * -v; d[p + 2] = 60 + 195 * -v; }
      d[p + 3] = v ? 255 : 0;
    }
  }
  const off = new OffscreenCanvas(cols, N);
  off.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, cols * cell, N * cell);
  ctx.strokeStyle = '#ffffff22';
  ctx.lineWidth = 1;
  for (let g = 0; g < b.sizes.length; g++) {
    if (!b.sizes[g]) continue;
    const p = Math.round(b.starts[g] * cell) + 0.5;
    ctx.beginPath();
    ctx.moveTo(2 * cell + p, 0); ctx.lineTo(2 * cell + p, N * cell);
    ctx.moveTo(0, p); ctx.lineTo(cols * cell, p);
    ctx.stroke();
  }
  ctx.fillStyle = '#8a90a0';
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillText(`${N} neurons · ${b.numSynapses} synapses · rows: targets, columns: sources`, 2, N * cell + 11);
}

export class BrainView {
  constructor(root) {
    this.root = root;
    this.canvas = root.querySelector('canvas');
    this.title = root.querySelector('.bv-title');
    this.tab = 'network';
    this.mode = 'signal';
    this.hover = null;
    this.mouse = null;
    this.agentId = null;
    this.hist = null;
    this.histLen = 0;
    this.histPos = 0;
    this.layoutKey = null;

    root.querySelectorAll('[data-tab]').forEach((el) => {
      el.onclick = () => { this.tab = el.dataset.tab; this.syncButtons(); };
    });
    root.querySelectorAll('[data-mode]').forEach((el) => {
      el.onclick = () => { this.mode = el.dataset.mode; this.syncButtons(); };
    });
    root.querySelector('.bv-close').onclick = () => this.toggle(false);
    this.syncButtons();

    // drag by the header
    const head = root.querySelector('.bv-head');
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      head.setPointerCapture(e.pointerId);
      const r = root.getBoundingClientRect(), p = root.offsetParent.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      const move = (ev) => {
        root.style.left = Math.max(0, Math.min(p.width - 60, ev.clientX - p.left - ox)) + 'px';
        root.style.top = Math.max(0, Math.min(p.height - 30, ev.clientY - p.top - oy)) + 'px';
        root.style.right = root.style.bottom = 'auto';
      };
      const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
    });

    this.canvas.addEventListener('pointermove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.mouse = [e.clientX - r.left, e.clientY - r.top];
    });
    this.canvas.addEventListener('pointerleave', () => { this.mouse = null; });
  }

  get open() { return !this.root.hidden; }

  toggle(on = !this.open) {
    this.root.hidden = !on;
  }

  syncButtons() {
    this.root.querySelectorAll('[data-tab]').forEach((el) => el.classList.toggle('on', el.dataset.tab === this.tab));
    this.root.querySelectorAll('[data-mode]').forEach((el) => {
      el.classList.toggle('on', el.dataset.mode === this.mode);
      el.hidden = this.tab !== 'network';
    });
  }

  // Called after every simulation step with the selected agent (or null).
  record(a) {
    if (!a) return;
    const n = a.brain.numNeurons;
    if (a.id !== this.agentId) {
      this.agentId = a.id;
      this.hist = new Uint8Array(n * HIST);
      this.histLen = 0;
      this.histPos = 0;
    }
    const s = a.brain.state, o = this.histPos * n;
    for (let i = 0; i < n; i++) this.hist[o + i] = s[i] * 255;
    this.histPos = (this.histPos + 1) % HIST;
    this.histLen = Math.min(HIST, this.histLen + 1);
  }

  fit() {
    const c = this.canvas, dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return [ctx, c.clientWidth, c.clientHeight];
  }

  draw(a, retina) {
    if (!this.open) return;
    const [ctx, W, H] = this.fit();
    ctx.fillStyle = '#0d0e12';
    ctx.fillRect(0, 0, W, H);
    if (!a) {
      this.title.textContent = 'Brain';
      ctx.fillStyle = '#8a90a0';
      ctx.font = '12px ui-monospace, monospace';
      ctx.fillText(this.agentId ? 'This agent has died. Click another, or press N.' : 'Select an agent (click one, or press N).', 14, 24);
      return;
    }
    const b = a.brain;
    this.title.textContent = `Brain of #${a.id} · gen ${a.generation} · ${b.numNeurons} neurons · ${b.numSynapses} synapses`;
    if (this.tab === 'network') this.drawNetwork(ctx, W, H, a, retina);
    else if (this.tab === 'activity') this.drawActivity(ctx, W, H, a);
    else {
      const dpr = this.canvas.width / W;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      drawMatrix(this.canvas, b, this.canvas.width, this.canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  // --- network diagram ------------------------------------------------------

  layout(b, W, H) {
    const key = `${this.agentId}:${W}x${H}`;
    if (key === this.layoutKey) return this.pos;
    this.layoutKey = key;
    const n = b.numNeurons, x = new Float32Array(n), y = new Float32Array(n);
    const top = 62, bottom = H - 16, padL = 70, padR = 120;
    const shape = new Uint8Array(n); // 0 circle, 1 square (inhibitory)
    const labels = [];

    // inputs: random, energy, then the three colour channels, with gaps between groups
    const inGroups = [0, 1, 2, 3, 4];
    const slots = inGroups.reduce((t, g) => t + b.sizes[g], 0) + 4 * 1.2;
    const sp = Math.min(18, (bottom - top) / slots);
    let cy = top + ((bottom - top) - sp * slots) / 2;
    for (const g of inGroups) {
      labels.push({ text: groupName(g), x: padL - 12, y: cy + sp * (b.sizes[g] - 1) / 2, align: 'right' });
      for (let k = 0; k < b.sizes[g]; k++) { x[b.starts[g] + k] = padL; y[b.starts[g] + k] = cy; cy += sp; }
      cy += sp * 1.2;
    }

    // internal groups: one column each, excitatory then inhibitory neurons
    const internal = [];
    for (let i = 0; i < MAX_INTERNAL; i++) if (b.sizes[N_IN + i]) internal.push(N_IN + i);
    const x0 = padL + (W - padL - padR) * 0.22, x1 = padL + (W - padL - padR) * 0.78;
    let maxSp = sp;
    internal.forEach((g, i) => {
      const gx = internal.length === 1 ? (x0 + x1) / 2 : x0 + (x1 - x0) * i / (internal.length - 1);
      const m = b.sizes[g], gsp = Math.min(22, (bottom - top) / (m + 1));
      maxSp = Math.max(maxSp, gsp);
      let gy = top + ((bottom - top) - gsp * (m - 1)) / 2;
      for (let k = 0; k < m; k++) {
        const id = b.starts[g] + k;
        x[id] = gx; y[id] = gy; gy += gsp;
        shape[id] = b.sign[id] < 0 ? 1 : 0;
      }
      const ne = b.sign.subarray(b.starts[g], b.starts[g] + m).filter((s) => s > 0).length;
      labels.push({ text: groupName(g), x: gx, y: top - 22, align: 'center' });
      labels.push({ text: `${ne}E ${m - ne}I`, x: gx, y: top - 10, align: 'center' });
    });

    // outputs
    const nOut = b.numOutputs, oStart = b.outStart, osp = Math.min(40, (bottom - top) / nOut);
    let oy = top + ((bottom - top) - osp * (nOut - 1)) / 2;
    for (let o = 0; o < nOut; o++) { x[oStart + o] = W - padR; y[oStart + o] = oy; oy += osp; }

    this.pos = { x, y, shape, labels, r: Math.max(2.5, Math.min(7, sp * 0.36)), ro: Math.max(5, Math.min(9, osp * 0.25)) };
    return this.pos;
  }

  drawNetwork(ctx, W, H, a, retina) {
    const b = a.brain, n = b.numNeurons;
    const { x, y, shape, labels, r, ro } = this.layout(b, W, H);
    const st = b.state;

    // hover: nearest neuron within reach of the mouse
    this.hover = null;
    if (this.mouse) {
      let bd = 144;
      for (let i = 0; i < n; i++) {
        const d = (x[i] - this.mouse[0]) ** 2 + (y[i] - this.mouse[1]) ** 2;
        if (d < bd) { bd = d; this.hover = i; }
      }
    }
    const hv = this.hover;

    // synapses, batched into alpha buckets per sign so thousands draw quickly
    const BUCKETS = 6;
    const paths = [[], []].map(() => Array.from({ length: BUCKETS }, () => new Path2D()));
    const hiPaths = [new Path2D(), new Path2D()];
    const signal = this.mode === 'signal';
    for (let s = 0; s < b.numSynapses; s++) {
      const f = b.from[s], t = b.to[s];
      const touches = hv !== null && (f === hv || t === hv);
      if (hv !== null && !touches) continue;
      let v = b.w[s] / P.maxWeight;
      if (signal) v *= st[f];
      const m = Math.abs(v);
      if (m < 0.04 && !touches) continue;
      const sgn = v >= 0 ? 0 : 1;
      const p = touches ? hiPaths[sgn] : paths[sgn][Math.min(BUCKETS - 1, Math.floor(m * BUCKETS))];
      const x1 = x[f], y1 = y[f], x2 = x[t], y2 = y[t];
      p.moveTo(x1, y1);
      if (x2 > x1 + 1) {
        const dx = (x2 - x1) * 0.5;
        p.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2);
      } else {
        // recurrent / backward connection: loop out to the right and come back
        const k = 30 + Math.abs(x1 - x2) * 0.15;
        p.bezierCurveTo(x1 + k, y1 - k * 0.6, x2 - k, y2 - k * 0.6, x2, y2);
      }
    }
    ctx.lineWidth = 1;
    for (let sgn = 0; sgn < 2; sgn++) {
      const [cr, cg, cb] = sgn ? INH : EXC;
      for (let k = 0; k < BUCKETS; k++) {
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},${0.06 + 0.5 * ((k + 0.5) / BUCKETS) ** 1.5})`;
        ctx.stroke(paths[sgn][k]);
      }
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.9)`;
      ctx.lineWidth = 1.5;
      ctx.stroke(hiPaths[sgn]);
      ctx.lineWidth = 1;
    }

    // neurons
    for (let i = 0; i < n; i++) {
      const g = groupOf(b, i), v = st[i];
      const isOut = i >= b.outStart;
      const rad = isOut ? ro : r;
      const tint = GROUP_TINT[g];
      const c = tint
        ? `rgb(${tint[0] * v | 0},${tint[1] * v | 0},${tint[2] * v | 0})`
        : `rgb(${40 + 215 * v | 0},${40 + 215 * v | 0},${40 + 215 * v | 0})`;
      ctx.fillStyle = c;
      ctx.strokeStyle = i === hv ? '#fff' : '#ffffff40';
      ctx.beginPath();
      if (shape[i]) ctx.rect(x[i] - rad, y[i] - rad, rad * 2, rad * 2);
      else ctx.arc(x[i], y[i], rad, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // labels
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = '#8a90a0';
    for (const l of labels) {
      ctx.textAlign = l.align;
      ctx.fillText(l.text, l.x, l.y + 3);
    }
    ctx.textAlign = 'left';
    const thr = { eat: P.eatThreshold, mate: P.mateThreshold, fight: P.fightThreshold };
    for (let o = 0; o < b.numOutputs; o++) {
      const i = b.outStart + o, v = st[i], name = OUTPUT_NAMES[o];
      const bx = x[i] + ro + 8, bw = 60;
      ctx.fillStyle = '#d8dbe2';
      ctx.fillText(name, bx, y[i] - 3);
      ctx.fillStyle = '#262a33';
      ctx.fillRect(bx, y[i] + 1, bw, 4);
      const active = thr[name] === undefined || v > thr[name];
      ctx.fillStyle = active ? '#7fd18b' : '#4a6a50';
      ctx.fillRect(bx, y[i] + 1, bw * v, 4);
      if (thr[name] !== undefined) { ctx.fillStyle = '#fff8'; ctx.fillRect(bx + bw * thr[name], y[i] - 1, 1, 8); }
    }

    // the retina this brain is looking through
    if (retina) {
      const rw = P.retinaWidth, rh = retina.length / 4 / rw, line = rw * 4;
      const img = new ImageData(rw, rh);
      for (let yy = 0; yy < rh; yy++) img.data.set(retina.subarray(yy * line, (yy + 1) * line), (rh - 1 - yy) * line);
      const off = new OffscreenCanvas(rw, rh);
      off.getContext('2d').putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = false;
      const dh = rh > 1 ? 24 : 10;
      ctx.drawImage(off, 8, 8, 128, dh);
      ctx.strokeStyle = '#262a33';
      ctx.strokeRect(7.5, 7.5, 129, dh + 1);
      ctx.fillStyle = '#8a90a0';
      ctx.fillText('retina', 142, 8 + dh / 2 + 4);
    }

    // legend / tooltip
    ctx.fillStyle = '#5c6270';
    ctx.fillText(signal ? 'edges: weight × presynaptic activity' : 'edges: synapse weight', 8, H - 6);
    if (hv !== null) this.tooltip(ctx, W, H, b, hv, x[hv], y[hv]);
  }

  tooltip(ctx, W, H, b, i, px, py) {
    const g = groupOf(b, i);
    let fanIn = 0, fanOut = 0;
    for (let s = 0; s < b.numSynapses; s++) {
      if (b.to[s] === i) fanIn++;
      if (b.from[s] === i) fanOut++;
    }
    const lines = [
      `${groupName(g)} [${i - b.starts[g]}]${b.sign[i] < 0 ? ' inhibitory' : g >= N_IN && g < N_IN + MAX_INTERNAL ? ' excitatory' : ''}`,
      `activation ${b.state[i].toFixed(3)}`,
      i >= b.firstNonInput ? `bias ${b.bias[i].toFixed(2)}` : 'input neuron',
      `synapses in ${fanIn} · out ${fanOut}`,
    ];
    ctx.font = '11px ui-monospace, monospace';
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14, h = lines.length * 15 + 8;
    let tx = px + 12, ty = py + 12;
    if (tx + w > W) tx = px - w - 12;
    if (ty + h > H) ty = py - h - 12;
    ctx.fillStyle = 'rgba(20,22,28,0.95)';
    ctx.strokeStyle = '#3a4050';
    ctx.fillRect(tx, ty, w, h);
    ctx.strokeRect(tx + 0.5, ty + 0.5, w, h);
    ctx.fillStyle = '#d8dbe2';
    lines.forEach((l, k) => ctx.fillText(l, tx + 7, ty + 16 + k * 15));
  }

  // --- activity raster --------------------------------------------------------

  drawActivity(ctx, W, H, a) {
    const b = a.brain, n = b.numNeurons;
    const gut = 70, top = 8, bottom = H - 22;
    ctx.font = '10px ui-monospace, monospace';
    if (!this.hist || this.agentId !== a.id || !this.histLen) {
      ctx.fillStyle = '#8a90a0';
      ctx.fillText('Recording… (activity is captured while the simulation runs)', 14, 24);
      return;
    }
    const T = this.histLen, img = new ImageData(HIST, n), d = img.data;
    const tints = [];
    for (let i = 0; i < n; i++) tints.push(GROUP_TINT[groupOf(b, i)]);
    for (let t = 0; t < T; t++) {
      const slot = (this.histPos - T + t + HIST) % HIST, col = HIST - T + t;
      for (let i = 0; i < n; i++) {
        const v = this.hist[slot * n + i], p = (i * HIST + col) * 4;
        const tint = tints[i];
        if (tint) { d[p] = tint[0] * v / 255; d[p + 1] = tint[1] * v / 255; d[p + 2] = tint[2] * v / 255; }
        else if (b.sign[i] < 0) { d[p] = v * 0.55; d[p + 1] = v * 0.7; d[p + 2] = v; }
        else { d[p] = v; d[p + 1] = v * 0.92; d[p + 2] = v * 0.8; }
        d[p + 3] = 255;
      }
    }
    const off = new OffscreenCanvas(HIST, n);
    off.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const rowH = (bottom - top) / n;
    ctx.drawImage(off, gut, top, W - gut - 8, bottom - top);

    // group separators and labels
    ctx.strokeStyle = '#ffffff30';
    ctx.fillStyle = '#8a90a0';
    ctx.textAlign = 'right';
    for (let g = 0; g < b.sizes.length; g++) {
      const m = b.sizes[g];
      if (!m) continue;
      const y0 = top + b.starts[g] * rowH;
      ctx.beginPath(); ctx.moveTo(gut, y0 + 0.5); ctx.lineTo(W - 8, y0 + 0.5); ctx.stroke();
      if (m * rowH >= 9 || g >= N_IN + MAX_INTERNAL) ctx.fillText(groupName(g), gut - 6, y0 + (m * rowH) / 2 + 3);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = '#5c6270';
    ctx.fillText(`← ${HIST} steps`, gut, H - 7);
    ctx.textAlign = 'right';
    ctx.fillText('now', W - 8, H - 7);
    ctx.textAlign = 'left';
  }
}
