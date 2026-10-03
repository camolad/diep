# Dodge-prediction benchmark

`node bench/run.mjs --pred baseline,<name> --seeds 16 [--noise clean|mild|rough] [--held-out] [--behaviors a,b]`

Closed loop: a stationary shooter fires every 0.25 s at the point chosen by `solveAim` (sim.mjs) from a predictor's
hypotheses; the target (behaviors.mjs) moves like a human and can *see the shooter's bullets and dodge them* after a
reaction time (200-300 ms), sidestepping perpendicular to the bullet path, usually towards a favourite side.

## Predictor interface (predictors/<name>.mjs)

```js
export function createPredictor(opts) {          // opts = { seed }
  return {
    observe(t, x, y, ctx) {},   // every 60 Hz frame. t seconds (monotonic). (x, y) = where the target is DRAWN (true position
                                //   0.06 s ago + noise). ctx = { me:{x,y,vx,vy}, bullets:[{x,y,vx,vy,age}] } the shooter's own
                                //   bullets as drawn (also 0.06 s late). World coordinates, shooter at the origin.
    predict(h) { return [{ x, y, w }]; },  // where the target will be h seconds after the LAST observation.
                                //   One or several weighted hypotheses (w sum ~ 1). solveAim aims at the hypothesis that
                                //   covers the most weight within the hit radius (65 u), then iterates the bullet flight time.
    onShot(t, ax, ay) {},       // the shooter just dispatched an aim point (the bullet leaves 0.06 s later) - learn from it
    reset() {},
  };
}
```

Rules: plain JavaScript, no imports, no Date/Math.random (use opts.seed if randomness is needed), only `Math`.
The file must be portable: it will be pasted inside the userscript's IIFE after stripping `export`.
Per-frame cost must stay tiny (observe + a few predict calls per frame at 60 Hz, for a handful of tracked targets).
State per target: the userscript creates one predictor per tracked enemy tank.

`predictors/baseline.mjs` is the current production predictor (constant velocity with fading persistence).
Score = mean hit rate over behaviors. Do not regress on `linear`, `circle`, `still`, `kite` (simple behaviours must stay >= baseline - 1 point).
Use `--held-out` (behaviours never used for tuning) and different `--seed-base` values to check you are not over-fitting.
