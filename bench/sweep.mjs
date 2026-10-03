// Hit rate of one predictor over every behaviour: node bench/sweep.mjs <predictor> [clean|mild|rough] [seeds] [seed-base]
import { runEpisode } from './sim.mjs';
import { BEHAVIORS, HELD_OUT } from './behaviors.mjs';
const name = process.argv[2], noise = process.argv[3] || 'mild', seeds = +process.argv[4] || 16, base = +process.argv[5] || 1;
const { createPredictor } = await import(`./predictors/${name}.mjs`);
let tot = 0, n = 0; const out = [];
for (const k of [...BEHAVIORS, ...HELD_OUT]) {
  let sh = 0, h = 0;
  for (let s = 0; s < seeds; s++) { const r = runEpisode({ kind: k, makePredictor: (o) => createPredictor(o), seed: base + s, duration: 40, noise }); sh += r.shots; h += r.hits; }
  out.push(k + ' ' + (100 * h / sh).toFixed(1)); tot += h / sh; n++;
}
console.log(name.padEnd(9), noise.padEnd(6), 'base', base, '|', out.join(' | '), '| MEAN', (100 * tot / n).toFixed(2));
