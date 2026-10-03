// How natural does the lock-on look? Drives the mock into three situations and measures the barrel angle
// (what other players would see): onset delay, settle time, peak angular speed / acceleration / jerk, overshoot.
//
//   node test/lockon.mjs                       # current script
//   node test/lockon.mjs old=/path/old.js      # compare any number of labelled scripts
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const scripts = [];
let storeKey = {};
if (process.env.DIEP_SCRIPT) scripts.push(['new', path.resolve(process.env.DIEP_SCRIPT)]);
for (const a of process.argv.slice(2)) {
  const m = a.match(/^([\w.-]+)=(.+)$/);
  if (m) { scripts.push([m[1], path.resolve(m[2])]); }
}
const KEY_OF = (label) => (label === 'v1' || label === 'old1' ? 'diepAssist.v1' : 'diepAssist.v2');

const server = http.createServer((req, res) => {
  fs.readFile(path.join(here, 'mock-diep.html'), (err, data) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(data); });
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch({ headless: true });

const D = 180 / Math.PI;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function analyse(series, t0, label) {
  // series: [simT, angleRad]; unwrap, resample at 60 Hz relative to t0
  const pts = series.filter((p) => p[0] >= t0 - 0.05);
  let prev = pts[0][1], un = 0;
  const th = pts.map((p) => { un += wrap(p[1] - prev) * D; prev = p[1]; return [p[0] - t0, un]; });
  // moving-average smoothing (3 samples) to keep the numerical derivatives from drowning in quantisation
  const sm = th.map((p, i) => [p[0], (th[Math.max(0, i - 1)][1] + p[1] + th[Math.min(th.length - 1, i + 1)][1]) / 3]);
  const v = [], a = [], j = [];
  for (let i = 1; i < sm.length - 1; i++) v.push([sm[i][0], (sm[i + 1][1] - sm[i - 1][1]) / (sm[i + 1][0] - sm[i - 1][0])]);
  for (let i = 1; i < v.length - 1; i++) a.push([v[i][0], (v[i + 1][1] - v[i - 1][1]) / (v[i + 1][0] - v[i - 1][0])]);
  for (let i = 1; i < a.length - 1; i++) j.push([a[i][0], (a[i + 1][1] - a[i - 1][1]) / (a[i + 1][0] - a[i - 1][0])]);
  const tail = sm.filter((p) => p[0] > sm[sm.length - 1][0] - 0.25);
  const fin = tail.reduce((s, p) => s + p[1], 0) / tail.length;
  const start = sm.find((p) => p[0] >= 0)[1];
  const swing = fin - start;
  let onset = null;
  for (const p of sm) if (p[0] >= 0 && Math.abs(p[1] - start) > 1) { onset = p[0]; break; }
  let settle = null;
  for (let i = sm.length - 1; i >= 0; i--) if (sm[i][0] >= 0 && Math.abs(sm[i][1] - fin) > 2) { settle = sm[Math.min(i + 1, sm.length - 1)][0]; break; }
  const peak = (arr) => arr.filter((p) => p[0] >= 0).reduce((m, p) => Math.max(m, Math.abs(p[1])), 0);
  let over = 0;
  for (const p of sm) if (p[0] >= 0) over = Math.max(over, Math.sign(swing) * (p[1] - fin));
  return {
    label, swing: +swing.toFixed(0), onset: onset === null ? null : Math.round(onset * 1000), settle: settle === null ? null : Math.round(settle * 1000),
    vmax: Math.round(peak(v)), amax: Math.round(peak(a)), jmax: Math.round(peak(j)), over: +Math.max(0, over).toFixed(1),
  };
}

async function open(label, script, cfg, query) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERR', label, String(e)));
  await page.addInitScript((a) => { try { localStorage.setItem(a.k, JSON.stringify(a.c)); } catch (e) { /* ignore */ } }, { k: KEY_OF(label), c: cfg });
  await page.addInitScript({ path: script });
  await page.goto(`http://localhost:${port}/mock-diep.html?${query}`);
  return { page, ctx };
}

