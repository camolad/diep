// Human-like target behaviours for the closed-loop benchmark. Units: world units (u) and seconds.
// A behaviour owns a tank (x, y, vx, vy). step(dt, t, world) moves it. world = { shooter:{x,y}, bullets:[{x,y,vx,vy,age}] }
// where bullets are the shooter's bullets in flight (TRUE state: a dodger reacts to what it sees, after its reaction time).
import { range } from './rng.mjs';

const ARENA = { x: 820, y: 460 };
const MIN_DIST = 190;
const R_TANK = 50;

class Mover {
  constructor(rng, x, y) {
    this.rng = rng; this.x = x; this.y = y; this.vx = 0; this.vy = 0;
    this.accel = range(rng, 1500, 2300);   // how sharply it can change velocity (u/s^2)
    this.maxSpeed = 330;
  }
  drive(tvx, tvy, dt) {
    const ax = tvx - this.vx, ay = tvy - this.vy, am = Math.hypot(ax, ay);
    if (am > 1e-9) { const k = Math.min(am, this.accel * dt) / am; this.vx += ax * k; this.vy += ay * k; }
    const sp = Math.hypot(this.vx, this.vy);
    if (sp > this.maxSpeed) { this.vx *= this.maxSpeed / sp; this.vy *= this.maxSpeed / sp; }
  }
  integrate(dt, shooter) {
    this.x += this.vx * dt; this.y += this.vy * dt;
    if (this.x > ARENA.x) { this.x = ARENA.x; this.vx = -Math.abs(this.vx); this.flipX = true; }
    if (this.x < -ARENA.x) { this.x = -ARENA.x; this.vx = Math.abs(this.vx); this.flipX = true; }
    if (this.y > ARENA.y) { this.y = ARENA.y; this.vy = -Math.abs(this.vy); this.flipY = true; }
    if (this.y < -ARENA.y) { this.y = -ARENA.y; this.vy = Math.abs(this.vy); this.flipY = true; }
    const dx = this.x - shooter.x, dy = this.y - shooter.y, d = Math.hypot(dx, dy);
    if (d < MIN_DIST) { this.x = shooter.x + (dx / (d || 1)) * MIN_DIST; this.y = shooter.y + (dy / (d || 1)) * MIN_DIST; }
  }
}

// ---- base movement styles: each returns the desired velocity for the next step ---------------------------------
function styleLinear(rng) {
  const a = rng() * Math.PI * 2, s = range(rng, 150, 300);
  const v = { x: Math.cos(a) * s, y: Math.sin(a) * s };
  return (m) => { if (m.flipX) { v.x = m.vx; m.flipX = false; } if (m.flipY) { v.y = m.vy; m.flipY = false; } return v; };
}
function styleRandom(rng) {
  let next = 0, v = { x: 0, y: 0 };
  return (m, t) => {
    if (t >= next) { const a = rng() * Math.PI * 2, s = range(rng, 140, 280); v = { x: Math.cos(a) * s, y: Math.sin(a) * s }; next = t + range(rng, 0.4, 1.2); }
    return v;
  };
}
function stylePeriodic(rng) {
  const a = rng() * Math.PI * 2, ax = Math.cos(a), ay = Math.sin(a), s = range(rng, 200, 300);
  const half = range(rng, 0.35, 0.9);
  let sign = rng() < 0.5 ? -1 : 1, next = 0;
  return (m, t) => {
    if (t >= next) { if (rng() > 0.1) sign = -sign; next = t + half * range(rng, 0.88, 1.12); }
    return { x: ax * s * sign, y: ay * s * sign };
  };
}
function styleCircle(rng, shooter) {
  const R = range(rng, 250, 420), w0 = range(rng, 0.5, 1.1) * (rng() < 0.5 ? -1 : 1);
  let w = w0, next = range(rng, 3, 8);
  return (m, t) => {
    if (t >= next) { if (rng() < 0.5) w = -w; next = t + range(rng, 3, 8); }
    const dx = m.x - shooter.x, dy = m.y - shooter.y, d = Math.hypot(dx, dy) || 1;
    const tx = -dy / d * Math.sign(w), ty = dx / d * Math.sign(w), sp = Math.abs(w) * R;
    const k = (R - d) * 2.5; // radial correction
    return { x: tx * sp + (dx / d) * k, y: ty * sp + (dy / d) * k };
  };
}
function styleKite(rng, shooter) {
  const s = range(rng, 150, 260);
  let sign = 1, next = 0;
  return (m, t) => {
    if (t >= next) { sign = -sign; next = t + range(rng, 0.8, 1.8); }
    const dx = m.x - shooter.x, dy = m.y - shooter.y, d = Math.hypot(dx, dy) || 1;
    return { x: (dx / d) * s * sign, y: (dy / d) * s * sign };
  };
}
function styleStill(rng) {
  let next = range(rng, 1, 3), until = 0, v = { x: 0, y: 0 };
  return (m, t) => {
    if (t >= next) { const a = rng() * Math.PI * 2; v = { x: Math.cos(a) * 200, y: Math.sin(a) * 200 }; until = t + 0.3; next = t + range(rng, 1.5, 4); }
    return t < until ? v : { x: 0, y: 0 };
  };
}
function styleStopAndGo(rng) {
  const a = rng() * Math.PI * 2, s = range(rng, 200, 300);
  let phase = 'go', next = range(rng, 0.4, 0.8), v = { x: Math.cos(a) * s, y: Math.sin(a) * s };
  return (m, t) => {
    if (t >= next) {
      if (phase === 'go') { phase = 'stop'; next = t + range(rng, 0.3, 0.6); }
      else { phase = 'go'; const b = rng() * Math.PI * 2; v = { x: Math.cos(b) * s, y: Math.sin(b) * s }; next = t + range(rng, 0.4, 1.0); }
    }
    return phase === 'go' ? v : { x: 0, y: 0 };
  };
}
function styleFigure8(rng, shooter) {
  const A = range(rng, 200, 320), B = range(rng, 120, 220), w = range(rng, 0.8, 1.4), cx = range(rng, 280, 420) * (rng() < 0.5 ? -1 : 1);
  return (m, t) => ({ x: A * w * Math.cos(w * t), y: 2 * B * w * Math.cos(2 * w * t) + 0 * cx });
}

