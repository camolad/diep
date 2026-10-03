// Runs diep-assist.user.js (and optionally an older copy) against test/mock-diep.html in headless Chromium and
// prints hit rate + cursor smoothness per scenario.
//
//   node test/run.mjs                      # quick matrix with the current script
//   node test/run.mjs --baseline old.js    # also run an older script for comparison
//   node test/run.mjs --secs 20 --pattern strafe --move strafe
//
// Needs the `playwright` package and a Chromium (PLAYWRIGHT_BROWSERS_PATH is respected).
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const SECS = +opt('secs', 14);
const WARM = +opt('warm', 4);
const baseline = opt('baseline', null);
const only = opt('pattern', null);
const onlyMove = opt('move', null);
const extraQuery = opt('query', '');

const server = http.createServer((req, res) => {
  const f = path.join(here, req.url.split('?')[0].replace(/^\//, '') || 'mock-diep.html');
  fs.readFile(f, (err, data) => { if (err) { res.writeHead(404); res.end(); } else { res.writeHead(200, { 'content-type': 'text/html' }); res.end(data); } });
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({ headless: true });

async function scenario({ label, script, pattern, move, fire, cfg = {}, query = '', secs = SECS, warm = WARM, realMouse = true, screenshot = null }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'warning' && m.text().includes('Diep Assist')) errors.push(m.text()); });
  await page.addInitScript((c) => { try { localStorage.setItem('diepAssist.v2', JSON.stringify(c)); } catch (e) { /* ignore */ } }, cfg);
  if (script) await page.addInitScript({ path: script });
  await page.goto(`http://localhost:${port}/mock-diep.html?pattern=${pattern}${query ? '&' + query : ''}${extraQuery ? '&' + extraQuery : ''}`);
  await page.mouse.move(900, 300);
  if (fire === 'mouse') await page.mouse.down(); // the "user" holds fire; only the aim is the script's job

  let moving = true;
  const mover = (async () => {
    let dir = 0;
    while (moving) {
      if (move === 'strafe') {
        const k = dir++ % 2 ? 'KeyA' : 'KeyD';
        await page.keyboard.down(k); await page.waitForTimeout(650); await page.keyboard.up(k);
      } else await page.waitForTimeout(100);
    }
  })();
  const jitterer = (async () => { // a hand that keeps moving the real mouse around
    let a = 0;
    while (moving) { if (realMouse) { a += 0.4; await page.mouse.move(640 + Math.cos(a) * 240, 360 + Math.sin(a * 1.3) * 200); } await page.waitForTimeout(40); }
  })();

  await page.waitForTimeout(warm * 1000);
  await page.evaluate(() => window.__mock.resetStats());
  const t0 = Date.now();
  await page.waitForTimeout(secs * 1000);
  const m = await page.evaluate(() => ({
    fired: __mock.stats.fired, hits: __mock.stats.hits, frames: __mock.stats.frames, eToggles: __mock.stats.eToggles,
    synthMouseDown: __mock.stats.synthMouseDown, barrel: __mock.barrel.slice(), console: __mock.stats.console, statKeys: __mock.stats.statKeys,
    autoFire: __mock.autoFire,
    da: window.diepAssist ? { shots: diepAssist.S.stats.shots, hits: diepAssist.S.stats.hits, measured: diepAssist.cfg.measured, samples: diepAssist.S.loopSamples, cam: diepAssist.cam.src,
      zoom: diepAssist.cam.zoom, valid: diepAssist.bullet.valid, reach: diepAssist.bullet.reach.slice(0, 12), lastError: diepAssist.S.lastError, playing: diepAssist.S.playing } : null,
  }));
  if (screenshot) await page.screenshot({ path: screenshot });
  moving = false; await mover; await jitterer;
  await ctx.close();

  // smoothness: RMS of the second difference of the barrel angle, in degrees (frame-rate normalised to 60 Hz)
  const b = m.barrel; let s2 = 0, n = 0, maxd = 0;
  for (let i = 1; i < b.length - 1; i++) {
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    const d = wrap(b[i + 1][1] - b[i][1]) - wrap(b[i][1] - b[i - 1][1]);
    const dd = (d * 180) / Math.PI;
    if (Math.abs(dd) < 20) { s2 += dd * dd; n++; }
    maxd = Math.max(maxd, Math.abs(dd));
  }
  const secsReal = (Date.now() - t0) / 1000;
  return {
    label, pattern, move, fired: m.fired, hits: m.hits, hitPct: m.fired ? Math.round((100 * m.hits) / m.fired) : null,
    jitter: n ? +Math.sqrt(s2 / n).toFixed(3) : null, fps: Math.round(m.frames / secsReal), eToggles: m.eToggles, synthMouseDown: m.synthMouseDown,
    da: m.da, console: m.console, statKeys: m.statKeys, errors,
  };
}

export { scenario, browser, port, server };

if (import.meta.url === `file://${process.argv[1]}`) {
  const script = process.env.DIEP_SCRIPT ? path.resolve(process.env.DIEP_SCRIPT) : path.join(root, 'diep-assist.user.js');
  const rows = [];
  const patterns = only ? [only] : ['still', 'linear', 'circle', 'strafe'];
  const moves = onlyMove ? [onlyMove] : ['stand', 'strafe'];
  const jobs = [];
  for (const pattern of patterns) for (const move of moves) {
    jobs.push({ label: 'v2', script, pattern, move, fire: 'mouse', cfg: { aim: true, autoFire: false } });
    if (baseline) jobs.push({ label: 'old', script: path.resolve(baseline), pattern, move, fire: 'mouse', cfg: {} });
  }
  const PAR = +opt('par', 2);
  for (let i = 0; i < jobs.length; i += PAR) rows.push(...(await Promise.all(jobs.slice(i, i + PAR).map(scenario))));
  console.log('\nlabel  pattern  move    shots  hits   hit%  jitter(deg)  fps  extra');
  for (const r of rows) {
    console.log(`${r.label.padEnd(6)} ${r.pattern.padEnd(8)} ${r.move.padEnd(7)} ${String(r.fired).padStart(5)} ${String(r.hits).padStart(5)} ${String(r.hitPct).padStart(5)}  ${String(r.jitter).padStart(10)}  ${String(r.fps).padStart(3)}  ${r.da ? `cam=${r.da.cam} measured=${Math.round(r.da.measured * 1000)}ms n=${r.da.samples} prof=${r.da.valid} ${r.da.lastError || ''}` : ''}${r.errors.length ? ' ERR ' + r.errors.join('|') : ''}`);
  }
  await browser.close(); server.close();
}
