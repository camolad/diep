// Replays RECORDED draw calls through the script's canvas hooks, so the detection is checked against what a real client drew
// instead of against my own mock.
//
//   node test/replay.mjs                                   # the fixtures in test/fixtures
//   node test/replay.mjs path/to/diep-frames-123.json      # a recording made with "Record 2 frames to a file" (or a legacy probe)
//   DIEP_SCRIPT=work/next.user.js node test/replay.mjs
//
// Two recording formats are understood:
//   diep-assist-frames/1   made by the script itself: every call with its canvas index and the changed context state
//   diep-draw-probe/legacy the 400-call probe of an earlier script (one record per call, full state each time)
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.DIEP_SCRIPT ? path.resolve(process.env.DIEP_SCRIPT) : path.resolve(here, '..', 'diep-assist.user.js');

// legacy probe -> frames format
export function normalise(j) {
  if (j.format === 'diep-assist-frames/1') return j;
  const calls = j.calls || j;
  const canvases = [], key = (c) => (c.main ? 'main' : c.width + 'x' + c.height);
  const idx = new Map(), out = [];
  for (const r of calls) {
    const k = key(r.canvas);
    if (!idx.has(k)) { idx.set(k, canvases.length); canvases.push({ id: r.canvas.main ? 'canvas' : '', w: r.canvas.width, h: r.canvas.height, main: !!r.canvas.main }); }
    const d = { fs: r.fillStyle, ss: r.strokeStyle, lw: r.lineWidth, lc: r.lineCap, ga: r.alpha, ft: r.font, ta: r.textAlign, tf: r.transform };
    out.push({ m: r.method, c: idx.get(k), a: r.args || [], d });
  }
  return { format: 'diep-assist-frames/1', canvases, calls: out, legacy: true };
}

// runs inside the page
function replayInPage(rec) {
  const main = document.getElementById('canvas');
  const mc = rec.canvases.find((c) => c.main);
  main.width = mc.w; main.height = mc.h;
  const cvs = rec.canvases.map((c) => (c.main ? main : Object.assign(document.createElement('canvas'), { width: c.w, height: c.h })));
  const ctxs = cvs.map((c) => c.getContext('2d'));
  const pats = {};
  const tile = Object.assign(document.createElement('canvas'), { width: 50, height: 50 });
  // text that was cached in an offscreen canvas before the recording: drawn again so the hooks see it
  rec.canvases.forEach((c, i) => {
    if (!c.texts) return;
    const x = ctxs[i];
    x.textAlign = 'center'; x.textBaseline = 'middle';
    for (const t of c.texts) { x.font = `${Math.max(1, t.s)}px sans-serif`; x.fillText(t.t, t.x, t.y); }
  });
  for (const k of Object.keys(rec.patterns || {})) {
    const p = rec.patterns[k], tc = Object.assign(document.createElement('canvas'), { width: p.w, height: p.h });
    pats[k] = ctxs[0].createPattern(tc, 'repeat');
    if (p.sx !== 1 || p.sy !== 1) pats[k].setTransform(new DOMMatrix([p.sx, 0, 0, p.sy, 0, 0]));
  }
  const dec = (v) => {
    if (Array.isArray(v)) return v.map(dec);
    if (v && typeof v === 'object') {
      if ('cv' in v) return cvs[v.cv];
      if ('pat' in v) return pats[v.pat];
      if ('img' in v) return Object.assign(document.createElement('canvas'), { width: v.img[0], height: v.img[1] });
    }
    return v;
  };
  const rounds = { fs: 'fillStyle', ss: 'strokeStyle', lw: 'lineWidth', lc: 'lineCap', lj: 'lineJoin', ga: 'globalAlpha', ft: 'font', ta: 'textAlign' };
  let n = 0, errors = [], lastMainClear = -1;
  const cvIsMain = (i) => rec.canvases[i].main;
  rec.calls.forEach((r, i) => {
    const ctx = ctxs[r.c];
    try {
      if (r.d) {
        for (const k of Object.keys(r.d)) {
          let v = r.d[k];
          if (k === 'tf') { ctx.setTransform(v[0], v[1], v[2], v[3], v[4], v[5]); continue; }
          if (v && typeof v === 'object') v = pats[v.pat];
          else if (typeof v === 'string' && v.startsWith('[object')) continue;
          if (k === 'fs' && typeof v === 'string' && v.startsWith('[object')) continue;
          ctx[rounds[k]] = v;
        }
      }
      if (typeof r.d === 'object' && r.d && typeof r.d.fs === 'string' && r.d.fs === '[object CanvasPattern]') { pats.legacy = pats.legacy || ctx.createPattern(tile, 'repeat'); ctx.fillStyle = pats.legacy; }
      const args = dec(r.a);
      if (r.m === 'createPattern') { const p = ctx.createPattern(args[0], args[1] || 'repeat'); if (r.p !== undefined) pats[r.p] = p; }
      else if (r.m === 'drawImage' || typeof ctx[r.m] === 'function') ctx[r.m](...args);
      if (r.m === 'clearRect' && cvIsMain(r.c)) lastMainClear = i;
      n++;
    } catch (e) { errors.push(i + ' ' + r.m + ': ' + e.message); }
  });
  // flush the frame: the script promotes a frame when the next full clear arrives
  const mctx = ctxs.find((_, i) => rec.canvases[i].main);
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.clearRect(0, 0, main.width, main.height);
  return { replayed: n, errors, lastMainClear };
}

export async function replay(file, opts = {}) {
  const rec = normalise(JSON.parse(fs.readFileSync(file, 'utf8')));
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><body style="margin:0"><canvas id="canvas"></canvas></body>'); });
  await new Promise((r) => server.listen(0, r));
  const browser = opts.browser || await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 655 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.addInitScript({ path: SCRIPT });
  await page.goto(`http://localhost:${server.address().port}/`);
  const r = await page.evaluate(replayInPage, rec);
  await page.waitForTimeout(250);
  const seen = await page.evaluate(() => {
    const d = window.diepAssist, f = d.S.ready;
    if (!f) return null;
    const q = (v) => v.slice(0, 40).map((e) => ({ x: Math.round(e.x), y: Math.round(e.y), r: Math.round(e.r * 10) / 10, col: e.col && e.col.hex, nc: e.nc }));
    return { why: d.why(), tanks: q(f.tanks), bullets: q(f.bullets), shapes: q(f.shapes), drones: q(f.drones), bars: f.bars.length, texts: f.texts.map((t) => t.text).slice(0, 40), grid: f.grid, diag: f.diag, errors: d.S.lastError, canvas: [d.S.canvas.width, d.S.canvas.height] };
  });
  if (!opts.browser) await browser.close();
  server.close();
  return { rec, replayed: r, pageErrors, seen };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (!files.length) files.push(...fs.readdirSync(path.join(here, 'fixtures')).filter((f) => f.endsWith('.json')).map((f) => path.join(here, 'fixtures', f)));
  for (const f of files) {
    const r = await replay(f);
    console.log('\n' + path.basename(f), `calls ${r.rec.calls.length}, replayed ${r.replayed.replayed}`, r.replayed.errors.length ? 'replay errors: ' + r.replayed.errors.slice(0, 5).join(' | ') : '', r.pageErrors.length ? 'PAGE ERRORS: ' + r.pageErrors.join(' | ') : '');
    console.log(JSON.stringify(r.seen, null, 1));
  }
}