const STYLES = { linear: styleLinear, random: styleRandom, periodic: stylePeriodic, circle: styleCircle, kite: styleKite, still: styleStill, stopgo: styleStopAndGo, figure8: styleFigure8 };

// ---- reactive dodging layered on top of any style ----------------------------------------------------------------
// Sees the shooter's bullets, waits its reaction time, then sidesteps perpendicular to the bullet's path, mostly to its favourite side.
function makeReactive(rng, base) {
  const bias = range(rng, 0.55, 0.95), fav = rng() < 0.5 ? -1 : 1;
  const react = range(rng, 0.14, 0.3), speed = range(rng, 230, 330), dur = [range(rng, 0.3, 0.45), range(rng, 0.5, 0.8)];
  const cool = range(rng, 0.25, 0.6);
  let threatSince = null, dodgeUntil = 0, cooldownUntil = 0, dv = null;
  return {
    info: { bias, fav, react },
    desired(m, t, world) {
      if (t < dodgeUntil) return dv;
      // most dangerous bullet: closest predicted approach
      let best = null;
      for (const b of world.bullets) {
        const rx = m.x - b.x, ry = m.y - b.y, vx = b.vx - m.vx, vy = b.vy - m.vy, vv = vx * vx + vy * vy;
        if (vv < 1) continue;
        const tc = (rx * vx + ry * vy) / vv;
        if (tc < 0.05 || tc > 1.1) continue;
        const d = Math.hypot(rx - vx * tc, ry - vy * tc);
        if (d < 150 && (!best || tc < best.tc)) best = { b, tc, d };
      }
      if (best && t >= cooldownUntil) {
        if (threatSince === null) threatSince = t;
        if (t - threatSince >= react) {
          const sp = Math.hypot(best.b.vx, best.b.vy) || 1;
          const px = -best.b.vy / sp, py = best.b.vx / sp;       // perpendicular to the bullet path
          const side = rng() < bias ? fav : -fav;
          dv = { x: px * side * speed, y: py * side * speed };
          dodgeUntil = t + range(rng, dur[0], dur[1]); cooldownUntil = dodgeUntil + cool; threatSince = null;
          return dv;
        }
      } else threatSince = null;
      return base(m, t);
    },
  };
}

export const BEHAVIORS = ['linear', 'circle', 'random', 'periodic', 'kite', 'still', 'reactive-random', 'reactive-periodic'];
export const HELD_OUT = ['stopgo', 'figure8', 'reactive-linear', 'reactive-circle', 'reactive-stopgo'];

export function makeBehavior(kind, rng, shooter) {
  const start = range(rng, 300, 520), ang = rng() * Math.PI * 2;
  const m = new Mover(rng, shooter.x + Math.cos(ang) * start, shooter.y + Math.sin(ang) * start);
  let style, reactive = null;
  if (kind.startsWith('reactive-')) {
    const b = kind.slice(9);
    style = STYLES[b](rng, shooter);
    reactive = makeReactive(rng, style);
  } else style = STYLES[kind](rng, shooter);
  return {
    kind, tank: m, info: reactive ? reactive.info : null,
    step(dt, t, world) {
      const v = reactive ? reactive.desired(m, t, world) : style(m, t);
      m.drive(v.x, v.y, dt);
      m.integrate(dt, shooter);
    },
  };
}
export { R_TANK };
