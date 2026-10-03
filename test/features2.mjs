// Checks for the target-priority, parsing, human-motion and QoL features (see features.mjs for the basics).
//
//   DIEP_SCRIPT=diep-assist.user.js node test/features2.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.DIEP_SCRIPT ? path.resolve(process.env.DIEP_SCRIPT) : path.resolve(here, '..', 'diep-assist.user.js');
const server = http.createServer((req, res) => {
  fs.readFile(path.join(here, 'mock-diep.html'), (err, data) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(data); });
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch({ headless: true });

let pass = 0, failed = 0;
const check = (name, ok, detail = '') => { (ok ? pass++ : failed++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };

async function open(query = 'pattern=still', cfg = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript((c) => { try { localStorage.setItem('diepAssist.v2', JSON.stringify(c)); } catch (e) { /* ignore */ } }, { human: 0, ...cfg });
  await page.addInitScript({ path: SCRIPT });
  await page.goto(`http://localhost:${port}/mock-diep.html?${query}${process.env.DIEP_QUERY ? '&' + process.env.DIEP_QUERY : ''}`);
  return { page, ctx, errors };
}
// the three tanks of the story: a 300-score bot right next to me, a hurt mid bot, and a strong tester shooting at me
const SCENE = () => {
  __mock.clearEnemies();
  __mock.addEnemy({ name: 'Tester', level: 22, score: 8800, x: 380, y: -120, hp: 0.55, pattern: 'still', shoot: true });
  __mock.addEnemy({ name: 'Bot-300', level: 4, score: 300, x: -230, y: 100 });
  __mock.addEnemy({ name: 'Bot-1900', level: 9, score: 1900, x: -120, y: -260, hp: 0.3 });
};
const target = (page) => page.evaluate(() => (diepAssist.S.sol ? diepAssist.S.sol.tk.name : null));

/* 1. reading names, scores, health, my own score / level */
{
  const { page, ctx, errors } = await open('pattern=still&lvl=25', { priority: 'auto' });
  await page.evaluate(SCENE);
  await page.mouse.move(300, 500);
  await page.waitForTimeout(3500);
  const m = await page.evaluate(() => ({
    lb: diepAssist.S.leaderboard.map((r) => r.name + ':' + r.score), my: diepAssist.S.myScore, lvl: diepAssist.S.myLevel,
    tanks: Object.fromEntries(diepAssist.S.tanks.filter((t) => t.seen).map((t) => [t.name, { score: t.score, hp: t.hp === null ? null : +t.hp.toFixed(2), shots: t.shotsAtMe }])),
  }));
  check('reads the leaderboard', m.lb.length === 4 && m.lb.includes('Tester:8800') && m.lb.includes('Bot-300:300'), JSON.stringify(m.lb));
  check('reads my own score and level', m.my === 3700 && m.lvl === 25, `score ${m.my} level ${m.lvl}`);
  check('matches nameplates to leaderboard scores', m.tanks.Tester && m.tanks.Tester.score === 8800 && m.tanks['Bot-300'].score === 300, JSON.stringify(m.tanks));
  check('reads health bars (only damaged tanks have one)', Math.abs(m.tanks.Tester.hp - 0.55) < 0.06 && Math.abs(m.tanks['Bot-1900'].hp - 0.3) < 0.06 && m.tanks['Bot-300'].hp === null, JSON.stringify(m.tanks));
  check('sees who is shooting at me', m.tanks.Tester.shots >= 2 && m.tanks['Bot-300'].shots === 0, JSON.stringify(m.tanks));
  check('no page errors', errors.length === 0, errors.join('|'));
  const le = await page.evaluate(() => diepAssist.S.lastError);
  check('the script reported no internal errors', !le, le);
  await ctx.close();
}

/* 2. priority modes: the 300-score bot is nearest, but it is not who I am fighting */
for (const [mode, want] of [['closest', 'Bot-300'], ['auto', 'Tester'], ['score', 'Tester'], ['health', 'Bot-1900'], ['threat', 'Tester']]) {
  const { page, ctx } = await open('pattern=still&lvl=25', { priority: mode });
  await page.evaluate(SCENE);
  await page.mouse.move(300, 500);
  await page.waitForTimeout(3500);
  const t = await target(page);
  check(`priority "${mode}" aims at ${want}`, t === want, `aimed at ${t}`);
  await ctx.close();
}

/* 3. small fry is only skipped when something stronger is around, and never when it is the one shooting */
{
  const { page, ctx } = await open('pattern=still&lvl=25', { priority: 'auto', ignoreSmall: 30 });
  await page.evaluate(() => { __mock.clearEnemies(); __mock.addEnemy({ name: 'Bot-300', level: 4, score: 300, x: -230, y: 100 }); });
  await page.mouse.move(300, 500);
  await page.waitForTimeout(3000);
  const alone = await target(page);
  check('a lone small tank is still targeted', alone === 'Bot-300', `aimed at ${alone}`);
  await page.evaluate(() => { __mock.addEnemy({ name: 'Boss', level: 25, score: 12000, x: 400, y: -200 }); });
  await page.waitForTimeout(3000);
  const withBoss = await target(page);
  check('with a stronger tank around, the small one is skipped', withBoss === 'Boss', `aimed at ${withBoss}`);
  await page.evaluate(() => { const b = __mock.enemies.find((e) => e.name === 'Bot-300'); b.shoot = true; });
  await page.waitForTimeout(5000);
  const shooter = await target(page);
  check('...unless the small one is shooting at me', shooter === 'Bot-300', `aimed at ${shooter}`);
  await ctx.close();
}

/* 4. size alone (no leaderboard) still ranks strong above weak */
{
  const { page, ctx } = await open('pattern=still&lvl=25&text=0', { priority: 'score' });
  await page.evaluate(() => { __mock.clearEnemies(); __mock.addEnemy({ name: 'a', level: 22, x: 380, y: -120 }); __mock.addEnemy({ name: 'b', level: 4, x: -230, y: 100 }); });
  await page.mouse.move(300, 500);
  await page.waitForTimeout(3000);
  const r = await page.evaluate(() => { const s = diepAssist.S.sol; return s ? Math.round(s.tk.rW) : null; });
  check('without text, "highest score" falls back to the bigger tank', r > 55, `aimed at a tank of radius ${r}`);
  await ctx.close();
}

/* 5. ignore list */
{
  const { page, ctx } = await open('pattern=still&lvl=25', { priority: 'score', ignoreNames: 'tester, nobody' });
  await page.evaluate(SCENE);
  await page.mouse.move(300, 500);
  await page.waitForTimeout(3500);
  const t = await target(page);
  check('"never target" skips a listed name', t !== 'Tester' && t !== null, `aimed at ${t}`);
  await ctx.close();
}

/* 6. pin / cycle hotkeys */
{
  const { page, ctx } = await open('pattern=still&lvl=25', { priority: 'closest', ignoreSmall: 0, stickiness: 0 });
  await page.evaluate(SCENE);
  await page.mouse.move(300, 500);
  await page.waitForTimeout(3500);
  const first = await target(page);
  await page.keyboard.press('Period');
  await page.waitForTimeout(2500);
  const second = await target(page);
  check('cycle key moves to the next tank', first === 'Bot-300' && second !== first && second !== null, `${first} -> ${second}`);
  await page.keyboard.press('Comma'); // unpin / pin toggles; pinned already by cycle, so this unpins
  await page.waitForTimeout(2500);
  const third = await target(page);
  check('pin key releases the pin and ranking resumes', third === 'Bot-300', `aimed at ${third}`);
  await page.keyboard.press('Comma');
  await page.evaluate(() => { __mock.enemies.find((e) => e.name === 'Tester').pattern = 'still'; });
  const pinned = await page.evaluate(() => diepAssist.S.pinId);
  await page.evaluate(() => { __mock.addEnemy({ name: 'Intruder', level: 1, x: -150, y: 40 }); });
  await page.waitForTimeout(2500);
  const kept = await target(page);
  check('a pinned target is not stolen by a closer one', pinned !== 0 && kept === 'Bot-300', `pinned id ${pinned}, aimed at ${kept}`);
  await ctx.close();
}

/* 7. clean view, settings export/import, profiles, diagnostics */
{
  const { page, ctx } = await open('pattern=still&lvl=25', {});
  await page.evaluate(SCENE);
  await page.waitForTimeout(1500);
  const shown = await page.evaluate(() => getComputedStyle(document.getElementById('da-panel')).display !== 'none');
  await page.keyboard.press('End');
  const hidden = await page.evaluate(() => ({ panel: getComputedStyle(document.getElementById('da-panel')).display, overlay: getComputedStyle(diepAssist.S.overlay).display, clean: diepAssist.cfg.clean }));
  check('clean view hides the menu and the overlay', shown && hidden.panel === 'none' && hidden.overlay === 'none' && hidden.clean === true, JSON.stringify(hidden));
  await page.keyboard.press('End');
  const back = await page.evaluate(() => getComputedStyle(document.getElementById('da-panel')).display !== 'none');
  check('the same key brings them back', back);

  const rt = await page.evaluate(() => {
    diepAssist.set('smooth', 222); diepAssist.cfg.ignoreNames = 'abc'; diepAssist.cfg.keys.aim = 'KeyJ';
    const json = diepAssist.exportSettings();
    diepAssist.set('smooth', 10); diepAssist.cfg.ignoreNames = ''; diepAssist.cfg.keys.aim = 'Backslash';
    const ok = diepAssist.importSettings(json);
    return { ok, smooth: diepAssist.cfg.smooth, names: diepAssist.cfg.ignoreNames, aim: diepAssist.cfg.keys.aim, bad: diepAssist.importSettings('not json') };
  });
  check('settings export / import round trip', rt.ok && rt.smooth === 222 && rt.names === 'abc' && rt.aim === 'KeyJ' && rt.bad === false, JSON.stringify(rt));
  const pr = await page.evaluate(() => {
    diepAssist.set('reaction', 111); diepAssist.saveProfile(2); diepAssist.set('reaction', 5);
    return { loaded: diepAssist.loadProfile(2), reaction: diepAssist.cfg.reaction, empty: diepAssist.loadProfile(3) };
  });
  check('profiles save and load', pr.loaded && pr.reaction === 111 && pr.empty === false, JSON.stringify(pr));
  const rep = await page.evaluate(() => { const r = diepAssist.report(); return { keys: Object.keys(r), tanks: r.state.tanks.length, texts: r.lastFrame && r.lastFrame.texts.length, json: JSON.stringify(r).length }; });
  check('diagnostics report has config, state and the last frame', rep.keys.includes('cfg') && rep.keys.includes('state') && rep.tanks === 3 && rep.texts > 5, JSON.stringify(rep));
  await ctx.close();
}

/* 8. the human touch: a slow wander that stays inside the target, and it is switched off by the Instant style */
{
  for (const [human, label] of [[0, 'off'], [40, 'default'], [100, 'full']]) {
    const { page, ctx } = await open('pattern=still&lvl=1', { human, smooth: 130 });
    await page.mouse.move(300, 500);
    await page.waitForTimeout(2500);
    const r = await page.evaluate(() => new Promise((resolve) => {
      const st = __mock.state(); const want = Math.atan2(st.enemies[0].y - st.player.y, st.enemies[0].x - st.player.x);
      let n = 0, sum = 0, sum2 = 0, max = 0;
      function f() {
        const d = Math.atan2(Math.sin(__mock.player.angle - want), Math.cos(__mock.player.angle - want)) * 180 / Math.PI;
        sum += d; sum2 += d * d; max = Math.max(max, Math.abs(d));
        if (++n < 360) requestAnimationFrame(f); else resolve({ sd: Math.sqrt(sum2 / n - (sum / n) ** 2), max, tol: Math.atan2(56, Math.hypot(st.enemies[0].x, st.enemies[0].y)) * 180 / Math.PI });
      }
      requestAnimationFrame(f);
    }));
    if (human === 0) check('human 0: dead-on', r.max < 0.5, `max error ${r.max.toFixed(2)} deg`);
    else check(`human ${label}: wanders but stays well inside the tank (${r.tol.toFixed(1)} deg)`, r.sd > 0.05 && r.max < r.tol * 0.8, `sd ${r.sd.toFixed(2)} deg, max ${r.max.toFixed(2)} deg`);
    await ctx.close();
  }
}

/* 9. assist modes: blend with the real mouse, and only near where I point */
{
  const { page, ctx } = await open('pattern=still&lvl=1', { assist: 50 });
  await page.mouse.move(640, 560); // straight down from the tank; the enemy is up-right
  await page.waitForTimeout(3000);
  const st = await page.evaluate(() => __mock.state());
  const toEnemy = Math.atan2(st.enemies[0].y - st.player.y, st.enemies[0].x - st.player.x), toMouse = Math.PI / 2;
  const frac = Math.abs(Math.atan2(Math.sin(st.player.angle - toMouse), Math.cos(st.player.angle - toMouse))) / Math.abs(Math.atan2(Math.sin(toEnemy - toMouse), Math.cos(toEnemy - toMouse)));
  check('assist 50% lands halfway between my mouse and the target', frac > 0.4 && frac < 0.6, `${(frac * 100).toFixed(0)}% of the way`);
  await ctx.close();
}
{
  const { page, ctx } = await open('pattern=still&lvl=1', { aimMode: 'near', cone: 25 });
  await page.mouse.move(640, 560);
  await page.waitForTimeout(2500);
  const far = await page.evaluate(() => diepAssist.ctl.on);
  await page.mouse.move(900, 280); // roughly at the enemy
  await page.waitForTimeout(2500);
  const near = await page.evaluate(() => diepAssist.ctl.on);
  check('near mode helps only when I point at the tank', far === false && near === true, `pointing away: ${far}, pointing at it: ${near}`);
  await ctx.close();
}

/* 10. a big flick of the real mouse takes the barrel back for a moment */
{
  const { page, ctx } = await open('pattern=still&lvl=1', { override: 2200 });
  await page.mouse.move(300, 500);
  await page.waitForTimeout(2500);
  const before = await page.evaluate(() => diepAssist.ctl.on);
  await page.mouse.move(300, 500);
  for (let i = 0; i < 14; i++) { await page.mouse.move(i % 2 ? 100 : 1000, 400); await page.waitForTimeout(8); }
  await page.waitForTimeout(420);
  const during = await page.evaluate(() => diepAssist.ctl.on);
  await page.mouse.move(300, 500);
  await page.waitForTimeout(2500);
  const after = await page.evaluate(() => diepAssist.ctl.on);
  check('a flick yields the barrel, and the aim comes back afterwards', before === true && during === false && after === true, `${before} / ${during} / ${after}`);
  await ctx.close();
}

/* 11. strength presets */
{
  const { page, ctx } = await open('pattern=still&lvl=25', {});
  const r = await page.evaluate(() => {
    const out = {};
    diepAssist.tier('assist'); out.assist = [diepAssist.cfg.aim, diepAssist.cfg.aimMode, diepAssist.cfg.assist];
    diepAssist.tier('off'); out.off = diepAssist.cfg.aim;
    diepAssist.tier('full'); out.full = [diepAssist.cfg.aim, diepAssist.cfg.aimMode, diepAssist.cfg.assist, diepAssist.cfg.dodge];
    out.bad = diepAssist.tier('nope');
    return out;
  });
  check('strength presets set the aim options', r.assist.join() === 'true,near,45' && r.off === false && r.full.join() === 'true,always,100,true' && r.bad === false, JSON.stringify(r));
  await ctx.close();
}

/* 12. the per-target learner picks up a strafing beat (the mock's periodic target reverses about every 0.55 s) */
{
  const { page, ctx } = await open('pattern=periodic&lvl=25', {});
  await page.mouse.move(300, 500);
  await page.waitForTimeout(9000);
  const m = await page.evaluate(() => { const tk = diepAssist.S.tanks.find((t) => t.seen); const d = tk && tk.pred ? tk.pred.dbg() : null; return d && { period: d.r ? d.r.period : null, conf: d.r ? d.r.conf : 0, revs: d.revs.length }; });
  check('detects the strafing beat of a periodic target', m && m.period > 0.42 && m.period < 0.7 && m.conf > 0.3, JSON.stringify(m));
  await ctx.close();
}

console.log(`\n${pass} passed, ${failed} failed`);
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
