# Polyworld

A browser re-creation of Larry Yaeger's **Polyworld** (1994), an artificial-life
simulation in which agents evolve brains, see with rendered vision, and learn
during their lifetimes. WebGL2 and plain ES modules, no build step.

```sh
python3 serve.py   # then open http://localhost:8000 (no-cache, so edits show on reload)
```

## What is simulated

- **Vision.** Each step, every agent's point of view is rendered with WebGL into
  its own 1×32-pixel row of an offscreen framebuffer (see *World size* below
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
  light (how bright the front face is) and focus (field of view).
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
follows it, and **E** shows the world through its eyes. The inspector shows the
agent's retina, vision neurons, outputs and its full synapse weight matrix.

`node tools/smoke.mjs [layout] [steps]` runs the simulation headless, with noise
in place of vision, to check that the code runs and how fast.

`window.pw` exposes `world` and `run(n)` in the console for experiments.

## Layout

```
src/params.js   parameters and world layouts
src/genome.js   genome layout, decoding, mutation, crossover
src/brain.js    brain growth from genes, update and Hebbian learning
src/world.js    agents, food, barriers, interactions, GA, statistics
src/gl.js       instanced-box renderer, per-agent vision pass, picking
src/main.js     UI, camera, charts, inspector
```
