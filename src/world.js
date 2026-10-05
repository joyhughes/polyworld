// Agents, food, barriers and the per-step simulation.

import { P, WORLDS } from './params.js';
import { makeRng } from './rng.js';
import { GENE, N_OUT, decode, randomGenome, mutate, crossover } from './genome.js';
import { Brain, OUT } from './brain.js';
import { Plants } from './plants.js';

const DEG = Math.PI / 180;
const CELL = 5;

let nextId = 1;

export class Agent {
  // y is the eye/body-centre height: fixed at eye level on the flat world.
  constructor(genome, x, y, z, yaw, energy, rng, generation = 0, dims = 2, gravity = false) {
    this.id = nextId++;
    this.genome = genome;
    const d = (this.traits = decode(genome));
    this.dims = dims;
    this.gravity = gravity;
    this.vy = 0;
    this.jumps = 0;
    this.brain = new Brain(genome, d, rng, dims, gravity);
    this.x = x;
    this.y = dims === 3 ? y : P.eyeHeight;
    this.z = z;
    this.yaw = yaw;
    this.pitch = 0;
    this.size = d.size;
    this.r = 0.6 * d.size;
    this.len = 1.2 * d.size;
    this.wid = 0.8 * d.size;
    this.hgt = 0.6 + 0.3 * d.size;
    this.maxEnergy = P.maxEnergyPerSize * d.size;
    this.energy = Math.min(energy, this.maxEnergy);
    this.generation = generation;
    this.age = 0;
    this.eaten = 0;
    this.offspring = 0;
    this.kills = 0;
    this.mateWait = P.mateWait;
    this.attackedAt = -1;
    this.speed = 0;
    this.fov = 60 * DEG;
    this.out = new Float32Array(N_OUT).fill(0.5);
    this.dead = null;
  }

  // Load the retina block (rw x rh pixels, agent i's block at i * rw * rh * 4)
  // and internal state into the input neurons, then step. Each vision neuron
  // averages one colour channel over its cell of a cols x rows grid.
  think(pixels, i, rw, rh, rng) {
    const b = this.brain, s = b.state, base = i * rw * rh * 4;
    s[0] = rng();
    s[1] = this.energy / this.maxEnergy;
    const rows = b.visRows;
    for (let c = 0; c < 3; c++) {
      const start = b.starts[2 + c], cols = b.visCols[c];
      for (let k = 0; k < cols * rows; k++) {
        const kx = k % cols, ky = (k / cols) | 0;
        const x0 = Math.floor((kx * rw) / cols), x1 = Math.floor(((kx + 1) * rw) / cols);
        const y0 = Math.floor((ky * rh) / rows), y1 = Math.floor(((ky + 1) * rh) / rows);
        let sum = 0;
        for (let y = y0; y < y1; y++) {
          const line = base + y * rw * 4;
          for (let x = x0; x < x1; x++) sum += pixels[line + x * 4 + c];
        }
        s[start + k] = sum / ((x1 - x0) * (y1 - y0) * 255);
      }
    }
    b.step();
    for (let o = 0; o < N_OUT; o++) this.out[o] = b.output(o);
  }

