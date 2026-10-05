# Polyworld

A browser re-creation of Larry Yaeger's **Polyworld** (1994), an artificial-life
simulation in which agents evolve brains, see with rendered vision, and learn
during their lifetimes. WebGL2 and plain ES modules, no build step.

**Live:** https://joyhughes.github.io/polyworld/

```sh
python3 serve.py   # then open http://localhost:8000 (no-cache, so edits show on reload)
```

## What is simulated

- **Vision.** Each step, every agent's point of view is rendered with WebGL into
  its own 32×1-pixel row of an offscreen framebuffer (32×8 in a 3D volume) (see *World size* below
  for how this is batched). All rows are read back in
  one call, and each agent's red, green and blue vision neurons average their part
  of that row. The *Vision* panel shows every agent's retina, one row each.
- **Genome.** A fixed-length genome of floats in [0,1] encodes size, strength, max
  speed, lifespan, mutation rate, crossover points, how much energy is donated to
  offspring, and a genetic green colour. It also encodes the brain's architecture:
  how many neurons are in each vision channel, 1–5 internal groups of excitatory
  and inhibitory neurons, a bias for each group, and, for each pair of groups,
  connection density, topological distortion and learning rate.
- **Brain.** Logistic neurons updated synchronously. The sign of each synapse is
  set by its source neuron. Weights learn by a Hebbian rule,
  `w += lr·(post−0.5)·(pre−0.5)`, clamped to their sign. Inputs are a random
  neuron, energy level and vision. Outputs are eat, mate, fight, speed, yaw,
  light (how bright the front face is) and focus (field of view), plus pitch
  in 3D volumes.
- **Behaviour and energy.** Everything costs energy: being alive, neurons,
  synapses, moving, turning, and each action. Agents eat food on contact.
  Fighting drains the agent it touches. Two agents that touch while both want to
  mate produce a child by crossover and mutation, funded by both parents' energy.
  Dead agents become food. An agent's colour is (fight, genetic green, mate), so
  intentions are visible to others.
- **Steady-state GA.** When the population falls below `minAgents`, new agents
  are bred from the fittest genomes on record (or created at random, 25% of the
  time). Once agents learn to forage and mate on their own, the top-ups stop.
  The grey line in the population chart shows this.

With the default parameters, natural reproduction typically takes over somewhere
between 15k and 25k steps. The population then climbs to the cap and food
becomes the limiting resource. All tunables are in `src/params.js`, including
the world layouts (patches, a divided world, foraging bands and an open field).

**3D volume** (the *Flat / 3D volume* selector) turns any layout into a tank
that agents swim through. It is 15 units deep at 100², scaling with world width.
What changes:
- **Vision:** each retina becomes 32×8 pixels. A `visionRows` gene splits each
  colour channel into 1–4 rows of neurons, and the floor is visible so agents
  can tell up from down.
- **Pitch:** a new *pitch* output turns the agent up or down, the same way *yaw*
  turns it left or right.
- **Contact and food:** eating, mating, fighting and collisions use 3D
  distance, and food floats at random depths.

Two findings shaped the design:
- **Pitch had to be a turning rate.** When the pitch output set the climb angle
  directly, random brains (which hold their outputs nearly constant) pinned
  themselves against the ceiling or floor. Nothing evolved in 40k steps. As a
  turning rate, a constant output makes agents loop and spiral through the
  volume.
- **Volumes need more of everything.** Search in 3D is much harder, so volumes
  get 3× the food and 2× the agent limits. With those settings, the steady-state
  GA stopped being needed at about 32k steps (versus 10–20k on the flat world).
  The population then held at 360–400 agents, with mean generation past 160 by
  60k steps.

Rendering is shared between the two modes. Every object carries a height and a
pitch, and each agent's view goes into its own block of the vision framebuffer,
packed into columns past the GPU's texture-height limit. Flat-world vision is
pixel-identical to before; 3D vision matches an independent per-agent render on
99.7% of pixels.

**3D with gravity** adds land, sky, evolving plants and a sun:

- **Agents crawl.** The eighth output becomes *lift*. On the ground, a strong
  lift signal is a jump. A *wings* gene, decoded cubed so it starts rare, turns
  lift into flapping thrust; with enough wing, an agent can beat gravity and
  fly. Wings cost energy every step, flapping more, and each jump has a cost.
- **Plants evolve.** Each plant has its own genome:
  - how it splits surplus energy between height, leaves, seeds and a winter
    reserve;
  - bark;
  - seed size;
  - seed dispersal.

  Plants photosynthesise in proportion to sunlit canopy area. Taller neighbours
  shade them, and shadows fall away from the sun, getting longer as it gets
  lower. When energy runs short, leaves die back first (deciduous behaviour
  emerges from that). A plant dies when its reserve runs out or it reaches its
  lifespan. Bark acts as woodiness: it costs extra to build height, makes the
  stem inedible, and lengthens life (soft herbs live about 0.4× as long, fully
  woody plants about 2.8×).
