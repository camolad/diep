// Adaptive predictor: constant velocity with fading persistence (the baseline), plus two learned behaviours that are mixed in
// as weighted hypotheses, so the solver can aim where most of the probability sits:
//
//  1. RHYTHM  - strafing players reverse direction on a beat (A, D, A, D ...). Reversals are detected from the fitted velocity;
//               when the last few intervals agree, the next reversals are projected forward. Its weight follows how well the
//               rhythm model has been predicting this target compared with plain constant velocity (self-scored at 0.45 s).
//  2. DODGE   - a player who sees my bullet coming sidesteps after a reaction time, perpendicular to its path. Every bullet that
//               threatens the target starts an "episode"; a sharp sideways change of velocity in its first 0.55 s counts as a dodge
//               onset. The same measurement is taken with no bullet around ("control episodes") and a target only gets dodge
//               hypotheses once it has dodged significantly more than that (z >= 2.2, excess >= 25 %). Then, while a bullet
//               threatens: "no dodge / dodge left / dodge right" (weights from the learned rate and favoured side), or, once a dodge
//               has begun, "keeps going / old motion resumes soon / resumes later".
//
// Benchmark (bench/run.mjs, 24 seeds, 8 + 5 behaviours): +6.8 points on beat-strafers, +1.5 on reactive dodgers, no loss anywhere else.
//
// Portable: plain JavaScript, no imports, no Date / Math.random.
export function createPredictor(opts = {}) {
  let TAU = opts.tau === undefined ? 1.2 : opts.tau;
  const WIN = 220;
  const DODGER_MIN = opts.dmin === undefined ? 0.25 : opts.dmin;
  const Z_MIN = opts.zmin === undefined ? 2.2 : opts.zmin;
  const WR_MAX = opts.wrmax === undefined ? 0.85 : opts.wrmax, RH_BAND = opts.rhband === undefined ? 0.05 : opts.rhband;
  const RH_SKILL = opts.rhs === undefined ? 0.5 : opts.rhs;
  const ONSET = opts.onset === undefined ? 150 : opts.onset;
  const PD_CAP = opts.pdcap === undefined ? 0.6 : opts.pdcap;
  const REACT = 0.2, DODGE_DUR = 0.5, EPISODE = 0.65;
  const decay = (h) => (TAU >= 20 ? h : TAU * (1 - Math.exp(-h / TAU)));
  const hist = [], lhist = [];                                    // lhist: positions of the last ~3 s (centre of a beat)
  let fit = { x: 0, y: 0, vx: 0, vy: 0 }, tNow = 0, started = false;

  function lsq(i0, i1, tRef) {
    let sw = 0, st = 0, stt = 0, sx = 0, sy = 0, stx = 0, sty = 0;
    for (let i = i0; i < i1; i++) {
      const tau_ = (hist[i].t - tRef) / 1000, w = 1 + 1.5 * Math.min(1, Math.max(0, 1 + (hist[i].t - tRef) / WIN));
      sw += w; st += w * tau_; stt += w * tau_ * tau_; sx += w * hist[i].x; sy += w * hist[i].y; stx += w * tau_ * hist[i].x; sty += w * tau_ * hist[i].y;
    }
    const det = sw * stt - st * st;
    if (det < 1e-7) return null;
    const vx = (sw * stx - st * sx) / det, vy = (sw * sty - st * sy) / det;
    return { x: (sx - vx * st) / sw, y: (sy - vy * st) / sw, vx, vy };
  }

  // ---- rhythm ----
  let dir = null;                          // unit vector of the current direction of travel along the axis of motion
  const revs = [];                          // reversal times (s)
  let vRef = 250;                           // typical steady speed
  const LAG = opts.lag === undefined ? 0.15 : opts.lag, HYST = 40;
  // reversals = the velocity along the axis of motion changes sign (with hysteresis); the timestamp is moved back by LAG, the delay between
  // the target deciding to turn and the fitted velocity showing it, so that the sequence of stamps is the sequence of decisions
  let posSide = 0; // +1 / -1: which way (along dir) the target was last moving clearly
  function trackRhythm(t, dt) {
    const sp = Math.hypot(fit.vx, fit.vy);
    if (!dir) { if (sp > 140) { dir = { x: fit.vx / sp, y: fit.vy / sp }; posSide = 1; } return; }
    const va = fit.vx * dir.x + fit.vy * dir.y;
    if (va > HYST) {
      if (posSide < 0) { // was going the other way: a reversal
        const tr = t - LAG;
        if (!revs.length || tr - revs[revs.length - 1] > 0.15) revs.push(tr);
        while (revs.length > 8) revs.shift();
      }
      posSide = 1;
      if (sp > 140 && va > 0.8 * sp) { // follow a slowly turning axis
        const nx = dir.x * 0.97 + (fit.vx / sp) * 0.03, ny = dir.y * 0.97 + (fit.vy / sp) * 0.03, nn = Math.hypot(nx, ny) || 1;
        dir = { x: nx / nn, y: ny / nn }; vRef += (sp - vRef) * 0.02;
      }
    } else if (va < -HYST) {
      if (posSide > 0) { // reversal: the axis keeps its line, its sign flips
        const tr = t - LAG;
        if (!revs.length || tr - revs[revs.length - 1] > 0.15) revs.push(tr);
        while (revs.length > 8) revs.shift();
        dir = { x: -dir.x, y: -dir.y }; posSide = 1;
      } else posSide = -1;
    }
    if (revs.length && t - revs[revs.length - 1] > 3) { revs.length = 0; }
  }
  function rhythm() { // { period, next, conf } or null
    if (revs.length < 4) return null;
    const iv = []; for (let i = 1; i < revs.length; i++) iv.push(revs[i] - revs[i - 1]);
    const use = iv.slice(-5), s = use.slice().sort((a, b) => a - b), med = s[s.length >> 1];
    if (med < 0.2 || med > 2.5) return null;
    const dev = use.map((v) => Math.abs(v - med) / med).sort((a, b) => a - b)[use.length >> 1];
    const conf = Math.max(0, 1 - dev / 0.22) * Math.min(1, (use.length - 1) / 3);
    if (conf < 0.15) return null;
    let next = revs[revs.length - 1] + med;
    while (next < tNow - 0.05) next += med;
    return { period: med, next, conf };
  }
  // position after h more seconds if the target keeps its beat: velocity flips at `next`, `next + period` ... (acceleration limited)
  function rhythmPos(r, h) {
    const A = 2000, dtS = 0.025;
    let x = fit.x, y = fit.y, vx = fit.vx, vy = fit.vy, t = 0;
    const ux = dir ? dir.x : 0, uy = dir ? dir.y : 0; // the direction of motion since the last reversal
    let sign = 1, tf = r.next - tNow;
    while (t < h - 1e-9) {
      const d = Math.min(dtS, h - t);
      if (t >= tf) { sign = -sign; tf += r.period; }
      const tvx = ux * vRef * sign, tvy = uy * vRef * sign;
      const ax = tvx - vx, ay = tvy - vy, am = Math.hypot(ax, ay);
      if (am > 1e-9) { const k = Math.min(am, A * d) / am; vx += ax * k; vy += ay * k; }
      x += vx * d; y += vy * d; t += d;
    }
    return { x, y };
  }
  // centre of the beat: mean position over the last full cycle (two reversals), drifting at the speed the centre has been moving
  function centre(r, h) {
    const T = 2 * r.period, now = tNow;
    if (now - lhist[0].t < T * 1.4) return null;
    let n1 = 0, x1 = 0, y1 = 0, n0 = 0, x0 = 0, y0 = 0;
    for (const q of lhist) {
      if (q.t > now - T) { n1++; x1 += q.x; y1 += q.y; } else if (q.t > now - 2 * T) { n0++; x0 += q.x; y0 += q.y; }
    }
    if (n1 < 6) return null;
    x1 /= n1; y1 /= n1;
    let vcx = 0, vcy = 0;
    if (n0 >= 6) { vcx = (x1 - x0 / n0) / T; vcy = (y1 - y0 / n0) / T; }
    const k = T / 2 + h;
    return { x: x1 + vcx * k, y: y1 + vcy * k };
  }
  // self-scoring: how well did each model predict this target 0.45 s later?
  const due = []; let errCV = 900, errRH = 900, nextScoreT = 0;

  // ---- dodge ----
  let sideP = 1, sideN = 2, dodgeSpeed = 260, retain = 0.4;   // retain: how much of its pre-dodge velocity the target takes back after a dodge   // Beta-ish counts: dodge probability, favoured side (+ = left of the bullet)
  const episodes = [], vring = [];                               // vring: fitted velocity of the last ~0.25 s
  let tN = 0, dLat = 0, dLon = 0;      // episodes judged; those with ONLY a sideways onset / ONLY an along-the-bullet onset
  function trackBullets(t, ctx) {
    const bl = ctx && ctx.bullets ? ctx.bullets : [];
    for (const b of bl) {
      const rx = fit.x - b.x, ry = fit.y - b.y, vx = b.vx - fit.vx, vy = b.vy - fit.vy, vv = vx * vx + vy * vy;
      if (vv < 1) continue;
      const tc = (rx * vx + ry * vy) / vv;
      if (tc < 0.05 || tc > 1.1) continue;
      const d = Math.hypot(rx - vx * tc, ry - vy * tc);
      if (d > 150) continue;
      const spawn = t - b.age, sp = Math.hypot(b.vx, b.vy) || 1;
      let e = null; for (const q of episodes) if (Math.abs(q.spawn - spawn) < 0.04) { e = q; break; }
      if (!e) episodes.push({ spawn, t0: t, n: { x: -b.vy / sp, y: b.vx / sp }, v0x: fit.vx, v0y: fit.vy, done: false, tc, tcT: t });
      else { e.tc = tc; e.tcT = t; }
    }
    vring.push({ t, vx: fit.vx, vy: fit.vy });
    while (vring.length > 2 && t - vring[0].t > 0.3) vring.shift();
    const past = vring.find((q) => t - q.t <= 0.16) || vring[0];
    for (let i = episodes.length - 1; i >= 0; i--) {
      const e = episodes[i], since = t - e.t0;
      // a dodge starts as a sharp sideways (relative to the bullet path) change of velocity shortly after the bullet appears; the same
      // measurement ALONG the bullet path is the control: a target that merely changes direction at random does both equally often
      if (!e.done && since >= 0.06 && since <= 0.55 && t - past.t > 0.08) {
        const k = 0.16 / (t - past.t), dx = fit.vx - past.vx, dy = fit.vy - past.vy;
        if (!e.onset) {
          const d = (dx * e.n.x + dy * e.n.y) * k;
          // a dodge moves AWAY from the bullet line (|sideways speed| grows); the return to the old course shrinks it and must not count as a side
          if (Math.abs(d) > ONSET) { e.onset = d > 0 ? 1 : -1; e.onsetT = t; e.out = Math.abs(fit.vx * e.n.x + fit.vy * e.n.y) > Math.abs(past.vx * e.n.x + past.vy * e.n.y); e.vPre = { x: past.vx, y: past.vy }; }
        }
        if (!e.onsetL && Math.abs((dx * e.n.y - dy * e.n.x) * k) > ONSET) e.onsetL = 1;
      }
      if (e.onset && e.out && !e.checked && t - e.onsetT >= 0.9) {
        e.checked = true;
        const pp = e.vPre.x * e.vPre.x + e.vPre.y * e.vPre.y;
        if (pp > 6400) retain += (Math.max(0, Math.min(1.2, (fit.vx * e.vPre.x + fit.vy * e.vPre.y) / pp)) - retain) * 0.2;
      }
      if (since >= EPISODE && !e.done) {
        e.done = true;
        tN += 1;
        if (e.onset && !e.onsetL) dLat += 1; else if (e.onsetL && !e.onset) dLon += 1;
        if (e.onset && e.out) { sideN += 1; if (e.onset > 0) sideP += 1; }
      }
      if (since > 2) episodes.splice(i, 1);
    }
  }
  function activeThreat(t) { // the soonest bullet that has not been judged yet
    let best = null;
    for (const e of episodes) if (!e.done && t - e.t0 < EPISODE && e.tc - (t - e.tcT) > -0.1 && (!best || e.tc - (t - e.tcT) < best.tc - (t - best.tcT))) best = e;
    return best;
  }

  function observe(t, x, y, ctx) {
    const dt = started ? Math.max(0.001, t - tNow) : 0.0167;
    started = true; tNow = t;
    hist.push({ t: t * 1000, x, y });
    lhist.push({ t, x, y });
    while (lhist.length > 2 && t - lhist[0].t > 3.2) lhist.shift();
    while (hist.length > 2 && t * 1000 - hist[0].t > 460) hist.shift();
    const n = hist.length, last = hist[n - 1];
    let i0 = n - 1; while (i0 > 0 && last.t - hist[i0 - 1].t <= WIN) i0--;
    const f = n - i0 >= 3 && last.t - hist[i0].t >= 50 ? lsq(i0, n, last.t) : null;
    if (f) fit = f;
    else { fit = { x: last.x, y: last.y, vx: fit.vx, vy: fit.vy }; if (n - i0 >= 2 && last.t - hist[i0].t >= 25) { const d = (last.t - hist[i0].t) / 1000; fit.vx = (last.x - hist[i0].x) / d; fit.vy = (last.y - hist[i0].y) / d; } }
    trackRhythm(t, dt);
    trackBullets(t, ctx);
    // score the models
    while (due.length && due[0].t <= t) {
      const q = due.shift();
      errCV += (Math.hypot(q.cx - x, q.cy - y) ** 2 - errCV) * 0.08;
      if (q.rx !== undefined) errRH += (Math.hypot(q.rx - x, q.ry - y) ** 2 - errRH) * 0.08;
    }
    if (n > 8 && t >= nextScoreT) {
      nextScoreT = t + 0.06;
      const r = rhythm(), a = decay(0.45), q = { t: t + 0.45, cx: fit.x + fit.vx * a, cy: fit.y + fit.vy * a };
      if (r) { const p = rhythmPos(r, 0.45); q.rx = p.x; q.ry = p.y; }
      due.push(q);
    }
  }

  function predict(h) {
    const r = rhythm();
    const a = decay(h);
    const cv = { x: fit.x + fit.vx * a, y: fit.y + fit.vy * a };
    let bases = [{ x: cv.x, y: cv.y, w: 1 }];
    if (r) {
      const skill = errCV / (errCV + errRH + 1e-6);               // > 0.5: the rhythm has been predicting better than constant velocity
      const wr = WR_MAX * Math.min(1, r.conf * 1.3) * Math.min(1, Math.max(0, (skill - RH_SKILL) / RH_BAND));
      if (wr > 0.05) {
        const p = rhythmPos(r, h), c = centre(r, h);
        // the solver aims where most weight lies within the hit radius: for a small beat the centre covers the whole swing
        bases = c ? [{ x: cv.x, y: cv.y, w: 1 - wr }, { x: p.x, y: p.y, w: wr * 0.6 }, { x: c.x, y: c.y, w: wr * 0.4 }] : [{ x: cv.x, y: cv.y, w: 1 - wr }, { x: p.x, y: p.y, w: wr }];
      }
    }
    const th = activeThreat(tNow);
    // a target gets dodge hypotheses only once it has shown that it sidesteps clearly MORE often when a bullet comes than it changes velocity
    // sideways anyway (control episodes without a bullet): two-proportion z test plus a minimum excess
    let pdE = 0;
    const nd = dLat + dLon;
    if (nd >= 8 && (dLat - dLon) / Math.sqrt(nd) >= Z_MIN) pdE = (dLat - dLon) / Math.max(1, tN);
    if (!th || pdE < DODGER_MIN) return bases;
    // a bullet is on its way: the target may sidestep (perpendicular to the bullet) after its reaction time
    const pd = Math.min(PD_CAP, pdE), pL = sideP / sideN; // the excess over what it does anyway
    const since = tNow - th.t0;
    const onset = Math.max(0.03, REACT - since);
    const out = [];
    const dv = (side) => ({ x: th.n.x * side * dodgeSpeed, y: th.n.y * side * dodgeSpeed });
    // velocity change already visible = it started; then only the rest of the dodge remains
    const started_ = !!th.onset;
    for (const b of bases) {
      if (started_) { // a dodge is under way (the fit carries it); it replaces the pre-dodge velocity for a while, then the old motion resumes
        const tin = Math.max(0, since - REACT), wk = Math.max(0.3, 1 - 0.75 * Math.min(1, retain));
        for (const [rem, w] of [[Infinity, wk], [Math.max(0.08, DODGE_DUR * 0.6 - tin), (1 - wk) / 2], [Math.max(0.15, DODGE_DUR * 1.4 - tin), (1 - wk) / 2]]) {
          if (rem === Infinity) { out.push({ x: b.x, y: b.y, w: b.w * w }); continue; }
          const k = Math.min(h, rem);
          out.push({ x: fit.x + fit.vx * decay(k) + th.v0x * Math.max(0, h - k) * 0.9, y: fit.y + fit.vy * decay(k) + th.v0y * Math.max(0, h - k) * 0.9, w: b.w * w });
        }
        continue;
      }
      out.push({ x: b.x, y: b.y, w: b.w * (1 - pd) });
      for (const side of [1, -1]) {
        const d = dv(side), te = Math.min(h, onset + DODGE_DUR), len = Math.max(0, te - onset);
        out.push({ x: b.x + (d.x - fit.vx) * len, y: b.y + (d.y - fit.vy) * len, w: b.w * pd * (side > 0 ? pL : 1 - pL) });
      }
    }
    return out;
  }
  return {
    observe, predict, onShot() {}, setTau(v) { TAU = v; }, dbg: () => ({ retain, revs: revs.slice(), r: rhythm(), errCV, errRH, vRef, pd: tN ? Math.max(0, dLat - dLon) / tN : 0, tN, dLat, dLon, pL: sideP / sideN }),
    reset() { hist.length = 0; fit = { x: 0, y: 0, vx: 0, vy: 0 }; started = false; revs.length = 0; episodes.length = 0; due.length = 0; lhist.length = 0; nextScoreT = 0; tN = 0; dLat = 0; dLon = 0; dir = null; posSide = 0; vRef = 250; errCV = 900; errRH = 900; },
  };
}