  act(world) {
    const o = this.out, t = this.traits, c = P.cost;
    const turn = (o[OUT.yaw] - 0.5) * 2;
    this.yaw += turn * P.maxTurn;
    this.speed = o[OUT.speed] * t.maxSpeed;
    this.fov = (P.fovMin + (P.fovMax - P.fovMin) * o[OUT.focus]) * DEG;

    let horiz = this.speed, extra = 0;
    if (this.gravity) {
      // crawl on the ground, jump with a strong lift signal, and fly if wings
      // give enough thrust to beat gravity
      const lift = o[OUT.pitch], wings = t.wings, G = P.gravity;
      const grounded = this.y <= this.r + 1e-3;
      if (grounded) {
        this.vy = 0;
        if (lift > G.jumpThreshold) { this.vy = G.jump; extra += c.jump * this.size; this.jumps++; }
      }
      if (!grounded || this.vy > 0) {
        this.vy = (this.vy - G.g + lift * wings * G.maxLift) * G.drag;
        extra += c.flap * lift * wings * this.size;
      }
      this.y += this.vy;
      if (this.y <= this.r) { this.y = this.r; this.vy = 0; }
      if (this.y >= world.height - this.r) { this.y = world.height - this.r; this.vy = Math.min(0, this.vy); }
      // look a little toward the direction of travel when airborne
      this.pitch = Math.max(-0.5, Math.min(0.5, 0.5 * Math.atan2(this.vy, Math.max(0.05, this.speed))));
      extra += c.wings * wings * this.size;
    } else if (this.dims === 3) {
      // pitch is a turning rate like yaw, so a constant output loops through the
      // volume rather than pinning the agent against the floor or ceiling
      this.pitch += (o[OUT.pitch] - 0.5) * 2 * P.maxPitchRate;
      this.pitch = Math.atan2(Math.sin(this.pitch), Math.cos(this.pitch));
      horiz = this.speed * Math.cos(this.pitch);
      const ny = this.y + this.speed * Math.sin(this.pitch);
      this.y = Math.min(world.height - this.r, Math.max(this.r, ny));
    }
    const nx = this.x + Math.cos(this.yaw) * horiz;
    const nz = this.z + Math.sin(this.yaw) * horiz;
    if (!world.blocked(nx, nz, this.r)) {
      this.x = nx;
      this.z = nz;
    } else if (!world.blocked(nx, this.z, this.r)) {
      this.x = nx;
    } else if (!world.blocked(this.x, nz, this.r)) {
      this.z = nz;
    }

    const b = this.brain;
    let cost = c.base * this.size
      + c.neuron * b.numNeurons
      + c.synapse * b.numSynapses
      + world.moveCost * this.speed * this.size
      + c.turn * Math.abs(turn)
      + c.eat * o[OUT.eat]
      + c.mate * o[OUT.mate]
      + c.light * o[OUT.light]
      + extra;
    if (o[OUT.fight] > P.fightThreshold) cost += c.fight * o[OUT.fight] * t.strength;
    this.energy -= cost;
    this.age++;
    if (this.mateWait > 0) this.mateWait--;
  }

  fitness() {
    const f = P.fit;
    return f.eat * this.eaten / this.maxEnergy
      + f.mate * this.offspring
      + f.age * this.age / this.traits.lifespan
      + f.energy * Math.max(0, this.energy) / this.maxEnergy;
  }

  color() {
    return [this.out[OUT.fight], this.traits.green, this.out[OUT.mate]];
  }
}

export class World {
  // dims: 2 for Polyworld's flat world, 3 for a volume agents swim through.
  constructor(layout = 'patches', seed = (Math.random() * 2 ** 32) >>> 0, size = P.worldSize, dims = 2, gravity = false) {
    this.seed = seed;
    this.rng = makeRng(seed);
    this.layoutKey = layout;
    const L = WORLDS[layout];
    // Layouts are drawn on a 100x100 world; larger worlds scale coordinates
    // linearly and populations, food rates and caps by area.
    this.size = size;
    this.gravity = gravity && dims === 3;
    this.dims = dims;
    this.latitude = P.gravity.latitude;
    const k = size / 100, area = k * k;
    this.height = this.gravity ? P.gravity.height * k : dims === 3 ? P.volumeHeight * k : 0;
    const volume = dims === 3 && !this.gravity;
    const foodScale = volume ? P.volumeFoodScale : 1;
    const agentScale = volume ? P.volumeAgentScale : 1;
    this.minAgents = Math.round(P.minAgents * area * agentScale);
    this.maxAgents = Math.round(P.maxAgents * area * agentScale);
    this.maxFood = Math.round(P.food.maxTotal * area * (this.gravity ? P.plants.foodScale : foodScale));
    this.corpseEnergy = L.corpseEnergy ?? P.corpseEnergy;
    this.moveCost = P.cost.move * (L.moveCostScale ?? 1);
    this.patches = L.patches.map((p) => ({
      rect: p.rect.map((v) => v * k), rate: p.rate * area * foodScale, max: Math.round(p.max * area * foodScale), count: 0, acc: 0,
    }));
    this.barriers = L.barriers.map((b) => {
      const [x0, z0, x1, z1] = b.map((v) => v * k);
      return { x0, z0, x1, z1, thick: 0.6, height: 2.5 };
    });
    this.agents = [];
    this.food = [];
    this.elites = [];
    this.t = 0;
    this.stats = { born: 0, ga: 0, starved: 0, old: 0, killed: 0, plant: 0, meat: 0 };
    this.interval = { born: 0, ga: 0, deaths: 0 };
    this.history = [];
    this.historyEvery = 50;

    this.ncell = Math.ceil(this.size / CELL);
    this.agentCells = Array.from({ length: this.ncell * this.ncell }, () => []);
    this.foodCells = Array.from({ length: this.ncell * this.ncell }, () => []);

    if (this.gravity) {
      // food grows as evolving plants; the layout's patches are fertile ground
      this.plants = new Plants(this);
      this.plants.seedInitial();
    } else {
      for (const p of this.patches) {
        while (p.count < p.max / 2) this.spawnFood(p);
      }
    }
    for (let i = 0; i < Math.round(P.initAgents * area * agentScale); i++) this.agents.push(this.makeGAAgent(true));
  }

