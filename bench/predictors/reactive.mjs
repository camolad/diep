// "reactive" predictor: models how the target reacts to the shooter's bullets, on top of how it normally moves.
// Portable: plain JS, no imports, no Date/Math.random, only Math.
const DBG = [];
export function createPredictor(opts = {}) {
  DBG.length = 0;
  const TAU = 1.2;                       // fading persistence of the plain "keep doing what it was doing" fallback
  const DT = 0.04, NG = 36;              // forward-model grid (s) and number of steps (HMAX = 1.44 s)
  const NS = 48;                         // Monte-Carlo futures per build
  const ACC = 1900;                      // prior for how sharply a target can change velocity (u/s^2)
  const HIT = 58;                        // aim-cluster radius (a bit under the 65 u hit radius)

  // tiny seeded PRNG (only used to build the fixed Latin-hypercube table of Monte-Carlo draws)
  let rs = ((opts.seed | 0) + 0x9E3779B9) | 0;
  const rnd = () => { rs = (rs + 0x6D2B79F5) | 0; let t = Math.imul(rs ^ (rs >>> 15), 1 | rs); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const ND = 12, U = [];
  for (let i = 0; i < NS; i++) U.push(new Float64Array(ND));
  for (let k = 0; k < ND; k++) {
    const p = []; for (let i = 0; i < NS; i++) p.push(i);
    for (let i = NS - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const q = p[i]; p[i] = p[j]; p[j] = q; }
    for (let i = 0; i < NS; i++) U[i][k] = (p[i] + rnd()) / NS;
  }

  // ---------------------------------------------------------------- sample buffer
  let T = [], X = [], Y = [];
  let lastT = -1e9;
  let fit = { x: 0, y: 0, vx: 0, vy: 0 };   // baseline-style fit at the last sample
  let vf = { vx: 0, vy: 0 };                // fast velocity (last ~0.12 s)
  const bd = { x: 1, y: 0 };                // unit direction of the shooter's line of fire at the target (bullet path)
  const me = { x: 0, y: 0 };
  let threat = null;

  const sane = (v) => (typeof v === 'number' && isFinite(v));

  function slope(i0, i1) {                  // LSQ line over samples i0..i1 -> {x,y at T[i1], vx, vy, n}
    const n = i1 - i0 + 1; if (n < 2) return null;
    const tm = T[i1]; let st = 0, sx = 0, sy = 0;
    for (let i = i0; i <= i1; i++) { st += T[i] - tm; sx += X[i]; sy += Y[i]; }
    st /= n; sx /= n; sy /= n;
    let stt = 0, stx = 0, sty = 0;
    for (let i = i0; i <= i1; i++) { const a = T[i] - tm - st; stt += a * a; stx += a * (X[i] - sx); sty += a * (Y[i] - sy); }
    if (stt < 1e-9) return null;
    const vx = stx / stt, vy = sty / stt;
    return { x: sx - vx * st, y: sy - vy * st, vx, vy, n };
  }
  const idxFrom = (tFrom) => { let i = T.length - 1; while (i > 0 && T[i - 1] >= tFrom) i--; return i; };
  const idxLE = (tTo) => { let i = T.length - 1; while (i > 0 && T[i] > tTo) i--; return i; };
  function slopeWin(tFrom, tTo) { const i0 = idxFrom(tFrom), i1 = idxLE(tTo); return i1 - i0 >= 2 ? slope(i0, i1) : null; }

  // baseline weighted LSQ (window 0.22 s, end-weighted)
  function lsqBase() {
    const n = T.length, tr = T[n - 1], WIN = 0.22;
    let i0 = n - 1; while (i0 > 0 && tr - T[i0 - 1] <= WIN) i0--;
    if (n - i0 >= 3 && tr - T[i0] >= 0.05) {
      let sw = 0, st = 0, stt = 0, sx = 0, sy = 0, stx = 0, sty = 0;
      for (let i = i0; i < n; i++) {
        const ta = T[i] - tr, w = 1 + 1.5 * Math.min(1, Math.max(0, 1 + ta / WIN));
        sw += w; st += w * ta; stt += w * ta * ta; sx += w * X[i]; sy += w * Y[i]; stx += w * ta * X[i]; sty += w * ta * Y[i];
      }
      const det = sw * stt - st * st;
      if (det > 1e-10) {
        const vx = (sw * stx - st * sx) / det, vy = (sw * sty - st * sy) / det;
        return { x: (sx - vx * st) / sw, y: (sy - vy * st) / sw, vx, vy };
      }
    }
    const last = n - 1; const f = { x: X[last], y: Y[last], vx: fit.vx, vy: fit.vy };
    if (n - i0 >= 2 && tr - T[i0] >= 0.025) { const d = tr - T[i0]; f.vx = (X[last] - X[i0]) / d; f.vy = (Y[last] - Y[i0]) / d; }
    return f;
  }
  const decay = (h) => TAU * (1 - Math.exp(-h / TAU));

  // ---------------------------------------------------------------- bullets: which one threatens the target?
  function analyseBullets(ctx) {
    threat = null;
    if (ctx && ctx.me && sane(ctx.me.x) && sane(ctx.me.y)) { me.x = ctx.me.x; me.y = ctx.me.y; }
    const px = fit.x, py = fit.y;
    const ux = px - me.x, uy = py - me.y, ul = Math.hypot(ux, uy);
    if (ul > 1e-6) { bd.x = ux / ul; bd.y = uy / ul; }
    const bl = ctx && ctx.bullets; if (!bl || !bl.length) return;
    let best = null;
    for (let k = 0; k < bl.length; k++) {
      const b = bl[k]; if (!b || !sane(b.x) || !sane(b.y) || !sane(b.vx) || !sane(b.vy)) continue;
      const rx = px - b.x, ry = py - b.y, wx = b.vx - fit.vx, wy = b.vy - fit.vy, vv = wx * wx + wy * wy;
      if (vv < 1) continue;
      const tc = (rx * wx + ry * wy) / vv; if (tc < 0.03 || tc > 1.2) continue;
      const d = Math.hypot(rx - wx * tc, ry - wy * tc);
      if (d < 160 && (!best || tc < best.tc)) best = { b, tc, d };
    }
    if (best) {
      const sp = Math.hypot(best.b.vx, best.b.vy) || 1;
      bd.x = best.b.vx / sp; bd.y = best.b.vy / sp; threat = best;
    }
  }

  // ---------------------------------------------------------------- velocity-change events
  const evs = [];                          // recent events {t, tsw, vm, vp, fin, cls, bx, by}
  let armed = true, lastEvT = -1e9;
  let sigPos = 2.5;                        // running estimate of the position noise
  const resHist = [];

  function noiseUpdate() {
    const n = T.length; if (n < 8) return;
    const s = slope(n - 7, n - 1); if (!s) return;
    let rss = 0; const tm = T[n - 1];
    for (let i = n - 7; i < n; i++) { const dx = X[i] - (s.x + s.vx * (T[i] - tm)), dy = Y[i] - (s.y + s.vy * (T[i] - tm)); rss += dx * dx + dy * dy; }
    resHist.push(Math.sqrt(rss / 10));       // 7 samples, 2 params per axis -> 5 dof per axis
    if (resHist.length > 90) resHist.shift();
    if (resHist.length >= 20) { const a = resHist.slice().sort((p, q) => p - q); sigPos = Math.max(0.8, a[Math.floor(a.length * 0.4)]); }
  }

  function detect(tn) {
    const n = T.length; if (n < 14) return;
    const a = slopeWin(tn - 0.1, tn), b = slopeWin(tn - 0.32, tn - 0.14);
    if (!a || !b || a.n < 4 || b.n < 5) return;
    const dt = 1 / 60;
    const sa = sigPos / (dt * Math.sqrt(a.n * (a.n * a.n - 1) / 12)), sb = sigPos / (dt * Math.sqrt(b.n * (b.n * b.n - 1) / 12));
    const thr = Math.max(95, 3.4 * Math.sqrt(sa * sa + sb * sb));
    const d = Math.hypot(a.vx - b.vx, a.vy - b.vy);
    if (armed && d > thr && tn - lastEvT > 0.16) {
      armed = false; lastEvT = tn;
      finalize(evs.length ? evs[evs.length - 1] : null, tn);
      const e = { t: tn, tsw: tn - d / (2 * ACC), vm: { vx: b.vx, vy: b.vy }, vp: { vx: a.vx, vy: a.vy }, fin: false, bx: bd.x, by: bd.y };
      evs.push(e); if (evs.length > 10) evs.shift();
    } else if (!armed && d < thr * 0.5) armed = true;
    const last = evs.length ? evs[evs.length - 1] : null;
    if (last && !last.fin && tn - last.t >= 0.22) finalize(last, tn);
  }

  // ---------------------------------------------------------------- learned statistics
  const S = { dur: [], gap: [], spd: [], side: [], bint: [], bspd: [], nR: 0, tIdle: 0, nNeg: 0, nChg: 0, trans: { pp: 1, pn: 1, np: 1, nn: 1 } };
  const push = (arr, v, cap) => { arr.push(v); if (arr.length > cap) arr.shift(); };
  const cm = { phase: 0, tOn: 0, tEnd: null, onEv: null, tBase: null, lastSide: 0 };   // committed phase machine (0 idle, 1 dodge)

  const tang = (e) => e.vp.vx * -e.by + e.vp.vy * e.bx;     // tangential speed (left of bullet path = +)
  const radl = (e) => e.vp.vx * e.bx + e.vp.vy * e.by;
  function sEst() { if (S.spd.length < 3) return 0; const a = S.spd.slice().sort((p, q) => p - q); return a[a.length >> 1]; }
  function looksDodge(e) {
    const sp = Math.hypot(e.vp.vx, e.vp.vy);
    if (sp < 90) return false;
    if (Math.abs(radl(e)) > 0.45 * sp) return false;
    const s = sEst();
    if (s > 0 && Math.abs(sp - s) > 0.3 * s) return false;
    return true;
  }

  function baseChange(e, vOld, vNew) {      // record a change of the target's "normal" velocity
    const mo = Math.hypot(vOld.vx, vOld.vy), no = Math.hypot(vNew.vx, vNew.vy);
    if (mo > 60) { S.nChg++; if (no > 0 && Math.hypot(vNew.vx + vOld.vx, vNew.vy + vOld.vy) < 0.4 * mo) S.nNeg++; }
    if (cm.tBase !== null && e.tsw - cm.tBase < 4) push(S.bint, e.tsw - cm.tBase, 10);
    push(S.bspd, no, 8);
    cm.tBase = e.tsw;
  }

  function finalize(e, tNext) {              // e is complete (its settled velocity is known)
    if (!e || e.fin) return;
    const i0 = idxFrom(e.t + 0.08), i1 = idxLE(tNext - 0.02);
    if (i1 - i0 >= 3) { const s = slope(i0, i1); if (s) e.vp = { vx: s.vx, vy: s.vy }; }
    e.fin = true; e.cls = looksDodge(e) ? 1 : 0;
    if (typeof DBG !== 'undefined') DBG.push({ t: e.t, tsw: e.tsw, cls: e.cls, sp: Math.hypot(e.vp.vx, e.vp.vy), vr: radl(e), vt: tang(e) });
    commit(e);
  }
  function commit(e) {
    if (e.cls === 1) {
      push(S.spd, Math.hypot(e.vp.vx, e.vp.vy), 12);
      if (cm.phase === 1) push(S.dur, e.tsw - cm.tOn, 12);
      else if (cm.tEnd !== null && e.tsw - cm.tEnd < 2) push(S.gap, e.tsw - cm.tEnd, 12);
      const sd = tang(e) > 0 ? 1 : -1;
      if (cm.lastSide) S.trans[(cm.lastSide > 0 ? 'p' : 'n') + (sd > 0 ? 'p' : 'n')]++;
      push(S.side, sd, 16); cm.lastSide = sd;
      cm.phase = 1; cm.tOn = e.tsw; cm.onEv = e;
    } else if (cm.phase === 1) {
      push(S.dur, e.tsw - cm.tOn, 12);
      if (cm.onEv) {
        const m = cm.onEv.vm, p = e.vp, mm = Math.hypot(m.vx, m.vy);
        if (mm > 60 && Math.hypot(p.vx - m.vx, p.vy - m.vy) > Math.max(70, 0.4 * mm)) baseChange(e, m, p);
      }
      cm.phase = 0; cm.tEnd = e.tsw;
    } else {
      baseChange(e, e.vm, e.vp);          // idle-time change of direction/speed
      S.nR++;
    }
  }

  // ---------------------------------------------------------------- forward model (Monte Carlo over learned event processes)
  const NV = 3;                              // model variants: 0 dodge only, 1 base-change process only, 2 both
  const POOLS = []; for (let v = 0; v < NV; v++) { const p = []; for (let i = 0; i < NS; i++) p.push({ traj: new Float64Array(2 * (NG + 1)), w: 1 / NS }); POOLS.push(p); }
  function sortedCopy(a) { return a.slice().sort((p, q) => p - q); }
  function median(a, d) { if (!a.length) return d; const b = sortedCopy(a); return b[b.length >> 1]; }
  // conditional quantile of an empirical distribution (sorted ascending), given value >= minV; u in [0,1)
  function condQ(a, u, minV) {
    const n = a.length; let lo = 0; while (lo < n && a[lo] < minV) lo++;
    const m = n - lo; if (m <= 0) return -1;
    if (m === 1) return a[lo];
    const f = u * (m - 1), k = Math.floor(f), r = f - k;
    return a[lo + k] * (1 - r) + a[lo + Math.min(k + 1, m - 1)] * r;
  }
  const padded = (arr, prior) => {
    if (arr.length < 3) return prior;
    const a = sortedCopy(arr), n = a.length, sp = (a[n - 1] - a[0]) / (n - 1);
    return [a[0] - sp * 0.5].concat(a, [a[n - 1] + sp * 0.5]);
  };

  function effPhase(t0) {
    let ph = cm.phase, tOn = cm.tOn, tEnd = cm.tEnd, onEv = cm.onEv, tBase = cm.tBase, vb = null;
    const last = evs.length ? evs[evs.length - 1] : null;
    if (last && !last.fin) {
      const s = slopeWin(last.t + 0.04, t0);
      const tmp = { t: last.t, tsw: last.tsw, vp: s && s.n >= 3 ? { vx: s.vx, vy: s.vy } : last.vp, vm: last.vm, bx: last.bx, by: last.by };
      if (looksDodge(tmp)) { ph = 1; tOn = tmp.tsw; onEv = tmp; }
      else if (ph === 1) { ph = 0; tEnd = tmp.tsw; vb = tmp.vp; }
      else { tBase = tmp.tsw; vb = tmp.vp; }
    } else if (last && last.fin && last.cls === 0 && t0 - last.t < 0.5) vb = last.vp;
    if (ph === 1 && t0 - tOn > Math.max(1.0, 1.6 * Math.max.apply(null, S.dur.concat([0.5])))) { ph = 0; tEnd = tOn + median(S.dur, 0.5); }
    return { ph, tOn, tEnd, onEv, tBase, vb };
  }

  function build(t0, vr) {
    const useDodge = vr !== 1, useBase = vr !== 0, POOL = POOLS[vr];
    const E = effPhase(t0);
    const dodgeOK = useDodge && S.spd.length >= 2 && (S.dur.length + S.gap.length) >= 2 && (E.ph === 1 || E.tEnd !== null);
    const spd = sEst() || median(S.spd, 0);
    // side probabilities (Laplace smoothed, conditioned on the previous side)
    let nl = 0; for (const s of S.side) if (s > 0) nl++;
    const pm = (nl + 1) / (S.side.length + 2);
    const cnt = cm.lastSide > 0 ? [S.trans.pp, S.trans.pn] : [S.trans.np, S.trans.nn];
    const pL = cm.lastSide === 0 ? pm : (cnt[0] - 1 + 2 * pm) / (cnt[0] + cnt[1] - 2 + 2);
    const durA = padded(S.dur, [0.3, 0.8]), gapA = padded(S.gap, [0.4, 1.1]);
    const px = -bd.y, py = bd.x;                                 // left of the bullet path
    const nowSettled = E.vb || vf;
    let b0;
    if (E.ph === 1) { const m = E.onEv.vm; b0 = { vx: m.vx, vy: m.vy }; } else b0 = { vx: nowSettled.vx, vy: nowSettled.vy };
    const b0m = Math.hypot(b0.vx, b0.vy);
    // base process
    const lam = useBase ? (S.nR + 0.5) / (S.tIdle + 1.0) : 0.15;
    const bint = S.bint, bm = bint.length >= 3 ? bint.reduce((a, v) => a + v, 0) / bint.length : 0;
    let bsd = 0; if (bint.length >= 3) { for (const v of bint) bsd += (v - bm) * (v - bm); bsd = Math.sqrt(bsd / bint.length); }
    const regular = useBase && bint.length >= 3 && bsd < 0.18 * bm;
    const bA = regular ? padded(bint, [0.8]) : null;
    const baseAge = E.tBase === null ? 0 : Math.max(0, t0 - E.tBase);
    const pNeg = useBase && S.nChg >= 3 ? S.nNeg / S.nChg : 0;
    const vTyp = Math.max(100, Math.min(300, median(S.bspd, b0m)));
    const dmean = median(S.dur, 0.5);
    const out = [];
    const e = E.ph === 1 ? t0 - E.tOn : 0, q = E.ph === 0 && E.tEnd !== null ? t0 - E.tEnd : 0;
    for (let i = 0; i < NS; i++) {
      const u = U[i];
      // ---- dodge windows within the horizon: [start, end, vx, vy]
      let w1 = null, w2 = null;
      if (dodgeOK) {
        let endT, onT;
        if (E.ph === 1) {
          const d = condQ(durA, u[0], e - 0.05);
          endT = Math.max(0.02, (d < 0 ? e + 0.05 : d) - e);
          w1 = [0, endT, E.onEv.vp.vx, E.onEv.vp.vy];
          const g = condQ(gapA, u[1], 0); onT = endT + (g < 0 ? 0.6 : g);
        } else {
          const g = condQ(gapA, u[0], q - 0.06);
          onT = g < 0 ? -1 : Math.max(0, g - q);
        }
        if (onT >= 0 && onT < NG * DT) {
          const sd = u[2] < pL ? 1 : -1, d2 = condQ(durA, u[3], 0);
          w2 = [onT, onT + (d2 < 0 ? dmean : d2), px * sd * spd, py * sd * spd];
        }
      }
      // ---- base changes: times and new velocities
      let c1, c2, v1x, v1y, v2x, v2y;
      if (regular) { const a1 = condQ(bA, u[4], baseAge - 0.05); c1 = a1 < 0 ? 0.05 + 0.1 * u[4] : Math.max(0, a1 - baseAge); const a2 = condQ(bA, u[7], 0); c2 = c1 + (a2 < 0 ? 0.8 : a2); }
      else { c1 = -Math.log(1 - u[4] * 0.9999) / lam; c2 = c1 - Math.log(1 - u[7] * 0.9999) / lam; }
      if (u[5] < pNeg) { v1x = -b0.vx; v1y = -b0.vy; v2x = b0.vx; v2y = b0.vy; }
      else {
        const ang = u[6] * 6.2831853, sp = vTyp * (0.55 + 0.9 * u[8]), a2 = u[9] * 6.2831853;
        v1x = Math.cos(ang) * sp; v1y = Math.sin(ang) * sp; v2x = Math.cos(a2) * sp; v2y = Math.sin(a2) * sp;
      }
      // ---- integrate
      let x = fit.x, y = fit.y, vx = vf.vx, vy = vf.vy;
      const traj = POOL[i].traj; traj[0] = x; traj[1] = y;
      for (let k = 1; k <= NG; k++) {
        const tau = (k - 0.5) * DT; let wx, wy;
        if (w1 && tau >= w1[0] && tau < w1[1]) { wx = w1[2]; wy = w1[3]; }
        else if (w2 && tau >= w2[0] && tau < w2[1]) { wx = w2[2]; wy = w2[3]; }
        else if (tau >= c2) { wx = v2x; wy = v2y; }
        else if (tau >= c1) { wx = v1x; wy = v1y; }
        else { wx = b0.vx; wy = b0.vy; }
        const ex = wx - vx, ey = wy - vy, em = Math.sqrt(ex * ex + ey * ey), mx = ACC * DT;
        if (em > mx) { vx += ex / em * mx; vy += ey / em * mx; } else { vx = wx; vy = wy; }
        x += vx * DT; y += vy * DT; traj[2 * k] = x; traj[2 * k + 1] = y;
      }
      out.push(POOL[i]);
    }
    return out;
  }

  function at(traj, h) {
    const f = Math.min(Math.max(h, 0) / DT, NG - 1e-9), k = Math.floor(f), r = f - k;
    return { x: traj[2 * k] * (1 - r) + traj[2 * k + 2] * r, y: traj[2 * k + 1] * (1 - r) + traj[2 * k + 3] * r };
  }

  const MX = new Float64Array(NS), MY = new Float64Array(NS), MW = new Float64Array(NS), MU = new Uint8Array(NS);
  function pointsAt(c, h) {
    for (let i = 0; i < NS; i++) { const p = at(c[i].traj, h); MX[i] = p.x; MY[i] = p.y; MW[i] = c[i].w; }
    return NS;
  }
  function modes(n, K) {                     // greedy mode finding on the weighted points in MX/MY/MW
    const out = [], H2 = HIT * HIT, G2 = HIT * 1.3 * HIT * 1.3; MU.fill(0);
    let tot = 0; for (let i = 0; i < n; i++) tot += MW[i]; if (tot <= 0) return out;
    for (let m = 0; m < K; m++) {
      let bi = -1, bs = -1;
      for (let i = 0; i < n; i++) {
        if (MU[i]) continue;
        let s = 0; for (let j = 0; j < n; j++) { if (MU[j]) continue; const dx = MX[i] - MX[j], dy = MY[i] - MY[j]; if (dx * dx + dy * dy < H2) s += MW[j]; }
        if (s > bs) { bs = s; bi = i; }
      }
      if (bi < 0) break;
      let cx = MX[bi], cy = MY[bi];
      for (let it = 0; it < 2; it++) {
        let sx = 0, sy = 0, sw = 0;
        for (let j = 0; j < n; j++) { if (MU[j]) continue; const dx = cx - MX[j], dy = cy - MY[j]; if (dx * dx + dy * dy < H2) { sx += MX[j] * MW[j]; sy += MY[j] * MW[j]; sw += MW[j]; } }
        if (sw > 0) { cx = sx / sw; cy = sy / sw; }
      }
      let mass = 0; for (let j = 0; j < n; j++) { if (MU[j]) continue; const dx = cx - MX[j], dy = cy - MY[j]; if (dx * dx + dy * dy < G2) { mass += MW[j]; MU[j] = 1; } }
      out.push({ x: cx, y: cy, w: mass / tot });
    }
    return out;
  }

  // ---------------------------------------------------------------- online validation (hindsight): is the model better than plain persistence?
  const HE = [0.4, 0.7];
  const pend = [];
  const rho = [0.45, 0.45, 0.45]; let rhoB = 0.5, nVal = 0, frame = 0;
  const PEN = [0.012, 0.012, 0.016];          // prior preference for simpler models
  const score = (d) => (d < 45 ? 1 : d > 80 ? 0 : (80 - d) / 35);
  function posAt(tq) {                       // observed position at time tq (linear interpolation)
    const n = T.length; if (!n || tq > T[n - 1] + 1e-9) return null;
    let i = n - 1; while (i > 0 && T[i - 1] > tq) i--;
    if (i === 0) return null;
    const r = (tq - T[i - 1]) / (T[i] - T[i - 1]);
    return { x: X[i - 1] + (X[i] - X[i - 1]) * r, y: Y[i - 1] + (Y[i] - Y[i - 1]) * r };
  }
  const caches = [undefined, undefined, undefined];
  function ensure(v) { if (caches[v] === undefined) caches[v] = build(lastT, v); return caches[v]; }
  function validate(t) {
    while (pend.length && pend[0].due <= t) {
      const p = pend.shift(), q = posAt(p.due); if (!q) continue;
      const al = 0.006;
      rhoB += al * (score(Math.hypot(q.x - p.bx, q.y - p.by)) - rhoB);
      for (let v = 0; v < NV; v++) rho[v] += al * (score(Math.hypot(q.x - p.mx[v], q.y - p.my[v])) - rho[v]);
      nVal++;
    }
    if (frame++ % 3 === 0) {
      for (const h of HE) {
        const a = decay(h), bx = fit.x + fit.vx * a, by = fit.y + fit.vy * a, mx = [bx, bx, bx], my = [by, by, by];
        for (let v = 0; v < NV; v++) { const c = ensure(v); if (c) { const m = modes(pointsAt(c, h), 1)[0]; if (m) { mx[v] = m.x; my[v] = m.y; } } }
        pend.push({ due: t + h, bx, by, mx, my });
      }
    }
  }
  function best() { let b = 0, bs = -1e9; for (let v = 0; v < NV; v++) { const sc = rho[v] - PEN[v]; if (sc > bs) { bs = sc; b = v; } } return { v: b, gain: bs - rhoB }; }

  // ---------------------------------------------------------------- interface
  function observe(t, x, y, ctx) {
    if (!sane(t) || !sane(x) || !sane(y)) return;
    if (T.length && t <= lastT + 1e-6) return;
    if (T.length && (t - lastT > 1.0 || Math.hypot(x - X[X.length - 1], y - Y[Y.length - 1]) > 700)) softReset();
    const dtp = T.length ? t - lastT : 0;
    T.push(t); X.push(x); Y.push(y); lastT = t;
    while (T.length > 2 && t - T[0] > 1.6) { T.shift(); X.shift(); Y.shift(); }
    if (T.length > 240) { T.shift(); X.shift(); Y.shift(); }
    fit = lsqBase();
    const s = slopeWin(t - 0.12, t); vf = s ? { vx: s.vx, vy: s.vy } : { vx: fit.vx, vy: fit.vy };
    analyseBullets(ctx);
    noiseUpdate();
    if (cm.phase === 0) S.tIdle += Math.min(dtp, 0.1);
    detect(t);
    caches[0] = caches[1] = caches[2] = undefined;
    validate(t);
  }
  function predict(h) {
    if (!T.length) return [{ x: 0, y: 0, w: 1 }];
    if (!sane(h) || h < 0) h = 0;
    const a = decay(h), bx = fit.x + fit.vx * a, by = fit.y + fit.vy * a;
    const B = best(), c = ensure(B.v);
    if (!c) return [{ x: bx, y: by, w: 1 }];
    const wm = 1 / (1 + Math.exp(-B.gain / 0.03));
    const m = modes(pointsAt(c, h), 3);
    if (!m.length) return [{ x: bx, y: by, w: 1 }];
    const out = [{ x: bx, y: by, w: 1 - wm }];
    for (const k of m) out.push({ x: k.x, y: k.y, w: k.w * wm });
    return out;
  }
  function softReset() { T = []; X = []; Y = []; evs.length = 0; armed = true; cm.phase = 0; cm.tEnd = null; cm.onEv = null; cm.tBase = null; caches[0] = caches[1] = caches[2] = undefined; pend.length = 0; }
  function reset() { softReset(); S.dur.length = S.gap.length = S.spd.length = S.side.length = S.bint.length = S.bspd.length = 0; S.nR = S.nNeg = S.nChg = 0; S.tIdle = 0; S.trans = { pp: 1, pn: 1, np: 1, nn: 1 }; cm.lastSide = 0; lastT = -1e9; fit = { x: 0, y: 0, vx: 0, vy: 0 }; vf = { vx: 0, vy: 0 }; rhoB = 0.5; rho[0] = rho[1] = rho[2] = 0.45; }
  return { observe, predict, onShot() {}, reset, _dbg: () => ({ S, cm, DBG, rhoB, rhoM: rho[2], rho, nVal }) };
}
