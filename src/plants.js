// Evolving plants and the sun, for gravity worlds.
//
// Each plant photosynthesises in proportion to its canopy area, the sunlight
// at the world's latitude and season, and how much of its canopy taller
// neighbours shade (shadows fall away from the sun and lengthen as it gets
// lower). Net energy is split by the plant's genes between height, leaves,
// seeds and a winter reserve. When energy runs short, leaves die back first;
// a plant dies when its reserve is gone. Agents graze leaves they can reach
// and unprotected stems; bark makes stems inedible at a construction cost.
// Seeds fall to the ground as fruit that agents can eat before it sprouts.
// Plants can go dormant: below a genetic daylight threshold they resorb their
// leaves into the reserve and idle on low maintenance until spring.

import { P } from './params.js';

const DEG = Math.PI / 180;

// genes, all in [0,1]
export const PG = { height: 0, leaf: 1, seed: 2, store: 3, bark: 4, seedSize: 5, dispersal: 6, dormancy: 7 };
const N_GENES = 8;

// Sun at a latitude (degrees) and time (steps). Light is the daily mean
// insolation relative to the equator at equinox; elev is the noon elevation;
// dirZ is +1 when the noon sun is to the south (+z), -1 when to the north;
// temp is a cold/warm proxy: the light of P.plants.seasonLag steps ago.
export function sun(latitude, t) {
  const s = sunNow(latitude, t);
  s.temp = sunNow(latitude, t - P.plants.seasonLag).light;
  return s;
}

function sunNow(latitude, t) {
  const phase = (t / P.plants.yearLength) % 1;
  const decl = 23.44 * DEG * Math.sin(2 * Math.PI * phase);
  const phi = latitude * DEG;
  const cosH0 = Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(decl)));
  const h0 = Math.acos(cosH0);
  const light = Math.max(0, h0 * Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.sin(h0));
  const elev = Math.PI / 2 - Math.abs(phi - decl);
  const north = latitude >= 0;
  const seasons = ['spring', 'summer', 'autumn', 'winter'];
  let season = seasons[Math.floor(phase * 4) % 4];
  if (!north) season = seasons[(Math.floor(phase * 4) + 2) % 4];
  return { light, elev, dirZ: phi >= decl ? 1 : -1, decl, phase, season };
}

export function canopyRadius(p) {
  return Math.min(P.plants.maxCanopy, 0.25 + 0.35 * Math.sqrt(p.L));
}
export function canopyDepth(cr) {
  return 0.3 + 0.4 * cr;
}
export function trunkWidth(p) {
  return 0.08 + 0.04 * p.h;
}

function decodePlant(g) {
  const w = [g[PG.height], g[PG.leaf], g[PG.seed], g[PG.store]].map((v) => v + 0.05);
  const sum = w[0] + w[1] + w[2] + w[3];
  return {
    aH: w[0] / sum, aL: w[1] / sum, aR: w[2] / sum, aS: w[3] / sum,
    bark: g[PG.bark],
    seedSize: 2 + 10 * g[PG.seedSize],
    dispersal: g[PG.dispersal],
    dormancy: 0.6 * g[PG.dormancy] ** 2, // daylight below which the plant goes dormant; 0 = evergreen
  };
}

let nextPlantId = 1;

export class Plants {
  constructor(world) {
    this.world = world;
    this.list = [];
    this.n = Math.ceil(world.size / 5);
    this.cells = Array.from({ length: this.n * this.n }, () => []);
    this.max = Math.round(P.plants.maxPer100 * (world.size / 100) ** 2);
    this.born = 0;
    this.died = 0;
    this.light = 1;
  }

  fertility(x, z) {
    for (const p of this.world.patches) {
      const [x0, z0, x1, z1] = p.rect;
      if (x1 - x0 >= this.world.size && z1 - z0 >= this.world.size) continue;
      if (x >= x0 && x <= x1 && z >= z0 && z <= z1) return 1;
    }
    return P.plants.baseFertility;
  }

