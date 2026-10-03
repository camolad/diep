// Checks that recorded frames go through the hooks the way they should.
//   DIEP_SCRIPT=diep-assist.user.js node test/replay-check.mjs
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
import os from 'node:os';
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
  check('real probe: the status explains why nothing is happening', /cannot find my tank.*30 drones/.test(s.why), s.why);
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
  const file = path.join(os.tmpdir(), `diep-rt-${style}.json`);
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

/* 3. hand-made frames for the edge cases found in review (not the mock, not real data) */
{
  const draw = () => {
    const c = document.getElementById('canvas'), x = c.getContext('2d');
    const tile = Object.assign(document.createElement('canvas'), { width: 50, height: 50 });
    const pat = x.createPattern(tile, 'repeat');
    const grad = x.createLinearGradient(0, 0, 800, 0);
    x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, 800, 600);
    x.setTransform(0.5, 0, 0, 0.5, 13, 7); x.fillStyle = pat; x.fillRect(0, 0, 1700, 1300);   // the grid (zoom 0.5)
    x.setTransform(1, 0, 0, 1, 0, 0); x.fillStyle = grad; x.fillRect(0, 0, 800, 600);        // a gradient fill must not replace the grid
    // a tank at the centre: grey barrel polygon, then a round body with a trailing moveTo(centre), filled twice and stroked
    x.beginPath(); x.moveTo(400, 290); x.lineTo(470, 290); x.lineTo(470, 310); x.lineTo(400, 310); x.fillStyle = '#999999'; x.fill(); x.fill(); x.strokeStyle = '#727272'; x.lineWidth = 3; x.stroke();
    x.beginPath(); x.arc(400, 300, 25, 0, Math.PI * 2); x.moveTo(400, 300); x.fillStyle = '#00b2e1'; x.fill(); x.fill(); x.strokeStyle = '#0085a8'; x.stroke();
    // a team-coloured triangle built under translate + scale
    x.save(); x.translate(600, 400); x.scale(2, 2); x.beginPath(); x.moveTo(-10, 8); x.lineTo(10, 8); x.lineTo(0, -12); x.closePath(); x.fillStyle = '#f14e54'; x.fill(); x.restore();
    x.setTransform(1, 0, 0, 1, 0, 0);
  };
  const summarise = () => {
    const f = diepAssist.S.ready, q = (v) => v.map((e) => ({ x: Math.round(e.x), y: Math.round(e.y), r: Math.round(e.r) }));
    return f && { tanks: q(f.tanks), bullets: q(f.bullets), drones: q(f.drones), grid: f.grid && { zoom: f.grid.zoom, tw: f.grid.tw } };
  };
  const server2 = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><body style="margin:0"><canvas id="canvas" width="800" height="600"></canvas></body>'); });
  await new Promise((r) => server2.listen(0, r));
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.addInitScript({ path: SCRIPT });
  await page.goto(`http://localhost:${server2.address().port}/`);
  const out = await page.evaluate(([drawSrc, sumSrc]) => new Promise((resolve) => {
    const drawF = new Function('return ' + drawSrc)(), sumF = new Function('return ' + sumSrc)();
    drawF(); const c = document.getElementById('canvas'); c.getContext('2d').clearRect(0, 0, 800, 600);   // flush
    const live = sumF();
    diepAssist.recordFrames(1, (data) => { resolve({ live, data }); });
    const x = c.getContext('2d');
    drawF(); drawF(); x.clearRect(0, 0, 800, 600);
  }), [draw.toString(), summarise.toString()]);
  fs.writeFileSync(path.join(os.tmpdir(), 'diep-rt-hand.json'), JSON.stringify(out.data));
  await ctx.close(); server2.close();
  const L = out.live;
  check('hand-made: a round body whose path also has a moveTo(centre) is still a tank', L && L.tanks.length === 1 && L.tanks[0].r === 25 && L.bullets.length === 0, JSON.stringify(L && L.tanks));
  check('hand-made: a gradient fill does not replace the grid', L && L.grid && L.grid.zoom === 0.5 && L.grid.tw === 50, JSON.stringify(L && L.grid));
  check('hand-made: a triangle built under translate + scale is read at the right place and size (drone at 600,400, r ~ 24)', L && L.drones.length === 1 && Math.abs(L.drones[0].x - 600) <= 3 && Math.abs(L.drones[0].y - 402) <= 6 && Math.abs(L.drones[0].r - 24) <= 3, JSON.stringify(L && L.drones));
  const r = await replay(path.join(os.tmpdir(), 'diep-rt-hand.json'), { browser });
  const same = r.seen && r.seen.drones.length === 1 && Math.abs(r.seen.drones[0].x - L.drones[0].x) <= 1 && Math.abs(r.seen.drones[0].r - L.drones[0].r) <= 1 && r.seen.tanks.length === 1;
  check('hand-made: replaying the recording (translate / scale / restore) gives the same frame', same, JSON.stringify(r.seen && { tanks: r.seen.tanks, drones: r.seen.drones }));
  check('hand-made: no page errors', errs.length === 0 && r.pageErrors.length === 0, errs.join('|'));
  fs.rmSync(path.join(os.tmpdir(), 'diep-rt-hand.json'), { force: true });
}
console.log(`\n${pass} passed, ${failed} failed`);
await browser.close();
process.exit(failed ? 1 : 0);
