// A/B of the prediction learner: the same mock scenarios with `dodge` off and on.   DIEP_SCRIPT=work/next.user.js node test/ab.mjs
import { scenario, browser, server } from './run.mjs';
const script = process.env.DIEP_SCRIPT;
const rows = [];
for (const dodge of [false, true]) for (const [pattern, move] of [['strafe', 'stand'], ['periodic', 'stand'], ['linear', 'stand']]) {
  rows.push(scenario({ label: dodge ? 'dodge' : 'off', script, pattern, move, fire: 'mouse', cfg: { aim: true, autoFire: false, dodge }, secs: 12, warm: 4 }));
}
const out = []; for (let i = 0; i < rows.length; i += 2) out.push(...(await Promise.all(rows.slice(i, i + 2))));
for (const r of out) console.log(r.label.padEnd(6), r.pattern.padEnd(9), 'shots', r.fired, 'hits', r.hits, r.hitPct + '%', 'jitter', r.jitter);
await browser.close(); server.close();