const rows = { swing: [], switch: [], enter: [] };
for (const [label, script] of scripts) {
  /* A: the cursor is parked on the far side of the tank, the aim is switched on */
  {
    const { page, ctx } = await open(label, script, { aim: false }, 'pattern=still');
    await page.mouse.move(200, 360);
    await page.waitForTimeout(2500);
    const t0 = await page.evaluate(() => __mock.simT());
    await page.keyboard.press('Backslash');
    await page.waitForTimeout(1500);
    const series = await page.evaluate(() => __mock.barrel.slice());
    rows.swing.push(analyse(series, t0, label));
    if (process.env.DUMP) {
      console.log(`\n[${label}] swing A: time(ms) angle(deg) speed(deg/s)`);
      const pts = series.filter((p) => p[0] >= t0 - 0.05 && p[0] <= t0 + 0.9);
      let un = 0, prev = pts[0][1]; const th = pts.map((p) => { un += wrap(p[1] - prev) * D; prev = p[1]; return [Math.round((p[0] - t0) * 1000), un]; });
      for (let i = 2; i < th.length - 2; i += 2) console.log(String(th[i][0]).padStart(5), th[i][1].toFixed(1).padStart(8), Math.round((th[i + 2][1] - th[i - 2][1]) / ((th[i + 2][0] - th[i - 2][0]) / 1000)).toString().padStart(7), '#'.repeat(Math.max(0, Math.round(Math.abs((th[i + 2][1] - th[i - 2][1]) / ((th[i + 2][0] - th[i - 2][0]) / 1000)) / 40))));
    }
    await ctx.close();
  }
  /* B: locked on one tank, it dies, the only other tank is on the opposite side */
  {
    const { page, ctx } = await open(label, script, { aim: true }, 'pattern=still');
    await page.mouse.move(640, 200);
    const B = await page.evaluate(() => __mock.addEnemy({ x: -380, y: 120, pattern: 'still' }));
    await page.waitForTimeout(3000);
    const t0 = await page.evaluate(() => { const A = __mock.enemies[0]; __mock.removeEnemy(A.id); return __mock.simT(); });
    await page.waitForTimeout(1600);
    rows.switch.push(analyse(await page.evaluate(() => __mock.barrel.slice()), t0, label));
    await ctx.close();
  }
  /* C: a tank appears on screen already moving (a brand new track, no velocity history yet) */
  {
    const { page, ctx } = await open(label, script, { aim: true }, 'pattern=still');
    await page.evaluate(() => __mock.clearEnemies());
    await page.mouse.move(640, 600);
    await page.waitForTimeout(2500);
    const t0 = await page.evaluate(() => { __mock.addEnemy({ x: 300, y: -250, vx: -90, vy: 200, pattern: 'drift' }); return __mock.simT(); });
    await page.waitForTimeout(1500);
    const r = analyse(await page.evaluate(() => __mock.barrel.slice()), t0, label);
    rows.enter.push(r);
    await ctx.close();
  }
}
const names = { swing: 'A  cursor on the far side -> aim switched on (swing to a tank ~100 deg away)', switch: 'B  target dies, next tank is on the opposite side (~180 deg swing)', enter: 'C  a moving tank appears (brand-new track)' };
for (const k of Object.keys(rows)) {
  console.log('\n' + names[k]);
  console.log('script   swing  onset  settle  vmax(deg/s)  amax(deg/s2)  jmax(deg/s3)  overshoot');
  for (const r of rows[k]) console.log(`${r.label.padEnd(8)} ${String(r.swing).padStart(5)} ${String(r.onset).padStart(6)} ${String(r.settle).padStart(7)} ${String(r.vmax).padStart(11)} ${String(r.amax).padStart(13)} ${String(r.jmax).padStart(13)} ${String(r.over).padStart(10)}`);
}
await browser.close(); server.close();