  // --- geometry -----------------------------------------------------------

  blocked(x, z, r) {
    if (x < r || z < r || x > this.size - r || z > this.size - r) return true;
    for (const b of this.barriers) {
      const dx = b.x1 - b.x0, dz = b.z1 - b.z0;
      const L2 = dx * dx + dz * dz;
      let u = L2 ? ((x - b.x0) * dx + (z - b.z0) * dz) / L2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const ex = b.x0 + u * dx - x, ez = b.z0 + u * dz - z;
      const lim = r + b.thick / 2;
      if (ex * ex + ez * ez < lim * lim) return true;
    }
    return false;
  }

  randomFreeSpot(r, rect) {
    const [x0, z0, x1, z1] = rect || [0, 0, this.size, this.size];
    for (let i = 0; i < 50; i++) {
      const x = x0 + this.rng() * (x1 - x0), z = z0 + this.rng() * (z1 - z0);
      if (!this.blocked(x, z, r)) return [x, z];
    }
    return [this.size / 2, this.size / 2];
  }

  // Random height within the volume (eye level on the flat world).
  randomHeight(r) {
    if (this.gravity) return r;
    return this.dims === 3 ? r + this.rng() * (this.height - 2 * r) : P.eyeHeight;
  }

  // --- food ---------------------------------------------------------------

  spawnFood(patch) {
    const pi = this.patches.indexOf(patch);
    const [x, z] = this.randomFreeSpot(0.6, patch.rect);
    const f = P.food;
    this.food.push({ x, y: this.randomHeight(0.6), z, energy: f.minEnergy + this.rng() * (f.maxEnergy - f.minEnergy), patch: pi });
    patch.count++;
  }

  // A seed lies on the ground as edible fruit, then tries to sprout.
  addSeed(g, x, z, energy, generation) {
    if (this.food.length >= this.maxFood) return;
    const C = P.plants;
    // fruit holds foodValue x the seed's energy for animals; a sprout gets the seed's energy
    this.food.push({ x, y: 0.15, z, energy: energy * C.foodValue, seedEnergy: energy, patch: -2, g, generation,
      germinate: this.t + C.germinateAfter * (0.5 + this.rng()), rot: this.t + C.seedLife });
  }

  static foodHalf(f) {
    // fruit is sized by the seed inside it, not its food value
    if (f.patch === -2) return 0.1 + 0.02 * f.seedEnergy;
    return 0.25 + 0.45 * Math.sqrt(Math.min(1, f.energy / P.food.maxEnergy));
  }

  // --- agents -------------------------------------------------------------

  makeGAAgent(initial = false) {
    const rng = this.rng;
    let genome, gen = 0;
    if (!initial && this.elites.length >= 2 && rng() >= P.randomFraction) {
      const a = this.elites[rng.int(this.elites.length)];
      let b = this.elites[rng.int(this.elites.length)];
      if (b === a) b = this.elites[(this.elites.indexOf(a) + 1) % this.elites.length];
      const pts = decode(a.genome).crossoverPoints;
      genome = crossover(a.genome, b.genome, pts, rng);
      mutate(genome, decode(genome).mutationRate, rng);
      gen = Math.max(a.generation, b.generation) + 1;
    } else {
      genome = randomGenome(rng);
    }
    const size = P.size[0] + (P.size[1] - P.size[0]) * genome[GENE.size];
    const [x, z] = this.randomFreeSpot(0.6 * size);
    const energy = P.maxEnergyPerSize * size * P.initEnergyFrac;
    return new Agent(genome, x, this.randomHeight(0.6 * size), z, rng() * Math.PI * 2, energy, rng, gen, this.dims, this.gravity);
  }

  recordElite(a) {
    const fit = a.fitness();
    const E = this.elites;
    if (E.length >= P.elites && fit <= E[E.length - 1].fitness) return;
    E.push({ fitness: fit, genome: a.genome, generation: a.generation, id: a.id });
    E.sort((p, q) => q.fitness - p.fitness);
    if (E.length > P.elites) E.length = P.elites;
  }

