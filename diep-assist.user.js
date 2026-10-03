// ==UserScript==
// @name         Diep Assist (private server testing)
// @namespace    https://github.com/camolad/diep
// @version      2.0.0
// @description  Smooth predictive auto-aim, auto-fire, ESP, shape farming, auto-build scheduler and quality-of-life tools for a private diep.io-style server you run yourself.
// @match        http://localhost/*
// @match        http://localhost:*/*
// @match        http://127.0.0.1/*
// @match        http://127.0.0.1:*/*
// @match        https://YOUR-PRIVATE-SERVER.example/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/*
 * SETUP: edit the @match lines above so they only cover your own private server.
 * The script refuses to run on the public diep.io.
 *
 * Open / close the menu with Insert (rebindable in the Misc tab).
 * Default hotkeys:  \ aim   [ fire   ] ESP   ; farm shapes   ' prediction   Delete master switch
 *
 * HOW IT WORKS
 *   diep draws everything on one <canvas>, so there is no DOM to query. The script wraps a few
 *   CanvasRenderingContext2D methods and rebuilds, every frame, a list of what was drawn:
 *     - tank   = grey parts (barrels, bases, turrets) followed by a body (two circles: border + fill)
 *     - bullet = the same circle pair without grey parts
 *     - shape  = a polygon filled with one of the four shape colours
 *   The camera is followed through the background grid pattern (and the shapes), so enemies can be
 *   tracked in world coordinates. Each enemy gets a least-squares position/velocity track, and the
 *   aim point is the intercept of a bullet (flight profile measured from your own shots) with the
 *   enemy's predicted path. The cursor is then moved with synthetic mousemove events, eased towards
 *   the aim point rather than snapped to it.
 */
