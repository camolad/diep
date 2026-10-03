// Checks that recorded frames go through the hooks the way they should.
//   DIEP_SCRIPT=work/next.user.js node test/replay-check.mjs
//
//  1. test/fixtures/client-probe-partial.json  - REAL: the first 400 draw calls of a frame of the actual client (a team arena, no tank on
//     screen yet). Checks the geometry handling on real data: translucent bases ignored, grid read, the 30 small triangles seen as drones.
//  2. a frame recorded from the mock arena with the script's own recorder and replayed in a fresh page: the replay has to see the same
//     tanks, bullets, shapes, health bars and text as the live run did (recorder + replay machinery round trip). The mock is NOT real
//     data, so this proves the tooling, not the detection on a real client.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replay } from './replay.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.DIEP_SCRIPT ? path.resolve(process.env.DIEP_SCRIPT) : path.resolve(here, '..', 'diep-assist.user.js');
let pass = 0, failed = 0;
const check = (name, ok, detail = '') => { (ok ? pass++ : failed++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };
const browser = await chromium.launch({ headless: true });

/* 1. real client data */
{
  const r = await replay(path.join(here, 'fixtures', 'client-probe-partial.json'), { browser });
  const s = r.seen;
  check('real probe: every recorded call replays', r.replayed.replayed === r.rec.calls.length && r.replayed.errors.length === 0, r.replayed.errors.slice(0, 2).join('|'));
  check('real probe: no script errors', r.pageErrors.length === 0 && !s.errors, r.pageErrors.join('|') + (s.errors || ''));
  check('real probe: the grid pattern gives zoom 0.406 and a 50 unit tile', s.grid && Math.abs(s.grid.zoom - 0.4065) < 0.001 && s.grid.tw === 50 && Math.abs(s.grid.e + 10.6) < 0.1, JSON.stringify(s.grid));
  check('real probe: translucent bases / margins are ignored', s.diag.ignored >= 4 && s.diag.bases === 0, JSON.stringify(s.diag));
  check('real probe: the 30 small blue polygons are seen once each (the client fills them twice)', s.drones.length === 30 && s.shapes.length === 0, `drones ${s.drones.length}, shapes ${s.shapes.length}`);
  check('real probe: nothing is mistaken for a tank or a bullet', s.tanks.length === 0 && s.bullets.length === 0);
}

/* 2. recorder round trip on the mock arena */
const server = http.createServer((req, res) => { fs.readFile(path.join(here, 'mock-diep.html'), (e, d) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(d); }); });
await new Promise((r) => server.listen(0, r));
for (const style of ['real', 'xform', 'legacy']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript((c) => { try { localStorage.setItem('diepAssist.v2', JSON.stringify(c)); } catch (e) { /* ignore */ } }, { human: 0 });
  await page.addInitScript({ path: SCRIPT });
  await page.goto(`http://localhost:${server.address().port}/?pattern=still&lvl=25&style=${style}&drones=3&textmode=offscreen`);
  await page.evaluate(() => { __mock.clearEnemies(); __mock.addEnemy({ name: 'Tester', score: 8800, x: 380, y: -120, hp: 0.55, pattern: 'still' }); __mock.addEnemy({ name: 'Bot', score: 300, x: -230, y: 100 }); });
  await page.waitForTimeout(2500);
  const out = await page.evaluate(() => new Promise((resolve) => {
    diepAssist.recordFrames(1, (data) => {
      // the live frame that was drawn while recording, as the script itself assembled it
      setTimeout(() => {
        const f = diepAssist.S.ready, q = (v) => v.length;
        resolve({ data, live: { tanks: q(f.tanks), bullets: q(f.bullets), shapes: q(f.shapes), drones: q(f.drones), bars: q(f.bars), texts: q(f.texts) } });
      }, 0);
    });
  }));
  const file = path.join(here, '..', 'work', `rt-${style}.json`);
  fs.writeFileSync(file, JSON.stringify(out.data));
  await ctx.close();
  const r = await replay(file, { browser });
  const s = r.seen;
  const got = { tanks: s.tanks.length, bullets: s.bullets.length, shapes: s.shapes.length, drones: s.drones.length, bars: s.bars, texts: s.texts.length };
  const calls = out.data.calls.length, offscreen = out.data.canvases.filter((c) => !c.main).length;
  check(`[${style}] recorder: one frame, ${calls} calls, ${offscreen} offscreen canvases`, out.data.ended === 'complete' && calls > 100 && !out.data.truncated && errors.length === 0, `${out.data.ended} ${errors.join('|')}`);
  check(`[${style}] replay sees 3 tanks (2 enemies + me), 3 drones per enemy, 1 health bar, text`, got.tanks === 3 && (style === 'legacy' ? got.drones >= 6 : got.drones === 6) && got.bars >= 1 && got.texts >= 5, JSON.stringify(got));
  check(`[${style}] replay agrees with the live run`, got.tanks === out.live.tanks && got.shapes === out.live.shapes && got.drones === out.live.drones && got.bars === out.live.bars && got.texts === out.live.texts, JSON.stringify({ live: out.live, got }));
  fs.rmSync(file, { force: true });
}
server.close();
console.log(`\n${pass} passed, ${failed} failed`);
await browser.close();
process.exit(failed ? 1 : 0);