  mate(a, b, births) {
    const ea = a.energy * a.traits.mateEnergy, eb = b.energy * b.traits.mateEnergy;
    if (ea + eb < P.minOffspringEnergy) return;
    const rng = this.rng;
    const pts = rng() < 0.5 ? a.traits.crossoverPoints : b.traits.crossoverPoints;
    const genome = crossover(a.genome, b.genome, pts, rng);
    mutate(genome, (a.traits.mutationRate + b.traits.mutationRate) / 2, rng);
    let x = (a.x + b.x) / 2, z = (a.z + b.z) / 2;
    if (this.blocked(x, z, 0.6)) { x = a.x; z = a.z; }
    a.energy -= ea;
    b.energy -= eb;
    a.mateWait = b.mateWait = P.mateWait;
    a.offspring++;
    b.offspring++;
    const child = new Agent(genome, x, (a.y + b.y) / 2, z, rng() * Math.PI * 2, ea + eb, rng,
      Math.max(a.generation, b.generation) + 1, this.dims, this.gravity);
    child.parents = [a.id, b.id];
    births.push(child);
  }

  buildGrid() {
    const n = this.ncell, inv = 1 / CELL;
    for (const c of this.agentCells) c.length = 0;
    for (const c of this.foodCells) c.length = 0;
    const cellOf = (x, z) => {
      const cx = Math.min(n - 1, Math.max(0, Math.floor(x * inv)));
      const cz = Math.min(n - 1, Math.max(0, Math.floor(z * inv)));
      return cz * n + cx;
    };
    for (const a of this.agents) this.agentCells[cellOf(a.x, a.z)].push(a);
    if (this.plants) this.plants.buildGrid();
    for (const f of this.food) this.foodCells[cellOf(f.x, f.z)].push(f);
  }

