// How the script behaves on diep.io itself, using the offline mock served at https://diep.io/ (every request is fulfilled locally,
// nothing touches the real site) and, for the Sandbox / public distinction, window.__common__.active_gamemode as the real client
// exposes it (the mock sets it from ?mode=).
//
//   node test/diepio.mjs            (DIEP_SCRIPT=path picks the script)
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.DIEP_SCRIPT ? path.resolve(process.env.DIEP_SCRIPT) : path.resolve(here, '..', 'diep-assist.user.js');
const MOCK = fs.readFileSync(path.join(here, 'mock-diep.html'), 'utf8');
const browser = await chromium.launch({ headless: true });
let pass = 0, failed = 0;
const check = (name, ok, detail = '') => { (ok ? pass++ : failed++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };
const D = 180 / Math.PI;

/** open the mock as if it were diep.io (host = diep.io) or localhost */
async function open(query, { host = 'diep.io', cfg = {}, headers = {}, init = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route((u) => u.hostname === host, (r) => r.fulfill({ status: 200, contentType: 'text/html', headers, body: MOCK }));
  await page.addInitScript((c) => { try { localStorage.setItem('diepAssist.v2', JSON.stringify(c)); } catch (e) { /* ignore */ } }, { human: 0, ...cfg });
  if (init) await page.addInitScript(init);
  await page.addInitScript({ path: SCRIPT });
  await page.goto(`http://${host}/?${query}`);
  return { page, ctx, errors };
}
const angleErr = (page) => page.evaluate(() => {
  const st = __mock.state(), e = st.enemies[0];
  return Math.abs(Math.atan2(Math.sin(st.player.angle - Math.atan2(e.y - st.player.y, e.x - st.player.x)), Math.cos(st.player.angle - Math.atan2(e.y - st.player.y, e.x - st.player.x)))) * 180 / Math.PI;
});

/* 1. the install header */
{
  const head = fs.readFileSync(SCRIPT, 'utf8').split('==/UserScript==')[0];
  check('header: matches diep.io and its subdomains, runs at document-start in the page context', /@match\s+\*:\/\/diep\.io\/\*/.test(head) && /@match\s+\*:\/\/\*\.diep\.io\/\*/.test(head) && /@run-at\s+document-start/.test(head) && /@sandbox\s+raw/.test(head) && /@grant\s+none/.test(head), '');
}

/* 2. the menu pops up on diep.io, in a public mode, and says what is locked */
{
  const { page, ctx, errors } = await open('pattern=still&lvl=25&mode=ffa');
  await page.waitForTimeout(900);
  const r = await page.evaluate(() => {
    const vis = (el) => { if (!el) return false; const b = el.getBoundingClientRect(), cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 20 && b.height > 20 && b.right > 0 && b.bottom > 0 && b.left < innerWidth && b.top < innerHeight; };
    return {
      panel: vis(document.getElementById('da-panel')), badge: vis(document.getElementById('da-badge')), position: getComputedStyle(document.getElementById('da-panel')).position,
      banner: document.getElementById('da-lock').className, text: document.getElementById('da-locktext').textContent, button: document.getElementById('da-lockbtn').textContent,
      toast: document.getElementById('da-toast').textContent, kind: diepAssist.lobby().kind,
    };
  });
  check('diep.io: the menu and the DA badge are on screen', r.panel && r.badge && r.position === 'fixed', JSON.stringify(r));
  check('diep.io (ffa): the banner says the aids are off and offers the unlock button', r.banner === 'locked' && /ffa/.test(r.text) && /off/.test(r.text) && /private lobby/.test(r.button), `${r.banner} | ${r.text} | ${r.button}`);
  check('diep.io: a "loaded" toast names the menu key', /loaded/.test(r.toast) && /Insert/.test(r.toast), r.toast);
  check('diep.io: no page errors', errors.length === 0, errors.join('|'));
  await ctx.close();
}

/* 3. locked in a public mode: nothing aims, fires, farms or draws ESP */
{
  const { page, ctx } = await open('pattern=still&lvl=25&mode=ffa', { cfg: { aim: true, autoFire: true, farm: true, esp: true } });
  await page.mouse.move(250, 560);
  await page.waitForTimeout(3500);
  const r = await page.evaluate(() => {
    const S = diepAssist.S, ov = S.overlay.getContext('2d'), tk = S.tanks.find((t) => t.seen);
    let px = 0;
    if (tk) { const x0 = Math.round(S.rect.left + tk.sx * S.k - 90), y0 = Math.round(S.rect.top + tk.sy * S.k - 90); const d = ov.getImageData(Math.max(0, x0), Math.max(0, y0), 180, 180).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) px++; }
    return { on: diepAssist.ctl.on, sol: !!S.sol, tracked: S.tanks.filter((t) => t.seen).length, want: diepAssist.F.want, eToggles: __mock.stats.eToggles, espPixels: px, why: diepAssist.why() };
  });
  check('public mode: no lock-on, no target, no fire, no E presses', r.on === false && r.sol === false && r.want === false && r.eToggles === 0, JSON.stringify(r));
  check('public mode: the ESP draws nothing around a tank that is on screen', r.tracked >= 1 && r.espPixels === 0, `tracked ${r.tracked}, overlay pixels ${r.espPixels}`);
  check('public mode: the status explains how to unlock', /Unlock/.test(r.why), r.why);
  await ctx.close();
}

/* 4. a Sandbox is detected from the game: everything is on, with no click needed */
{
  const { page, ctx } = await open('pattern=still&lvl=25&mode=sandbox', { cfg: { aim: true } });
  await page.mouse.move(250, 560);
  await page.waitForTimeout(3500);
  const r = await page.evaluate(() => ({ kind: diepAssist.lobby().kind, banner: document.getElementById('da-lock').className, text: document.getElementById('da-locktext').textContent, button: document.getElementById('da-lockbtn').style.display, on: diepAssist.ctl.on }));
  const err = await angleErr(page);
  check('sandbox: detected, banner is green, no unlock button', r.kind === 'sandbox' && r.banner === 'sandbox' && /Sandbox/.test(r.text) && r.button === 'none', JSON.stringify(r));
  check('sandbox: the aim locks on', r.on === true && err < 1.5, `barrel off by ${err.toFixed(2)} deg`);
  /* the mode flips while playing (back to the home screen and another mode) */
  await page.evaluate(() => { window.__common__.active_gamemode = 'ffa'; });
  await page.waitForTimeout(1200);
  const off = await page.evaluate(() => ({ on: diepAssist.ctl.on, open: diepAssist.lobby().open }));
  check('leaving the Sandbox hands the cursor back at once', off.on === false && off.open === false, JSON.stringify(off));
  await page.evaluate(() => { window.__common__.active_gamemode = 'sandbox'; });
  await page.waitForTimeout(2200);
  check('...and back in a Sandbox it locks on again', await page.evaluate(() => diepAssist.ctl.on), '');
  await ctx.close();
}

/* 5. a lobby the game does not identify can be confirmed by the player, once, for that lobby */
{
  const { page, ctx } = await open('pattern=still&lvl=25', { cfg: { aim: true } });   // no __common__ at all
  page.on('dialog', (d) => d.accept());
  await page.mouse.move(250, 560);
  await page.waitForTimeout(1500);
  const before = await page.evaluate(() => ({ kind: diepAssist.lobby().kind, text: document.getElementById('da-locktext').textContent, on: diepAssist.ctl.on }));
  check('unknown mode: locked, and the text says the game did not report a Sandbox', before.kind === 'locked' && /did not report/.test(before.text) && before.on === false, JSON.stringify(before));
  await page.click('#da-lockbtn');
  await page.mouse.move(250, 560); // away from the menu again (the aim pauses while the pointer is over it)
  await page.waitForTimeout(2500);
  const after = await page.evaluate(() => ({ kind: diepAssist.lobby().kind, on: diepAssist.ctl.on, button: document.getElementById('da-lockbtn').textContent }));
  const err = await angleErr(page);
  check('the unlock button (after the confirmation dialog) turns the aids on', after.kind === 'confirmed' && after.on === true && err < 1.5 && after.button === 'Lock again', `${JSON.stringify(after)} off by ${err.toFixed(2)} deg`);
  await page.reload();
  await page.waitForTimeout(1200);
  check('the confirmation survives a reload of the same lobby', await page.evaluate(() => diepAssist.lobby().kind) === 'confirmed', '');
  await page.evaluate(() => { location.hash = '#another-lobby'; });
  await page.waitForTimeout(600);
  check('a different lobby (new link) asks again', await page.evaluate(() => diepAssist.lobby().kind) === 'locked', '');
  await page.evaluate(() => { location.hash = ''; });
  await page.waitForTimeout(600);
  await page.click('#da-lockbtn'); // unlocked again by the earlier confirmation for this lobby? (it was for the empty hash) -> Lock again
  await page.waitForTimeout(400);
  check('"Lock again" takes the confirmation back', await page.evaluate(() => diepAssist.lobby().kind) === 'locked', '');
  await ctx.close();
}

/* 6. a private server (localhost) is never restricted, and shows no banner */
{
  const { page, ctx } = await open('pattern=still&lvl=25', { host: 'localhost', cfg: { aim: true } });
  await page.mouse.move(250, 560);
  await page.waitForTimeout(3000);
  const r = await page.evaluate(() => ({ kind: diepAssist.lobby().kind, banner: getComputedStyle(document.getElementById('da-lock')).display, on: diepAssist.ctl.on }));
  check('localhost: no restriction and no banner', r.kind === 'own' && r.banner === 'none' && r.on === true, JSON.stringify(r));
  await ctx.close();
}

/* 7. a page that forbids inline styles (Content-Security-Policy) still gets a positioned menu */
{
  const { page, ctx } = await open('pattern=still&lvl=25&mode=ffa', { headers: { 'content-security-policy': "style-src 'none'" } });
  await page.waitForTimeout(900);
  const r = await page.evaluate(() => ({ position: getComputedStyle(document.getElementById('da-panel')).position, adopted: document.adoptedStyleSheets.length }));
  check('CSP style-src none: the menu is still styled (constructed stylesheet fallback)', r.position === 'fixed' && r.adopted >= 1, JSON.stringify(r));
  await ctx.close();
}

/* 8. if the menu cannot be built, the page says so instead of staying silent */
{
  const { page, ctx } = await open('pattern=still&lvl=25&mode=ffa', {
    init: () => { const o = Element.prototype.append; Element.prototype.append = function (...a) { if (this === document.body) throw new Error('boom'); return o.apply(this, a); }; },
  });
  await page.waitForTimeout(900);
  const msg = await page.evaluate(() => [...document.body.children].map((e) => e.textContent).find((t) => /failed to start/.test(t)) || null);
  check('a start-up failure is shown on the page', !!msg && /boom/.test(msg), msg);
  check('...and the script keeps running (frames are still processed)', await page.evaluate(() => !!diepAssist.S.ready), '');
  await ctx.close();
}

/* 9. the mouse-control self test: finds a way the game obeys */
for (const [label, query, want] of [
  ['synthetic mouse events', 'mode=sandbox', 'events'],
  ['only pointer events', 'mode=sandbox&mouse=pointer', 'pointer'],
  ['only the game\'s own input.mouse(x, y)', 'mode=sandbox&mouse=trusted&api=1', 'api'],
]) {
  const { page, ctx } = await open(`pattern=still&lvl=25&${query}`, { cfg: { aim: true } });
  await page.mouse.move(250, 560);
  await page.waitForTimeout(2500);
  const rows = await page.evaluate(() => diepAssist.check(true));
  const mc = rows.find((r) => /Mouse control/.test(r.label));
  const method = await page.evaluate(() => diepAssist.cfg.inputMethod);
  await page.waitForTimeout(2500);
  const err = await angleErr(page);
  check(`self test (${label}): passes with "${want}" and the aim then works with it`, mc && mc.ok === true && method === want && err < 2, `${mc && mc.detail} | method ${method} | barrel off by ${err.toFixed(2)} deg`);
  await ctx.close();
}
{
  const { page, ctx } = await open('pattern=still&lvl=25&mode=sandbox&mouse=trusted', { cfg: { aim: true } });
  await page.mouse.move(250, 560);
  await page.waitForTimeout(2500);
  const rows = await page.evaluate(() => diepAssist.check(true));
  const mc = rows.find((r) => /Mouse control/.test(r.label));
  check('self test: a game that ignores every synthetic input is reported, not hidden', mc && mc.ok === false && /did not follow/.test(mc.detail), mc && mc.detail);
  const rows2 = await page.evaluate(() => diepAssist.check(false));
  check('...and the passive check keeps the last test result', rows2.some((r) => /last test/.test(r.label) && r.ok === false), '');
  await ctx.close();
}
{
  const { page, ctx } = await open('pattern=still&lvl=25&mode=ffa');
  await page.mouse.move(250, 560);
  await page.waitForTimeout(2000);
  const rows = await page.evaluate(() => diepAssist.check(true));
  const mc = rows.find((r) => /Mouse control/.test(r.label));
  check('self test: refuses to turn the barrel in a public lobby', mc && mc.ok === null && /locked/.test(mc.detail), mc && mc.detail);
  const lobbyRow = rows.find((r) => r.label === 'Lobby');
  check('setup check: lists the lobby and the tank it sees', lobbyRow && lobbyRow.ok === false && rows.find((r) => r.label === 'My tank').ok === true, JSON.stringify(rows.map((r) => [r.label, r.ok])));
  await ctx.close();
}

/* 10. the passive tools work while locked: frame recorder, diagnostics report */
{
  const { page, ctx } = await open('pattern=still&lvl=25&mode=ffa');
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => new Promise((resolve) => {
    const rep = diepAssist.report();
    diepAssist.recordFrames(1, (d) => resolve({ calls: d.calls.length, ended: d.ended, lobby: rep.lobby, version: rep.version }));
  }));
  check('recording a frame works while locked', r.calls > 100 && r.ended === 'complete', JSON.stringify({ calls: r.calls, ended: r.ended }));
  check('the diagnostics report names the game mode the client reports', r.lobby.publicHost === true && r.lobby.mode === 'ffa' && r.lobby.common && r.lobby.common.active_gamemode === 'ffa', JSON.stringify(r.lobby).slice(0, 300));
  await ctx.close();
}

console.log(`\n${pass} passed, ${failed} failed`);
await browser.close();
process.exit(failed ? 1 : 0);
