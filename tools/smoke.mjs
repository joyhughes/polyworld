// Headless smoke test: runs the simulation with random retina noise in place of
// rendered vision, to check the energy economy, plant dynamics and step cost.
// usage: node tools/smoke.mjs [layout] [steps] [flat|volume|gravity] [latitude]
import { World } from '../src/world.js';
import { P } from '../src/params.js';
const layout = process.argv[2] || 'patches', steps = +(process.argv[3] || 3000), mode = process.argv[4] || 'flat';
const w = new World(layout, 1234, 100, mode === 'flat' ? 2 : 3, mode === 'gravity');
if (process.argv[5]) w.latitude = +process.argv[5];
const rw = P.retinaWidth, rh = mode === 'flat' ? 1 : P.retinaHeight3D;
const px = new Uint8Array(rw * rh * (w.maxAgents + 64) * 4);
const t0 = performance.now();
for (let i = 0; i < steps; i++) {
  if (px.length < w.agents.length * rw * rh * 4) continue;
  for (let j = 0; j < w.agents.length * rw * rh * 4; j++) px[j] = Math.random() < 0.1 ? 200 : 0;
  w.update(px, rw, rh);
  if ((i + 1) % Math.max(500, steps / 12) === 0) {
    const h = w.history.at(-1) || {};
    const plants = w.plants ? ` plants=${h.plants} treeH=${h.treeH?.toFixed(2)} max=${h.treeMax?.toFixed(1)} bark=${h.bark?.toFixed(2)} wings=${h.wings?.toFixed(3)} air=${(100 * (h.airborne || 0)).toFixed(0)}%` : ` food=${w.food.length}`;
    console.log(`t=${w.t} pop=${w.agents.length} born=${w.stats.born} ga=${w.stats.ga} starved=${w.stats.starved} plantEaten=${w.stats.plant.toFixed(0)}${plants}`);
  }
}
console.log(`${((performance.now() - t0) / steps).toFixed(2)} ms/step`);
