// "rhythm" predictor v2. Humans move in segments: hold a velocity for a while, change it abruptly (strafe reversal, sidestep,
// stop, resume), hold again - and the hold times and the velocities they alternate between are far more regular than
// constant-velocity extrapolation assumes. This predictor
//   1. estimates velocity by weighted least squares, time-stamped at the window centroid (zero crossings stay unbiased in time);
//   2. segments the velocity track into plateaus separated by EVENTS = bursts of high acceleration with a large velocity change
//      (reversals, sidesteps, stops, starts - no fixed axis, any direction), with a provisional event as soon as the change is
//      big enough so the latency is small;
//   3. treats the plateaus as a period-2 alternation (A,B,A,B... which covers strafing, sidestep-and-return, move/stop) with
//      parity-specific hold times and velocities; learns from its own track record how reliable the timing and the next
//      velocity have been (per parity) - that reliability is the mixing weight;
//   4. predicts by integrating a velocity that switches at the predicted event times (accel-limited ramps), hedged over timing
//      jitter and over "the event is skipped", and blended with constant velocity + fading persistence (the baseline) in
//      proportion to (1 - reliability). With no evidence the output IS the baseline.
// Portable: plain JS, no imports, no Date/Math.random.
export function createPredictor(opts = {}) {
  const P = Object.assign({
    tau: 1.2, win: 0.22,
    aOn: 600, aOffF: 0.4, dvMin: 80, quietN: 3, maxBurst: 0.9, minSeg: 0.2, accel: 1800,
    sigPrior: 0.1, sigPriorN: 2, sigFloor: 0.02, pSkip: 0.08, detDelay: 0.1,
    rA: 1.2, rB: 0.6, backMin: 35, backFrac: 0.2, hEval: 0.6, infoDist: 25, tauE: 3, kappa: 8, wHalf: 8, lossC: 55, lossW: 10, rCap: 0.95, maxEv: 14, rN: 6,
  }, opts.params || {});
  const dbg = opts.dbg || null;
  const decay = (h) => (P.tau >= 20 ? h : P.tau * (1 - Math.exp(-h / P.tau)));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const GN = [-1.8, -1.2, -0.6, 0, 0.6, 1.2, 1.8];

  let T, X, Y, lastT, lastX, lastY, fit, nObs;
  let VT, VX, VY, VA, PHX, PHY;         // velocity series (time-stamped at window centroid), accel magnitude, plateau history
  let plat, mode, bT0, bV0, bMax, bQuiet, bProv, bThr, bPrevM, bPrevT, bPkT, bPkV, bBack;
  let EZ, EV, eOff, VPRE0, SS, accel;
  let rm, Q, LR, LB, WS, rhoNow, lastObsT;
  function reset() {
    T = []; X = []; Y = []; lastT = -Infinity; lastX = 0; lastY = 0; nObs = 0;
    fit = { x: 0, y: 0, vx: 0, vy: 0, tc: 0 };
    VT = []; VX = []; VY = []; VA = []; PHX = []; PHY = [];
    plat = null; mode = 0; bT0 = 0; bV0 = null; bMax = 0; bQuiet = 0; bProv = false;
    EZ = []; EV = []; eOff = 0; VPRE0 = null; SS = []; accel = P.accel;
    rm = null; Q = []; LR = 0; LB = 0; WS = 0; rhoNow = 0; lastObsT = -Infinity;
  }
  reset();

  function lsq() {
    const n = T.length, tRef = T[n - 1];
    let i0 = n - 1; while (i0 > 0 && tRef - T[i0 - 1] <= P.win) i0--;
    if (n - i0 < 3 || tRef - T[i0] < 0.05) return null;
    let sw = 0, st = 0, stt = 0, sx = 0, sy = 0, stx = 0, sty = 0;
    for (let i = i0; i < n; i++) {
      const tt = T[i] - tRef, w = 1 + 1.5 * clamp(1 + tt / P.win, 0, 1);
      sw += w; st += w * tt; stt += w * tt * tt; sx += w * X[i]; sy += w * Y[i]; stx += w * tt * X[i]; sty += w * tt * Y[i];
    }
    const det = sw * stt - st * st;
    if (!(det > 1e-9)) return null;
    const vx = (sw * stx - st * sx) / det, vy = (sw * sty - st * sy) / det;
    return { x: (sx - vx * st) / sw, y: (sy - vy * st) / sw, vx, vy, tc: tRef + st / sw };
  }

  // ---- events ------------------------------------------------------------------------------------------------------------
  function median(a) { const s = a.slice().sort((p, q) => p - q), n = s.length; return n & 1 ? s[n >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]); }
  function refineLast(tEnd) {
    // the plateau after the latest event = median of its settled velocity samples (robust to hitch spikes)
    const n = EZ.length; if (!n) return;
    const z = EZ[n - 1], xs = [], ys = [];
    for (let i = 0; i < SS.length; i += 3) if (SS[i] >= z + 0.12 && SS[i] <= tEnd) { xs.push(SS[i + 1]); ys.push(SS[i + 2]); }
    if (xs.length >= 3) EV[n - 1] = [median(xs), median(ys)];
  }
  function pushEvent(z, Vn) {
    EZ.push(z); EV.push(Vn);
    if (EZ.length > P.maxEv) { VPRE0 = EV[0]; EZ.shift(); EV.shift(); eOff++; }
    SS = [];
  }
  // time when the velocity covered half of the change v0 -> v1 (burst samples only)
  function midpoint(v0, v1, tStart) {
    const dx = v1[0] - v0[0], dy = v1[1] - v0[1], m = Math.hypot(dx, dy) || 1, ux = dx / m, uy = dy / m;
    let prevT = null, prevP = 0;
    for (let i = 0; i < VT.length; i++) {
      if (VT[i] < tStart) continue;
      const p = (VX[i] - v0[0]) * ux + (VY[i] - v0[1]) * uy;
      if (p >= 0.5 * m) { if (prevT === null || p <= prevP) return VT[i]; return prevT + (VT[i] - prevT) * (0.5 * m - prevP) / (p - prevP); }
      prevT = VT[i]; prevP = p;
    }
    return VT[VT.length - 1];
  }
  function expectedPlateau() {
    // what the model currently expects the NEXT plateau to be (two segments ago), if known
    const n = EZ.length;
    if (n >= 2) return EV[n - 2];
    if (n === 1) return VPRE0 || null;
    return null;
  }
  function startBurst(i) {
    // scan back to the start of the acceleration burst
    const aOff = P.aOffF * P.aOn;
    let s = i; while (s > 0 && VA[s - 1] >= aOff) s--;
    bT0 = VT[s];
    bV0 = [PHX[s], PHY[s]];
    bMax = 0; bQuiet = 0; bProv = false; mode = 1;
    const ex = expectedPlateau();
    bThr = ex ? Math.max(P.dvMin, 0.5 * Math.hypot(ex[0] - bV0[0], ex[1] - bV0[1])) : P.dvMin;
    bPrevM = 0; bPrevT = bT0;
  }
  function provisional(z, vx, vy) {
    // the change has covered half of what the model expects (or the minimum event size): register the event now
    bProv = true;
    refineLast(bT0);
    const exp = expectedPlateau();
    pushEvent(z, exp ? exp.slice() : [vx, vy]);
  }
  function finalizeBurst(tc, v1, tEndBurst) {
    const dv = Math.hypot(v1[0] - bV0[0], v1[1] - bV0[1]);
    const ok = dv >= P.dvMin && tEndBurst - bT0 <= P.maxBurst;
    if (ok) {
      const z = midpoint(bV0, v1, bT0);
      if (bProv) { EZ[EZ.length - 1] = Math.max(z, EZ.length > 1 ? EZ[EZ.length - 2] + 1e-3 : z); EV[EV.length - 1] = v1; SS = []; }
      else { refineLast(bT0); pushEvent(z, v1); }
      mergeHitch();
      if (dbg) dbg.events = (dbg.events || 0) + 1;
    } else if (bProv) {
      EZ.pop(); EV.pop();                                   // cancel the provisional event
    }
    plat = v1; mode = 0; bProv = false; SS = [];
  }
  function mergeHitch() {
    // a short excursion that returns to the earlier plateau is a rendering hitch / noise, not a human segment
    const n = EZ.length;
    if (n < 2) return;
    const dur = EZ[n - 1] - EZ[n - 2];
    const before = n >= 3 ? EV[n - 3] : VPRE0;
    if (!before) return;
    if (dur < P.minSeg && Math.hypot(EV[n - 1][0] - before[0], EV[n - 1][1] - before[1]) < 0.6 * P.dvMin) { EZ.pop(); EZ.pop(); EV.pop(); EV.pop(); }
  }
  function processVel(tc, vx, vy) {
    const L0 = VT.length;
    let a = 0;
    { let j = L0 - 1; while (j > 0 && tc - VT[j] < 0.07) j--; if (j >= 0 && L0 > 0 && tc - VT[j] >= 0.04) a = Math.hypot(vx - VX[j], vy - VY[j]) / (tc - VT[j]); }
    VT.push(tc); VX.push(vx); VY.push(vy); VA.push(a); PHX.push(plat ? plat[0] : vx); PHY.push(plat ? plat[1] : vy);
    if (VT.length > 200) { VT.shift(); VX.shift(); VY.shift(); VA.shift(); PHX.shift(); PHY.shift(); }
    SS.push(tc, vx, vy); if (SS.length > 600) SS.splice(0, 3);
    const aOff = P.aOffF * P.aOn;
    if (!plat) { plat = [vx, vy]; return; }
    if (mode === 0) {
      if (a >= P.aOn) startBurst(VT.length - 1);
      else { plat = [plat[0] + 0.2 * (vx - plat[0]), plat[1] + 0.2 * (vy - plat[1])]; }
    }
    if (mode === 1) {
      const m = Math.hypot(vx - bV0[0], vy - bV0[1]);
      if (m > bMax) { bMax = m; bPkT = tc; bPkV = [vx, vy]; }
      if (!bProv && m >= bThr) provisional(m > bPrevM ? bPrevT + (tc - bPrevT) * clamp((bThr - bPrevM) / (m - bPrevM), 0, 1) : tc, vx, vy);
      bPrevM = m; bPrevT = tc;
      bBack = (bMax >= P.dvMin && m < bMax - Math.max(P.backMin, P.backFrac * bMax)) ? bBack + 1 : 0;
      if (a < aOff) bQuiet++; else bQuiet = 0;
      if (bQuiet >= P.quietN) {
        const L = VT.length, k = Math.min(P.quietN, L); let sx = 0, sy = 0; for (let i = L - k; i < L; i++) { sx += VX[i]; sy += VY[i]; }
        finalizeBurst(tc, [sx / k, sy / k], tc);
      } else if (bBack >= 2) {
        // the velocity peaked and is coming back: the transition ended at the peak, a new one starts there (back-to-back reversals)
        const v1 = bPkV, tPk = bPkT;
        finalizeBurst(tc, v1, tPk);
        mode = 1; bT0 = tPk; bV0 = v1; bMax = Math.hypot(vx - v1[0], vy - v1[1]); bPkT = tc; bPkV = [vx, vy]; bQuiet = 0; bBack = 0; bProv = false;
        const ex = expectedPlateau();
        bThr = ex ? Math.max(P.dvMin, 0.5 * Math.hypot(ex[0] - v1[0], ex[1] - v1[1])) : P.dvMin;
        bPrevM = bMax; bPrevT = tc;
        if (bMax >= bThr) provisional(tc, vx, vy);
      } else if (tc - bT0 > P.maxBurst) { finalizeBurst(tc, [vx, vy], tc); }
    }
  }

  // ---- rhythm model ------------------------------------------------------------------------------------------------------
  const soft = (e, tol) => (e <= tol ? 1 : e >= 2 * tol ? 0 : 2 - e / tol);
  function stats() {
    // per-parity hold-time statistics + track record of timing and next-velocity predictions
    const n = EZ.length, Lp = [[], []], sT = [[], []], sV = [[], []];
    for (let j = 1; j < n; j++) {
      const D = EZ[j] - EZ[j - 1], pe = (eOff + j) & 1, L = Lp[pe];
      if (L.length >= 1) {
        const rec = L.slice(-4), m = median(rec);
        const inl = rec.filter((d) => Math.abs(d - m) <= 0.35 * m), Dp = inl.length ? inl.reduce((a, b) => a + b, 0) / inl.length : m;
        let ss = 0; for (const d of inl) ss += (d - Dp) * (d - Dp);
        const sp = P.sigPrior * Dp, sgp = Math.max(P.sigFloor, Math.sqrt((P.sigPriorN * sp * sp + ss) / (P.sigPriorN + inl.length - 1)));
        sT[pe].push(Math.max(soft(Math.abs(D - Dp), Math.max(0.05, 2.2 * sgp)), soft(Math.abs(D - 2 * Dp), Math.max(0.08, 3 * sgp))));
        if (j >= 2) {
          const pv = EV[j - 2], av = EV[j], pr = EV[j - 1];
          const err = Math.hypot(av[0] - pv[0], av[1] - pv[1]), tol = Math.max(50, 0.3 * Math.hypot(av[0] - pr[0], av[1] - pr[1]));
          sV[pe].push(soft(err, tol));
        }
      }
      L.push(D);
    }
    const out = { Dm: [0, 0], sd: [0, 0], cnt: [0, 0], skip: [0, 0], rT: [0, 0], rV: [0, 0] };
    for (let p = 0; p < 2; p++) {
      const L = Lp[p].slice(-5), m = L.length ? median(L) : 0;
      const inl = L.filter((d) => Math.abs(d - m) <= 0.35 * m), sk = L.filter((d) => Math.abs(d - 2 * m) <= 0.35 * 2 * m).length;
      out.cnt[p] = inl.length; out.skip[p] = L.length ? sk / L.length : 0;
      if (inl.length) {
        const dm = inl.reduce((a, b) => a + b, 0) / inl.length;
        let ss = 0; for (const d of inl) ss += (d - dm) * (d - dm);
        const sp = P.sigPrior * dm;
        out.Dm[p] = dm; out.sd[p] = Math.max(P.sigFloor, Math.sqrt((P.sigPriorN * sp * sp + ss) / (P.sigPriorN + inl.length - 1)));
      }
      const a = sT[p].slice(-P.rN), b = sV[p].slice(-P.rN);
      out.rT[p] = (a.reduce((x, y) => x + y, 0) + P.rA) / (a.length + P.rA + P.rB);
      out.rV[p] = (b.reduce((x, y) => x + y, 0) + P.rA) / (b.length + P.rA + P.rB);
    }
    return out;
  }

  function buildModel(tO) {
    rm = null;
    const n = EZ.length;
    if (n < 3) return;
    const st = stats(), p0 = (eOff + n) & 1;
    const Dm = [st.Dm[p0], st.Dm[p0 ^ 1]], sd = [st.sd[p0], st.sd[p0 ^ 1]];
    if (!(Dm[0] > 0)) { if (!(Dm[1] > 0)) return; Dm[0] = Dm[1]; sd[0] = 1.6 * sd[1]; }
    if (!(Dm[1] > 0)) { Dm[1] = Dm[0]; sd[1] = 1.6 * sd[0]; }
    const zk = EZ[n - 1];
    const prev = n >= 2 ? EV[n - 2] : VPRE0; if (!prev) return;
    // current plateau: measured velocity once the transition has settled, else the model's expectation
    let cur = EV[n - 1];
    if (mode === 0 && tO - zk > 0.25 && VT.length >= 3) { const L = VT.length; cur = [(VX[L - 1] + VX[L - 2] + VX[L - 3]) / 3, (VY[L - 1] + VY[L - 2] + VY[L - 3]) / 3]; }
    // reliability of the j-th upcoming event (parity alternates), chain probabilities
    const M = 3, rj = [];
    for (let j = 0; j < M; j++) { const p = (p0 + j) & 1; rj.push(clamp(st.rT[p] * st.rV[p], 0, 1)); }
    if (P.force) for (let j = 0; j < M; j++) rj[j] = P.force;
    rj[0] *= P.rCap;
    if (rj[0] < 0.03) return;
    const skp = clamp(Math.max(P.pSkip, st.skip[p0]), 0, 0.4);
    // P(exactly m events happen | at least one): chain
    const chain = []; let acc = 1;
    for (let m = 1; m <= M; m++) { const pm = acc * (m < M ? 1 - rj[m] : 1); chain.push(pm); acc *= m < M ? rj[m] : 1; }
    const tDet = tO - P.detDelay, mu1 = zk + Dm[0];
    let all = 0, valid = 0; const nodes = [];
    for (const g of GN) { const w = Math.exp(-0.5 * g * g), z = mu1 + sd[0] * g; all += w; if (z > tDet) { valid += w; nodes.push({ g, w, skip: false }); } }
    const massOn = valid / all, post = skp / (skp + (1 - skp) * massOn);
    for (const nd of nodes) nd.w = (1 - post) * nd.w / valid;
    for (const [g, w] of [[-1, 0.25], [0, 0.5], [1, 0.25]]) nodes.push({ g: g * 1.4, w: post * w, skip: true });
    const V = [prev, cur, prev, cur, prev, cur];
    rm = { rhoEv: rj[0], zk, nodes, chain, Dm, sd, V, M, mu1 };
    if (opts.probe) opts.probe({ t: tO, n, ev: EZ.slice(-4).map((z) => +z.toFixed(2)), rho: rj[0], D: Dm.map((d) => +d.toFixed(2)), rT: st.rT.map((v) => +v.toFixed(2)), rV: st.rV.map((v) => +v.toFixed(2)) });
  }

  function ramp(t, z, dv) {
    const T2 = Math.max(0.02, dv / accel);
    return clamp((t - z) / T2 + 0.5, 0, 1);
  }
  // event times of a node: f_1.. f_M (cumulative durations alternate Dm[0], Dm[1], ...; the spread grows with sqrt(count))
  function eventTimes(nd) {
    const f = [], Dm = rm.Dm, sd = rm.sd;
    let mu = rm.zk, var2 = 0;
    for (let j = 0; j < rm.M; j++) {
      let d = Dm[j & 1], v = sd[j & 1];
      if (nd.skip && j === 0) { d += Dm[1]; v = Math.hypot(sd[0], sd[1]); }
      mu += d; var2 += v * v;
      f.push(mu + nd.g * Math.sqrt(var2));
    }
    return f;
  }
  function dispOf(f, m, tO, h) {
    // integrate the velocity: previous plateau -> current (ramp at zk) -> then m switches at f[0..m-1]
    const V = rm.V, zk = rm.zk;
    const step = 0.025, n = Math.max(1, Math.ceil(h / step)), dt = h / n;
    const d1 = Math.hypot(V[1][0] - V[0][0], V[1][1] - V[0][1]);
    let dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      const t = tO + (i + 0.5) * dt;
      let ph = ramp(t, zk, d1), vx = V[0][0] + (V[1][0] - V[0][0]) * ph, vy = V[0][1] + (V[1][1] - V[0][1]) * ph;
      for (let j = 0; j < m; j++) {
        const a = V[j + 1], b = V[j + 2];
        ph = ramp(t, f[j], Math.hypot(b[0] - a[0], b[1] - a[1])); vx += (b[0] - a[0]) * ph; vy += (b[1] - a[1]) * ph;
      }
      dx += vx * dt; dy += vy * dt;
    }
    return [dx, dy];
  }


  function baseAt(h) { const a = decay(h); return { x: fit.x + fit.vx * a, y: fit.y + fit.vy * a, w: 1 }; }
  function rhythmHyps(h) {
    const out = [], tEnd = lastT + h;
    for (const nd of rm.nodes) {
      const f = eventTimes(nd);
      let mh = 0; while (mh < rm.M && f[mh] < tEnd) mh++;            // events that matter within the horizon
      let wTail = 0;
      for (let m = 1; m <= rm.M; m++) { if (m < Math.max(1, mh)) { const d = dispOf(f, m, lastT, h); out.push({ x: fit.x + d[0], y: fit.y + d[1], w: nd.w * rm.chain[m - 1] }); } else wTail += rm.chain[m - 1]; }
      const d = dispOf(f, Math.max(1, mh), lastT, h); out.push({ x: fit.x + d[0], y: fit.y + d[1], w: nd.w * wTail });
    }
    return out;
  }
  // the point a solver would aim at: the candidate covering the most weight within the hit radius
  function pickAim(hs) {
    if (hs.length === 1) return hs[0];
    let sw = 0, mx = 0, my = 0, top = hs[0];
    for (const h of hs) { sw += h.w; mx += h.x * h.w; my += h.y * h.w; if (h.w > top.w) top = h; }
    mx /= sw || 1; my /= sw || 1;
    let best = null, bs = -1, bd = 1e18;
    for (let c = 0; c <= hs.length; c++) {
      const cx = c < hs.length ? hs[c].x : mx, cy = c < hs.length ? hs[c].y : my;
      let sc = 0; for (const h of hs) if (Math.hypot(cx - h.x, cy - h.y) < 55) sc += h.w;
      const d = Math.hypot(cx - top.x, cy - top.y);
      if (sc > bs + 1e-9 || (Math.abs(sc - bs) <= 1e-9 && d < bd)) { bs = sc; bd = d; best = { x: cx, y: cy }; }
    }
    return best;
  }
  const lossOf = (e) => 1 / (1 + Math.exp(-(e - P.lossC) / P.lossW));
  function currentRho() {
    // prior from the event-level track record + evidence from realised aiming errors (rhythm vs constant velocity)
    const pr = clamp(rm.rhoEv, 0.1, 0.9);
    const delta = WS > 0 ? (LB - LR) / WS : 0, conf = WS / (WS + P.wHalf);
    const lg = Math.log(pr / (1 - pr)) + P.kappa * delta * conf;
    return P.force ? P.force : P.rCap / (1 + Math.exp(-lg));
  }
  function evaluate(t, x, y) {
    const dec = Math.exp(-(t - lastObsT) / P.tauE);
    if (lastObsT > -Infinity && t > lastObsT) { LR *= dec; LB *= dec; WS *= dec; }
    lastObsT = t;
    while (Q.length && Q[0].tDue <= t + 1e-6) {
      const q = Q.shift();
      LR += lossOf(Math.hypot(q.rx - x, q.ry - y)); LB += lossOf(Math.hypot(q.bx - x, q.by - y)); WS += 1;
    }
    if (rm) {
      const R = pickAim(rhythmHyps(P.hEval)), B = baseAt(P.hEval);
      if (Math.hypot(R.x - B.x, R.y - B.y) > P.infoDist) Q.push({ tDue: t + P.hEval, rx: R.x, ry: R.y, bx: B.x, by: B.y });
    }
  }

  return {
    observe(t, x, y) {
      if (!Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(y)) return;
      if (nObs > 0) {
        const dt = t - lastT;
        if (dt <= 1e-4) { if (dt < -1) reset(); else return; }
        else if (dt > 0.6 || Math.hypot(x - lastX, y - lastY) > 220 + 800 * dt) reset();
      }
      nObs++; lastT = t; lastX = x; lastY = y;
      T.push(t); X.push(x); Y.push(y);
      while (T.length > 2 && t - T[0] > 0.5) { T.shift(); X.shift(); Y.shift(); }
      const f = lsq();
      if (f) { fit = f; processVel(f.tc, f.vx, f.vy); }
      else {
        const n = T.length; fit = { x, y, vx: fit.vx, vy: fit.vy, tc: t };
        let i0 = n - 1; while (i0 > 0 && t - T[i0 - 1] <= P.win) i0--;
        if (n - i0 >= 2 && t - T[i0] >= 0.025) { const d = t - T[i0]; fit.vx = (x - X[i0]) / d; fit.vy = (y - Y[i0]) / d; }
      }
      buildModel(t);
      evaluate(t, x, y);
    },
    predict(h) {
      if (!(h >= 0)) h = 0; else if (h > 4) h = 4;
      const b = baseAt(h);
      if (!rm) return [b];
      const rho = currentRho();
      if (rho < 0.02) return [b];
      const out = rhythmHyps(h);
      for (const o of out) o.w *= rho;
      if (rho < 0.999) { b.w = 1 - rho; out.push(b); }
      return out;
    },
    onShot() {},
    reset,
  };
}