- **Grazing and fruit.** Agents eat leaves they can reach. Crawlers reach only
  low canopies; jumpers and fliers reach higher. Unprotected stems are edible
  too. Seeds fall to the ground as fruit and sprout after a delay unless
  eaten, so energy from tall canopies reaches the ground. Corpses become
  carrion. Each unit of plant matter is worth 5 energy to an animal.
- **Latitude** is a live slider. It sets the sun's path over a 6,000-step year:
  daily mean insolation (the standard formula, so polar night and midnight sun
  appear), noon sun elevation (shadow length), and the season shown in the HUD.
  The main view is lit from the sun, with the sky brightening and darkening
  through the year.

What happened in 60k-step runs on the patches layout (results vary from run to
run):

| | Equator (0°) | 45°N | 70°N |
|---|---|---|---|
| Agents | self-sustaining from about 15k steps; 70–116 agents; generation about 190 | near the self-sustaining threshold; often seasonal booms (about 200) and crashes (about 45) | never self-sustaining; polar night cuts off food every year |
| Plants | seeds got smaller (5.9 → 3.7) | seeds got smaller | seeds got bigger (7.5 → 9.1) |
| Bark | about 0.3 → 0.47 | about 0.3 → 0.47 | about 0.3 → 0.47 |
| Jumping | agents mostly stopped (1–11% airborne) | | |

Flight has not yet evolved at any latitude; wings tend to drift down, because
crawling and eating fruit pays better. Under grazing the forest thins toward
shrubland (mean height about 2 → 1), though tall trees persist.

**Indolent cannibals** is a layout that recreates the most famous accident in
Polyworld's history. In an early run, a dead agent became more food energy than
its parents had spent making it. Agents evolved to sit still, mate, and eat
their offspring's corpses. The preset has only a trickle of plant food, makes
corpses worth 150 × size, and makes moving 4× as costly. In testing, the
population took off around 20k steps and filled to its cap, eating 100% meat.
Average speed then collapsed from about 0.15 to 0.03 by 40k steps. Watch
*meat eaten* and *speed avg* in the stats panel.

**World size** can be set from 100² to 600². Layouts are drawn on a 100×100 map
and scaled up. Agent limits, food rates and food caps scale with area, so a
400² world holds up to 3,840 agents. Agents see as far as `visionRange` (60
units).

To keep vision affordable at large sizes, agents and food are bucketed into
grid cells `visionRange` wide. Each cell's agents are rendered together in a
few instanced draws, covering only the neighbouring cells. The vertex shader
works out which agent and object each instance is (object data comes from a
float texture). It squeezes each agent's projection into that agent's
framebuffer row, and fragments that land in other rows are discarded. The cost
grows roughly linearly with agent count. Measured on an M3 Max with a full
population: 3.5 ms/step at 100² (240 agents), 12 ms at 200² (960), 28 ms at
300² (2,160), 52 ms at 400² (3,840) and 126 ms at 600² (8,640). At large sizes,
brain updates and the GPU vision pass split the time about evenly.

## Controls

Drag to orbit, right-drag or shift-drag to pan, scroll to zoom. Click an agent
to inspect it. **Space** pauses, **N** selects the fittest agent alive, **F**
follows it, **E** shows the world through its eyes, and **B** opens the brain
viewer. The brain viewer is a draggable, resizable window with three tabs.
*Network* is a live wiring diagram: retina, energy and random inputs on the
left, internal groups in the middle (squares are inhibitory), outputs and their
thresholds on the right. Neurons glow with activation, and edges show either
weight × presynaptic activity (*signal*) or raw weights. Hover a neuron to
isolate its connections. *Activity* is a raster of every neuron over the last
400 steps. *Matrix* is the full weight matrix. The inspector shows the
agent's retina, vision neurons, outputs and its full synapse weight matrix.

`node tools/smoke.mjs [layout] [steps] [flat|volume|gravity] [latitude]` runs
the simulation headless, with noise in place of vision, to check that the code
runs and how fast. It is also enough to study plant dynamics.

`window.pw` exposes `world` and `run(n)` in the console for experiments.

## Layout

```
src/params.js   parameters and world layouts
src/genome.js   genome layout, decoding, mutation, crossover
src/brain.js    brain growth from genes, update and Hebbian learning
src/brainview.js  brain viewer: network diagram, activity raster, weight matrix
src/plants.js   evolving plants, shading, grazing, and the sun by latitude and season
src/world.js    agents, food, barriers, interactions, GA, statistics
src/gl.js       instanced-box renderer, per-agent vision pass, picking
src/main.js     UI, camera, charts, inspector
```