  add(g, x, z, energy, generation = 0) {
    if (this.list.length >= this.max) return null;
    if (this.world.blocked(x, z, 0.3)) return null;
    const t = decodePlant(g);
    const p = {
      id: nextPlantId++, g, ...t, x, z, generation,
      h: 0.2, L: energy * 0.3, reserve: energy * 0.7, seedStore: 0, age: 0,
      fert: this.fertility(x, z), shade: 0,
      // bark is woodiness: soft herbs are short-lived, woody plants long-lived
      maxAge: P.plants.maxAge * (0.4 + 2.4 * t.bark) * (0.6 + 0.8 * this.world.rng()),
    };
    this.list.push(p);
    this.born++;
    return p;
  }

  seedInitial() {
    const W = this.world, rng = W.rng;
    const n = Math.round(P.plants.initPer100 * (W.size / 100) ** 2);
    const patches = W.patches.filter((p) => p.rect[2] - p.rect[0] < W.size || p.rect[3] - p.rect[1] < W.size);
    for (let i = 0; i < n; i++) {
      const g = new Float32Array(N_GENES);
      for (let k = 0; k < N_GENES; k++) g[k] = rng();
      // most of the starting flora is low and unprotected
      g[PG.height] *= 0.5;
      g[PG.bark] *= 0.5;
      const src = patches.length && rng() < 0.8 ? patches[rng.int(patches.length)].rect : [0, 0, W.size, W.size];
      const [x, z] = W.randomFreeSpot(0.3, src);
      const p = this.add(g, x, z, 2 + rng() * 8);
      if (p) { p.h = 0.2 + rng() * 0.8; p.L = 0.5 + rng() * 2; }
    }
  }

  buildGrid() {
    const n = this.n;
    for (const c of this.cells) c.length = 0;
    for (const p of this.list) {
      const cx = Math.min(n - 1, Math.max(0, Math.floor(p.x / 5)));
      const cz = Math.min(n - 1, Math.max(0, Math.floor(p.z / 5)));
      this.cells[cz * n + cx].push(p);
    }
  }

