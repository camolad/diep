// The predictor the userscript used before this work: weighted least-squares line over the last 0.22 s,
// then straight-line motion with exponentially fading persistence (tau seconds). Portable: plain JS, no imports.
export function createPredictor(opts = {}) {
  const tau = opts.tau === undefined ? 1.2 : opts.tau;
  const WIN = 220;
  const hist = [];
  let fit = { x: 0, y: 0, vx: 0, vy: 0 };
  const decay = (h) => (tau >= 20 ? h : tau * (1 - Math.exp(-h / tau)));
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
  return {
    observe(t, x, y) {
      hist.push({ t: t * 1000, x, y });
      while (hist.length > 2 && t * 1000 - hist[0].t > 460) hist.shift();
      const n = hist.length, last = hist[n - 1];
      let i0 = n - 1; while (i0 > 0 && last.t - hist[i0 - 1].t <= WIN) i0--;
      const f = n - i0 >= 3 && last.t - hist[i0].t >= 50 ? lsq(i0, n, last.t) : null;
      if (f) fit = f;
      else { fit = { x: last.x, y: last.y, vx: fit.vx, vy: fit.vy }; if (n - i0 >= 2 && last.t - hist[i0].t >= 25) { const d = (last.t - hist[i0].t) / 1000; fit.vx = (last.x - hist[i0].x) / d; fit.vy = (last.y - hist[i0].y) / d; } }
    },
    predict(h) { const a = decay(h); return [{ x: fit.x + fit.vx * a, y: fit.y + fit.vy * a, w: 1 }]; },
    onShot() {},
    reset() { hist.length = 0; fit = { x: 0, y: 0, vx: 0, vy: 0 }; },
  };
}
