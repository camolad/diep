// How much does the AIM DIRECTION wobble when the observations are noisy / hitching? (steady targets, so ideal wobble = 0)
import { PHYS, solveAim } from '../bench/sim.mjs';
import { makeBehavior } from '../bench/behaviors.mjs';
import { mulberry32, gauss } from '../bench/rng.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const predFile = process.argv[2] || '../bench/predictors/baseline.mjs';
const { createPredictor } = await import(pathToFileURL(path.resolve(predFile)).href);

function smoothDamp(st, goal, smoothTime, dt) {
  const w = 2 / Math.max(smoothTime, 1e-3), k = w * dt, e = 1 / (1 + k + 0.48 * k * k + 0.235 * k * k * k);
  const d = st.x - goal, tmp = (st.v + w * d) * dt;
  st.v = (st.v - w * tmp) * e; st.x = goal + (d + tmp) * e;
}
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function run(kind, noise, seed) {
  const rng = mulberry32(seed * 977 + 5), nrng = mulberry32(seed * 31 + 9);
  const shooter = { x: 0, y: 0 }, beh = makeBehavior(kind, rng, shooter), pred = createPredictor({ seed });
  const dt = 1 / 120, hist = [], sigma = noise === 'clean' ? 0 : noise === 'mild' ? 1.5 : 3;
  let stallUntil = -1, nextStall = 2 + nrng() * 2, frozen = null;
  const goal = [], out = [];
  const A = { x: 0, v: 0 }, B = { x: 0, v: 0 };
  let started = false;
  for (let i = 0; i < 40 / dt; i++) {
    const t = i * dt;
    beh.step(dt, t, { shooter, bullets: [] });
    hist.push({ x: beh.tank.x, y: beh.tank.y });
    if (i % 2) continue;
    let di = Math.max(0, i - Math.round(PHYS.renderDelay / dt));
    if (noise === 'rough') {
      if (t >= nextStall && stallUntil < 0) { stallUntil = t + 0.1; frozen = hist[di]; nextStall = t + 2 + nrng() * 3; }
      if (stallUntil >= 0) { if (t < stallUntil) di = -1; else stallUntil = -1; }
    }
    const pos = di >= 0 ? hist[di] : frozen;
    pred.observe(t, pos.x + sigma * gauss(nrng), pos.y + sigma * gauss(nrng), { me: { x: 0, y: 0, vx: 0, vy: 0 }, bullets: [] });
    if (t < 2) continue;
    const a = solveAim(pred, PHYS.renderDelay + PHYS.inputDelay, shooter);
    const th = Math.atan2(a.y, a.x);
    if (!started) { A.x = B.x = th; started = true; }
    const gA = A.x + wrap(th - A.x);
    smoothDamp(A, gA, 0.065, 1 / 60); smoothDamp(B, B.x + wrap(A.x - B.x), 0.065, 1 / 60);
    goal.push(th); out.push(B.x);
  }
  return { goal, out };
}
// wobble = RMS of (angle - centred 0.6 s moving average) in degrees, over steady stretches only; kinds with constant-direction motion
function wobble(series) {
  const n = 36, r = [];
  const u = []; let prev = series[0], acc = 0; for (const s of series) { acc += wrap(s - prev); prev = s; u.push(acc); }
  for (let i = n; i < u.length - n; i++) { let m = 0; for (let k = -n; k <= n; k++) m += u[i + k]; m /= 2 * n + 1; r.push(u[i] - m); }
  return Math.sqrt(r.reduce((a, b) => a + b * b, 0) / r.length) * 180 / Math.PI;
}
console.log('predictor:', predFile);
console.log('behavior   noise   goal-wobble(deg)  cursor-wobble(deg)');
for (const kind of ['linear', 'circle']) for (const noise of ['clean', 'mild', 'rough']) {
  let g = 0, o = 0; const S = 6;
  for (let s = 1; s <= S; s++) { const r = run(kind, noise, s); g += wobble(r.goal); o += wobble(r.out); }
  console.log(kind.padEnd(10), noise.padEnd(7), (g / S).toFixed(3).padStart(10), (o / S).toFixed(3).padStart(18));
}
