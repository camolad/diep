// node bench/run.mjs [--pred baseline,foo] [--seeds 16] [--noise clean|mild|rough] [--duration 40] [--held-out] [--behaviors a,b]
import { runEpisode } from './sim.mjs';
import { BEHAVIORS, HELD_OUT } from './behaviors.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const preds = opt('pred', 'baseline').split(',');
const seeds = +opt('seeds', 16), noise = opt('noise', 'mild'), duration = +opt('duration', 40);
const seedBase = +opt('seed-base', 1);
const behaviors = opt('behaviors', null) ? opt('behaviors').split(',') : args.includes('--held-out') ? HELD_OUT : BEHAVIORS;
const quiet = args.includes('--quiet');

const factories = {};
for (const p of preds) {
  const file = p.includes('/') || p.endsWith('.mjs') ? path.resolve(p) : path.join(here, 'predictors', p + '.mjs');
  factories[p] = (await import(pathToFileURL(file).href)).createPredictor;
}
const table = {};
for (const p of preds) {
  table[p] = {};
  for (const b of behaviors) {
    let shots = 0, hits = 0, err = 0, en = 0;
    for (let s = 0; s < seeds; s++) {
      const r = runEpisode({ kind: b, makePredictor: factories[p], seed: seedBase + s, duration, noise });
      shots += r.shots; hits += r.hits; if (r.err06 !== null) { err += r.err06; en++; }
    }
    table[p][b] = { hit: shots ? hits / shots : 0, err: en ? err / en : 0, shots };
  }
}
const pad = (s, n) => String(s).padEnd(n);
if (!quiet) {
  console.log(`noise=${noise} seeds=${seeds} duration=${duration}s`);
  console.log(pad('behavior', 20) + preds.map((p) => pad(p, 18)).join(''));
  for (const b of behaviors) console.log(pad(b, 20) + preds.map((p) => pad((100 * table[p][b].hit).toFixed(1) + '%  err ' + table[p][b].err.toFixed(0), 18)).join(''));
}
const mean = (p) => behaviors.reduce((a, b) => a + table[p][b].hit, 0) / behaviors.length;
console.log(pad('MEAN hit%', 20) + preds.map((p) => pad((100 * mean(p)).toFixed(1) + '%', 18)).join(''));
