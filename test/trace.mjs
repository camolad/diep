// Draws what an observer sees: the barrel angle over time against the ideal angle, and its angular speed.
//   DIEP_SCRIPT=diep-assist.user.js node test/trace.mjs out.png [pattern] [cfg-json]
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(process.env.DIEP_SCRIPT || path.join(here, '..', 'diep-assist.user.js'));
const out = process.argv[2] || 'trace.png', pattern = process.argv[3] || 'strafe', cfg = JSON.parse(process.argv[4] || '{}');
const server = http.createServer((req, res) => { fs.readFile(path.join(here, 'mock-diep.html'), (e, d) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(d); }); });
await new Promise((r) => server.listen(0, r));
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.addInitScript((c) => { localStorage.setItem('diepAssist.v2', JSON.stringify(c)); }, { aim: false, ...cfg });
await page.addInitScript({ path: SCRIPT });
await page.goto(`http://localhost:${server.address().port}/?pattern=${pattern}&lvl=25&${process.env.TRACE_QUERY || "net=jitter"}`);
await page.mouse.move(250, 500);
await page.waitForTimeout(2500);
const t0 = await page.evaluate(() => { __mock.barrel.length = 0; window.__tr = []; (function f() { const s = __mock.state(), e = s.enemies[0]; if (e) window.__tr.push([s.simT, Math.atan2(e.y - s.player.y, e.x - s.player.x), s.player.angle]); requestAnimationFrame(f); })(); return __mock.simT(); });
await page.keyboard.press('Backslash'); // aim on
await page.waitForTimeout(4500);
await page.evaluate(() => { __mock.clearEnemies(); __mock.addEnemy({ x: -380, y: 140, pattern: 'strafe' }); }); // the target dies, another appears on the other side
await page.waitForTimeout(4500);
const tr = await page.evaluate(() => window.__tr);
await page.close();

const D = 180 / Math.PI, wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const pts = tr.filter((p) => p[0] >= t0 - 0.2);
let ub = pts[0][2], ut = pts[0][1], prevB = pts[0][2], prevT = pts[0][1];
const data = pts.map((p) => { ub += wrap(p[2] - prevB); prevB = p[2]; ut += wrap(p[1] - prevT); prevT = p[1]; return [p[0] - t0, ub * D, ut * D]; });
// angular speed over a 3-sample window
const sp = data.map((d, i) => { const a = data[Math.max(0, i - 2)], b = data[Math.min(data.length - 1, i + 2)]; return [d[0], (b[1] - a[1]) / (b[0] - a[0] || 1)]; });
const plot = await browser.newPage({ viewport: { width: 1200, height: 760 } });
await plot.setContent('<canvas id=c width=1200 height=760></canvas>');
await plot.evaluate(({ data, sp }) => {
  const c = document.getElementById('c'), x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, 1200, 760);
  const T = data[data.length - 1][0];
  const panel = (y0, h, series, label, unit) => {
    const all = series.flatMap((s) => s.pts.map((p) => p[1])), lo = Math.min(...all), hi = Math.max(...all), pad = (hi - lo) * 0.05 + 1;
    const X = (t) => 60 + (t / T) * 1120, Y = (v) => y0 + h - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * h;
    x.strokeStyle = '#ccc'; x.strokeRect(60, y0, 1120, h);
    x.fillStyle = '#000'; x.font = '13px sans-serif'; x.fillText(label, 64, y0 - 6);
    for (let k = 0; k <= 4; k++) { const v = lo - pad + ((hi - lo + 2 * pad) * k) / 4; x.fillStyle = '#666'; x.fillText(v.toFixed(0) + unit, 4, Y(v) + 4); x.strokeStyle = '#eee'; x.beginPath(); x.moveTo(60, Y(v)); x.lineTo(1180, Y(v)); x.stroke(); }
    for (const s of series) { x.strokeStyle = s.col; x.lineWidth = s.w || 1.5; x.beginPath(); s.pts.forEach((p, i) => (i ? x.lineTo(X(p[0]), Y(p[1])) : x.moveTo(X(p[0]), Y(p[1])))); x.stroke(); }
    for (let t = 0; t <= T; t += 1) { x.fillStyle = '#666'; x.fillText(t + 's', X(t) - 6, y0 + h + 14); }
  };
  panel(30, 330, [{ col: '#e08a00', pts: data.map((d) => [d[0], d[2]]), w: 1 }, { col: '#1060d0', pts: data.map((d) => [d[0], d[1]]), w: 1.8 }], 'barrel angle (blue) vs ideal angle at the target (orange), degrees', '°');
  panel(410, 300, [{ col: '#1060d0', pts: sp, w: 1.3 }], 'barrel angular speed, deg/s', '');
}, { data, sp });
await plot.screenshot({ path: out });
console.log('wrote', out, 'samples', data.length);
await browser.close(); server.close();
