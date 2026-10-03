# Prediction benchmark results

`node bench/sweep.mjs baseline|adaptive <noise> <seeds> <seed-base>` — hit rate of a stationary shooter firing every 0.25 s at the
point a predictor picks, against simulated human-like movers (see README.md here). **These are simulated opponents I wrote, not
recordings of players**, so read them as "does the idea work in principle" and not as a promise for your server.

16 seeds, seed base 100 (never used for tuning), mean hit % per behaviour:

| behaviour | baseline (constant velocity, fading persistence) | adaptive (rhythm + dodge learning) |
| --- | ---: | ---: |
| periodic strafing (A/D beat) | 44 | 64–68 |
| reactive-periodic (beat + dodges bullets) | 36–40 | 41–43 |
| reactive-linear (dodges) | 42 | 47–50 |
| reactive-stopgo (dodges) | 43 | 42–44 |
| reactive-random | 44–46 | 44–47 |
| reactive-circle | 69 | 69–71 |
| linear / circle / still / kite / random / stopgo / figure8 | unchanged | unchanged (within ±0.5) |
| **mean of 13 behaviours** | **66.2–66.8** | **68.7–69.5** |

What it learns, per tracked enemy:

* **Strafing rhythm** — direction reversals are detected from the fitted velocity; when the last intervals agree the next
  reversals are projected forward and the centre of the swing is offered as a second guess. The weight is scored against plain
  constant velocity on this very target (0.45 s ahead), so a target without a beat gets weight 0. This is where the gain is.
* **Dodging** — every bullet that threatens the target opens an "episode". A sharp sideways velocity change early in the episode is a
  dodge; the same measurement *along* the bullet path is the control (someone who just changes direction at random does both equally
  often). Only a target that sidesteps significantly more often than it changes speed (sign test, z >= 2.2) gets dodge guesses.
  Simulated dodgers are separated from random movers cleanly (sideways 50-110 vs along 0-14 events; random movers 25 vs 25).
* **Which side** — recorded and shown, but it is the weakest part: in the simulation it follows the true favourite side in about
  half the seeds and is no better than a coin flip in the rest, so it only shapes the weights (it never overrides the evidence
  that a dodge happens).

Not shown by the numbers: how real players behave. The simulated dodgers react after 0.14–0.3 s and always sidestep perpendicular to
the bullet; real players mix this with ordinary strafing. Use Aim -> "Learn rhythm and dodging" to switch it off, and the status
line shows `beat 0.55s` / `dodges 70%` when something has been learned about the current target.
