# Diep Assist

A Tampermonkey userscript for a **private diep.io-style server you run yourself**: natural-looking predictive auto-aim
that goes for the right tank, auto-fire, ESP, shape farming, an auto-build scheduler and quality-of-life tools.
It refuses to run on the public `diep.io` (any `*.diep.io` host) - keep it that way, it is for your own server.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Create a new script and paste in `diep-assist.user.js`.
3. Edit the `@match` lines at the top so they cover **only your server** (`localhost` / `127.0.0.1` are already there;
   replace `YOUR-PRIVATE-SERVER.example`). Tampermonkey injects at `document-start`, which the canvas hooks need.
4. Open the game. **Insert** shows/hides the menu.

| Default key | Action | | Default key | Action |
|---|---|---|---|---|
| `\` | auto aim | | `,` | pin / unpin the current target |
| `[` | auto fire | | `.` | next target in the ranking |
| `]` | ESP | | `End` | clean view (hides every overlay and the menu) |
| `;` | farm shapes | | `Delete` | master switch |
| `'` | prediction | | `Insert` | menu |

Every key can be rebound in the **Misc** tab.

## What it does

**Picks the right tank.** *Who to shoot* (Targets tab): *Smart* (default) weighs who is shooting at you, how strong the tank
is (score), how hurt it is, and how near; or choose *highest score*, *lowest health*, *whoever shoots at me*, *closest to my
tank*, *closest to my mouse*. Scores come from the leaderboard (matched to nameplates), health from the health bars (the last
fraction seen is kept when a bar fades), and a size-based level estimate fills the gaps. *Ignore small fry* skips low-score
tanks while something much stronger is around - unless the small one is the one fighting you - so a 300-score bot no
longer steals the lock while you duel a stronger player. A challenger has to stay better for a moment before the lock moves.
Pin (`,`) or cycle (`.`) to decide yourself; list names under *Never target*.

**Natural motion.** The cursor is driven in polar coordinates around your tank through two critically damped followers:
swings start and end gently (bell-shaped speed, no snap), take the short way round, begin after a short reaction delay, and
tracking has a slow human wander that stays inside the tank. *Lock-on style* presets: Natural / Quick / Instant; *Assist
strength* blends with your own mouse; *Assist* activation only helps with tanks near where you point; a hard flick of the real
mouse takes the barrel back for a moment. `node test/trace.mjs out.png` draws the barrel angle and speed over time.

**Prediction.** Enemies are tracked in world coordinates (the camera is read from the background grid, zoom-safe, and cross-checked
with shapes); the aim point is where your bullet and the tank meet, using the bullet flight profile and the loop latency
measured from your own shots. On top of that, each tank has a small learner (*Learn rhythm and dodging*):
* a **strafing beat** (A/D spam) is detected from direction reversals and projected forward, with the centre of the swing as a
  second guess; it is scored against plain constant velocity on that very tank, so a tank without a beat gets weight 0;
* a tank that **dodges your bullets** (sideways velocity change after a bullet appears, tested against the same measurement
  along the bullet path) gets "dodges / keeps dodging" guesses; the favoured side is recorded but is the weakest part.

`bench/RESULTS.md` has the numbers: on simulated opponents, +20 points against beat-strafers and +5 against dodgers, nothing worse
elsewhere - *simulated*, see "What is verified" below. The status line shows `beat 0.55s` / `dodges 70%` when something was learned.

**Strength presets** (Aim tab): Off / Assist / Smart / Full - handy when the aim is a perk that unlocks in steps.
**Auto fire** toggles the game's own auto-fire (`E`) or holds Space, only while locked on and likely to land.
**Farm mode** aims at shapes when no enemy is in range. **Auto build** schedules the stat order (`game_stats_build` or `U`+digits).
**ESP**: rings, distances, predicted path, aim point, off-screen arrows, incoming-bullet warnings, name/score/health labels.
**Comfort**: safe click zones on the upgrade panels, aim pauses over the menu, auto respawn, settings export/import and
three profiles, `ren_*` / `net_predict_movement` toggles, a diagnostics report, and a plain-language "why nothing happens" line
(Misc tab, and on screen when no tank is found).

`window.diepAssist` exposes the config and state (`diepAssist.set('aim', true)`, `.tier('assist')`, `.why()`, `.report()` ...).

## If it does not see your game (read this first)

The drawing of the real client is only partly known. What was recorded from a real frame (`test/fixtures/client-probe-partial.json`):
one `clearRect` per frame, paths whose points are already in canvas pixels, shapes filled twice then stroked with a darker colour
under a scaled pen transform, the grid as a 50-unit `CanvasPattern` fill, translucent team bases, small team-coloured triangles.
**No real frame with a tank body, barrels, text or health bar has been captured yet** - those parts are assumed (a filled and stroked
circle for a body, grey `#999999` polygons drawn before it for barrels, `fillText` / offscreen text for names, `#85e37d` / `#555555`
bars for health) and the script has fallbacks (a round object at the screen centre is taken as your tank).

If the status says it cannot find your tank:
1. Spawn into the game with a tank on screen and some other tank or the leaderboard visible.
2. **Misc -> Record 2 frames to a file.** It saves *every* canvas call of two complete frames, including the offscreen canvases
   the game draws into, with only the changed state per call.
3. Replay it offline with `node test/replay.mjs diep-frames-*.json` (prints what the script made of it), or send the file to
   whoever maintains the script. `node test/replay-check.mjs` replays the fixtures and a recorder round trip.

Other knobs: *Visuals -> Debug info* (zoom, camera source, counts), *Latency compensation* (used until measured), *Bullets
inherit my velocity* (if shots miss only while you strafe), the other *Fire method* if auto fire does nothing.

## What is verified (and what is not)

* **Real data:** the recorded frame above replays without errors; the grid (zoom 0.406, 50-unit tile), the ignored translucent
  bases and the 30 small polygons are read as expected (`test/replay-check.mjs`).
* **Mock arena (my own, not real):** `test/mock-diep.html` draws in three styles (`real` = the recorded path style, `xform`, `legacy`),
  optionally with text in offscreen canvases, circles as polygons, drones, a breathing zoom and a rough network. Feature checks
  (`features.mjs` 28, `features2.mjs` 33, `replay-check.mjs` 21) pass in every style.
* **Benchmark opponents (my own, not real):** `bench/` - see `bench/RESULTS.md`.
* **Not verified:** anything involving a real tank/barrel/text/health-bar frame, real server timing, or real players' dodging.

## Tests (no game server needed)

```
npm install && npx playwright install chromium
npm test                       # features.mjs + features2.mjs + replay-check.mjs
node test/run.mjs              # hit-rate + smoothness matrix (--baseline old.js to compare)
node test/lockon.mjs           # lock-on speed / acceleration / jerk
node test/trace.mjs out.png    # barrel angle + speed plot
node test/ab.mjs               # prediction learner on / off in the mock
node bench/sweep.mjs adaptive mild 16 100   # predictor benchmark
```
`DIEP_SCRIPT=path/to/script.js` picks the script under test and `DIEP_QUERY="style=xform&textmode=offscreen"` the mock's draw style.

## Layout

`diep-assist.user.js` the script (one file, sections 1-16 - hooks, world model, aim solver, cursor control, build, UI) -
`bench/` predictor benchmark and the learner's source of truth (`predictors/adaptive.mjs`, embedded by `bench/embed.py`) -
`test/` mock arena, tests, recorded fixtures.
