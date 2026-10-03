// Feature checks for diep-assist.user.js against the mock arena (hotkeys, build scheduler, auto-fire, farm mode,
// click safe zones, menu pause, hit-flash robustness, diep.io guard, menu screenshots).
//
//   node test/features.mjs [--shots dir]
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.DIEP_SCRIPT ? path.resolve(process.env.DIEP_SCRIPT) : path.resolve(here, '..', 'diep-assist.user.js');
const args = process.argv.slice(2);
const shotsDir = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;

const server = http.createServer((req, res) => {
  fs.readFile(path.join(here, 'mock-diep.html'), (err, data) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(data); });
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch({ headless: true });

let pass = 0, failed = 0;
const check = (name, ok, detail = '') => { (ok ? pass++ : failed++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };

async function open(query = 'pattern=still', cfg = {}, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: opts.dpr || 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // precision checks run without the deliberate human wander unless a test asks for it
  await page.addInitScript((c) => { try { localStorage.setItem('diepAssist.v2', JSON.stringify(c)); } catch (e) { /* ignore */ } }, { human: 0, ...cfg });
  await page.addInitScript({ path: SCRIPT });
  await page.goto(`http://localhost:${port}/mock-diep.html?${query}${process.env.DIEP_QUERY ? '&' + process.env.DIEP_QUERY : ''}`);
  return { page, ctx, errors };
}
const angleTo = (st, e) => Math.atan2(e.y - st.player.y, e.x - st.player.x);
const diffDeg = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) * 180 / Math.PI;

/* 1. basic lock + no page errors */
{
  const { page, ctx, errors } = await open('pattern=still', {});
  await page.mouse.move(300, 500);
  await page.waitForTimeout(2500);
  const st = await page.evaluate(() => __mock.state());
  const d = diffDeg(st.player.angle, angleTo(st, st.enemies[0]));
  check('locks onto a still tank', d < 1.5, `barrel off by ${d.toFixed(2)} deg`);
  const info = await page.evaluate(() => ({ playing: diepAssist.S.playing, cam: diepAssist.cam.src, zoom: +diepAssist.cam.zoom.toFixed(3), tanks: diepAssist.S.tanks.length }));
  check('detects zoom from the grid pattern', Math.abs(info.zoom - 0.8) < 0.01, JSON.stringify(info));
  check('no page errors', errors.length === 0, errors.join('|'));
  await ctx.close();
}

/* 2. hotkeys + master switch release the mouse */
{
  const { page, ctx } = await open('pattern=still', {});
  await page.mouse.move(300, 500);
  await page.waitForTimeout(2000);
  await page.keyboard.press('Backslash');
  const aimOff = await page.evaluate(() => diepAssist.cfg.aim);
  await page.waitForTimeout(1500);
  const st = await page.evaluate(() => __mock.state());
  const toMouse = Math.atan2(500 - 360, 300 - 640);
  check('Backslash toggles auto aim off', aimOff === false);
  check('cursor handed back to the real mouse', diffDeg(st.player.angle, toMouse) < 2, `barrel off real mouse by ${diffDeg(st.player.angle, toMouse).toFixed(2)} deg`);
  await page.keyboard.press('Backslash');
  await page.keyboard.press('Delete');
  const en = await page.evaluate(() => diepAssist.cfg.enabled);
  check('Delete toggles the master switch', en === false);
  await ctx.close();
}

/* 3. auto-fire through the game's E toggle */
{
  const { page, ctx } = await open('pattern=circle', { autoFire: true });
  await page.mouse.move(300, 500);
  await page.waitForTimeout(3000);
  await page.evaluate(() => __mock.resetStats());
  await page.waitForTimeout(10000);
  const m = await page.evaluate(() => ({ fired: __mock.stats.fired, hits: __mock.stats.hits, e: __mock.stats.eToggles, on: __mock.autoFire }));
  check('auto-fire (E toggle) shoots without the user pressing anything', m.fired >= 20, `fired ${m.fired}`);
  check('auto-fire does not spam the E key', m.e <= 3, `E presses ${m.e}`);
  check('auto-fire hits', m.hits / Math.max(1, m.fired) > 0.7, `${m.hits}/${m.fired}`);
  // target disappears: firing must stop
  await page.evaluate(() => __mock.clearEnemies());
  await page.waitForTimeout(2500);
  const on = await page.evaluate(() => __mock.autoFire);
  check('auto-fire switches itself off when there is no target', on === false);
  await ctx.close();
}

/* 4. auto-fire through held Space */
{
  const { page, ctx } = await open('pattern=linear', { autoFire: true, fireMethod: 'holdSpace' });
  await page.mouse.move(300, 500);
  await page.waitForTimeout(3000);
  await page.evaluate(() => __mock.resetStats());
  await page.waitForTimeout(8000);
  const m = await page.evaluate(() => ({ fired: __mock.stats.fired, hits: __mock.stats.hits, e: __mock.stats.eToggles }));
  check('auto-fire (hold Space) shoots', m.fired >= 15 && m.e === 0, `fired ${m.fired}, E presses ${m.e}`);
  await ctx.close();
}

/* 5. build scheduler: game console path and U-key queue path */
{
  const { page, ctx } = await open('pattern=still&console=1', { build: '3333355555' });
  await page.waitForTimeout(1500);
  const ok = await page.evaluate(() => diepAssist.applyBuild());
  const log = await page.evaluate(() => __mock.stats.console.slice());
  check('console method sends game_stats_build', ok && log.includes('game_stats_build 3333355555'), JSON.stringify(log));
  await ctx.close();
}
{
  const { page, ctx } = await open('pattern=still&console=0', { build: '1234567812' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => diepAssist.applyBuild());
  await page.waitForTimeout(1500);
  const keys = await page.evaluate(() => __mock.stats.statKeys.slice());
  const seq = keys.map((k) => k.key).join('');
  check('key method queues the build with U held, in order', seq === '1234567812' && keys.every((k) => k.withU), `${seq} withU=${keys.every((k) => k.withU)}`);
  await ctx.close();
}
{
  const { page, ctx } = await open('pattern=still&console=1', { buildKeep: true, build: '3333355555' });
  await page.waitForTimeout(3500);
  const log = await page.evaluate(() => __mock.stats.console.slice());
  check('keep-build re-applies on spawn', log.filter((c) => c.startsWith('game_stats_build')).length >= 1, JSON.stringify(log));
  await ctx.close();
}
{
  const r = await (async () => {
    const { page, ctx } = await open('pattern=still', {});
    const res = await page.evaluate(() => {
      const sched = diepAssist.scheduleBuild;
      const out = {};
      for (const [n, t] of [['rammer', [5, 7, 7, 0, 0, 0, 7, 7]], ['umbrella', [0, 1, 2, 2, 7, 7, 7, 7]], ['bal', [3, 3, 3, 5, 5, 5, 5, 4]]]) {
        for (const mode of ['balanced', 'down', 'up']) {
          const s = sched(t, mode); const c = Array(8).fill(0); for (const ch of s) c[+ch - 1]++;
          out[n + mode] = JSON.stringify(c) === JSON.stringify(t) && s.length === t.reduce((a, b) => a + b, 0);
        }
      }
      return out;
    });
    await ctx.close();
    return res;
  })();
  check('build scheduler always yields exactly the requested stat totals', Object.values(r).every(Boolean), JSON.stringify(r));
}

/* 6. farm mode aims at a shape when no enemy is around */
{
  const { page, ctx } = await open('pattern=still&shapes=60&seed=3', { farm: true });
  await page.evaluate(() => __mock.clearEnemies());
  await page.mouse.move(300, 500);
  await page.waitForTimeout(3000);
  const info = await page.evaluate(() => ({ kind: diepAssist.S.sol && diepAssist.S.sol.tk.kind, on: diepAssist.ctl.on, ang: __mock.player.angle, px: __mock.player.x, py: __mock.player.y }));
  check('farm mode locks onto a shape', info.kind === 'shape' && info.on, JSON.stringify({ kind: info.kind, on: info.on }));
  await ctx.close();
}

/* 7. real clicks on the upgrade panels are never aimed away; menu hover pauses aim */
{
  const { page, ctx } = await open('pattern=still', {});
  await page.mouse.move(300, 500);
  await page.waitForTimeout(2500);
  const before = await page.evaluate(() => diepAssist.ctl.on);
  await page.mouse.move(60, 80);
  await page.mouse.down();
  const during = await page.evaluate(() => ({ on: diepAssist.ctl.on, susp: diepAssist.ctl.suspended }));
  await page.waitForTimeout(300);
  const inGame = await page.evaluate(() => { const i = __mock.state(); return Math.atan2(80 - 360, 60 - 640) - i.player.angle; });
  await page.mouse.up();
  const after = await page.evaluate(() => diepAssist.ctl.suspended);
  check('aim engaged before the click', before === true);
  check('click in the upgrade zone suspends aim and hands the real pointer to the game', during.susp === true && during.on === false && Math.abs(inGame) < 0.2, JSON.stringify(during));
  check('aim resumes after the click', after === false);
  await page.mouse.move(1100, 60); // over the menu
  await page.waitForTimeout(800);
  const hover = await page.evaluate(() => ({ h: diepAssist.S.panelHover, on: diepAssist.ctl.on }));
  check('aim pauses while the pointer is over the menu', hover.h === true && hover.on === false, JSON.stringify(hover));
  await ctx.close();
}

/* 8. a white hit-flash on my own tank must not break the lock */
{
  const { page, ctx } = await open('pattern=still', {});
  await page.mouse.move(300, 500);
  await page.waitForTimeout(2500);
  const res = await page.evaluate(() => new Promise((resolve) => {
    let maxDev = 0, offFrames = 0, n = 0;
    const base = __mock.player.angle;
    __mock.flashPlayer(500);
    function f() {
      maxDev = Math.max(maxDev, Math.abs(Math.atan2(Math.sin(__mock.player.angle - base), Math.cos(__mock.player.angle - base))));
      if (!diepAssist.ctl.on) offFrames++;
      if (++n < 45) requestAnimationFrame(f); else resolve({ maxDevDeg: maxDev * 180 / Math.PI, offFrames, playing: diepAssist.S.playing });
    }
    requestAnimationFrame(f);
  }));
  check('self flash: barrel does not move and aim stays engaged', res.maxDevDeg < 0.5 && res.offFrames === 0 && res.playing, JSON.stringify(res));
  await page.evaluate(() => __mock.flashEnemies(500));
  await page.waitForTimeout(700);
  const t = await page.evaluate(() => ({ tanks: diepAssist.S.tanks.filter((x) => x.seen).length, on: diepAssist.ctl.on }));
  check('enemy flash: still tracked as an enemy', t.tanks === 1 && t.on, JSON.stringify(t));
  await ctx.close();
}

/* 9. incoming bullets are flagged */
{
  const { page, ctx } = await open('pattern=still&efire=1', {});
  await page.waitForTimeout(5000);
  const seen = await page.evaluate(() => new Promise((resolve) => {
    let max = 0, n = 0;
    function f() { max = Math.max(max, diepAssist.S.threats); if (++n < 240) requestAnimationFrame(f); else resolve(max); }
    requestAnimationFrame(f);
  }));
  check('incoming enemy bullets raise a threat warning', seen >= 1, `max threats ${seen}`);
  await ctx.close();
}

/* 10. zoom / grid variants keep the aim accurate */
for (const q of ['zoom=0.5', 'zoom=1.3&wrap=0']) {
  const { page, ctx } = await open(`pattern=linear&${q}`, { autoFire: true });
  await page.mouse.move(300, 500);
  await page.waitForTimeout(4000);
  await page.evaluate(() => __mock.resetStats());
  await page.waitForTimeout(9000);
  const m = await page.evaluate(() => ({ fired: __mock.stats.fired, hits: __mock.stats.hits, zoom: diepAssist.cam.zoom }));
  check(`accurate at ${q}`, m.fired > 15 && m.hits / m.fired > 0.7, `${m.hits}/${m.fired}, detected zoom ${m.zoom.toFixed(2)}`);
  await ctx.close();
}

/* 10b. the loop latency is measured from the player's own shots, whatever the server's delay is */
{
  const { page, ctx } = await open('pattern=circle&rd=0.14&id=0.09', { autoFire: true });
  await page.mouse.move(300, 500);
  await page.waitForTimeout(24000);
  const m = await page.evaluate(() => ({ measured: diepAssist.cfg.measured, n: diepAssist.S.loopSamples, fired: __mock.stats.fired, hits: __mock.stats.hits }));
  check('measures the real latency (true 230 ms)', Math.abs(m.measured - 0.23) < 0.03 && m.n >= 8, `measured ${Math.round(m.measured * 1000)} ms from ${m.n} shots`);
  await ctx.close();
}

/* 11. hi-dpi canvas */
{
  const { page, ctx } = await open('pattern=still', {}, { dpr: 2 });
  await page.mouse.move(300, 500);
  await page.waitForTimeout(2500);
  const st = await page.evaluate(() => __mock.state());
  const d = diffDeg(st.player.angle, angleTo(st, st.enemies[0]));
  check('locks on at devicePixelRatio 2', d < 1.5, `off by ${d.toFixed(2)} deg`);
  await ctx.close();
}

/* 12. refuses to run on diep.io */
{
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await ctx.newPage();
  await page.route('http://diep.io/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(here, 'mock-diep.html'), 'utf8') }));
  const warnings = [];
  page.on('console', (m) => warnings.push(m.text()));
  await page.addInitScript({ path: SCRIPT });
  await page.goto('http://diep.io/mock');
  await page.waitForTimeout(800);
  const has = await page.evaluate(() => typeof window.diepAssist);
  check('does nothing on diep.io', has === 'undefined' && warnings.some((w) => w.includes('Disabled on the public diep.io')), has);
  await ctx.close();
}

/* 13. menu screenshots */
if (shotsDir) {
  fs.mkdirSync(shotsDir, { recursive: true });
  const { page, ctx } = await open('pattern=circle', { ui: { tab: 'Aim', open: true } });
  await page.mouse.move(300, 500);
  await page.waitForTimeout(2500);
  for (const tab of ['Aim', 'Fire', 'Visuals', 'Build', 'Misc']) {
    await page.click(`.da-tab[data-tab="${tab}"]`);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(shotsDir, `menu-${tab}.png`) });
  }
  await page.click('.da-tab[data-tab="Aim"]');
  await page.evaluate(() => { diepAssist.cfg.debug = true; diepAssist.cfg.aimLine = true; });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(shotsDir, 'ingame.png') });
  await ctx.close();
}

console.log(`\n${pass} passed, ${failed} failed`);
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
