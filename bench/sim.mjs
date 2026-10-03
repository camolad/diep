// Closed-loop benchmark: a stationary shooter fires every 0.25 s at the point a predictor + intercept solver chooses,
// against a human-like target (behaviors.mjs) that can see and dodge the bullets. Everything is deterministic per seed.
//
// What the predictor sees (exactly what the userscript sees):
//   observe(t, x, y, ctx)  every 60 Hz frame; (x, y) = where the target is DRAWN = its true position `renderDelay` s ago, plus noise.
//                          ctx = { me:{x,y,vx,vy}, bullets:[{x,y,vx,vy,age}] }  (the shooter's own bullets as drawn, also delayed)
//   onShot(t, ax, ay)      when the shooter dispatches an aim point (the bullet leaves `inputDelay` s later)
//   predict(h)             -> [{x, y, w}] hypotheses for where the target will be h seconds after the LAST observation (weights sum to ~1)
// The solver iterates the bullet flight time T and asks predict(L + T) with L = renderDelay + inputDelay.
import { mulberry32, gauss } from './rng.mjs';
import { makeBehavior } from './behaviors.mjs';

export const PHYS = { bulletSpeed: 900, muzzle: 85, hitRadius: 65, reload: 0.25, renderDelay: 0.06, inputDelay: 0.06, lifetime: 2.0 };
const speedAt = (age) => PHYS.bulletSpeed * (1 - 0.55 * Math.exp(-age / 0.12));
export const reach = (T) => PHYS.bulletSpeed * (T - 0.55 * 0.12 * (1 - Math.exp(-T / 0.12)));
export function reachInv(d) {
  if (d <= 0) return 0;
  let lo = 0, hi = 4;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (reach(mid) < d) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

// Aim at the hypothesis (or weighted mean) that covers the most probability mass within the hit radius.
export function chooseAim(hyps) {
  if (!hyps || !hyps.length) return null;
  if (hyps.length === 1) return hyps[0];
  const sw = hyps.reduce((a, h) => a + h.w, 0) || 1;
  const mean = { x: hyps.reduce((a, h) => a + h.x * h.w, 0) / sw, y: hyps.reduce((a, h) => a + h.y * h.w, 0) / sw };
  const cands = hyps.map((h) => ({ x: h.x, y: h.y })).concat([mean]);
  let top = hyps[0]; for (const h of hyps) if (h.w > top.w) top = h;
  let best = null, bs = -1, bd = 1e9;
  for (const c of cands) {
    let s = 0; for (const h of hyps) if (Math.hypot(c.x - h.x, c.y - h.y) < PHYS.hitRadius * 0.85) s += h.w;
    const d = Math.hypot(c.x - top.x, c.y - top.y);
    if (s > bs + 1e-9 || (Math.abs(s - bs) <= 1e-9 && d < bd)) { bs = s; bd = d; best = c; }
  }
  return best;
}

export function solveAim(pred, L, shooter) {
  const first = pred.predict(L);
  let p0 = Array.isArray(first) ? first[0] : first;
  if (!p0) return null;
  let T = reachInv(Math.max(0, Math.hypot(p0.x - shooter.x, p0.y - shooter.y) - PHYS.muzzle)), aim = p0;
  for (let i = 0; i < 7; i++) {
    const hs = pred.predict(L + T);
    aim = chooseAim(Array.isArray(hs) ? hs : [hs]);
    const d = Math.hypot(aim.x - shooter.x, aim.y - shooter.y);
    const Tn = Math.min(reachInv(Math.max(0, d - PHYS.muzzle)), 2.5);
    const done = Math.abs(Tn - T) < 0.004; T = Tn; if (done) break;
  }
  return { x: aim.x, y: aim.y, T };
}

const hash = (s) => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

export function runEpisode({ kind, makePredictor, seed = 1, duration = 40, noise = 'mild', warmup = 1.5 }) {
  const rng = mulberry32(seed * 7919 + hash(kind));
  const nrng = mulberry32(seed * 104729 + 17);
  const shooter = { x: 0, y: 0 };
  const beh = makeBehavior(kind, rng, shooter);
  const pred = makePredictor({ seed });
  const dt = 1 / 120, steps = Math.round(duration / dt);
  const hist = [];                         // true target position per step
  const bullets = [], pending = [];
  const sigma = noise === 'clean' ? 0 : noise === 'mild' ? 1.5 : 3;
  let nextShot = warmup, shots = 0, hits = 0, stallUntil = -1, nextStall = 2 + nrng() * 2, frozen = null;
  let errSum = 0, errN = 0; const probes = [];
  const L = PHYS.renderDelay + PHYS.inputDelay;

  for (let i = 0; i < steps; i++) {
    const t = i * dt;
    beh.step(dt, t, { shooter, bullets });
    hist.push({ x: beh.tank.x, y: beh.tank.y });
    // spawn / move bullets, collide with the TRUE target
    while (pending.length && pending[0].spawn <= t) {
      const p = pending.shift();
      bullets.push({ x: shooter.x + Math.cos(p.ang) * PHYS.muzzle, y: shooter.y + Math.sin(p.ang) * PHYS.muzzle, ang: p.ang, age: 0, vx: 0, vy: 0, counted: p.counted, spawn: t });
    }
    for (let k = bullets.length - 1; k >= 0; k--) {
      const b = bullets[k];
      b.age += dt; const sp = speedAt(b.age);
      b.vx = Math.cos(b.ang) * sp; b.vy = Math.sin(b.ang) * sp; b.x += b.vx * dt; b.y += b.vy * dt;
      if (Math.hypot(b.x - beh.tank.x, b.y - beh.tank.y) < PHYS.hitRadius) { if (b.counted) hits++; bullets.splice(k, 1); }
      else if (b.age > PHYS.lifetime) bullets.splice(k, 1);
    }
    // frame: the predictor observes what is drawn
    if (i % 2 === 0) {
      let di = Math.max(0, i - Math.round(PHYS.renderDelay / dt));
      if (noise === 'rough') { // hitches: the drawn position freezes for ~0.1 s, then catches up
        if (t >= nextStall && stallUntil < 0) { stallUntil = t + 0.1; frozen = hist[di]; nextStall = t + 2 + nrng() * 3; }
        if (stallUntil >= 0) { if (t < stallUntil) di = -1; else stallUntil = -1; }
      }
      const pos = di >= 0 ? hist[di] : frozen;
      const ox = pos.x + sigma * gauss(nrng), oy = pos.y + sigma * gauss(nrng);
      const vis = [];
      for (const b of bullets) if (t - b.spawn >= PHYS.renderDelay) vis.push({ x: b.x - b.vx * PHYS.renderDelay, y: b.y - b.vy * PHYS.renderDelay, vx: b.vx, vy: b.vy, age: b.age - PHYS.renderDelay });
      pred.observe(t, ox, oy, { me: { x: 0, y: 0, vx: 0, vy: 0 }, bullets: vis });
      // probe: remember the primary prediction for h = 0.6 s to score it later
      if (t > warmup && i % 12 === 0) { const hs = pred.predict(0.6); const p = Array.isArray(hs) ? hs.reduce((a, h) => (h.w > a.w ? h : a), hs[0]) : hs; probes.push({ due: t + 0.6, x: p.x, y: p.y }); }
      while (probes.length && probes[0].due <= t) {
        const pr = probes.shift(), idx = Math.max(0, i - Math.round(PHYS.renderDelay / dt));
        errSum += Math.hypot(pr.x - hist[idx].x, pr.y - hist[idx].y); errN++;
      }
    }
    // fire
    if (t >= nextShot) {
      nextShot += PHYS.reload;
      const aim = solveAim(pred, L, shooter);
      if (aim) {
        if (pred.onShot) pred.onShot(t, aim.x, aim.y);
        pending.push({ spawn: t + PHYS.inputDelay, ang: Math.atan2(aim.y - shooter.y, aim.x - shooter.x), counted: t >= warmup + 0.5 });
        if (t >= warmup + 0.5) shots++;
      }
    }
  }
  return { shots, hits, err06: errN ? errSum / errN : null, info: beh.info };
}
