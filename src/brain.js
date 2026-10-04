// Genetically grown neural network with Hebbian learning, after Polyworld.
//
// Neurons are laid out by group: inputs (random, energy, red[], green[], blue[]),
// then internal groups (excitatory neurons followed by inhibitory ones), then the
// seven output neurons. Every non-input neuron is a logistic unit updated
// synchronously each step. Synapse sign is fixed by the source neuron's type;
// magnitude changes by w += lr * (post - 0.5) * (pre - 0.5).

import { P } from './params.js';
import { GENE, MAX_INTERNAL, N_IN, N_OUT, N_SRC, N_TGT } from './genome.js';

export const OUT = { eat: 0, mate: 1, fight: 2, speed: 3, yaw: 4, light: 5, focus: 6 };

export class Brain {
  constructor(g, traits, rng) {
    const sizes = new Array(N_SRC).fill(0);
    sizes[0] = 1;
    sizes[1] = 1;
    sizes[2] = traits.nRed;
    sizes[3] = traits.nGreen;
    sizes[4] = traits.nBlue;
    for (let i = 0; i < MAX_INTERNAL; i++) {
      sizes[N_IN + i] = i < traits.numInternal ? traits.exc[i] + traits.inh[i] : 0;
    }
    for (let o = 0; o < N_OUT; o++) sizes[N_IN + MAX_INTERNAL + o] = 1;

    const starts = new Array(N_SRC);
    let n = 0;
    for (let s = 0; s < N_SRC; s++) { starts[s] = n; n += sizes[s]; }

    this.sizes = sizes;
    this.starts = starts;
    this.numNeurons = n;
    this.firstNonInput = starts[N_IN];
    this.outStart = starts[N_IN + MAX_INTERNAL];

    const sign = new Int8Array(n).fill(1);
    for (let i = 0; i < traits.numInternal; i++) {
      const s0 = starts[N_IN + i] + traits.exc[i];
      for (let k = 0; k < traits.inh[i]; k++) sign[s0 + k] = -1;
    }
    this.sign = sign;

    const bias = new Float32Array(n);
    for (let t = 0; t < N_TGT; t++) {
      const grp = N_IN + t;
      const b = (g[GENE.bias + t] * 2 - 1) * P.maxBias;
      for (let k = 0; k < sizes[grp]; k++) bias[starts[grp] + k] = b;
    }
    this.bias = bias;

    // Grow synapses. For each target neuron j of a target group, connect to
    // round(density * |source|) neurons of each source group, centred on the
    // topologically corresponding source position; topological distortion is
    // the chance each of those is replaced by a random source neuron.
    const from = [], to = [], w = [], lr = [];
    const used = new Set();
    for (let t = 0; t < N_TGT; t++) {
      const tg = N_IN + t, nt = sizes[tg];
      if (!nt) continue;
      for (let s = 0; s < N_SRC; s++) {
        const ns = sizes[s];
        if (!ns) continue;
        const k = t * N_SRC + s;
        const nc = Math.round(g[GENE.density + k] * ns);
        if (!nc) continue;
        const topo = g[GENE.topo + k];
        const rate = g[GENE.lr + k] * P.maxLR;
        for (let j = 0; j < nt; j++) {
          const target = starts[tg] + j;
          const centre = Math.floor(((j + 0.5) / nt) * ns);
          const first = centre - (nc >> 1);
          used.clear();
          for (let m = 0; m < nc; m++) {
            let idx = (((first + m) % ns) + ns) % ns;
            if (rng() < topo) {
              for (let tries = 0; tries < 4; tries++) {
                const r = rng.int(ns);
                if (!used.has(r)) { idx = r; break; }
              }
            }
            if (used.has(idx)) continue;
            used.add(idx);
            const src = starts[s] + idx;
            from.push(src);
            to.push(target);
            w.push(sign[src] * rng() * P.initMaxWeight);
            lr.push(rate);
          }
        }
      }
    }
    this.from = Int32Array.from(from);
    this.to = Int32Array.from(to);
    this.w = Float32Array.from(w);
    this.lr = Float32Array.from(lr);
    this.numSynapses = this.from.length;

    this.state = new Float32Array(n);
    this.next = new Float32Array(n);
    for (let i = this.firstNonInput; i < n; i++) this.state[i] = 0.5;
  }

  step() {
    const { state, next, from, to, w, lr, bias, sign, numSynapses, firstNonInput, numNeurons } = this;
    const gain = P.logisticGain, maxW = P.maxWeight;
    for (let i = firstNonInput; i < numNeurons; i++) next[i] = bias[i];
    for (let s = 0; s < numSynapses; s++) next[to[s]] += w[s] * state[from[s]];
    for (let i = firstNonInput; i < numNeurons; i++) next[i] = 1 / (1 + Math.exp(-gain * next[i]));
    for (let s = 0; s < numSynapses; s++) {
      const f = from[s];
      let nw = w[s] + lr[s] * (next[to[s]] - 0.5) * (state[f] - 0.5);
      if (sign[f] > 0) nw = nw < 0 ? 0 : nw > maxW ? maxW : nw;
      else nw = nw > 0 ? 0 : nw < -maxW ? -maxW : nw;
      w[s] = nw;
    }
    for (let i = firstNonInput; i < numNeurons; i++) state[i] = next[i];
  }

  output(o) {
    return this.state[this.outStart + o];
  }
}
