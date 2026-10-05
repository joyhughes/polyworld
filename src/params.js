// Global simulation parameters. Units: world distance units, simulation steps.

export const P = {
  worldSize: 100,
  initAgents: 90,
  minAgents: 40,          // steady-state GA tops the population up to this
  maxAgents: 240,         // births are suppressed above this

  // vision
  retinaWidth: 32,        // pixels rendered per agent per step
  eyeHeight: 0.45,        // every object is taller than this, so the horizon ray sees them
  near: 0.05,
  visionRange: 60,        // agents see this far; also the vision culling cell size
  fovMin: 25,             // degrees; the focus output interpolates between these
  fovMax: 120,

  // motion
  maxTurn: 0.12,          // radians per step at full yaw output

  // 3D volume worlds: agents swim through a volume instead of walking a plane
  volumeHeight: 15,       // at world size 100; scales with world width
  maxPitchRate: 0.12,     // radians per step at full pitch output (pitch turns like yaw)
  retinaHeight3D: 8,      // retina rows rendered per agent in 3D
  retinaVAspect: 0.5,     // tan(vertical fov) / tan(horizontal fov)
  volumeFoodScale: 3,     // extra food in volumes, which are sparser to search
  volumeAgentScale: 2,    // more agents in volumes, so mates can find each other

  // gravity worlds: agents crawl, jump, and can evolve flight; plants evolve
  gravity: {
    height: 20,           // sky ceiling at world size 100
    g: 0.012,             // downward acceleration per step
    jump: 0.22,           // upward speed of a jump
    jumpThreshold: 0.75,  // lift output needed to jump from the ground
    maxLift: 0.026,       // upward acceleration at full lift output with full wings
    drag: 0.97,           // vertical velocity kept per step in the air
    reach: 0.6,           // how far above its body an agent can graze
    latitude: 45,         // default; the UI slider changes it live
  },
  plants: {
    yearLength: 6000,     // steps per year (seasons)
    initPer100: 350,      // starting plants per 100x100
    maxPer100: 1100,      // plant cap per 100x100
    baseFertility: 0.55,  // growth multiplier outside the layout's patches (1 inside)
    photo: 0.012,         // energy per step per unit of sunlit canopy area at full sun
    baseCost: 0.002,      // maintenance per plant per step, so deep shade is fatal
    leafCost: 0.0009,     // maintenance per unit leaf per step
    heightCost: 0.00025,  // maintenance per unit height per unit canopy radius per step
    buildCost: 1.0,       // energy per unit of height grown
    barkCost: 1.5,        // bark multiplies height build cost by (1 + bark * this)
    reserveCap: 6,        // reserve capacity, times (1 + height)
    minLeaf: 0.1,         // leaves never drop below a bud
    maxCanopy: 2.6,
    maxHeight: 14,
    maxAge: 10000,        // lifespan in steps for bark 0.25; woody plants live longer (see plants.js)
    shadeOpacity: 0.85,   // fraction of light a fully overlapping canopy blocks
    mutationRate: 0.3,    // per gene, per seed
    updateEvery: 5,       // plants advance every this many steps
    germinateAfter: 300,  // seeds lie on the ground as edible fruit this long before sprouting
    seedLife: 1500,       // seeds that cannot sprout rot after this long
    foodScale: 4,         // food cap multiplier in gravity worlds (fruit + carrion)
    foodValue: 5,         // animal energy per unit of plant matter (leaf, stem or fruit)
  },

  // genetic ranges (genes are 0..1, decoded into these)
  lifespan: [1200, 4000],
  size: [0.7, 1.5],
  strength: [0.5, 1.5],
  maxSpeed: [0.08, 0.3],
  mateEnergy: [0.2, 0.7], // fraction of own energy donated to an offspring
  mutationRate: [0.002, 0.1],

  // brain
  maxBias: 1.0,
  maxLR: 0.08,
  initMaxWeight: 0.5,
  maxWeight: 1.0,
  logisticGain: 1.0,

  // energy
  maxEnergyPerSize: 200,
  initEnergyFrac: 0.75,
  cost: {
    base: 0.01,       // per step, times size
    neuron: 0.0004,   // per neuron per step
    synapse: 0.00003, // per synapse per step
    move: 0.3,        // times speed * size
    turn: 0.02,       // times |turn output|
    eat: 0.01,
    mate: 0.02,
    fight: 0.12,      // times strength
    light: 0.01,
    wings: 0.015,     // per step, times wings * size (gravity worlds)
    flap: 0.05,       // per airborne step, times lift * wings * size
    jump: 0.3,        // per jump, times size
  },
  eatThreshold: 0.3,
  mateThreshold: 0.6,
  fightThreshold: 0.6,
  eatRate: 3,             // energy per step at full eat output
  fightDamage: 0.8,       // energy per step at full fight * strength * size
  mateWait: 60,           // steps between matings
  minOffspringEnergy: 30,
  corpseEnergy: 40,       // times size

  food: { minEnergy: 20, maxEnergy: 60, maxTotal: 450 },

  // fitness used to rank genomes for the steady-state GA
  fit: { eat: 1.0, mate: 2.0, age: 0.5, energy: 0.5 },
  elites: 30,
  randomFraction: 0.25,   // chance a GA top-up agent is random rather than bred from elites
};

// World layouts. Patches are rectangles [x0, z0, x1, z1] with a spawn rate
// (food items per step) and a cap; barriers are wall segments.
export const WORLDS = {
  patches: {
    name: 'Three patches',
    patches: [
      { rect: [0, 0, 100, 100], rate: 0.12, max: 60 },
      { rect: [12, 12, 38, 38], rate: 0.25, max: 90 },
      { rect: [62, 15, 88, 41], rate: 0.25, max: 90 },
      { rect: [35, 62, 65, 88], rate: 0.25, max: 90 },
    ],
    barriers: [],
  },
  wall: {
    name: 'Divided world',
    patches: [
      { rect: [8, 20, 40, 80], rate: 0.35, max: 140 },
      { rect: [60, 20, 92, 80], rate: 0.35, max: 140 },
    ],
    barriers: [
      [50, 0, 50, 42],
      [50, 58, 50, 100],
    ],
  },
  bands: {
    name: 'Foraging bands',
    patches: [
      { rect: [5, 10, 95, 22], rate: 0.25, max: 100 },
      { rect: [5, 44, 95, 56], rate: 0.25, max: 100 },
      { rect: [5, 78, 95, 90], rate: 0.25, max: 100 },
    ],
    barriers: [
      [20, 33, 80, 33],
      [20, 67, 80, 67],
    ],
  },
  // Yaeger's "indolent cannibals": in an early Polyworld run, a dead agent
  // became more food energy than its parents spent making it. Agents evolved to
  // sit still, mate, and eat their offspring's corpses. Here plant food is a
  // trickle, and a corpse is worth several times the energy of a newborn.
  cannibals: {
    name: 'Indolent cannibals',
    patches: [{ rect: [30, 30, 70, 70], rate: 0.08, max: 30 }],
    barriers: [],
    corpseEnergy: 150,
    moveCostScale: 4,   // with offspring born beside their parents, there's no reason to move
  },
  open: {
    name: 'Open field',
    patches: [{ rect: [0, 0, 100, 100], rate: 0.7, max: 320 }],
    barriers: [],
  },
};
