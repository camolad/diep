# Diep Assist

A Tampermonkey userscript for a **private diep.io-style server you run yourself**: smooth predictive auto-aim,
auto-fire, ESP, shape farming, an auto-build scheduler and a few quality-of-life tools. It refuses to run on the
public `diep.io`.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Create a new script and paste in `diep-assist.user.js`.
3. Edit the `@match` lines at the top so they cover only your server (`localhost` is already there).
4. Open the game. **Insert** shows/hides the menu.

| Default key | Action | | Default key | Action |
|---|---|---|---|---|
| `\` | auto aim | | `;` | farm shapes |
| `[` | auto fire | | `'` | prediction |
| `]` | ESP | | `Delete` | master switch |

All keys can be rebound in the **Misc** tab.

## What it does

- **Natural lock-on.** The cursor is driven in polar coordinates around your tank through two critically damped
  followers: a swing starts and ends gently (bell-shaped speed, no snap), always takes the short way round, and
  carries on at the speed your real mouse had. A short reaction delay and a wait for a usable velocity estimate
  stop a lock from jerking when a tank first appears. *Lock-on style* presets: Natural / Quick / Instant.
- **Prediction.** Enemies are tracked in world coordinates (the camera is followed through the background grid
  and the shapes). Each gets a weighted least-squares position/velocity fit; the aim point is where your bullet
  and the tank meet, using the bullet flight profile measured from your own shots. Motion is assumed to persist
  for a limited time (*prediction persistence*), the way real players keep changing course.
- **Measured latency.** Every bullet leaves in the direction the cursor pointed one loop-latency earlier, so
  matching a bullet's flight direction against the cursor history measures render + input delay directly
  (needs a moving cursor, e.g. while tracking). The lead uses the measurement instead of the slider. On the mock
  arena this took a circling target from 9% hits (latency wrong by 140 ms) to 97%.
- **Auto fire.** Toggles the game's own auto-fire (`E`) or holds Space, only while locked on, aimed, and the shot
  is likely to land (confidence, flight time and aim error gates).
- **Farm mode.** With no enemy in range, aims at the nearest (or most valuable) shape.
- **Auto build.** Pick how many points go in each stat (or a preset); the script schedules the upgrade order
  (balanced or one stat at a time), shows a level-by-level timeline, and queues it with the game's
  `game_stats_build` console command (or, without a console, by holding `U` and pressing the stat keys).
  *Re-apply on every respawn* keeps it going across lives.
- **ESP.** Rings, distances, predicted path, aim point, off-screen arrows (also where an enemy that just left
  the view should be) and incoming-bullet warnings.
- **Comfort.** Real clicks on the upgrade panels are never aimed away, aim pauses while the pointer is over the
  menu, auto respawn, and toggles for the game's `ren_fps`, `ren_debug_collisions`, `ren_raw_health_values`,
  `ren_ui` and `net_predict_movement`.

`window.diepAssist` exposes the live config (`diepAssist.set('aim', true)`, `diepAssist.cfg`, ...) for other code.

## If something does not line up on your server

Turn on **Visuals → Debug info**. It shows the detected zoom, how the camera is being followed (`grid` /
`shapes` / `dead`), how many tanks and shapes were recognised and how many shots the latency tuner has seen.

- Shots land consistently ahead of / behind a moving target: raise / lower *Latency compensation* (or let the
  tuner work), and try *Bullets inherit my velocity* if it only happens while you strafe.
- Auto fire does nothing: try the other *Fire method*.
- Nothing is recognised: the server's client draws differently from the assumptions listed in the header of
  `diep-assist.user.js`.

## Tests (no game server needed)

`test/mock-diep.html` is a small stand-in arena that draws the way the script expects (grey barrels then a
border + body circle, polygon shapes, a wrapped grid pattern, 30 Hz snapshots with render and input delay).

```
npm install && npx playwright install chromium
npm test                  # feature checks: hotkeys, build, auto-fire, farm, safe zones, flash, diep.io guard ...
node test/run.mjs         # hit rate + smoothness matrix (add --baseline old.js to compare versions)
node test/lockon.mjs      # lock-on speed / acceleration / jerk (add label=old.js to compare versions)
```