  // Advance all plants by `dt` steps.
  update(dt) {
    const W = this.world, C = P.plants, rng = W.rng;
    this.buildGrid();

    // shading: taller neighbours whose shadow, cast away from the local sun, overlaps this canopy
    const n = this.n;
    for (const p of this.list) {
      const S = W.sunAt(p.z), tanE = Math.tan(Math.max(5 * DEG, S.elev));
      const cr = canopyRadius(p);
      const cx = Math.floor(p.x / 5), cz = Math.floor(p.z / 5);
      let lit = 1;
      for (let j = cz - 2; j <= cz + 2; j++) {
        if (j < 0 || j >= n) continue;
        for (let i = cx - 2; i <= cx + 2; i++) {
          if (i < 0 || i >= n) continue;
          for (const q of this.cells[j * n + i]) {
            if (q === p || q.h <= p.h || q.dormant) continue;
            const off = Math.min(12, (q.h - p.h) / tanE);
            const sx = q.x, sz = q.z - S.dirZ * off;
            const crq = canopyRadius(q);
            const d = Math.hypot(sx - p.x, sz - p.z), reach = cr + crq;
            if (d >= reach) continue;
            const overlap = Math.min(1, (reach - d) / (2 * Math.min(cr, crq))) * Math.min(1, (crq * crq) / (cr * cr));
            lit *= 1 - C.shadeOpacity * overlap;
          }
        }
      }
      p.shade = 1 - lit;
    }

    const births = [];
    for (const p of this.list) {
      p.age += dt;
      const S = W.sunAt(p.z);
      p.light = S.light;
      // dormancy with a little hysteresis; going dormant resorbs half the leaf matter
      if (!p.dormant && S.light < p.dormancy) {
        p.dormant = true;
        p.reserve += (p.L - C.minLeaf) * C.resorb;
        p.L = C.minLeaf;
      } else if (p.dormant && S.light > p.dormancy + 0.05) {
        p.dormant = false;
        const flush = p.reserve * C.springFlush;
        p.reserve -= flush;
        p.L += flush;
      }
      if (p.dormant) {
        p.reserve -= (C.baseCost + C.heightCost * p.h * 0.36) * C.dormantCost * dt;
        if (p.reserve < 0 || p.age > p.maxAge) p.dead = true;
        continue;
      }
      const cr = canopyRadius(p);
      const photo = C.photo * S.light * p.fert * Math.PI * cr * cr * (1 - p.shade);
      const maint = C.baseCost + C.leafCost * p.L + C.heightCost * p.h * cr;
      let net = (photo - maint) * dt;
      if (net > 0) {
        p.reserve = Math.min(C.reserveCap * (1 + p.h), p.reserve + net * p.aS);
        p.L += net * p.aL;
        p.h = Math.min(C.maxHeight, p.h + (net * p.aH) / (C.buildCost * (1 + p.bark * C.barkCost) * (1 + 0.1 * p.h)));
        p.seedStore += net * p.aR;
      } else {
        // leaves die back first, then the reserve is spent; out of both, the plant dies
        const fromLeaves = Math.min(-net, Math.max(0, p.L - C.minLeaf) * 0.5);
        p.L -= fromLeaves;
        net += fromLeaves;
        p.reserve += net;
      }
      if (p.reserve < 0 || p.age > p.maxAge) { p.dead = true; continue; }

      while (p.seedStore >= p.seedSize) {
        p.seedStore -= p.seedSize;
        const dist = (1 + p.dispersal * 7) * (0.6 + p.h / 3) * (0.3 + rng());
        const ang = rng() * Math.PI * 2;
        const x = p.x + Math.cos(ang) * dist, z = p.z + Math.sin(ang) * dist;
        if (x < 0.5 || z < 0.5 || x > W.size - 0.5 || z > W.size - 0.5) continue;
        const g = Float32Array.from(p.g);
        for (let k = 0; k < g.length; k++) {
          if (rng() < C.mutationRate) g[k] = Math.min(1, Math.max(0, g[k] + rng.gauss() * 0.1));
        }
        births.push([g, x, z, p.seedSize, p.generation + 1]);
      }
    }
    let w = 0;
    for (const p of this.list) { if (!p.dead) this.list[w++] = p; else this.died++; }
    this.list.length = w;
    for (const b of births) W.addSeed(...b);
  }

  // Agent `a` grazes plants near it. Returns energy eaten.
  graze(a, amount, i0, i1, j0, j1) {
    const C = P.plants, G = P.gravity;
    const n = this.n;
    let eaten = 0;
    const lo = a.y - a.hgt / 2, hi = a.y + a.hgt / 2 + G.reach;
    for (let j = Math.max(0, j0); j <= Math.min(n - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(n - 1, i1); i++) {
        for (const p of this.cells[j * n + i]) {
          if (eaten >= amount) return eaten;
          const dx = p.x - a.x, dz = p.z - a.z, d2 = dx * dx + dz * dz;
          const cr = canopyRadius(p), cd = canopyDepth(cr);
          const bottom = Math.max(0, p.h - cd);
          const want = Math.min(amount - eaten, a.maxEnergy - a.energy - eaten);
          if (want <= 0) return eaten;
          const V = C.foodValue; // animal energy per unit of plant matter
          if (d2 < (cr + a.r) ** 2 && hi >= bottom && lo <= p.h + 0.2) {
            // leaves within reach
            const amt = Math.min(want, (p.L - C.minLeaf) * V);
            if (amt > 0) { p.L -= amt / V; eaten += amt; }
          } else if (bottom > 0 && lo < bottom && d2 < (a.r + trunkWidth(p) + 0.15) ** 2) {
            // stem: bark makes it inedible
            const edible = 1 - p.bark;
            if (edible < 0.05) continue;
            const amt = Math.min(want, edible * amount);
            p.h = Math.max(0.1, p.h - amt / (V * C.buildCost));
            eaten += amt;
          }
        }
      }
    }
    return eaten;
  }
}