  interact(births) {
    const n = this.ncell, inv = 1 / CELL, vol = this.dims === 3;
    for (const a of this.agents) {
      const cx = Math.floor(a.x * inv), cz = Math.floor(a.z * inv);
      const eat = a.out[OUT.eat], fight = a.out[OUT.fight], mate = a.out[OUT.mate];
      if (this.plants && eat > P.eatThreshold) {
        // plants share the 5-unit grid
        const amt = this.plants.graze(a, P.eatRate * eat, cx - 1, cx + 1, cz - 1, cz + 1);
        a.energy += amt;
        a.eaten += amt;
        this.stats.plant += amt;
      }
      for (let j = cz - 1; j <= cz + 1; j++) {
        if (j < 0 || j >= n) continue;
        for (let i = cx - 1; i <= cx + 1; i++) {
          if (i < 0 || i >= n) continue;
          const cell = j * n + i;

          if (eat > P.eatThreshold) {
            for (const f of this.foodCells[cell]) {
              if (f.energy <= 0) continue;
              const lim = a.r + World.foodHalf(f);
              const dx = f.x - a.x, dz = f.z - a.z, dy = vol ? f.y - a.y : 0;
              if (dx * dx + dy * dy + dz * dz > lim * lim) continue;
              const amt = Math.min(f.energy, P.eatRate * eat, a.maxEnergy - a.energy);
              if (amt <= 0) continue;
              f.energy -= amt;
              a.energy += amt;
              a.eaten += amt;
              if (f.patch === -1) this.stats.meat += amt; else this.stats.plant += amt;
            }
          }

          for (const b of this.agentCells[cell]) {
            if (b === a) continue;
            const dx = b.x - a.x, dz = b.z - a.z, dy = vol ? b.y - a.y : 0;
            const lim = a.r + b.r, d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > lim * lim) continue;

            if (a.id < b.id) {
              // soft separation so bodies don't pile up
              const d = Math.sqrt(d2) || 1e-3, push = (lim - d) * 0.25;
              const px = (dx / d) * push, pz = (dz / d) * push;
              if (vol) {
                const py = (dy / d) * push;
                a.y = Math.min(this.height - a.r, Math.max(a.r, a.y - py));
                b.y = Math.min(this.height - b.r, Math.max(b.r, b.y + py));
              }
              if (!this.blocked(a.x - px, a.z - pz, a.r)) { a.x -= px; a.z -= pz; }
              if (!this.blocked(b.x + px, b.z + pz, b.r)) { b.x += px; b.z += pz; }

              if (mate > P.mateThreshold && b.out[OUT.mate] > P.mateThreshold
                && a.mateWait === 0 && b.mateWait === 0
                && this.agents.length + births.length < this.maxAgents) {
                this.mate(a, b, births);
              }
            }

            if (fight > P.fightThreshold && b.energy > 0) {
              b.energy -= P.fightDamage * fight * a.traits.strength * a.size;
              b.attackedAt = this.t;
              if (b.energy <= 0) a.kills++;
            }
          }
        }
      }
    }
  }

  // One simulation step. `pixels` holds one rw x rh retina block per agent, in agent order.
  update(pixels, rw, rh = 1) {
    const A = this.agents, rng = this.rng;
    for (let i = 0; i < A.length; i++) A[i].think(pixels, i, rw, rh, rng);
    for (const a of A) a.act(this);

    this.buildGrid();
    const births = [];
    this.interact(births);

    // deaths
    const alive = [];
    for (const a of A) {
      let cause = null;
      if (a.energy <= 0) cause = a.attackedAt >= this.t - 1 ? 'killed' : 'starved';
      else if (a.age >= a.traits.lifespan) cause = 'old';
      if (!cause) { alive.push(a); continue; }
      a.dead = cause;
      this.stats[cause]++;
      this.interval.deaths++;
      this.recordElite(a);
      if (this.food.length < this.maxFood) {
        this.food.push({ x: a.x, y: this.gravity ? 0.3 : a.y, z: a.z, energy: this.corpseEnergy * a.size, patch: -1 });
      }
    }
    for (const c of births) alive.push(c);
    this.stats.born += births.length;
    this.interval.born += births.length;
    this.agents = alive;

    // seeds sprout into plants, or rot
    if (this.plants) {
      for (const f of this.food) {
        if (f.patch !== -2 || f.energy <= 0.5) continue;
        if (this.t >= f.germinate && this.plants.add(f.g, f.x, f.z, f.seedEnergy, f.generation)) f.energy = 0;
        else if (this.t >= f.rot) f.energy = 0;
      }
    }

    // eaten food
    let w = 0;
    for (const f of this.food) {
      if (f.energy > 0.5) this.food[w++] = f;
      else if (f.patch >= 0) this.patches[f.patch].count--;
    }
    this.food.length = w;

    if (this.plants && this.t % P.plants.updateEvery === 0) this.plants.update(P.plants.updateEvery);

    // food growth
    for (const p of this.gravity ? [] : this.patches) {
      p.acc += p.rate;
      while (p.acc >= 1) {
        p.acc -= 1;
        if (p.count < p.max && this.food.length < this.maxFood) this.spawnFood(p);
      }
    }

    // steady-state GA keeps the population from collapsing
    while (this.agents.length < this.minAgents) {
      this.agents.push(this.makeGAAgent());
      this.stats.ga++;
      this.interval.ga++;
    }

    this.t++;
    if (this.t % this.historyEvery === 0) this.sample();
  }

  plantStats() {
    const L = this.plants.list, A = this.agents;
    let h = 0, hmax = 0, bark = 0, wings = 0, air = 0;
    for (const p of L) { h += p.h; hmax = Math.max(hmax, p.h); bark += p.bark; }
    for (const a of A) { wings += a.traits.wings; if (a.y > a.r + 0.3) air++; }
    const np = L.length || 1, na = A.length || 1;
    return { plants: L.length, treeH: h / np, treeMax: hmax, bark: bark / np, wings: wings / na, airborne: air / na };
  }

  sample() {
    const A = this.agents;
    let neurons = 0, syn = 0, gen = 0, fit = 0;
    for (const a of A) {
      neurons += a.brain.numNeurons;
      syn += a.brain.numSynapses;
      gen += a.generation;
      fit += a.fitness();
    }
    const n = A.length || 1;
    this.history.push({
      t: this.t,
      pop: A.length,
      food: this.food.length,
      born: this.interval.born,
      ga: this.interval.ga,
      deaths: this.interval.deaths,
      neurons: neurons / n,
      synapses: syn / n,
      generation: gen / n,
      fitness: fit / n,
      ...(this.plants ? this.plantStats() : {}),
    });
    this.interval = { born: 0, ga: 0, deaths: 0 };
    if (this.history.length > 800) {
      // halve resolution, keep the whole run
      this.history = this.history.filter((_, i) => i % 2 === 1);
      this.historyEvery *= 2;
    }
  }
}
