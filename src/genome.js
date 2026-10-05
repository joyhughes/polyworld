// Fixed-length genome of floats in [0,1], as in Polyworld's byte genome.
// Physiological genes come first, then the genes that grow the brain: neuron
// group sizes, per-group bias, and per (target group, source group) connection
// density, topological distortion and Hebbian learning rate.

import { P } from './params.js';

export const MAX_INTERNAL = 5;
export const MAX_VISION = 8;   // neurons per colour channel
export const MAX_EXC = 8;
export const MAX_INH = 8;

export const INPUT_NAMES = ['random', 'energy', 'red', 'green', 'blue'];
// pitch exists only in 3D worlds; it is last so the others keep their indices
export const OUTPUT_NAMES = ['eat', 'mate', 'fight', 'speed', 'yaw', 'light', 'focus', 'pitch'];
export const N_IN = INPUT_NAMES.length;
export const N_OUT = OUTPUT_NAMES.length;
export const N_SRC = N_IN + MAX_INTERNAL + N_OUT; // groups that send synapses
export const N_TGT = MAX_INTERNAL + N_OUT;        // groups that receive synapses

const G = {};
let len = 0;
const gene = (name, n = 1) => { G[name] = len; len += n; };
gene('mutationRate');
gene('crossoverPoints');
gene('lifespan');
gene('size');
gene('strength');
gene('maxSpeed');
gene('mateEnergy');
gene('green');
gene('redN');
gene('greenN');
gene('blueN');
gene('visionRows'); // 3D only: retina rows each colour channel is split into
gene('wings');      // gravity only: flight muscle; decoded cubed so it starts rare
gene('hibernate');  // gravity only: daylight below which the agent goes torpid
gene('numInternal');
gene('exc', MAX_INTERNAL);
gene('inh', MAX_INTERNAL);
gene('bias', N_TGT);
gene('density', N_TGT * N_SRC);
gene('topo', N_TGT * N_SRC);
gene('lr', N_TGT * N_SRC);

export const GENE = G;
export const GENOME_LENGTH = len;

const lerp = ([a, b], t) => a + (b - a) * t;
const irange = (a, b, t) => Math.min(b, a + Math.floor(t * (b - a + 1)));

export function decode(g) {
  const exc = [], inh = [];
  for (let i = 0; i < MAX_INTERNAL; i++) {
    exc.push(irange(1, MAX_EXC, g[G.exc + i]));
    inh.push(irange(0, MAX_INH, g[G.inh + i]));
  }
  const [mr0, mr1] = P.mutationRate;
  return {
    mutationRate: mr0 * Math.pow(mr1 / mr0, g[G.mutationRate]),
    crossoverPoints: irange(1, 8, g[G.crossoverPoints]),
    lifespan: Math.round(lerp(P.lifespan, g[G.lifespan])),
    size: lerp(P.size, g[G.size]),
    strength: lerp(P.strength, g[G.strength]),
    maxSpeed: lerp(P.maxSpeed, g[G.maxSpeed]),
    mateEnergy: lerp(P.mateEnergy, g[G.mateEnergy]),
    green: g[G.green],
    nRed: irange(1, MAX_VISION, g[G.redN]),
    nGreen: irange(1, MAX_VISION, g[G.greenN]),
    nBlue: irange(1, MAX_VISION, g[G.blueN]),
    visionRows: irange(1, 4, g[G.visionRows]),
    wings: g[G.wings] ** 3,
    // below 0.3 the agent never hibernates (-1); above, the daylight threshold is 0-0.6
    hibernate: g[G.hibernate] < 0.3 ? -1 : ((g[G.hibernate] - 0.3) / 0.7) * 0.6,
    numInternal: irange(1, MAX_INTERNAL, g[G.numInternal]),
    exc,
    inh,
  };
}

export function randomGenome(rng) {
  const g = new Float32Array(GENOME_LENGTH);
  for (let i = 0; i < GENOME_LENGTH; i++) g[i] = rng();
  return g;
}

export function mutate(g, rate, rng) {
  for (let i = 0; i < g.length; i++) {
    if (rng() < rate) {
      const v = g[i] + rng.gauss() * 0.2;
      g[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }
  return g;
}

// Multi-point crossover: alternate parents between randomly chosen cut points.
export function crossover(a, b, points, rng) {
  const cuts = [];
  for (let i = 0; i < points; i++) cuts.push(1 + rng.int(GENOME_LENGTH - 1));
  cuts.sort((x, y) => x - y);
  cuts.push(GENOME_LENGTH);
  const child = new Float32Array(GENOME_LENGTH);
  let src = rng() < 0.5 ? a : b;
  let i = 0;
  for (const c of cuts) {
    for (; i < c; i++) child[i] = src[i];
    src = src === a ? b : a;
  }
  return child;
}