(function () {
  'use strict';

  if (window.__diepAssistLoaded) return;
  window.__diepAssistLoaded = true;
  if (/(^|\.)diep\.io$/i.test(location.hostname)) {
    console.warn('[Diep Assist] Disabled on the public diep.io - this script is for private servers you run yourself.');
    return;
  }

  /* ===================================================================== *
   *  1. Utilities
   * ===================================================================== */
  const hyp = Math.hypot;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const nowMs = () => performance.now();
  const median = (arr) => {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const n = s.length;
    return n & 1 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
  };
  // Distance a target keeps covering after `h` seconds if it keeps its velocity but, as players do,
  // gradually changes course: v * tau * (1 - e^(-h/tau)).
  const decay = (h, tau) => (tau >= 20 ? h : tau * (1 - Math.exp(-h / tau)));
  // Bring `d`, known only modulo `period`, to the value nearest `expected`.
  const unwrap = (d, period, expected) => d - period * Math.round((d - expected) / period);

  let errorCount = 0;
  function fail(e) {
    if (errorCount++ < 5) console.warn('[Diep Assist]', e);
    S.lastError = String((e && e.message) || e);
  }

  /* ===================================================================== *
   *  2. Settings
   * ===================================================================== */
  const STORE_KEY = 'diepAssist.v2';
  const DEFAULTS = {
    enabled: true, // master switch
    // aiming
    aim: true,
    aimMode: 'always', // always | firing | hold
    holdKey: 'KeyF',
    priority: 'closest', // closest (to my tank) | cursor (to my real mouse)
    range: 100, // % of the half screen diagonal
    predict: true,
    latency: 120, // ms between "what I see" and "where the bullet is born"
    persistence: 1.2, // s, how long a straight-line guess is trusted
    leadScale: 100, // %
    inherit: false, // bullets inherit the shooter's velocity
    autoTune: true, // measure the real latency from my own shots and use it instead of the slider
    measured: 0, // s, loop latency measured from my own shots (0 = not measured yet)
    smooth: 130, // ms, how long a lock-on takes to settle (higher = softer)
    reaction: 70, // ms between spotting a target and the cursor starting to move
    maxTurn: 0, // deg/s, 0 = unlimited
    stickiness: 50, // %
    farm: false,
    farmPriority: 'nearest', // nearest | value
    // firing
    autoFire: false,
    fireMethod: 'toggleE', // toggleE | holdSpace
    fireConfidence: 30, // %
    fireMaxFlight: 1.8, // s
    fireTolerance: 100, // % of the target's angular radius
    // visuals
    esp: true,
    espPath: true,
    espArrows: true,
    espBullets: true,
    aimLine: false,
    hud: true,
    debug: false,
    // safety / comfort
    uiZones: true, // let real clicks through on the upgrade panels
    panelPause: true, // pause aim while the pointer is over this menu
    // build
    build: '',
    buildKeep: false,
    buildMethod: 'auto', // auto | console | keys
    buildMode: 'balanced', // balanced | down | up
    // misc
    autoRespawn: false,
    spawnName: '',
    renFps: false,
    renCollisions: false,
    renRawHealth: false,
    renHideUi: false,
    netPredict: true,
    keys: {
      menu: 'Insert',
      master: 'Delete',
      aim: 'Backslash',
      fire: 'BracketLeft',
      esp: 'BracketRight',
      farm: 'Semicolon',
      predict: 'Quote',
    },
    ui: { tab: 'Aim', x: null, y: null, open: true },
  };

  function loadConfig() {
    const c = JSON.parse(JSON.stringify(DEFAULTS));
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      for (const k of Object.keys(saved)) {
        if (k === 'keys' || k === 'ui') Object.assign(c[k], saved[k]);
        else if (k in c && typeof saved[k] === typeof c[k]) c[k] = saved[k];
      }
    } catch { /* storage blocked: defaults */ }
    return c;
  }
  const cfg = loadConfig();
  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
    }, 150);
  }

  /* ===================================================================== *
   *  3. Shared state and colour helpers
   * ===================================================================== */
  const S = {
    canvas: null, overlay: null, octx: null,
    cur: null, ready: null, readySeq: 0, processedSeq: 0, prevFrame: null,
    cw: 0, ch: 0, k: 1, rect: null, frameT: 0,
    self: null, me: null, selfCol: null, selfTrack: null, selfSeenT: -1e9, noSelf: 99, wasDown: true,
    tanks: [], shapes: [], target: null, targetSince: 0, sol: null,
    mouse: { x: innerWidth / 2, y: innerHeight / 2 }, mouseTh: null, mouseThT: 0, mouseW: 0, pivot: null,
    mouseL: false, spaceDown: false, holdDown: false, panelHover: false,
    playing: false, spawnT: 0, lastPlayingT: -1e9,
    dom: { menu: false, dead: false, t: -1e9 },
    stats: { shots: 0, hits: 0 }, loopSamples: 0,
    lastOwnBirth: -1e9, threats: 0,
    fps: 60, lastTs: 0, lastError: '',
  };

  const colorCache = new Map();
  const SHAPE_HEX = new Set(['#ffe869', '#fc7677', '#768dfc', '#f177dd']);
  const toHex = (n) => (n < 16 ? '0' : '') + Math.round(n).toString(16);
  function parseColor(style) {
    if (typeof style !== 'string') return null;
    let c = colorCache.get(style);
    if (c !== undefined) return c;
    let r = -1, g = 0, b = 0, a = 1;
    if (style.charCodeAt(0) === 35) {
      if (style.length === 7 || style.length === 9) {
        r = parseInt(style.slice(1, 3), 16); g = parseInt(style.slice(3, 5), 16); b = parseInt(style.slice(5, 7), 16);
        if (style.length === 9) a = parseInt(style.slice(7, 9), 16) / 255;
      } else if (style.length === 4) {
        r = parseInt(style[1] + style[1], 16); g = parseInt(style[2] + style[2], 16); b = parseInt(style[3] + style[3], 16);
      }
    } else {
      const m = style.match(/[\d.]+/g);
      if (m && m.length >= 3) { r = +m[0]; g = +m[1]; b = +m[2]; if (m.length >= 4) a = +m[3]; }
    }
    if (r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255) {
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      let hue = 0;
      if (d > 0) {
        if (max === r) hue = ((g - b) / d + 6) % 6;
        else if (max === g) hue = (b - r) / d + 2;
        else hue = (r - g) / d + 4;
        hue *= 60;
      }
      c = { r, g, b, a, hex: '#' + toHex(r) + toHex(g) + toHex(b), h: hue, s: max === 0 ? 0 : d / max, gray: d < 12 };
    } else c = null;
    if (colorCache.size > 600) colorCache.clear();
    colorCache.set(style, c);
    return c;
  }
  // Same team = same hue. A tank flashing white after a hit keeps its hue, so it is not mistaken for a new team.
  function sameTeam(a, b) {
    if (!a || !b || a.gray || b.gray) return false;
    if (a.s < 0.12 || b.s < 0.12) return false;
    const d = Math.abs(a.h - b.h);
    return Math.min(d, 360 - d) < 25;
  }

  /* ===================================================================== *
   *  4. Canvas hooks: collect what the game draws each frame
   * ===================================================================== */
  const proto = CanvasRenderingContext2D.prototype;
  const orig = {};
  for (const n of ['clearRect', 'fillRect', 'beginPath', 'moveTo', 'lineTo', 'rect', 'arc', 'fill', 'createPattern']) orig[n] = proto[n];
  const patternInfo = new WeakMap();
  const path = { n: 0, lines: 0, circles: 0, other: 0, sx: 0, sy: 0, minX: 0, maxX: 0, minY: 0, maxY: 0, cx: 0, cy: 0, cr: 0 };

  function pathReset() {
    path.n = 0; path.lines = 0; path.circles = 0; path.other = 0; path.sx = 0; path.sy = 0;
    path.minX = Infinity; path.maxX = -Infinity; path.minY = Infinity; path.maxY = -Infinity;
  }
  function pathPoint(x, y) {
    path.n++; path.sx += x; path.sy += y;
    if (x < path.minX) path.minX = x;
    if (x > path.maxX) path.maxX = x;
    if (y < path.minY) path.minY = y;
    if (y > path.maxY) path.maxY = y;
  }
  const newFrame = (t) => ({
    t, calls: 0, tanks: [], bullets: [], shapes: [], grid: null,
    pendingGray: null, grayRect: null, lastCircle: null, lastBody: null,
  });

  proto.clearRect = function (x, y, w, h) {
    try { onClear(this, w, h); } catch (e) { fail(e); }
    return orig.clearRect.apply(this, arguments);
  };
  proto.fillRect = function () {
    if (this.canvas === S.canvas && S.cur) {
      const fs = this.fillStyle;
      if (fs && typeof fs === 'object') { try { onGrid(this, fs); } catch (e) { fail(e); } }
    }
    return orig.fillRect.apply(this, arguments);
  };
  proto.beginPath = function () {
    if (this.canvas === S.canvas) pathReset();
    return orig.beginPath.apply(this, arguments);
  };
  proto.moveTo = function (x, y) {
    if (this.canvas === S.canvas) pathPoint(x, y);
    return orig.moveTo.apply(this, arguments);
  };
  proto.lineTo = function (x, y) {
    if (this.canvas === S.canvas) { path.lines++; pathPoint(x, y); }
    return orig.lineTo.apply(this, arguments);
  };
  proto.rect = function (x, y, w, h) {
    if (this.canvas === S.canvas) {
      path.lines += 4;
      pathPoint(x, y); pathPoint(x + w, y); pathPoint(x, y + h); pathPoint(x + w, y + h);
    }
    return orig.rect.apply(this, arguments);
  };
  proto.arc = function (x, y, r, a0, a1) {
    if (this.canvas === S.canvas) {
      if (Math.abs(a1 - a0) > 6) { path.circles++; path.cx = x; path.cy = y; path.cr = r; } else path.other++;
    }
    return orig.arc.apply(this, arguments);
  };
  proto.fill = function () {
    if (this.canvas === S.canvas && (arguments.length === 0 || typeof arguments[0] === 'string')) {
      try { onFill(this); } catch (e) { fail(e); }
    }
    return orig.fill.apply(this, arguments);
  };
  const patternProto = typeof CanvasPattern !== 'undefined' ? CanvasPattern.prototype : null;
  const origSetTransform = patternProto && patternProto.setTransform;
  if (origSetTransform) {
    patternProto.setTransform = function (m) {
      try {
        const info = patternInfo.get(this);
        if (info && m) { info.sx = hyp(m.a, m.b) || 1; info.sy = hyp(m.c, m.d) || 1; }
      } catch { /* ignore */ }
      return origSetTransform.apply(this, arguments);
    };
  }
  proto.createPattern = function (img) {
    const p = orig.createPattern.apply(this, arguments);
    try { if (p && img && img.width) patternInfo.set(p, { w: img.width, h: img.height }); } catch { /* ignore */ }
    return p;
  };

  function onClear(ctx, w, h) {
    const c = ctx.canvas;
    if (!c || c === S.overlay) return;
    if (w < c.width * 0.9 || h < c.height * 0.9) return; // only whole-canvas clears start a frame
    if (S.canvas === null) {
      const big = c.isConnected && c.width >= innerWidth * 0.5 && c.height >= innerHeight * 0.5;
      if (c.id === 'canvas' || big) S.canvas = c; else return;
    }
    if (c !== S.canvas) return;
    if (S.cur && S.cur.calls > 0) { S.ready = S.cur; S.readySeq++; }
    S.cur = newFrame(nowMs());
  }

  function onGrid(ctx, pattern) {
    const t = ctx.getTransform();
    const zoom = hyp(t.a, t.b);
    const info = patternInfo.get(pattern);
    S.cur.grid = { e: t.e, f: t.f, zoom, pw: info ? info.w * (info.sx || 1) * zoom : 0, ph: info ? info.h * (info.sy || 1) * zoom : 0 };
  }

  function onFill(ctx) {
    const f = S.cur;
    if (!f) return;
    const P = path;
    if (P.n === 0 && P.circles === 0) return;
    const col = parseColor(ctx.fillStyle);
    if (!col) return;
    f.calls++;
    const m = ctx.getTransform();
    const sc = hyp(m.a, m.b);
    if (P.circles === 1 && P.lines === 0 && P.other === 0) {
      onCircle(f, m.a * P.cx + m.c * P.cy + m.e, m.b * P.cx + m.d * P.cy + m.f, P.cr * sc, col);
    } else if (P.n > 0) {
      const lx = P.sx / P.n, ly = P.sy / P.n;
      const ext = (Math.max(P.maxX - P.minX, P.maxY - P.minY) * sc) / 2;
      onPolygon(f, m.a * lx + m.c * ly + m.e, m.b * lx + m.d * ly + m.f, ext, col);
    }
  }

  function pushEntity(f, x, y, r, col, tank) {
    (tank ? f.tanks : f.bullets).push({ x, y, r, col });
    if (tank) f.lastBody = { x, y, r };
    f.pendingGray = null; f.grayRect = null; f.lastCircle = null;
  }
  const onLastBody = (f, x, y) => f.lastBody !== null && hyp(x - f.lastBody.x, y - f.lastBody.y) < f.lastBody.r * 1.2;

  function onCircle(f, x, y, r, col) {
    if (col.gray) {
      // A grey circle is an auto-turret dome (on a barrel drawn just before) or a grey bullet.
      const g = f.grayRect;
      const dome = g !== null && hyp(g.x - x, g.y - y) < r * 2;
      f.pendingGray = dome && !onLastBody(f, x, y) ? { x, y } : null;
      f.lastCircle = null;
      return;
    }
    const first = f.lastCircle;
    if (first && Math.abs(first.x - x) < 1 && Math.abs(first.y - y) < 1 && first.r > r) {
      // second circle of a border + body pair: a complete tank or bullet
      const g = f.pendingGray;
      pushEntity(f, x, y, first.r, col, g !== null && hyp(g.x - x, g.y - y) < first.r * 4);
    } else {
      f.lastCircle = { x, y, r };
    }
  }

  function onPolygon(f, x, y, ext, col) {
    if (col.gray) { f.pendingGray = { x, y }; f.grayRect = { x, y }; f.lastCircle = null; return; }
    const g = f.pendingGray;
    f.pendingGray = null; f.grayRect = null; f.lastCircle = null;
    if (SHAPE_HEX.has(col.hex)) { f.shapes.push({ x, y, r: ext, col }); return; }
    // A coloured polygon right after grey parts is a tank whose body is not round (Necromancer).
    const selfR = S.me ? S.me.r : 20;
    if (g && ext >= selfR * 0.6 && hyp(g.x - x, g.y - y) < ext * 4) pushEntity(f, x, y, ext, col, true);
  }

  /* ===================================================================== *
   *  5. World model: camera and tracks
   * ===================================================================== */
  let idSeq = 0;
  const TRACK_WIN = 0.22; // s of history used for each position / velocity fit
  const cam = { x: 0, y: 0, zoom: 1, track: null, gridErr: 0, gridTrust: true, src: 'none', deadFor: 0 };

  // Weighted least-squares line through samples h[i0..i1): p(t) = p0 + v * (t - tRef). Newer samples weigh more.
  function lsq(h, i0, i1, tRef) {
    let sw = 0, st = 0, stt = 0, sx = 0, sy = 0, stx = 0, sty = 0;
    for (let i = i0; i < i1; i++) {
      const tau = (h[i].t - tRef) / 1000;
      const w = 1 + 1.5 * clamp(1 + tau / TRACK_WIN, 0, 1);
      sw += w; st += w * tau; stt += w * tau * tau;
      sx += w * h[i].x; sy += w * h[i].y; stx += w * tau * h[i].x; sty += w * tau * h[i].y;
    }
    const det = sw * stt - st * st;
    if (det < 1e-7) return null;
    const vx = (sw * stx - st * sx) / det, vy = (sw * sty - st * sy) / det;
    const x = (sx - vx * st) / sw, y = (sy - vy * st) / sw;
    let e2 = 0;
    for (let i = i0; i < i1; i++) {
      const tau = (h[i].t - tRef) / 1000;
      const w = 1 + 1.5 * clamp(1 + tau / TRACK_WIN, 0, 1);
      e2 += w * ((h[i].x - x - vx * tau) ** 2 + (h[i].y - y - vy * tau) ** 2);
    }
    return { x, y, vx, vy, res: Math.sqrt(e2 / sw) };
  }

  class Track {
    constructor(kind, t, wx, wy) {
      this.kind = kind; this.id = ++idSeq; this.hist = [];
      this.x = wx; this.y = wy; this.vx = 0; this.vy = 0;
      this.first = t; this.last = t; this.n = 0; this.res = 0; this.acc = 0;
      this.rW = 0; this.col = null; this.sx = 0; this.sy = 0; this.seen = true;
      this.threat = null;
      this.push(t, wx, wy);
    }
    push(t, wx, wy) {
      const h = this.hist;
      h.push({ t, x: wx, y: wy });
      while (h.length > 2 && t - h[0].t > 460) h.shift();
      this.last = t;
      this.fit();
    }
    fit() {
      const h = this.hist, n = h.length, last = h[n - 1];
      let i0 = n - 1;
      while (i0 > 0 && last.t - h[i0 - 1].t <= TRACK_WIN * 1000) i0--;
      this.n = n - i0;
      const f = this.n >= 3 && last.t - h[i0].t >= 50 ? lsq(h, i0, n, last.t) : null;
      if (f) {
        this.x = f.x; this.y = f.y; this.vx = f.vx; this.vy = f.vy; this.res = f.res;
        // acceleration: how much the velocity changed since the window before this one
        let j1 = i0, j0 = i0;
        while (j0 > 0 && h[j1 - 1].t - h[j0 - 1].t <= TRACK_WIN * 1000) j0--;
        const old = j1 - j0 >= 3 && h[j1 - 1].t - h[j0].t >= 50 ? lsq(h, j0, j1, h[j1 - 1].t) : null;
        if (old) {
          const dtc = ((last.t + h[i0].t) / 2 - (h[j1 - 1].t + h[j0].t) / 2) / 1000;
          this.acc = dtc > 0.02 ? hyp(f.vx - old.vx, f.vy - old.vy) / dtc : 0;
        }
        return;
      }
      if (this.n >= 2 && last.t - h[i0].t >= 25) {
        const dt = (last.t - h[i0].t) / 1000;
        this.vx = (last.x - h[i0].x) / dt; this.vy = (last.y - h[i0].y) / dt;
      } // else: keep the previous velocity (new or re-acquired track)
      this.x = last.x; this.y = last.y; this.res = 0;
    }
  }

  const toWX = (sx) => (sx - S.cw / 2) / cam.zoom + cam.x;
  const toWY = (sy) => (sy - S.ch / 2) / cam.zoom + cam.y;
  const toSX = (wx) => (wx - cam.x) * cam.zoom + S.cw / 2;
  const toSY = (wy) => (wy - cam.y) * cam.zoom + S.ch / 2;

  // The camera is the world position of the screen centre. Everything static on screen (the background grid,
  // the shapes) slides the opposite way when it moves, which is how it is measured.
  function updateCamera(f, prev) {
    const g = f.grid;
    if (g && g.zoom > 0.02 && g.zoom < 50) cam.zoom = g.zoom;
    if (!cam.track) cam.track = new Track('cam', f.t, cam.x, cam.y);
    if (!prev) { cam.src = 'none'; return; }
    const dt = (f.t - prev.t) / 1000;
    if (dt < 0.002 || dt > 0.6) { cam.src = 'gap'; return; }
    const Z = cam.zoom;
    const exx = -cam.track.vx * dt * Z, exy = -cam.track.vy * dt * Z; // dead-reckoned shift of static things (px)

    let sh = null; // shift measured from the shapes
    if (f.shapes.length >= 3 && prev.shapes.length >= 3) {
      const gate = 6 + 0.4 * hyp(exx, exy);
      const dxs = [], dys = [];
      for (const s of f.shapes) {
        let best = null, bd = gate;
        for (const p of prev.shapes) {
          const d = hyp(s.x - p.x - exx, s.y - p.y - exy);
          if (d < bd) { bd = d; best = p; }
        }
        if (best) { dxs.push(s.x - best.x); dys.push(s.y - best.y); }
      }
      if (dxs.length >= 3) sh = { x: median(dxs), y: median(dys) };
    }
    let gr = null; // shift measured from the grid pattern
    if (g && prev.grid) {
      const refx = sh ? sh.x : exx, refy = sh ? sh.y : exy;
      let rx = g.e - prev.grid.e, ry = g.f - prev.grid.f;
      if (g.pw > 4 && g.ph > 4) { rx = unwrap(rx, g.pw, refx); ry = unwrap(ry, g.ph, refy); }
      if (hyp(rx - refx, ry - refy) < (g.pw > 4 ? Math.min(g.pw, g.ph) * 0.3 : 20)) gr = { x: rx, y: ry };
    }
    let shift;
    if (gr && sh) {
      cam.gridErr += (hyp(gr.x - sh.x, gr.y - sh.y) - cam.gridErr) * 0.1;
      cam.gridTrust = cam.gridErr < 2.5;
      shift = cam.gridTrust ? gr : sh; cam.src = cam.gridTrust ? 'grid' : 'shapes'; cam.deadFor = 0;
    } else if (gr && cam.gridTrust) { shift = gr; cam.src = 'grid'; cam.deadFor = 0; }
    else if (sh) { shift = sh; cam.src = 'shapes'; cam.deadFor = 0; }
    else {
      cam.deadFor += dt;
      shift = cam.deadFor < 0.5 ? { x: exx, y: exy } : { x: 0, y: 0 };
      cam.src = 'dead';
    }
    cam.x -= shift.x / Z; cam.y -= shift.y / Z;
    cam.track.push(f.t, cam.x, cam.y);
  }

  // Associate this frame's detections with tracks (nearest first), create tracks for the rest.
  function matchTracks(list, dets, t, kind, gateOf) {
    const pairs = [];
    for (const tk of list) {
      const dt = (t - tk.last) / 1000;
      const px = tk.x + tk.vx * Math.min(dt, 0.3), py = tk.y + tk.vy * Math.min(dt, 0.3);
      const gate = gateOf(tk, dt);
      for (let j = 0; j < dets.length; j++) {
        const d = hyp(dets[j].wx - px, dets[j].wy - py);
        if (d < gate) pairs.push({ d, tk, j });
      }
    }
    pairs.sort((a, b) => a.d - b.d);
    const usedT = new Set(), usedD = new Set();
    for (const p of pairs) {
      if (usedT.has(p.tk) || usedD.has(p.j)) continue;
      usedT.add(p.tk); usedD.add(p.j);
      const d = dets[p.j], tk = p.tk;
      if (t - tk.last > 300) { tk.hist.length = 0; tk.vx = 0; tk.vy = 0; tk.first = t; } // back after a gap: start the fit afresh
      tk.rW = d.r; tk.col = d.col; tk.sx = d.sx; tk.sy = d.sy;
      tk.push(t, d.wx, d.wy);
    }
    for (let j = 0; j < dets.length; j++) {
      if (usedD.has(j)) continue;
      const d = dets[j];
      const tk = new Track(kind, t, d.wx, d.wy);
      tk.rW = d.r; tk.col = d.col; tk.sx = d.sx; tk.sy = d.sy;
      list.push(tk);
      usedT.add(tk);
    }
    for (const tk of list) tk.seen = usedT.has(tk);
  }

  // Two detections of the same object (e.g. an overlay drawn on a body) collapse into the larger one.
  function dedupe(dets) {
    const out = [];
    for (const d of dets.sort((a, b) => b.r - a.r)) {
      if (!out.some((o) => hyp(o.wx - d.wx, o.wy - d.wy) < o.r * 0.5)) out.push(d);
    }
    return out;
  }

  function detectSelf(f, t) {
    let px = S.cw / 2, py = S.ch / 2, lim = S.ch * 0.25;
    const st = S.selfTrack;
    const fresh = st && t - st.last < 400;
    if (fresh) {
      const age = (t - st.last) / 1000;
      px = toSX(st.x + st.vx * age); py = toSY(st.y + st.vy * age);
      lim = S.ch * 0.12;
    }
    // after a death the killer can sit in the middle of the screen: only relearn the colour when the game says we are alive
    const relearn = !S.selfCol || (S.noSelf > 30 && !S.dom.dead && !S.dom.menu);
    let best = null, bd = Infinity;
    for (const e of f.tanks) {
      let d = hyp(e.x - px, e.y - py);
      if (d >= lim) continue;
      const own = S.selfCol && sameTeam(e.col, S.selfCol);
      // a tank flashing white after a hit has no hue left, but it is still me if it is exactly where I was
      const flashMe = fresh && e.col.s < 0.3 && d < S.ch * 0.04;
      if (!own && !flashMe && !relearn) continue;
      if (own) d *= 0.5;
      if (d < bd) { bd = d; best = e; }
    }
    S.self = best;
    if (!best) { S.noSelf++; return; }
    S.noSelf = 0;
    S.selfSeenT = t;
    if (best.col.s >= 0.3) S.selfCol = best.col;
    const wx = toWX(best.x), wy = toWY(best.y);
    if (!st || t - st.last > 1000) { S.selfTrack = new Track('self', t, wx, wy); } else st.push(t, wx, wy);
    S.selfTrack.rW = best.r / cam.zoom;
  }

  const GHOST_MS = 8000;
  function updateTracks(f, t) {
    const dets = [];
    const sdets = [];
    if (S.selfCol && S.me) {
      for (const e of f.tanks) {
        if (e === S.self || sameTeam(e.col, S.selfCol)) continue;
        if (e.r < S.me.r * 0.35) continue;
        dets.push({ wx: toWX(e.x), wy: toWY(e.y), r: e.r / cam.zoom, sx: e.x, sy: e.y, col: e.col });
      }
      if (cfg.farm) {
        for (const e of f.shapes) sdets.push({ wx: toWX(e.x), wy: toWY(e.y), r: e.r / cam.zoom, sx: e.x, sy: e.y, col: e.col });
      }
    }
    matchTracks(S.tanks, dedupe(dets), t, 'tank', (tk, dt) => tk.rW + 15 + Math.min(700 * dt, 900));
    matchTracks(S.shapes, dedupe(sdets), t, 'shape', (tk, dt) => tk.rW + 10 + 60 * dt);
    S.tanks = S.tanks.filter((tk) => t - tk.last < GHOST_MS);
    S.shapes = S.shapes.filter((tk) => t - tk.last < 700);
  }

  /* ===================================================================== *
   *  6. Own bullets: flight profile and shot statistics; enemy bullets: threats
   * ===================================================================== */
  const BUCKET = 0.1; // s
  const bullet = { reach: [0], valid: 1, muzzle: [], active: [] };
  // Which way the game was pointed, over the last second or so (cursor angle about my tank, unwrapped). Every bullet
  // leaves in the direction the cursor had one loop-latency earlier, so matching a bullet's flight direction against
  // this history measures that latency directly, whatever the target does.
  const angHist = [];
  const loopHist = [];
  function recordAngle(t, th) {
    const n = angHist.length;
    const u = n ? angHist[n - 1].th + wrapAngle(th - angHist[n - 1].th) : th;
    if (n && t - angHist[n - 1].t < 2) angHist[n - 1].th = u;
    else angHist.push({ t, th: u });
    while (angHist.length && t - angHist[0].t > 1300) angHist.shift();
    return u;
  }
  function angleAt(t) {
    const h = angHist;
    if (h.length < 2 || t < h[0].t || t > h[h.length - 1].t) return null;
    let i = h.length - 1;
    while (i > 0 && h[i - 1].t > t) i--;
    const a = h[Math.max(0, i - 1)], b = h[i];
    return b.t > a.t ? a.th + ((b.th - a.th) * (t - a.t)) / (b.t - a.t) : a.th;
  }
  function measureLoop(b, t) {
    if (b.measured) return;
    const age = (t - b.born) / 1000;
    if (age < 0.15) return;
    const me = S.selfTrack;
    if (!me || angHist.length < 8) { b.measured = true; return; }
    // wait until the bullet has flown far enough for its direction to be well defined
    if (hyp(b.x - b.x0, b.y - b.y0) < me.rW * 2.5) { if (age > 0.8) b.measured = true; return; }
    b.measured = true;
    let vx = (b.x - b.x0) / age, vy = (b.y - b.y0) / age;
    if (cfg.inherit) { vx -= b.vsx; vy -= b.vsy; }
    const phi = Math.atan2(vy, vx);
    let best = -1, be = 1e9;
    const errs = [];
    for (let tau = 0.02; tau <= 0.6; tau += 0.005) {
      const th = angleAt(b.born - tau * 1000);
      if (th === null) continue;
      const e = Math.abs(wrapAngle(phi - th));
      errs.push([tau, e]);
      if (e < be) { be = e; best = tau; }
    }
    if (best < 0 || be > 0.035) return;                      // never pointed this way: not fired by the aim we know about
    for (const [tau, e] of errs) if (Math.abs(tau - best) > 0.04 && e < be * 1.5 + 0.0087) return; // ambiguous: cursor was (nearly) still
    loopHist.push(best);
    if (loopHist.length > 9) loopHist.shift();
    S.loopSamples++;
    // a new bullet only shows up at the next server tick and display frame (~25 ms on average), which the target's
    // interpolated position does not suffer from, so that much is taken back off
    if (loopHist.length >= 4) { cfg.measured = Math.max(0.01, median(loopHist) - 0.025); save(); }
  }

  function bulletPrior() { return 20 * (S.selfTrack ? S.selfTrack.rW : 50); } // world units / s until measured
  function muzzleDist() { return bullet.muzzle.length >= 4 ? median(bullet.muzzle) : (S.selfTrack ? S.selfTrack.rW * 1.7 : 80); }
  function reachInv(d) {
    if (d <= 0) return 0;
    const r = bullet.reach, n = bullet.valid;
    if (n < 3) return d / bulletPrior();
    for (let i = 1; i < n; i++) {
      if (r[i] >= d) return (i - 1 + (d - r[i - 1]) / (r[i] - r[i - 1] || 1)) * BUCKET;
    }
    const j = Math.max(0, n - 4);
    const sp = Math.max((r[n - 1] - r[j]) / ((n - 1 - j) * BUCKET), 60);
    return (n - 1) * BUCKET + (d - r[n - 1]) / sp;
  }
  function reachAt(T) {
    const r = bullet.reach, n = bullet.valid;
    if (n < 3) return bulletPrior() * T;
    const i = Math.floor(T / BUCKET);
    if (i >= n - 1) {
      const j = Math.max(0, n - 4);
      return r[n - 1] + Math.max((r[n - 1] - r[j]) / ((n - 1 - j) * BUCKET), 60) * (T - (n - 1) * BUCKET);
    }
    return r[i] + (r[i + 1] - r[i]) * (T / BUCKET - i);
  }

  function mergeBullet(b) {
    const s = b.samples;
    if (s.length < 5 || b.path < 1 || hyp(b.x - b.x0, b.y - b.y0) < 0.9 * b.path) return; // drones wander, traps stop
    const maxAge = s[s.length - 1][0] / 1000;
    for (let i = 1; i * BUCKET <= maxAge; i++) {
      const ts = i * BUCKET * 1000;
      let j = 0;
      while (j < s.length - 1 && s[j + 1][0] < ts) j++;
      const a = s[j], c = s[Math.min(j + 1, s.length - 1)];
      const d = c[0] > a[0] ? a[1] + ((c[1] - a[1]) * (ts - a[0])) / (c[0] - a[0]) : a[1];
      bullet.reach[i] = bullet.reach[i] === undefined ? d : bullet.reach[i] * 0.7 + d * 0.3;
    }
    let n = 1;
    while (bullet.reach[n] !== undefined) { bullet.reach[n] = Math.max(bullet.reach[n], bullet.reach[n - 1]); n++; }
    bullet.valid = n;
  }

  function updateOwnBullets(f, t) {
    const me = S.selfTrack;
    if (!me || !S.me || !S.selfCol) { bullet.active.length = 0; return; }
    const Z = cam.zoom;
    for (const b of bullet.active) b.seen = false;
    for (const e of f.bullets) {
      if (!sameTeam(e.col, S.selfCol)) continue;
      const wx = toWX(e.x), wy = toWY(e.y), rW = e.r / Z;
      let best = null, bd = Infinity;
      for (const b of bullet.active) {
        if (b.seen) continue;
        const dt = (t - b.t) / 1000;
        const d = hyp(wx - (b.x + b.vx * dt), wy - (b.y + b.vy * dt));
        if (d < bd) { bd = d; best = b; }
      }
      const gate = best && best.n > 1 ? Math.max(rW * 3, 40) : Math.max(rW * 8, 160);
      if (best && bd < gate) {
        const dt = (t - best.t) / 1000;
        if (dt > 0) {
          best.vx = (wx - best.x) / dt; best.vy = (wy - best.y) / dt;
          best.path += hyp(wx - best.x, wy - best.y);
        }
        best.x = wx; best.y = wy; best.t = t; best.n++; best.seen = true; best.rW = rW;
        best.samples.push([t - best.born, hyp(wx - best.x0, wy - best.y0)]);
        measureLoop(best, t);
      } else if (hyp(wx - me.x, wy - me.y) < me.rW * 4 + 60) {
        const b = {
          born: t, t, x: wx, y: wy, x0: wx, y0: wy, vx: 0, vy: 0, n: 1, seen: true, rW, path: 0,
          samples: [[0, 0]], shot: null, measured: false, vsx: me.vx, vsy: me.vy,
        };
        bullet.muzzle.push(hyp(wx - me.x, wy - me.y));
        if (bullet.muzzle.length > 30) bullet.muzzle.shift();
        S.lastOwnBirth = t;
        b.shot = ctl.on && S.sol ? { tk: S.sol.tk } : null; // a shot = a bullet born while locked on a target
        if (b.shot) S.stats.shots++;
        bullet.active.push(b);
      }
    }
    for (let i = bullet.active.length - 1; i >= 0; i--) {
      const b = bullet.active[i];
      if (b.seen && t - b.born < 3000) continue;
      bullet.active.splice(i, 1);
      mergeBullet(b);
      if (b.shot) endShot(b, t);
    }
  }

  function endShot(b, t) {
    const tk = b.shot.tk;
    if (t - tk.last > 400) return;
    const age = Math.min((t - tk.last) / 1000, 0.3);
    const d = hyp(b.x - (tk.x + tk.vx * age), b.y - (tk.y + tk.vy * age));
    if (d < tk.rW + b.rW + 12) S.stats.hits++;
  }

  const eBullets = [];
  function updateEnemyBullets(f, t) {
    const me = S.selfTrack;
    if (!cfg.espBullets || !me || !S.selfCol) { eBullets.length = 0; S.threats = 0; return; }
    const dets = [];
    for (const e of f.bullets) {
      if (sameTeam(e.col, S.selfCol) || e.col.gray || SHAPE_HEX.has(e.col.hex)) continue;
      dets.push({ wx: toWX(e.x), wy: toWY(e.y), r: e.r / cam.zoom, sx: e.x, sy: e.y, col: e.col });
    }
    matchTracks(eBullets, dets, t, 'ebullet', (tk, dt) => tk.rW * 3 + 30 + 1500 * dt);
    for (let i = eBullets.length - 1; i >= 0; i--) if (t - eBullets[i].last > 250) eBullets.splice(i, 1);
    let threats = 0;
    for (const tk of eBullets) {
      tk.threat = null;
      if (!tk.seen || tk.n < 3) continue;
      const rx = tk.x - me.x, ry = tk.y - me.y, ux = tk.vx - me.vx, uy = tk.vy - me.vy;
      const uu = ux * ux + uy * uy;
      if (uu < 1) continue;
      const tc = -(rx * ux + ry * uy) / uu;
      if (tc < 0 || tc > 1.2) continue;
      if (hyp(rx + ux * tc, ry + uy * tc) < (me.rW + tk.rW) * 1.2) { tk.threat = tc; threats++; }
    }
    S.threats = threats;
  }

  /* ===================================================================== *
   *  7. Aim solver
   * ===================================================================== */
  const GRACE_MS = 250;
  const effLatency = () => clamp(cfg.autoTune && cfg.measured > 0 ? cfg.measured : cfg.latency / 1000, 0, 0.8);
  const SHAPE_VALUE = { '#768dfc': 3, '#f177dd': 2, '#fc7677': 1.8, '#ffe869': 1 };

  function pickTarget(t) {
    const me = S.me;
    if (!me) return null;
    const rect = S.rect;
    const mx = (S.mouse.x - rect.left) / S.k, my = (S.mouse.y - rect.top) / S.k;
    const maxD = (cfg.range / 100) * hyp(S.cw, S.ch) / 2 + 1;
    const tau = cfg.persistence;
    const cands = [];
    const consider = (tk, scale) => {
      const age = (t - tk.last) / 1000;
      if (age * 1000 > GRACE_MS) return;
      const sx = toSX(tk.x + tk.vx * decay(age, tau)), sy = toSY(tk.y + tk.vy * decay(age, tau));
      const keep = tk === S.target; // the target we already have gets a wider band, so the edge does not flicker
      const mg = keep ? 40 : 0;
      if (sx < -mg || sx > S.cw + mg || sy < -mg || sy > S.ch + mg) return;
      const d = hyp(sx - me.x, sy - me.y);
      if (d > (keep ? maxD * 1.15 : maxD)) return;
      const key = (cfg.priority === 'cursor' && scale === 1 ? hyp(sx - mx, sy - my) : d) / scale;
      cands.push({ tk, key });
    };
    for (const tk of S.tanks) consider(tk, 1);
    if (!cands.length && cfg.farm) {
      for (const tk of S.shapes) consider(tk, cfg.farmPriority === 'value' ? SHAPE_VALUE[tk.col.hex] || 1 : 1);
    }
    if (!cands.length) return null;
    cands.sort((a, b) => a.key - b.key);
    let best = cands[0];
    const cur = S.target && cands.find((c) => c.tk === S.target);
    if (cur && best.tk !== cur.tk) {
      const s = (cfg.stickiness / 100) * 0.6;
      if (t - S.targetSince < 350 || best.key > cur.key * (1 - s)) best = cur;
    }
    return best.tk;
  }

  function solveAim(tk, t) {
    const me = S.selfTrack;
    if (!me) return null;
    const tau = cfg.persistence;
    const age = Math.max(0, (t - tk.last) / 1000);
    const L = cfg.predict ? effLatency() : 0;
    const mature = clamp((tk.last - tk.first - 40) / 100, 0, 1); // lead fades in over the first 140 ms of a track
    const lead = cfg.predict ? (cfg.leadScale / 100) * mature : 0;
    const m = muzzleDist();
    const Ps = { x: me.x, y: me.y }, Vs = { x: me.vx, y: me.vy };
    const inh = cfg.inherit ? 1 : 0;
    const Rw = me.rW || 50;
    let tvx = tk.vx, tvy = tk.vy;
    const sp0 = hyp(tvx, tvy), vcap = 25 * Rw; // anything faster is a tracking glitch (teleport, mismatched track)
    if (sp0 > vcap) { tvx *= vcap / sp0; tvy *= vcap / sp0; }
    const x0 = tk.x + tvx * decay(age, tau) * lead, y0 = tk.y + tvy * decay(age, tau) * lead; // where it is now
    let T = reachInv(Math.max(0, hyp(x0 - Ps.x, y0 - Ps.y) - m));
    let qx = x0, qy = y0;
    for (let i = 0; i < 7; i++) {
      const adv = decay(age + L + T, tau) * lead;
      qx = tk.x + tvx * adv; qy = tk.y + tvy * adv;
      const d = hyp(qx - Ps.x - inh * Vs.x * T, qy - Ps.y - inh * Vs.y * T);
      const Tn = Math.min(reachInv(Math.max(0, d - m)), 2.5);
      const done = Math.abs(Tn - T) < 0.004;
      T = Tn;
      if (done) break;
    }
    const ax = qx - inh * Vs.x * T, ay = qy - inh * Vs.y * T; // world point to aim at
    const dx = ax - Ps.x, dy = ay - Ps.y;
    const dist = hyp(dx, dy) || 1;
    const speed = hyp(tvx, tvy);
    const bulletSpeed = Math.max(reachAt(T) / Math.max(T, 0.05), 1);
    const stab = 1 / (1 + (tk.acc / (6 * Rw)) ** 2);
    const samples = clamp((tk.n - 2) / 6, 0, 1);
    const conf = clamp(
      (1 - T / (cfg.fireMaxFlight * 1.25)) * 0.45 + stab * 0.35 + samples * 0.2 - 0.3 * Math.max(0, speed / bulletSpeed - 0.8),
      0, 1,
    );
    return {
      tk, T, dist, conf, ax, ay, ux: dx / dist, uy: dy / dist,
      tol: Math.atan2(tk.rW + 6, dist), t,
      // aim point on the canvas (px) and in CSS px for the mouse event
      cx: toSX(ax), cy: toSY(ay),
      px: S.rect.left + toSX(ax) * S.k, py: S.rect.top + toSY(ay) * S.k,
    };
  }

  /* ===================================================================== *
   *  8. Cursor control: take the cursor over like a hand would, never snap it
   * ===================================================================== */
  // The cursor is driven in polar coordinates around my own tank (angle + distance), not along a straight
  // line on screen: a swing to the far side then turns the barrel through the shortest arc instead of cutting
  // across the tank, which would flip the barrel almost instantly. The angle goes through two critically
  // damped followers in series, so a lock-on starts with zero speed AND zero acceleration (bell-shaped speed,
  // continuous jerk), and it starts with the speed the real mouse had, so taking over is seamless.
  const ctl = {
    on: false, thA: 0, wA: 0, thB: 0, wB: 0, rho: 0, rv: 0, x: 0, y: 0,
    gw: 0, gr: 0, gPrev: null, armT: -1, lastEng: -1e9, suspended: false, reassert: false, err: 0,
  };
  const sd = { x: 0, v: 0 };
  // One step of a critically damped follower (the SmoothDamp scheme); result in sd.
  function smoothDamp(x, goal, v, smoothTime, dt) {
    const w = 2 / Math.max(smoothTime, 1e-3), k = w * dt;
    const e = 1 / (1 + k + 0.48 * k * k + 0.235 * k * k * k);
    const d = x - goal, tmp = (v + w * d) * dt;
    sd.v = (v - w * tmp) * e;
    sd.x = goal + (d + tmp) * e;
  }

  function dispatchMouse(x, y) {
    const c = S.canvas;
    const ev = new MouseEvent('mousemove', {
      clientX: x, clientY: y, screenX: x + (window.screenX || 0), screenY: y + (window.screenY || 0),
      bubbles: true, cancelable: true, composed: true, view: window,
    });
    (c || window).dispatchEvent(ev);
  }

  function canEngage() {
    if (!cfg.enabled || !cfg.aim || !S.playing || ctl.suspended || !S.sol || !S.pivot) return false;
    if (cfg.panelPause && S.panelHover) return false;
    // a tank spotted a moment ago has no velocity estimate yet: wait until it has one
    if (!ctl.on && (S.sol.tk.last - S.sol.tk.first < 60 || S.sol.tk.n < 3)) return false;
    if (cfg.autoFire) return true;
    if (cfg.aimMode === 'firing') return S.mouseL || S.spaceDown || F.belief;
    if (cfg.aimMode === 'hold') return S.holdDown;
    return true;
  }

  function beginEngage(piv, t) {
    const mx = S.mouse.x - piv.x, my = S.mouse.y - piv.y;
    ctl.thA = ctl.thB = recordAngle(t, Math.atan2(my, mx));
    ctl.wA = ctl.wB = clamp(S.mouseW, -18, 18); // carry on at the speed the hand had
    ctl.rho = Math.max(hyp(mx, my), 12); ctl.rv = 0;
    ctl.gPrev = null; ctl.gw = 0; ctl.gr = 0;
    ctl.on = true;
  }

  function control(dt, t) {
    const piv = S.pivot;
    const eng = canEngage();
    if (!ctl.on) {
      if (!eng) { ctl.armT = -1; ctl.err = 0; return; }
      if (ctl.armT < 0) ctl.armT = t;
      // a short reaction time before a fresh lock-on (none when re-locking right after a release)
      if (t - ctl.lastEng > 400 && t - ctl.armT < cfg.reaction) return;
      beginEngage(piv, t);
    }
    if (!piv) { releaseNow(S.mouse.x, S.mouse.y); return; }

    const total = Math.max(cfg.smooth, 0) / 1000;
    let gTh, gRho;
    if (eng) {
      const d = S.sol;
      const dx = d.px - piv.x, dy = d.py - piv.y;
      gTh = Math.atan2(dy, dx); gRho = Math.max(hyp(dx, dy), 12);
      // how fast the aim point is moving (rad/s, px/s): added to the goal to cancel the lag of the followers
      const gp = ctl.gPrev;
      if (gp && gp.id === d.tk.id) {
        if (d.t !== gp.t) {
          const dtf = (d.t - gp.t) / 1000, dth = wrapAngle(gTh - gp.th);
          if (dtf > 0.004 && dtf < 0.2 && Math.abs(dth) < 0.7) {
            const k = 1 - Math.exp(-dtf / 0.07);
            ctl.gw += (dth / dtf - ctl.gw) * k;
            ctl.gr += ((gRho - gp.rho) / dtf - ctl.gr) * k;
          }
          ctl.gPrev = { th: gTh, rho: gRho, t: d.t, id: d.tk.id };
        }
      } else { ctl.gw = 0; ctl.gr = 0; ctl.gPrev = { th: gTh, rho: gRho, t: d.t, id: d.tk.id }; }
      gTh += ctl.gw * total; gRho += ctl.gr * total;
      ctl.lastEng = t;
    } else {
      gTh = Math.atan2(S.mouse.y - piv.y, S.mouse.x - piv.x);
      gRho = Math.max(hyp(S.mouse.x - piv.x, S.mouse.y - piv.y), 12);
      ctl.gPrev = null; ctl.gw = 0; ctl.gr = 0;
    }

    const st = eng ? total : Math.max(total, 0.12); // hand the cursor back a little more gently
    const old = ctl.thB;
    if (st < 0.004) {
      ctl.thA = ctl.thB = gTh; ctl.wA = ctl.wB = 0; ctl.rho = gRho; ctl.rv = 0;
    } else {
      smoothDamp(ctl.thA, ctl.thA + wrapAngle(gTh - ctl.thA), ctl.wA, st / 2, dt); ctl.thA = sd.x; ctl.wA = sd.v;
      smoothDamp(ctl.thB, ctl.thB + wrapAngle(ctl.thA - ctl.thB), ctl.wB, st / 2, dt); ctl.thB = sd.x; ctl.wB = sd.v;
      smoothDamp(ctl.rho, gRho, ctl.rv, st, dt); ctl.rho = sd.x; ctl.rv = sd.v;
    }
    if (cfg.maxTurn > 0) {
      const lim = ((cfg.maxTurn * Math.PI) / 180) * dt;
      if (Math.abs(ctl.thB - old) > lim) { ctl.thB = old + Math.sign(ctl.thB - old) * lim; ctl.wB = clamp(ctl.wB, -lim / dt, lim / dt); }
    }
    ctl.x = piv.x + Math.cos(ctl.thB) * ctl.rho;
    ctl.y = piv.y + Math.sin(ctl.thB) * ctl.rho;
    recordAngle(t, ctl.thB);
    ctl.err = eng ? Math.abs(wrapAngle(ctl.thB - Math.atan2(S.sol.py - piv.y, S.sol.px - piv.x))) : 0;
    if (!eng && Math.abs(wrapAngle(ctl.thB - gTh)) < 0.008 && Math.abs(ctl.rho - gRho) < 2 && Math.abs(ctl.wB) < 0.3 && Math.abs(ctl.rv) < 30) {
      ctl.on = false; dispatchMouse(S.mouse.x, S.mouse.y); return;
    }
    dispatchMouse(ctl.x, ctl.y);
  }

  function releaseNow(x, y) {
    if (!ctl.on) return;
    ctl.on = false; ctl.gPrev = null;
    dispatchMouse(x, y);
  }

  /* ===================================================================== *
   *  9. Synthetic keys and the fire controller
   * ===================================================================== */
  const KEYS = {
    e: ['KeyE', 69], u: ['KeyU', 85], ' ': ['Space', 32],
    1: ['Digit1', 49], 2: ['Digit2', 50], 3: ['Digit3', 51], 4: ['Digit4', 52],
    5: ['Digit5', 53], 6: ['Digit6', 54], 7: ['Digit7', 55], 8: ['Digit8', 56],
  };
  function sendKey(type, ch) {
    const [code, kc] = KEYS[ch];
    const ev = new KeyboardEvent(type, { key: ch, code, keyCode: kc, which: kc, bubbles: true, cancelable: true, composed: true, view: window });
    if (ev.keyCode !== kc) {
      try {
        Object.defineProperty(ev, 'keyCode', { get: () => kc });
        Object.defineProperty(ev, 'which', { get: () => kc });
      } catch { /* ignore */ }
    }
    (document.body || window).dispatchEvent(ev);
  }

  // `belief` is whether the game's auto-fire (E) is believed to be on. E is a toggle, so the script keeps
  // a belief and corrects it from what actually happens (bullets appearing, or not).
  const F = { belief: false, lastPress: -1e9, spaceHeld: false, want: false, births: [], seenBirth: -1e9 };

  function pressE() {
    sendKey('keydown', 'e'); sendKey('keyup', 'e');
    F.belief = !F.belief; F.lastPress = nowMs();
  }

  function fireControl(t) {
    let want = false;
    const sol = S.sol;
    if (cfg.enabled && cfg.autoFire && S.playing && sol && ctl.on) {
      const tolOk = ctl.err <= Math.max(0.035, sol.tol * (cfg.fireTolerance / 100));
      want = tolOk && sol.T <= cfg.fireMaxFlight && sol.conf >= cfg.fireConfidence / 100;
      // hysteresis: keep firing through short dips in confidence
      if (!want && F.want && sol.T <= cfg.fireMaxFlight && sol.conf >= (cfg.fireConfidence / 100) * 0.7 && ctl.err <= 0.2) want = true;
    }
    F.want = want;
    if (cfg.fireMethod === 'holdSpace') {
      if (want && !F.spaceHeld) { sendKey('keydown', ' '); F.spaceHeld = true; }
      else if (!want && F.spaceHeld) { sendKey('keyup', ' '); F.spaceHeld = false; }
      return;
    }
    if (F.spaceHeld) { sendKey('keyup', ' '); F.spaceHeld = false; }
    if (!S.playing) return;
    // reconcile the belief with reality
    if (S.lastOwnBirth > F.seenBirth) {
      F.seenBirth = S.lastOwnBirth;
      F.births.push(S.lastOwnBirth);
      if (F.births.length > 6) F.births.shift();
    }
    if (F.belief && t - Math.max(S.lastOwnBirth, F.lastPress) > 3000) F.belief = false; // "on" but nothing fires
    if (!F.belief && !S.mouseL && !S.spaceDown) {
      const recent = F.births.filter((b) => t - b < 3000 && b > F.lastPress + 500);
      if (recent.length >= 3) F.belief = true; // bullets keep coming with the button up: it is on
    }
    if (want !== F.belief && t - F.lastPress > 300 && (cfg.autoFire || F.belief)) {
      if (want || (F.belief && cfg.autoFire)) pressE();
    }
  }

  /* ===================================================================== *
   *  10. Auto build: schedule the stat points
   * ===================================================================== */
  const STATS = [
    ['Health Regen', 'HR'], ['Max Health', 'MH'], ['Body Damage', 'BD'], ['Bullet Speed', 'BS'],
    ['Bullet Penetration', 'BP'], ['Bullet Damage', 'DMG'], ['Reload', 'RLD'], ['Movement Speed', 'MS'],
  ];
  const MAX_POINTS = 33, MAX_STAT = 7;
  const PRESETS = [
    ['Rammer / Smasher', [5, 7, 7, 0, 0, 0, 7, 7]],
    ['Bullet Umbrella', [0, 1, 2, 2, 7, 7, 7, 7]],
    ['Glass Cannon', [0, 0, 0, 6, 7, 7, 7, 6]],
    ['Balanced', [3, 3, 3, 5, 5, 5, 5, 4]],
    ['Overlord', [2, 3, 0, 7, 7, 7, 0, 7]],
    ['Factory', [2, 3, 0, 5, 6, 7, 6, 4]],
    ['Armor / Traps', [0, 6, 6, 0, 7, 7, 7, 0]],
  ];
  const STAT_COLORS = ['#7bd88f', '#e5866b', '#c58af9', '#6fb7ff', '#ffd166', '#ff7aa8', '#4fd6c9', '#b0b8c8'];
  // points arrive at levels 2..28, then at 30, 33, 36, 39, 42, 45 (33 in total)
  const levelOfPoint = (i) => (i < 27 ? i + 2 : 30 + 3 * (i - 27));
  const sanitizeBuild = (s) => String(s || '').replace(/[^1-8]/g, '').slice(0, MAX_POINTS);
  function countStats(s) {
    const c = Array(8).fill(0);
    for (const ch of s) c[+ch - 1]++;
    return c;
  }
  // Turn "how many points in each stat" into an upgrade order.
  //   balanced: each stat climbs in proportion to its final level (nothing is left for last)
  //   down / up: finish stat 1 (8) first, then 2 (7), ...
  function scheduleBuild(targets, mode) {
    const total = targets.reduce((a, b) => a + b, 0);
    let out = '';
    if (mode === 'down' || mode === 'up') {
      const order = mode === 'down' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
      for (const s of order) out += String(s + 1).repeat(targets[s]);
      return out;
    }
    const placed = Array(8).fill(0);
    for (let k = 1; k <= total; k++) {
      let best = -1, bs = -Infinity;
      for (let s = 0; s < 8; s++) {
        if (placed[s] >= targets[s]) continue;
        const sc = (targets[s] * k) / total - placed[s]; // how far this stat is behind its share
        if (sc > bs + 1e-9) { bs = sc; best = s; }
      }
      placed[best]++; out += best + 1;
    }
    return out;
  }
  if (!cfg.build) cfg.build = scheduleBuild(PRESETS[3][1], 'balanced');

  const build = { last: -1e9, pendingSpawn: false, queueing: false, status: '' };
  const hasConsole = () => !!(window.input && typeof window.input.execute === 'function');
  function consoleExec(cmd) {
    try { window.input.execute(cmd); return true; } catch (e) { fail(e); return false; }
  }
  // The game queues points for you while U is held: U + a number = "spend the next point on this stat".
  function queueByKeys(b) {
    if (build.queueing) return;
    build.queueing = true;
    const seq = [() => sendKey('keydown', 'u')];
    for (const ch of b) { seq.push(() => sendKey('keydown', ch)); seq.push(() => sendKey('keyup', ch)); }
    seq.push(() => sendKey('keyup', 'u'));
    let i = 0;
    const step = () => {
      try { seq[i++](); } catch (e) { fail(e); }
      if (i < seq.length) setTimeout(step, i % 2 ? 25 : 45); else build.queueing = false;
    };
    step();
  }
  function applyBuild() {
    const b = sanitizeBuild(cfg.build);
    if (!b) return false;
    const method = cfg.buildMethod === 'auto' ? (hasConsole() ? 'console' : 'keys') : cfg.buildMethod;
    let ok;
    if (method === 'console') ok = hasConsole() && consoleExec('game_stats_build ' + b);
    else { queueByKeys(b); ok = true; }
    build.last = nowMs();
    build.status = ok ? `queued ${b.length} points via ${method}` : 'game console not available';
    return ok;
  }
  function buildTick(t) {
    if (!cfg.enabled || !cfg.buildKeep || !S.playing) return;
    if (build.pendingSpawn) {
      if (t - S.spawnT > 700) { build.pendingSpawn = false; applyBuild(); }
    } else if ((cfg.buildMethod === 'console' || (cfg.buildMethod === 'auto' && hasConsole())) && t - build.last > 5000) {
      applyBuild(); // harmless to repeat: the game continues from the points already spent
    }
  }

  /* ===================================================================== *
   *  11. Misc: respawn, game convars
   * ===================================================================== */
  const misc = { lastSpawnTry: -1e9, convarsApplied: false };
  const CONVARS = [
    ['renFps', 'ren_fps', 'Show FPS', false, false],
    ['renCollisions', 'ren_debug_collisions', 'Show collision boxes', false, false],
    ['renRawHealth', 'ren_raw_health_values', 'Raw health numbers', false, false],
    ['renHideUi', 'ren_ui', 'Hide game UI', false, true],
    ['netPredict', 'net_predict_movement', 'Client movement prediction', true, false],
  ];
  function applyConvar(row) {
    const [key, name, , def, invert] = row;
    consoleExec(name + ' ' + (invert ? !cfg[key] : cfg[key]));
    return def;
  }
  function applyConvarsOnce() {
    if (misc.convarsApplied || !hasConsole()) return;
    misc.convarsApplied = true;
    for (const row of CONVARS) if (cfg[row[0]] !== row[3]) applyConvar(row);
  }
  function respawnTick(t) {
    if (!cfg.enabled || !cfg.autoRespawn || S.playing || !S.wasDown) return;
    if (t - S.lastPlayingT < 800 || t - misc.lastSpawnTry < 2000) return;
    misc.lastSpawnTry = t;
    if (hasConsole()) {
      consoleExec('game_spawn ' + String(cfg.spawnName || '').replace(/[^\w .-]/g, '').slice(0, 15));
    } else {
      const btn = document.querySelector('.action-button') || document.getElementById('spawn-button');
      if (btn && btn.offsetParent !== null) btn.click();
    }
  }
  function domCheck(t) {
    if (t - S.dom.t < 250) return;
    S.dom.t = t;
    const vis = (el) => el !== null && el.offsetParent !== null;
    S.dom.menu = vis(document.getElementById('spawn-button'));
    S.dom.dead = vis(document.querySelector('.action-button'));
  }

  /* ===================================================================== *
   *  12. Frame processing and main loop
   * ===================================================================== */
  function processFrame(f) {
    const cv = S.canvas;
    S.cw = cv.width; S.ch = cv.height;
    S.k = cv.clientWidth ? cv.clientWidth / cv.width : 1;
    S.rect = cv.getBoundingClientRect();
    S.frameT = f.t;
    updateCamera(f, S.prevFrame);
    S.prevFrame = f;
    detectSelf(f, f.t);
    // where my tank is on screen: as drawn, or (for the frames it is hidden by a hit flash) where it should be
    const st = S.selfTrack;
    if (S.self) S.me = { x: S.self.x, y: S.self.y, r: S.self.r };
    else if (st && f.t - st.last < 300) {
      const age = (f.t - st.last) / 1000;
      S.me = { x: toSX(st.x + st.vx * age), y: toSY(st.y + st.vy * age), r: st.rW * cam.zoom };
    } else S.me = null;
    S.pivot = S.me ? { x: S.rect.left + S.me.x * S.k, y: S.rect.top + S.me.y * S.k } : null;
    updateTracks(f, f.t);
    updateOwnBullets(f, f.t);
    updateEnemyBullets(f, f.t);

    const playing = f.t - S.selfSeenT < 400 && !S.dom.menu && !S.dom.dead && !!S.selfTrack;
    // "down" = in the menu or on the death screen (not merely a stalled frame loop): a new life starts when it ends
    const down = S.dom.menu || S.dom.dead || S.noSelf >= 20;
    if (playing && !S.playing) {
      S.playing = true;
      if (S.wasDown) { S.spawnT = f.t; build.pendingSpawn = true; }
    } else if (!playing && S.playing) { S.playing = false; S.target = null; bullet.active.length = 0; F.births.length = 0; }
    if (down) S.wasDown = true; else if (playing) S.wasDown = false;
    if (playing) S.lastPlayingT = f.t;

    let sol = null;
    if (playing && cfg.enabled) {
      const tk = pickTarget(f.t);
      if (tk) {
        if (tk !== S.target) { S.target = tk; S.targetSince = f.t; }
        sol = solveAim(tk, f.t);
      } else S.target = null;
    } else S.target = null;
    S.sol = sol;
  }

  const raf = window.requestAnimationFrame.bind(window);
  function loop(ts) {
    raf(loop);
    try { tick(ts); } catch (e) { fail(e); }
  }
  function tick(ts) {
    const dt = clamp((ts - (S.lastTs || ts)) / 1000, 0.001, 0.1);
    S.lastTs = ts;
    S.fps += (1 / dt - S.fps) * 0.05;
    const t = nowMs();
    domCheck(t);
    if (t - S.mouseThT > 90) S.mouseW = 0;
    if (S.ready && S.readySeq !== S.processedSeq) {
      S.processedSeq = S.readySeq;
      try { processFrame(S.ready); } catch (e) { fail(e); }
    } else if (S.ready && t - S.ready.t > 400 && S.playing) {
      S.playing = false; S.sol = null; S.target = null; // the game stopped drawing
    }
    if (!cfg.enabled) { releaseNow(S.mouse.x, S.mouse.y); if (F.spaceHeld) { sendKey('keyup', ' '); F.spaceHeld = false; } }
    else control(dt, t);
    fireControl(t);
    buildTick(t);
    respawnTick(t);
    applyConvarsOnce();
    drawOverlay(t);
    refreshPanelStatus();
  }

  /* ===================================================================== *
   *  13. Overlay (ESP, prediction path, edge arrows, HUD)
   * ===================================================================== */
  function drawOverlay() {
    const ctx = S.octx;
    if (!ctx) return;
    const oc = S.overlay;
    const dpr = window.devicePixelRatio || 1;
    const W = innerWidth, H = innerHeight;
    if (oc.width !== Math.round(W * dpr) || oc.height !== Math.round(H * dpr)) { oc.width = Math.round(W * dpr); oc.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!cfg.enabled || !S.canvas || !S.rect || !S.playing) { drawHud(ctx, W); return; }

    const k = S.k, Z = cam.zoom, tau = cfg.persistence;
    const X = (cx) => S.rect.left + cx * k, Y = (cy) => S.rect.top + cy * k;
    const me = S.me;
    const sol = S.sol;

    if (cfg.esp) {
      ctx.lineWidth = 1.5;
      const list = S.tanks.concat(cfg.farm && !S.tanks.some((tk) => tk.seen) ? S.shapes : []);
      for (const tk of list) {
        if (!tk.seen) continue;
        const sx = tk.sx, sy = tk.sy;
        const isT = sol && sol.tk === tk;
        ctx.strokeStyle = isT ? '#ffd23c' : tk.kind === 'shape' ? 'rgba(255,255,255,.35)' : 'rgba(255,70,70,.85)';
        ctx.beginPath(); ctx.arc(X(sx), Y(sy), tk.rW * Z * k + 5, 0, Math.PI * 2); ctx.stroke();
        if (tk.kind === 'tank' && me) {
          const d = hyp(tk.x - S.selfTrack.x, tk.y - S.selfTrack.y) / (S.selfTrack.rW || 50);
          ctx.fillStyle = 'rgba(255,255,255,.85)';
          ctx.font = '11px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(d.toFixed(1) + 'R', X(sx), Y(sy) - tk.rW * Z * k - 9);
        }
      }
      if (cfg.espPath && sol) {
        const tk = sol.tk;
        ctx.strokeStyle = 'rgba(255,210,60,.55)'; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
        ctx.beginPath();
        const age = Math.max(0, (S.frameT - tk.last) / 1000);
        for (let h = 0; h <= 1.4; h += 0.1) {
          const adv = decay(age + h, tau);
          const px = X(toSX(tk.x + tk.vx * adv)), py = Y(toSY(tk.y + tk.vy * adv));
          if (h === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke(); ctx.setLineDash([]);
      }
      if (sol) {
        const ax = X(sol.cx), ay = Y(sol.cy);
        if (cfg.aimLine && S.me) {
          ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(X(S.me.x), Y(S.me.y)); ctx.lineTo(ax, ay); ctx.stroke();
        }
        const good = sol.conf >= cfg.fireConfidence / 100 && sol.T <= cfg.fireMaxFlight;
        ctx.strokeStyle = good ? '#4be37a' : '#ffb13c'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(ax, ay, 6, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(ax - 10, ay); ctx.lineTo(ax + 10, ay); ctx.moveTo(ax, ay - 10); ctx.lineTo(ax, ay + 10); ctx.stroke();
        if (F.want) { ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.arc(ax, ay, 3, 0, Math.PI * 2); ctx.fill(); }
      }
    }

    if (cfg.espArrows) drawArrows(ctx, X, Y, W, H);
    if (cfg.espBullets) {
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,60,60,.9)';
      for (const tk of eBullets) {
        if (tk.threat === null) continue;
        ctx.beginPath(); ctx.arc(X(tk.sx), Y(tk.sy), tk.rW * Z * k + 5, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(X(tk.sx), Y(tk.sy));
        ctx.lineTo(X(toSX(tk.x + tk.vx * tk.threat)), Y(toSY(tk.y + tk.vy * tk.threat))); ctx.stroke();
      }
    }
    drawHud(ctx, W);
  }

  function drawArrows(ctx, X, Y, W, H) {
    const tau = cfg.persistence, cx = W / 2, cy = H / 2, inset = 30;
    const R = S.selfTrack ? S.selfTrack.rW || 50 : 50;
    for (const tk of S.tanks) {
      const age = Math.max(0, (S.frameT - tk.last) / 1000);
      const wx = tk.x + tk.vx * decay(age, tau), wy = tk.y + tk.vy * decay(age, tau);
      const px = X(toSX(wx)), py = Y(toSY(wy));
      const dx = px - cx, dy = py - cy;
      let s = Infinity;
      if (dx > 0) s = Math.min(s, (W - inset - cx) / dx);
      if (dx < 0) s = Math.min(s, (inset - cx) / dx);
      if (dy > 0) s = Math.min(s, (H - inset - cy) / dy);
      if (dy < 0) s = Math.min(s, (inset - cy) / dy);
      if (!isFinite(s) || s >= 1) continue; // inside the view
      const ax = cx + dx * s, ay = cy + dy * s, ang = Math.atan2(dy, dx);
      const alpha = tk.seen ? 0.9 : Math.max(0.25, 0.9 - age / 8);
      ctx.save();
      ctx.translate(ax, ay); ctx.rotate(ang);
      ctx.fillStyle = tk.seen ? `rgba(235,60,60,${alpha})` : `rgba(215,130,45,${alpha})`;
      ctx.beginPath(); ctx.moveTo(11, 0); ctx.lineTo(-8, 7); ctx.lineTo(-8, -7); ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.fillStyle = `rgba(255,255,255,${alpha})`; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center';
      const dist = hyp(wx - S.selfTrack.x, wy - S.selfTrack.y) / R;
      ctx.fillText(dist.toFixed(0) + 'R' + (tk.seen ? '' : ' ' + age.toFixed(1) + 's'), ax - Math.cos(ang) * 28, ay - Math.sin(ang) * 22 + 4);
    }
  }

  function drawHud(ctx, W) {
    if (!cfg.hud || (cfg.enabled && !S.playing)) return;
    const lines = [];
    const sol = S.sol;
    const st = S.stats;
    if (!cfg.enabled) lines.push('Diep Assist: OFF');
    else {
      let head = 'AIM ' + (cfg.aim ? (ctl.on ? 'LOCKED' : 'ready') : 'off');
      if (cfg.autoFire) head += ' | FIRE ' + (F.want ? 'ON' : 'armed');
      if (cfg.farm) head += ' | FARM';
      if (S.threats) head += ' | INCOMING x' + S.threats;
      lines.push(head);
      if (sol) {
        const R = S.selfTrack.rW || 50;
        lines.push(`#${sol.tk.id} ${sol.tk.kind}  ${(sol.dist / R).toFixed(1)}R  T ${sol.T.toFixed(2)}s  conf ${Math.round(sol.conf * 100)}%  v ${(hyp(sol.tk.vx, sol.tk.vy) / R).toFixed(1)}R/s`);
      }
      if (st.shots) lines.push(`shots ${st.shots}  hits ${st.hits} (${Math.round((100 * st.hits) / st.shots)}%)  latency ${Math.round(effLatency() * 1000)}ms${cfg.autoTune && cfg.measured > 0 ? ' (measured)' : ''}`);
      if (cfg.debug) {
        lines.push(`zoom ${cam.zoom.toFixed(2)}  cam ${cam.src}  v (${cam.track ? cam.track.vx.toFixed(0) : 0}, ${cam.track ? cam.track.vy.toFixed(0) : 0})  grid ${cam.gridTrust ? 'ok' : 'off'}`);
        lines.push(`latency samples ${S.loopSamples}  manual ${cfg.latency}ms  measured ${cfg.measured ? Math.round(cfg.measured * 1000) + 'ms' : '-'}`);
        lines.push(`tanks ${S.tanks.length}  shapes ${S.shapes.length}  bullets ${bullet.valid > 2 ? 'profile ' + (bullet.valid - 1) * BUCKET + 's' : 'prior'}  muzzle ${muzzleDist().toFixed(0)}  ${S.fps.toFixed(0)}fps`);
        if (S.lastError) lines.push('err: ' + S.lastError);
      }
    }
    ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    let y = 18;
    for (const l of lines) {
      const w = ctx.measureText(l).width + 14;
      ctx.fillStyle = 'rgba(10,12,16,.55)';
      ctx.fillRect(W / 2 - w / 2, y - 12, w, 17);
      ctx.fillStyle = '#e8eef5';
      ctx.fillText(l, W / 2, y);
      y += 19;
    }
  }

  /* ===================================================================== *
   *  14. Menu
   * ===================================================================== */
  const CSS = `
  #da-panel{position:fixed;top:12px;right:12px;width:340px;max-height:calc(100vh - 24px);display:flex;flex-direction:column;z-index:2147483600;
    background:rgba(19,20,26,.93);color:#e6e8ee;font:12px/1.35 system-ui,'Segoe UI',Roboto,sans-serif;border:1px solid rgba(255,255,255,.1);
    border-radius:10px;box-shadow:0 10px 34px rgba(0,0,0,.5);user-select:none}
  #da-panel *{box-sizing:border-box}
  #da-head{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:move;border-bottom:1px solid rgba(255,255,255,.08);touch-action:none}
  #da-head b{font-size:13px;letter-spacing:.2px}
  #da-dot{width:8px;height:8px;border-radius:50%;background:#666}
  #da-dot.on{background:#4be37a;box-shadow:0 0 6px #4be37a}
  #da-status{margin-left:auto;opacity:.65;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px}
  .da-x{cursor:pointer;opacity:.6;padding:0 2px;font-size:15px}.da-x:hover{opacity:1}
  #da-quick{display:flex;gap:6px;padding:8px 10px 2px}
  .da-pill{flex:1;text-align:center;padding:5px 0;border-radius:6px;background:rgba(255,255,255,.07);cursor:pointer;font-weight:600;font-size:11px}
  .da-pill.on{background:#2f7d4a;color:#fff}
  #da-tabs{display:flex;gap:2px;padding:6px 10px 0}
  .da-tab{padding:6px 10px;border-radius:6px 6px 0 0;cursor:pointer;opacity:.6;font-weight:600}
  .da-tab.on{opacity:1;background:rgba(255,255,255,.08)}
  #da-body{overflow:auto;padding:8px 10px 10px;background:rgba(255,255,255,.04);border-radius:0 0 10px 10px;min-height:120px}
  .da-row{display:flex;align-items:center;gap:8px;min-height:26px;padding:1px 0}
  .da-row>label,.da-row>.da-l{flex:1;min-width:0}
  .da-row small{display:block;opacity:.5;font-size:10.5px;line-height:1.2}
  .da-sec{margin:10px 0 3px;font-weight:700;opacity:.55;font-size:10.5px;text-transform:uppercase;letter-spacing:.8px}
  .da-sw{position:relative;width:34px;height:18px;flex:none}
  .da-sw input{opacity:0;width:100%;height:100%;margin:0;position:absolute;cursor:pointer;z-index:1}
  .da-sw i{position:absolute;inset:0;border-radius:9px;background:#3b3d48;transition:.12s}
  .da-sw i:after{content:'';position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#aab;transition:.12s}
  .da-sw input:checked+i{background:#2f9d5a}.da-sw input:checked+i:after{left:18px;background:#fff}
  .da-row input[type=range]{width:118px;accent-color:#4aa8ff;margin:0}
  .da-val{width:46px;text-align:right;opacity:.8;font-variant-numeric:tabular-nums}
  .da-row select,.da-row input[type=text]{background:#262833;color:#e6e8ee;border:1px solid rgba(255,255,255,.12);border-radius:5px;padding:3px 5px;font:inherit;max-width:150px}
  .da-btn{background:#2b2e3b;border:1px solid rgba(255,255,255,.12);color:#e6e8ee;border-radius:6px;padding:4px 9px;cursor:pointer;font:inherit}
  .da-btn:hover{background:#363a4b}.da-btn.pri{background:#2f6fd0;border-color:#2f6fd0}
  .da-keybtn{min-width:78px;text-align:center;font-family:ui-monospace,Menlo,Consolas,monospace}
  .da-note{opacity:.6;font-size:11px;margin:6px 0}
  .da-stat{display:grid;grid-template-columns:24px 1fr 22px 28px 22px;gap:4px;align-items:center;margin:2px 0}
  .da-stat .bar{height:6px;background:#2a2c37;border-radius:3px;overflow:hidden;grid-column:2}
  .da-stat .bar i{display:block;height:100%;background:#4aa8ff}
  .da-stat.over .bar i{background:#e05252}
  .da-mini{padding:1px 0;text-align:center;border-radius:4px;background:#2b2e3b;cursor:pointer}
  .da-code{font-family:ui-monospace,Menlo,Consolas,monospace;width:100%!important;max-width:none!important;letter-spacing:1px}
  .da-tl{display:flex;flex-wrap:wrap;gap:2px;margin:2px 0 4px}
  .da-chip{width:18px;height:18px;line-height:18px;text-align:center;border-radius:4px;color:#101216;font:700 10px ui-monospace,Menlo,Consolas,monospace;cursor:default}
  .da-presets{display:flex;flex-wrap:wrap;gap:5px;margin:4px 0 8px}
  #da-toast{position:fixed;left:50%;top:70px;transform:translateX(-50%);z-index:2147483601;background:rgba(15,17,22,.9);color:#fff;
    padding:6px 14px;border-radius:7px;font:600 13px system-ui,sans-serif;pointer-events:none;opacity:0;transition:opacity .18s}
  `;

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === 'class') el.className = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else if (v !== false && v != null) el.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }

  const refreshers = [];
  let panel = null, body = null, statusEl = null, dotEl = null, toastEl = null, quickEls = {};

  function setCfg(key, value) { cfg[key] = value; save(); refreshAll(); }
  function refreshAll() { for (const r of refreshers) r(); }

  function rowToggle(key, label, hint, after) {
    const input = h('input', { type: 'checkbox' });
    input.addEventListener('change', () => { cfg[key] = input.checked; save(); if (after) after(input.checked); refreshAll(); });
    refreshers.push(() => { input.checked = !!cfg[key]; });
    input.checked = !!cfg[key];
    return h('div', { class: 'da-row' }, h('div', { class: 'da-l' }, label, hint ? h('small', null, hint) : null), h('span', { class: 'da-sw' }, input, h('i')));
  }
  function rowSlider(key, label, min, max, step, fmt, hint) {
    const val = h('span', { class: 'da-val' });
    const input = h('input', { type: 'range', min, max, step });
    const show = () => { val.textContent = fmt ? fmt(cfg[key]) : cfg[key]; };
    input.addEventListener('input', () => { cfg[key] = +input.value; show(); save(); });
    refreshers.push(() => { input.value = cfg[key]; show(); });
    input.value = cfg[key]; show();
    return h('div', { class: 'da-row' }, h('div', { class: 'da-l' }, label, hint ? h('small', null, hint) : null), input, val);
  }
  function rowSelect(key, label, options, hint, after) {
    const sel = h('select', null, options.map(([v, t]) => h('option', { value: v }, t)));
    sel.addEventListener('change', () => { cfg[key] = sel.value; save(); if (after) after(sel.value); refreshAll(); });
    refreshers.push(() => { sel.value = cfg[key]; });
    sel.value = cfg[key];
    return h('div', { class: 'da-row' }, h('div', { class: 'da-l' }, label, hint ? h('small', null, hint) : null), sel);
  }
  function rowText(key, label, placeholder, maxlength) {
    const input = h('input', { type: 'text', placeholder, maxlength });
    input.addEventListener('input', () => { cfg[key] = input.value; save(); });
    refreshers.push(() => { if (document.activeElement !== input) input.value = cfg[key]; });
    input.value = cfg[key];
    return h('div', { class: 'da-row' }, h('div', { class: 'da-l' }, label), input);
  }
  const keyLabel = (code) => {
    if (!code) return '(none)';
    return code.replace(/^Key/, '').replace(/^Digit/, '').replace('Backslash', '\\').replace('BracketLeft', '[').replace('BracketRight', ']')
      .replace('Semicolon', ';').replace('Quote', "'").replace('Backquote', '`').replace('Comma', ',').replace('Period', '.').replace('Slash', '/')
      .replace('Minus', '-').replace('Equal', '=');
  };
  let binding = null;
  function rowKey(label, get, set) {
    const btn = h('button', { class: 'da-btn da-keybtn' });
    const show = () => { btn.textContent = binding === btn ? 'press a key...' : keyLabel(get()); };
    btn.addEventListener('click', () => { binding = btn; btn._set = set; show(); });
    refreshers.push(show);
    show();
    return h('div', { class: 'da-row' }, h('div', { class: 'da-l' }, label), btn);
  }
  const sec = (t) => h('div', { class: 'da-sec' }, t);
  const note = (t) => h('div', { class: 'da-note' }, t);

  function tabAim() {
    return [
      rowToggle('aim', 'Auto aim', 'Move the cursor onto enemy tanks'),
      rowSelect('aimMode', 'Activation', [['always', 'Always'], ['firing', 'While I fire (LMB / Space / E)'], ['hold', 'While holding a key']]),
      rowKey('Hold key', () => cfg.holdKey, (c) => setCfg('holdKey', c)),
      rowSelect('priority', 'Target priority', [['closest', 'Closest to my tank'], ['cursor', 'Closest to my mouse']]),
      rowSlider('range', 'Max range', 10, 100, 1, (v) => v + '%', 'of the half screen diagonal'),
      rowSlider('stickiness', 'Target stickiness', 0, 100, 5, (v) => v + '%', 'higher = switches targets less'),
      sec('Prediction'),
      rowToggle('predict', 'Lead moving targets', 'Aim where the bullet and the tank will meet'),
      rowSlider('latency', 'Latency compensation', 0, 400, 5, (v) => v + 'ms', 'render + input delay; used until measured'),
      rowToggle('autoTune', 'Measure latency from my shots', 'matches each bullet\u2019s direction to where the cursor pointed; needs a moving cursor'),
      h('div', { class: 'da-row' }, h('div', { class: 'da-l' }, 'Measured latency'), h('span', { class: 'da-val', id: 'da-tune', style: 'width:auto' }),
        h('button', { class: 'da-btn', onclick: () => { cfg.measured = 0; loopHist.length = 0; save(); } }, 'reset')),
      rowSlider('persistence', 'Prediction persistence', 0.5, 8, 0.1, (v) => v.toFixed(1) + 's', 'how long straight-line motion is trusted'),
      rowSlider('leadScale', 'Lead strength', 0, 150, 5, (v) => v + '%'),
      rowToggle('inherit', 'Bullets inherit my velocity', 'enable if shots miss when you strafe'),
      sec('Feel'),
      h('div', { class: 'da-row' }, h('div', { class: 'da-l' }, 'Lock-on style', h('small', null, 'Natural is the default: eased swing with a short reaction')),
        ...[['Natural', 130, 70], ['Quick', 70, 30], ['Instant', 0, 0]].map(([n, sm, re]) => h('button', { class: 'da-btn', onclick: () => { cfg.smooth = sm; cfg.reaction = re; save(); refreshAll(); } }, n))),
      rowSlider('smooth', 'Lock-on smoothness', 0, 300, 5, (v) => (v ? v + 'ms' : 'snap'), 'how long a swing onto a target takes to settle'),
      rowSlider('reaction', 'Lock-on delay', 0, 300, 10, (v) => v + 'ms', 'pause between spotting a target and moving'),
      rowSlider('maxTurn', 'Max turn speed', 0, 3000, 50, (v) => (v ? v + '°/s' : 'off'), 'optional hard cap on the barrel swing'),
      sec('Farming'),
      rowToggle('farm', 'Farm shapes when no enemy', 'aims at the nearest shape'),
      rowSelect('farmPriority', 'Shape priority', [['nearest', 'Nearest'], ['value', 'Most valuable']]),
    ];
  }
  function tabFire() {
    return [
      rowToggle('autoFire', 'Auto fire', 'Fires only while locked on and aimed'),
      rowSelect('fireMethod', 'Fire method', [['toggleE', "Toggle the game's auto-fire (E)"], ['holdSpace', 'Hold Space']],
        'if one does not work on your server, try the other'),
      rowSlider('fireConfidence', 'Min confidence', 0, 100, 5, (v) => v + '%', 'prediction quality needed to fire'),
      rowSlider('fireMaxFlight', 'Max flight time', 0.3, 3, 0.1, (v) => v.toFixed(1) + 's', 'do not shoot targets further than this'),
      rowSlider('fireTolerance', 'Aim tolerance', 20, 300, 10, (v) => v + '%', 'of the target’s apparent size'),
      note('Aim must be on (Aim tab). With auto fire on, the aim engages by itself in every activation mode.'),
    ];
  }
  function tabVisuals() {
    return [
      rowToggle('esp', 'ESP', 'rings, distances, predicted path, aim point'),
      rowToggle('espPath', 'Predicted path'),
      rowToggle('espArrows', 'Off-screen arrows', 'also shows where an enemy that just left should be'),
      rowToggle('espBullets', 'Incoming bullet warning'),
      rowToggle('aimLine', 'Aim line'),
      rowToggle('hud', 'Status display'),
      rowToggle('debug', 'Debug info'),
      sec('Game client (needs the game console)'),
      ...CONVARS.map((row) => rowToggle(row[0], row[2], row[1], () => { if (hasConsole()) applyConvar(row); })),
    ];
  }
  function tabMisc() {
    return [
      rowToggle('enabled', 'Master switch', 'turns every feature off at once'),
      rowToggle('autoRespawn', 'Auto respawn', 'uses game_spawn when the console exists'),
      rowText('spawnName', 'Respawn name', 'name', 15),
      rowToggle('uiZones', 'Safe click zones', 'real clicks on the upgrade panels are never aimed away'),
      rowToggle('panelPause', 'Pause aim over this menu'),
      sec('Hotkeys'),
      ...[['menu', 'Show / hide menu'], ['master', 'Master switch'], ['aim', 'Auto aim'], ['fire', 'Auto fire'], ['esp', 'ESP'], ['farm', 'Farm shapes'], ['predict', 'Prediction']]
        .map(([a, l]) => rowKey(l, () => cfg.keys[a], (c) => { cfg.keys[a] = c; save(); refreshAll(); })),
      note('Click a key, then press the new one. Backspace clears, Esc cancels.'),
      h('div', { class: 'da-row' }, h('button', { class: 'da-btn', onclick: () => { if (confirm('Reset all Diep Assist settings?')) { try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ } location.reload(); } } }, 'Reset all settings')),
      note('For private servers you run yourself. The script does nothing on diep.io.'),
    ];
  }

  function tabBuild() {
    const wrap = h('div');
    const draw = () => {
      wrap.textContent = '';
      const b = sanitizeBuild(cfg.build);
      const counts = countStats(b);
      const total = counts.reduce((x, y) => x + y, 0);
      const setTargets = (t) => { cfg.build = scheduleBuild(t, cfg.buildMode); save(); draw(); };
      wrap.append(
        sec(`Stat points  ${total} / ${MAX_POINTS}`),
        ...STATS.map(([name], i) => {
          const over = counts[i] > MAX_STAT;
          return h('div', { class: 'da-stat' + (over ? ' over' : '') },
            h('span', { style: 'opacity:.55' }, i + 1),
            h('span', null, name),
            h('span', { class: 'da-mini', onclick: () => { if (counts[i] > 0) { const t = counts.slice(); t[i]--; setTargets(t); } } }, '−'),
            h('span', { style: 'text-align:center' }, counts[i]),
            h('span', { class: 'da-mini', onclick: () => { if (total < MAX_POINTS && counts[i] < MAX_STAT) { const t = counts.slice(); t[i]++; setTargets(t); } } }, '+'),
            h('div', { class: 'bar', style: 'grid-column:2/6' }, h('i', { style: `width:${Math.min(100, (counts[i] / MAX_STAT) * 100)}%` })));
        }),
        rowSelect('buildMode', 'Schedule', [['balanced', 'Balanced'], ['down', 'One at a time 1→8'], ['up', 'One at a time 8→1']],
          'order the points are spent in', () => { cfg.build = scheduleBuild(counts, cfg.buildMode); save(); draw(); }),
        sec('Timeline (level \u2192 stat)'),
        h('div', { class: 'da-tl' }, [...b].map((ch, i) => h('span', { class: 'da-chip', style: `background:${STAT_COLORS[+ch - 1]}`, title: `Level ${levelOfPoint(i)}: ${STATS[+ch - 1][0]}` }, ch))),
        sec('Presets'),
        h('div', { class: 'da-presets' }, PRESETS.map(([n, t]) => h('button', { class: 'da-btn', title: t.join(' / '), onclick: () => setTargets(t.slice()) }, n))),
        sec('Upgrade order'),
      );
      const input = h('input', { type: 'text', class: 'da-code', value: b, maxlength: MAX_POINTS, placeholder: 'e.g. 5675675676...' });
      input.addEventListener('input', () => { cfg.build = sanitizeBuild(input.value); save(); });
      input.addEventListener('change', draw);
      wrap.append(
        h('div', { class: 'da-row' }, input),
        h('div', { class: 'da-row' },
          h('button', { class: 'da-btn pri', onclick: () => { const ok = applyBuild(); toast(ok ? 'Build queued' : 'Game console not found - try the key method'); draw(); } }, 'Apply now'),
          h('button', { class: 'da-btn', onclick: () => { try { navigator.clipboard.writeText(sanitizeBuild(cfg.build)); toast('Copied'); } catch { /* ignore */ } } }, 'Copy'),
          h('span', { class: 'da-note', style: 'margin:0' }, build.status)),
        rowToggle('buildKeep', 'Re-apply on every respawn', 'a new life starts with no queued upgrades'),
        rowSelect('buildMethod', 'Method', [['auto', 'Auto'], ['console', 'Game console (game_stats_build)'], ['keys', 'Hold-U key queue']]),
        note('The game spends points on its own as you level up, in the order above. 33 points total, 7 per stat.'),
      );
    };
    draw();
    return wrap;
  }

  const TABS = { Aim: tabAim, Fire: tabFire, Visuals: tabVisuals, Build: tabBuild, Misc: tabMisc };
  function showTab(name) {
    cfg.ui.tab = name; save();
    refreshers.length = 0;
    quickRefreshInstall();
    body.textContent = '';
    body.append(...[].concat(TABS[name]()));
    for (const el of panel.querySelectorAll('.da-tab')) el.classList.toggle('on', el.dataset.tab === name);
    refreshAll();
  }
  function quickRefreshInstall() {
    refreshers.push(() => { for (const [k, el] of Object.entries(quickEls)) el.classList.toggle('on', !!cfg[k]); });
  }

  function buildPanel() {
    if (panel || !document.body) return;
    document.head.append(h('style', null, CSS));
    const quick = h('div', { id: 'da-quick' });
    for (const [key, label] of [['aim', 'Aim'], ['autoFire', 'Fire'], ['esp', 'ESP'], ['farm', 'Farm']]) {
      const el = h('div', { class: 'da-pill', onclick: () => setCfg(key, !cfg[key]) }, label);
      quickEls[key] = el; quick.append(el);
    }
    dotEl = h('span', { id: 'da-dot' });
    statusEl = h('span', { id: 'da-status' }, '');
    const head = h('div', { id: 'da-head' }, dotEl, h('b', null, 'Diep Assist'), statusEl, h('span', { class: 'da-x', title: 'Hide (' + keyLabel(cfg.keys.menu) + ')', onclick: () => togglePanel() }, '×'));
    const tabs = h('div', { id: 'da-tabs' }, Object.keys(TABS).map((n) => h('div', { class: 'da-tab', 'data-tab': n, onclick: () => showTab(n) }, n)));
    body = h('div', { id: 'da-body' });
    panel = h('div', { id: 'da-panel' }, head, quick, tabs, body);
    toastEl = h('div', { id: 'da-toast' });
    document.body.append(panel, toastEl);
    if (cfg.ui.x !== null && cfg.ui.y !== null) {
      panel.style.left = clamp(cfg.ui.x, 0, innerWidth - 120) + 'px'; panel.style.top = clamp(cfg.ui.y, 0, innerHeight - 40) + 'px'; panel.style.right = 'auto';
    }
    panel.style.display = cfg.ui.open ? '' : 'none';
    panel.addEventListener('mouseenter', () => { S.panelHover = true; });
    panel.addEventListener('mouseleave', () => { S.panelHover = false; });
    // keep typing in the menu away from the game (digits would buy stat points)
    for (const ev of ['keydown', 'keyup', 'keypress']) panel.addEventListener(ev, (e) => e.stopPropagation());
    // drag by the header
    let drag = null;
    head.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('da-x')) return;
      const r = panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const x = clamp(e.clientX - drag.dx, 0, innerWidth - 120), y = clamp(e.clientY - drag.dy, 0, innerHeight - 40);
      panel.style.left = x + 'px'; panel.style.top = y + 'px'; panel.style.right = 'auto';
      cfg.ui.x = x; cfg.ui.y = y;
    });
    head.addEventListener('pointerup', () => { drag = null; save(); });
    showTab(TABS[cfg.ui.tab] ? cfg.ui.tab : 'Aim');
  }

  function togglePanel() {
    cfg.ui.open = !cfg.ui.open; save();
    if (panel) panel.style.display = cfg.ui.open ? '' : 'none';
    if (!cfg.ui.open) S.panelHover = false;
  }
  let toastTimer = 0;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg; toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, 1300);
  }
  let lastStatus = '';
  function refreshPanelStatus() {
    if (!panel || !cfg.ui.open) return;
    const txt = !cfg.enabled ? 'off' : S.playing ? (S.sol ? 'target #' + S.sol.tk.id : 'no target') : 'not in game';
    if (txt !== lastStatus) { lastStatus = txt; statusEl.textContent = txt; dotEl.classList.toggle('on', cfg.enabled && S.playing); }
    const tn = document.getElementById('da-tune');
    if (tn) tn.textContent = cfg.measured > 0 ? Math.round(cfg.measured * 1000) + ' ms' : 'not yet';
  }

  /* ===================================================================== *
   *  15. Input listeners
   * ===================================================================== */
  const ACTIONS = {
    menu: () => togglePanel(),
    master: () => { setCfg('enabled', !cfg.enabled); toast('Diep Assist ' + (cfg.enabled ? 'ON' : 'OFF')); },
    aim: () => { setCfg('aim', !cfg.aim); toast('Auto aim ' + (cfg.aim ? 'ON' : 'OFF')); },
    fire: () => { setCfg('autoFire', !cfg.autoFire); toast('Auto fire ' + (cfg.autoFire ? 'ON' : 'OFF')); },
    esp: () => { setCfg('esp', !cfg.esp); toast('ESP ' + (cfg.esp ? 'ON' : 'OFF')); },
    farm: () => { setCfg('farm', !cfg.farm); toast('Farm shapes ' + (cfg.farm ? 'ON' : 'OFF')); },
    predict: () => { setCfg('predict', !cfg.predict); toast('Prediction ' + (cfg.predict ? 'ON' : 'OFF')); },
  };

  function inUiZone(x, y) {
    const W = innerWidth, H = innerHeight;
    return x < W * 0.2 && (y < H * 0.4 || y > H * 0.62);
  }

  window.addEventListener('mousemove', (e) => {
    if (!e.isTrusted) return;
    S.mouse.x = e.clientX; S.mouse.y = e.clientY;
    if (S.pivot) {
      const th = Math.atan2(e.clientY - S.pivot.y, e.clientX - S.pivot.x), tn = nowMs();
      if (S.mouseTh !== null && tn - S.mouseThT > 1 && tn - S.mouseThT < 80) {
        S.mouseW += (clamp(wrapAngle(th - S.mouseTh) / ((tn - S.mouseThT) / 1000), -25, 25) - S.mouseW) * 0.4;
      }
      S.mouseTh = th; S.mouseThT = tn;
      if (!ctl.on) recordAngle(tn, th); // the game is following the real mouse
    }
    if (ctl.on) {
      e.stopImmediatePropagation(); // the game keeps seeing the aim point, not the real mouse
      if (!ctl.reassert) { // belt and braces if the game's own listener ran first
        ctl.reassert = true;
        setTimeout(() => { ctl.reassert = false; if (ctl.on) dispatchMouse(ctl.x, ctl.y); }, 0);
      }
    }
  }, true);
  window.addEventListener('mousedown', (e) => {
    if (!e.isTrusted) return;
    if (e.button === 0) S.mouseL = true;
    S.mouse.x = e.clientX; S.mouse.y = e.clientY;
    if (cfg.uiZones && e.button === 0 && inUiZone(e.clientX, e.clientY) && !(panel && panel.contains(e.target))) {
      ctl.suspended = true; releaseNow(e.clientX, e.clientY); // let the click land where the real pointer is
    }
  }, true);
  window.addEventListener('mouseup', (e) => {
    if (!e.isTrusted) return;
    if (e.button === 0) { S.mouseL = false; ctl.suspended = false; }
  }, true);
  window.addEventListener('blur', () => { S.mouseL = false; S.spaceDown = false; S.holdDown = false; ctl.suspended = false; });

  const isTyping = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  window.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    if (binding) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.code !== 'Escape') binding._set(e.code === 'Backspace' ? '' : e.code);
      binding = null; refreshAll();
      return;
    }
    if (isTyping(e.target)) return;
    if (e.code === 'Space') S.spaceDown = true;
    if (e.code === cfg.holdKey) S.holdDown = true;
    if (e.code === 'KeyE' && !e.repeat) { F.belief = !F.belief; F.lastPress = nowMs(); } // the player's own E press
    if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
    for (const [action, code] of Object.entries(cfg.keys)) {
      if (code && e.code === code) { e.preventDefault(); e.stopImmediatePropagation(); ACTIONS[action](); return; }
    }
    if (e.code === cfg.holdKey && cfg.aimMode === 'hold') { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  window.addEventListener('keyup', (e) => {
    if (!e.isTrusted) return;
    if (e.code === 'Space') S.spaceDown = false;
    if (e.code === cfg.holdKey) S.holdDown = false;
  }, true);

  /* ===================================================================== *
   *  16. Start
   * ===================================================================== */
  function init() {
    if (S.overlay) return;
    const oc = document.createElement('canvas');
    oc.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483000;';
    S.overlay = oc;
    document.body.appendChild(oc);
    S.octx = oc.getContext('2d');
    buildPanel();
    raf(loop);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();

  // Handy for debugging from the console: diepAssist.cfg, diepAssist.S ...
  window.diepAssist = {
    version: '2.0.0', cfg, S, cam, ctl, bullet, F, applyBuild, scheduleBuild,
    get: (key) => cfg[key],
    set: (key, value) => { if (key in cfg && key !== 'keys' && key !== 'ui') setCfg(key, value); }, // e.g. diepAssist.set('aim', true)
  };
})();
