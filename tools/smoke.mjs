// Headless smoke test: runs the simulation with random retina noise in place of
// rendered vision, to check the energy economy and step cost.
import { World } from '../src/world.js';
import { P } from '../src/params.js';
const layout = process.argv[2] || 'patches', steps = +(process.argv[3] || 3000);
const w = new World(layout, 1234);
const rw = P.retinaWidth, px = new Uint8Array(rw * (P.maxAgents + 64) * 4);
const t0 = performance.now();
for (let i = 0; i < steps; i++) {
  for (let j = 0; j < px.length; j++) px[j] = Math.random() < 0.1 ? 200 : 0;
  w.update(px, rw);
  if ((i + 1) % 500 === 0) {
    const h = w.history.at(-1);
    console.log(`t=${w.t} pop=${w.agents.length} food=${w.food.length} born=${w.stats.born} ga=${w.stats.ga} starved=${w.stats.starved} old=${w.stats.old} killed=${w.stats.killed} neurons=${h.neurons.toFixed(0)} syn=${h.synapses.toFixed(0)}`);
  }
}
console.log(`${((performance.now() - t0) / steps).toFixed(2)} ms/step`);
