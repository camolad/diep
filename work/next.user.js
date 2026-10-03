// ==UserScript==
// @name         Diep Assist (private server testing)
// @namespace    https://github.com/camolad/diep
// @version      2.1.0
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
  const VERSION = '2.1.0';
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
    priority: 'auto', // auto | score | health | threat | closest | cursor
    ignoreSmall: 30, // % - skip tanks much weaker than the strongest candidate (unless they are fighting me)
    ignoreNames: '', // comma separated names (or parts of names) that are never targeted
    range: 100, // % of the half screen diagonal
    predict: true,
    dodge: true, // learn each target's strafing rhythm and dodging (experimental; see bench/)
    latency: 120, // ms between "what I see" and "where the bullet is born"
    persistence: 1.2, // s, how long a straight-line guess is trusted
    leadScale: 100, // %
    inherit: false, // bullets inherit the shooter's velocity
    autoTune: true, // measure the real latency from my own shots and use it instead of the slider
    measured: 0, // s, loop latency measured from my own shots (0 = not measured yet)
    smooth: 130, // ms, how long a lock-on takes to settle (higher = softer)
    human: 40, // % - how human the motion is: reaction jitter, a late notice of course changes, a slow wander around the aim
    assist: 100, // % - 100 = full lock, less = blend with the player's own mouse
    cone: 25, // deg - the 'near' activation mode only helps with tanks this close to where the player points
    override: 2200, // px/s - a flick of the real mouse faster than this takes the barrel back for a moment (0 = off)
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
    labels: true, // name / score / health next to each enemy
    card: true, // target details in the status display
    clean: false, // hide every overlay and the menu (screen sharing / hosting)
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
      lock: 'Comma',
      cycle: 'Period',
      clean: 'End',
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
    mouseSpeed: 0, mouseLastT: 0, mouseLastX: 0, mouseLastY: 0, chal: null, tableOk: true,
    mouseL: false, spaceDown: false, holdDown: false, panelHover: false,
    playing: false, spawnT: 0, lastPlayingT: -1e9,
    dom: { menu: false, dead: false, t: -1e9 },
    stats: { shots: 0, hits: 0 }, loopSamples: 0,
    leaderboard: [], lbT: -1e9, myScore: null, myLevel: null, rank: [], pinId: 0, pinT: 0, ignored: new Set(),
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
  // Everything is recorded in DEVICE space (canvas pixels): a canvas path stores its points already multiplied by the
  // transform that was active when the point was added, so that is what is mirrored here, not the transform at fill time.
  // Every fill / stroke becomes a "primitive" { g: geometry, fc: fill colour, sc: stroke colour, sw: stroke width in px }.
  // When the frame ends the primitives are turned into tanks, bullets, drones and shapes by `assemble` (a pure function of
  // the primitive list, so recorded frames can be replayed through it).
  const proto = CanvasRenderingContext2D.prototype;
  const orig = {};
  for (const n of ['clearRect', 'fillRect', 'strokeRect', 'beginPath', 'moveTo', 'lineTo', 'rect', 'roundRect', 'arc', 'arcTo', 'ellipse', 'quadraticCurveTo', 'bezierCurveTo', 'fill', 'stroke', 'createPattern', 'fillText', 'strokeText', 'drawImage']) {
    if (typeof proto[n] === 'function') orig[n] = proto[n];
  }
  const patternInfo = new WeakMap();
  const PA = { id: 0, ver: 0, pts: [], arcs: [], segs: 0, over: false };
  const PA_MAX = 200; // numbers (100 points) kept per path; bigger paths are not entities

  function paReset() { PA.id++; PA.ver = 0; PA.pts.length = 0; PA.arcs.length = 0; PA.segs = 0; PA.over = false; }
  function paPt(m, x, y) {
    PA.ver++;
    if (PA.pts.length >= PA_MAX) { PA.over = true; return; }
    PA.pts.push(m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f);
  }
  const scaleOf = (m) => Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));

  const newFrame = (t) => ({
    t, calls: 0, prims: [], last: null, grid: null, texts: [], textKeys: new Set(),
    tanks: [], bullets: [], shapes: [], drones: [], bars: [], diag: null,
  });

  proto.clearRect = function (x, y, w, h) {
    try { onClear(this, w, h); } catch (e) { fail(e); }
    return orig.clearRect.apply(this, arguments);
  };
  proto.fillRect = function (x, y, w, h) {
    if (this.canvas === S.canvas && S.cur) { try { onFillRect(this, x, y, w, h); } catch (e) { fail(e); } }
    return orig.fillRect.apply(this, arguments);
  };
  proto.beginPath = function () {
    if (this.canvas === S.canvas) paReset();
    return orig.beginPath.apply(this, arguments);
  };
  proto.moveTo = function (x, y) {
    if (this.canvas === S.canvas) paPt(this.getTransform(), x, y);
    return orig.moveTo.apply(this, arguments);
  };
  proto.lineTo = function (x, y) {
    if (this.canvas === S.canvas) { PA.segs++; paPt(this.getTransform(), x, y); }
    return orig.lineTo.apply(this, arguments);
  };
  proto.rect = function (x, y, w, h) {
    if (this.canvas === S.canvas) {
      const m = this.getTransform();
      PA.segs += 4; paPt(m, x, y); paPt(m, x + w, y); paPt(m, x + w, y + h); paPt(m, x, y + h);
    }
    return orig.rect.apply(this, arguments);
  };
  if (orig.roundRect) {
    proto.roundRect = function (x, y, w, h) {
      if (this.canvas === S.canvas) {
        const m = this.getTransform();
        PA.segs += 4; paPt(m, x, y); paPt(m, x + w, y); paPt(m, x + w, y + h); paPt(m, x, y + h);
      }
      return orig.roundRect.apply(this, arguments);
    };
  }
  proto.arc = function (x, y, r, a0, a1) {
    if (this.canvas === S.canvas) {
      const m = this.getTransform(), sc = scaleOf(m);
      if (Math.abs(a1 - a0) >= 6.2) { PA.ver++; PA.arcs.push({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f, r: Math.abs(r) * sc }); }
      else { PA.segs++; paPt(m, x + Math.cos(a0) * r, y + Math.sin(a0) * r); paPt(m, x + Math.cos((a0 + a1) / 2) * r, y + Math.sin((a0 + a1) / 2) * r); paPt(m, x + Math.cos(a1) * r, y + Math.sin(a1) * r); }
    }
    return orig.arc.apply(this, arguments);
  };
  proto.ellipse = function (x, y, rx, ry, rot, a0, a1) {
    if (this.canvas === S.canvas) {
      const m = this.getTransform();
      if (Math.abs(a1 - a0) >= 6.2) {
        const c = Math.cos(rot), s = Math.sin(rot);
        PA.segs++;
        for (const [px, py] of [[rx, 0], [0, ry], [-rx, 0], [0, -ry]]) paPt(m, x + px * c - py * s, y + px * s + py * c);
      } else { PA.segs++; paPt(m, x, y); }
    }
    return orig.ellipse.apply(this, arguments);
  };
  proto.arcTo = function (x1, y1, x2, y2) {
    if (this.canvas === S.canvas) { PA.segs++; const m = this.getTransform(); paPt(m, x1, y1); paPt(m, x2, y2); }
    return orig.arcTo.apply(this, arguments);
  };
  proto.quadraticCurveTo = function (cx, cy, x, y) {
    if (this.canvas === S.canvas) { PA.segs++; const m = this.getTransform(); paPt(m, cx, cy); paPt(m, x, y); }
    return orig.quadraticCurveTo.apply(this, arguments);
  };
  proto.bezierCurveTo = function (c1x, c1y, c2x, c2y, x, y) {
    if (this.canvas === S.canvas) { PA.segs++; const m = this.getTransform(); paPt(m, c1x, c1y); paPt(m, c2x, c2y); paPt(m, x, y); }
    return orig.bezierCurveTo.apply(this, arguments);
  };
  proto.fill = function () {
    if (this.canvas === S.canvas && S.cur && (arguments.length === 0 || typeof arguments[0] === 'string')) {
      try { onFill(this); } catch (e) { fail(e); }
    }
    return orig.fill.apply(this, arguments);
  };
  proto.stroke = function () {
    if (this.canvas === S.canvas && S.cur && arguments.length === 0) {
      try { onStroke(this); } catch (e) { fail(e); }
    }
    return orig.stroke.apply(this, arguments);
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
  // Text may be drawn straight onto the game canvas or into small offscreen canvases that are blitted with drawImage,
  // so text calls are watched on every canvas.
  proto.fillText = function (text, x, y) {
    try { onTextAny(this, text, x, y); } catch (e) { fail(e); }
    return orig.fillText.apply(this, arguments);
  };
  proto.strokeText = function (text, x, y) {
    try { onTextAny(this, text, x, y); } catch (e) { fail(e); }
    return orig.strokeText.apply(this, arguments);
  };
  if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
    const op = OffscreenCanvasRenderingContext2D.prototype;
    for (const n of ['fillText', 'strokeText']) {
      const o = op[n];
      if (typeof o === 'function') op[n] = function (text, x, y) { try { onTextAny(this, text, x, y); } catch (e) { fail(e); } return o.apply(this, arguments); };
    }
  }
  proto.drawImage = function (img) {
    try { if (this.canvas === S.canvas && S.cur && img && textCanvas.has(img)) onTextImage(this, arguments); } catch (e) { fail(e); }
    return orig.drawImage.apply(this, arguments);
  };
  proto.createPattern = function (img) {
    const p = orig.createPattern.apply(this, arguments);
    try { if (p && img && img.width) patternInfo.set(p, { w: img.width, h: img.height, sx: 1, sy: 1 }); } catch { /* ignore */ }
    return p;
  };

  function onClear(ctx, w, h) {
    const c = ctx.canvas;
    if (!c || c === S.overlay) return;
    const trec = textCanvas.get(c);
    if (trec && w >= c.width * 0.9 && h >= c.height * 0.9) trec.texts.length = 0;
    if (w < c.width * 0.9 || h < c.height * 0.9) return; // only whole-canvas clears start a frame
    if (S.canvas === null) {
      const big = c.isConnected && c.width >= innerWidth * 0.5 && c.height >= innerHeight * 0.5;
      if (c.id === 'canvas' || big) S.canvas = c; else return;
    }
    if (c !== S.canvas) return;
    paReset();
    if (S.cur && S.cur.calls > 0) { assemble(S.cur); S.ready = S.cur; S.readySeq++; }
    S.cur = newFrame(nowMs());
  }

  // The background grid: a CanvasPattern fill. Its origin on screen says where the camera is; its scale is the zoom.
  function onGridFill(ctx) {
    const t = ctx.getTransform();
    const zoom = hyp(t.a, t.b);
    const info = patternInfo.get(ctx.fillStyle);
    const tw = info ? info.w * (info.sx || 1) : 0, th = info ? info.h * (info.sy || 1) : 0; // tile size in world units
    S.cur.grid = { e: t.e, f: t.f, zoom, tw, th, pw: tw * zoom, ph: th * zoom };
  }

  function rectPrim(ctx, x, y, w, h) {
    const m = ctx.getTransform();
    const pts = [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f, m.a * (x + w) + m.c * y + m.e, m.b * (x + w) + m.d * y + m.f,
      m.a * (x + w) + m.c * (y + h) + m.e, m.b * (x + w) + m.d * (y + h) + m.f, m.a * x + m.c * (y + h) + m.e, m.b * x + m.d * (y + h) + m.f];
    return polyGeom(pts);
  }
  function onFillRect(ctx, x, y, w, h) {
    const fs = ctx.fillStyle;
    if (fs && typeof fs === 'object') { onGridFill(ctx); return; }
    const f = S.cur;
    if (f.prims.length >= 4000) return;
    const col = parseColor(fs);
    if (!col) return;
    const g = rectPrim(ctx, x, y, w, h);
    if (g) { f.prims.push({ g, fc: col, sc: null, sw: 0, a: ctx.globalAlpha * col.a, cap: '', pid: -1, ver: 0 }); f.calls++; }
  }

  // ---- path geometry ----
  // pts: flat [x0, y0, x1, y1 ...] in canvas px. Returns { t: 'p', x, y, r, w, h, n, nc } with the area centroid of the convex hull,
  // the circumradius about it, the bounding box, the vertex count and the number of real corners (collinear points dropped).
  function polyGeom(pts) {
    const n = pts.length >> 1;
    if (n < 3) return null;
    const P = [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pts[2 * i], y = pts[2 * i + 1];
      if (!(x === x) || !(y === y)) return null;
      P.push([x, y]);
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    P.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [];
    for (const p of P) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    const up = [];
    for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    lo.pop(); up.pop();
    const H = lo.concat(up);
    let cx = 0, cy = 0, A = 0;
    for (let i = 0; i < H.length; i++) {
      const a = H[i], b = H[(i + 1) % H.length], cr = a[0] * b[1] - b[0] * a[1];
      A += cr; cx += (a[0] + b[0]) * cr; cy += (a[1] + b[1]) * cr;
    }
    if (H.length < 3 || Math.abs(A) < 1e-6) { cx = (minX + maxX) / 2; cy = (minY + maxY) / 2; } else { cx /= 3 * A; cy /= 3 * A; }
    let r = 0;
    for (const p of H) r = Math.max(r, hyp(p[0] - cx, p[1] - cy));
    // corners: hull vertices where the outline really turns (> 18 degrees)
    let nc = 0;
    for (let i = 0; i < H.length; i++) {
      const a = H[(i + H.length - 1) % H.length], b = H[i], c = H[(i + 1) % H.length];
      const t1 = Math.atan2(b[1] - a[1], b[0] - a[0]), t2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
      if (Math.abs(wrapAngle(t2 - t1)) > 0.31) nc++;
    }
    // many vertices at an even distance from the centre: a circle drawn as a polygon
    if (H.length >= 10) {
      let sum = 0, dev = 0;
      for (const p of H) sum += hyp(p[0] - cx, p[1] - cy);
      const mean = sum / H.length;
      for (const p of H) dev = Math.max(dev, Math.abs(hyp(p[0] - cx, p[1] - cy) - mean));
      if (mean > 1 && dev / mean < 0.06) return { t: 'c', x: cx, y: cy, r: mean, poly: true };
    }
    return { t: 'p', x: cx, y: cy, r, w: maxX - minX, h: maxY - minY, n, nc };
  }
  function pathGeom() {
    const pts = PA.pts, n = pts.length >> 1, arcs = PA.arcs;
    if (arcs.length >= 1 && n === 0) {
      let a = arcs[0];
      for (const b of arcs) if (b.r > a.r) a = b;
      if (arcs.every((b) => hyp(b.x - a.x, b.y - a.y) < Math.max(1.5, a.r * 0.15))) return { t: 'c', x: a.x, y: a.y, r: a.r };
    }
    if (arcs.length === 0 && n === 2) return { t: 'l', x1: pts[0], y1: pts[1], x2: pts[2], y2: pts[3] };
    if (PA.over) return null;
    let all = pts;
    if (arcs.length) { all = pts.slice(); for (const a of arcs) all.push(a.x - a.r, a.y, a.x + a.r, a.y, a.x, a.y - a.r, a.x, a.y + a.r); }
    return polyGeom(all);
  }

  function onFill(ctx) {
    const f = S.cur;
    const col = parseColor(ctx.fillStyle);
    if (!col || f.prims.length >= 4000) return;
    const lp = f.last;
    if (lp && lp.pid === PA.id && lp.ver === PA.ver) return; // the same path filled again (the client fills twice)
    const g = pathGeom();
    if (!g) return;
    const p = { g, fc: col, sc: null, sw: 0, a: ctx.globalAlpha * col.a, cap: '', pid: PA.id, ver: PA.ver };
    f.prims.push(p); f.last = p; f.calls++;
  }
  function onStroke(ctx) {
    const f = S.cur;
    if (f.prims.length >= 4000) return;
    const col = parseColor(ctx.strokeStyle);
    const sw = ctx.lineWidth * scaleOf(ctx.getTransform()); // the pen is scaled by the transform active NOW
    const lp = f.last;
    if (lp && lp.pid === PA.id && lp.ver === PA.ver) { if (!lp.sc) { lp.sc = col; lp.sw = sw; } return; }
    const g = pathGeom();
    if (!g) return;
    const p = { g, fc: null, sc: col, sw, a: ctx.globalAlpha, cap: ctx.lineCap, pid: PA.id, ver: PA.ver };
    f.prims.push(p); f.last = p; f.calls++;
  }

  // ---- text ----
  // Text the game draws (nameplates, leaderboard rows, score / level): kept per frame with its centre in canvas px.
  const textCanvas = new WeakMap(); // offscreen canvas -> { texts: [{ text, x, y, size }] } drawn into it since it was last cleared
  function textGeom(ctx, text, x, y) {
    const m = ctx.getTransform(), sc = hyp(m.a, m.b);
    const fm = /(\d+(?:\.\d+)?)px/.exec(ctx.font);
    const size = (fm ? parseFloat(fm[1]) : 12) * sc;
    const al = ctx.textAlign;
    let cx = m.a * x + m.c * y + m.e;
    const cy = m.b * x + m.d * y + m.f;
    if (al === 'left' || al === 'start' || al === 'right' || al === 'end') {
      const w = ctx.measureText(text).width * sc;
      cx += al === 'left' || al === 'start' ? w / 2 : -w / 2;
    }
    return { text, x: cx, y: cy, size };
  }
  function pushText(f, g) {
    if (f.texts.length >= 160) return;
    const key = g.text + '|' + Math.round(g.x) + '|' + Math.round(g.y); // strokeText + fillText of the same label count once
    if (f.textKeys.has(key)) return;
    f.textKeys.add(key);
    f.texts.push(g);
  }
  function onTextAny(ctx, text, x, y) {
    const c = ctx.canvas;
    text = String(text);
    if (!c || c === S.overlay || text.length > 60 || !text.trim()) return;
    if (c === S.canvas) { if (S.cur) pushText(S.cur, textGeom(ctx, text, x, y)); return; }
    let rec = textCanvas.get(c);
    if (!rec) { if (c.width > 1600 || c.height > 700) return; rec = { texts: [] }; textCanvas.set(c, rec); }
    if (rec.texts.length < 40) rec.texts.push(textGeom(ctx, text, x, y));
  }
  // an offscreen canvas holding text is blitted onto the game canvas: its texts appear at the destination
  function onTextImage(ctx, a) {
    const src = a[0], rec = textCanvas.get(src);
    if (!rec || !rec.texts.length || !S.cur) return;
    let dx, dy, dw, dh;
    if (a.length >= 9) { dx = a[5]; dy = a[6]; dw = a[7]; dh = a[8]; } else if (a.length >= 5) { dx = a[1]; dy = a[2]; dw = a[3]; dh = a[4]; } else { dx = a[1]; dy = a[2]; dw = src.width; dh = src.height; }
    const m = ctx.getTransform(), sc = hyp(m.a, m.b), kx = dw / (src.width || 1), ky = dh / (src.height || 1);
    for (const t of rec.texts) {
      const lx = dx + t.x * kx, ly = dy + t.y * ky;
      pushText(S.cur, { text: t.text, x: m.a * lx + m.c * ly + m.e, y: m.b * lx + m.d * ly + m.f, size: t.size * ky * sc });
    }
  }

  // ---- frame assembly: primitives -> tanks / bullets / drones / shapes / health bars ----
  // What the client is known to draw (see the recorded frames): a game object is a path filled and then stroked with a darker
  // outline; shapes are polygons in four fixed colours; barrels are grey polygons drawn BEFORE the body they belong to; the
  // team bases are huge translucent rectangles. Two things are accepted for a round body: one filled + stroked circle, or
  // (older clients / my test arena) a bigger filled circle with a smaller concentric one on top.
  const BAR_FILL = '#85e37d';
  const isBarrelGray = (c) => c.gray && c.r >= 100 && c.r <= 215;
  function assemble(f) {
    const W = S.canvas ? S.canvas.width : 1280, Hh = S.canvas ? S.canvas.height : 720;
    const selfR = S.me ? S.me.r : 20;
    const d = { circles: 0, polys: 0, grays: 0, lines: 0, ignored: 0, bases: 0, other: 0 };
    let grays = []; // centres of grey parts drawn since the last body
    let pend = null; // a circle waiting to see whether a smaller concentric one follows it
    const nearGray = (x, y, r) => grays.some((g) => hyp(g.x - x, g.y - y) < r * 4);
    function place(x, y, r, col) {
      if (r < 3) return;
      if (nearGray(x, y, r)) f.tanks.push({ x, y, r, col });
      else f.bullets.push({ x, y, r, col });
      grays = [];
    }
    function flush() { if (pend) { place(pend.x, pend.y, pend.r, pend.col); pend = null; } }
    for (const p of f.prims) {
      const g = p.g;
      if (g.t === 'l') {
        // a health bar: two horizontal strokes, a dark back bar and a green one
        d.lines++;
        const c = p.sc;
        if (c && Math.abs(g.y1 - g.y2) < 1.5 && f.bars.length < 80) {
          const kind = c.hex === BAR_FILL ? 'fill' : c.gray && c.r < 120 ? 'back' : null;
          if (kind) f.bars.push({ kind, x1: Math.min(g.x1, g.x2), x2: Math.max(g.x1, g.x2), y: (g.y1 + g.y2) / 2 });
        }
        continue;
      }
      const col = p.fc;
      if (!col) { continue; } // stroke-only outlines are not entities
      if (p.a < 0.3) { d.ignored++; continue; } // translucent overlays: team bases, arena margin shading
      if (g.t === 'p' && (Math.max(g.w, g.h) > 0.5 * Math.max(W, Hh) || (g.r > 0.4 * Math.max(W, Hh)))) { d.bases++; continue; }
      if (g.t === 'p' && !p.sc && g.w > 2 && g.h > 2 && g.h < 14 && g.w / g.h > 2.5) { // a bar drawn as a thin rectangle
        const kind = col.hex === BAR_FILL ? 'fill' : col.gray && col.r < 120 ? 'back' : null;
        if (kind && f.bars.length < 80) { f.bars.push({ kind, x1: g.x - g.w / 2, x2: g.x + g.w / 2, y: g.y }); continue; }
      }
      if (g.t === 'c') {
        d.circles++;
        if (col.gray) {
          // a grey circle is an auto-turret dome (on a barrel drawn just before) or a grey bullet
          flush();
          const dome = grays.some((q) => hyp(q.x - g.x, q.y - g.y) < g.r * 2);
          grays = dome && !(f.tanks.length && hyp(f.tanks[f.tanks.length - 1].x - g.x, f.tanks[f.tanks.length - 1].y - g.y) < f.tanks[f.tanks.length - 1].r * 1.2) ? [{ x: g.x, y: g.y }] : [];
          continue;
        }
        if (p.sc) { flush(); place(g.x, g.y, g.r, col); continue; } // filled + stroked: a complete circle
        if (pend && hyp(pend.x - g.x, pend.y - g.y) < 1.5 && pend.r > g.r) { place(pend.x, pend.y, pend.r, col); pend = null; continue; } // border + body pair
        flush();
        pend = { x: g.x, y: g.y, r: g.r, col };
        continue;
      }
      flush();
      d.polys++;
      if (isBarrelGray(col)) { grays.push({ x: g.x, y: g.y }); d.grays++; continue; }
      if (col.gray) { d.other++; continue; }
      if (SHAPE_HEX.has(col.hex)) { f.shapes.push({ x: g.x, y: g.y, r: g.r, col }); grays = []; continue; }
      const g0 = grays.length ? grays[grays.length - 1] : null;
      grays = [];
      // a coloured polygon right after grey parts is a tank whose body is not round
      if (g0 && g.r >= selfR * 0.6 && hyp(g0.x - g.x, g0.y - g.y) < g.r * 4) { f.tanks.push({ x: g.x, y: g.y, r: g.r, col }); continue; }
      if (g.nc === 3 || g.nc === 4) f.drones.push({ x: g.x, y: g.y, r: g.r, col, nc: g.nc }); // triangle / square drones, traps, minions
      else d.other++;
    }
    flush();
    // Fallback for a client whose barrels are not drawn the way I expect: nothing barrel-backed sits at the centre of the
    // screen (where my own tank always is), so the round object that does sit there is my tank, and the round objects at
    // least as big as it are tanks too.
    const cx = W / 2, cy = Hh / 2;
    if (!f.tanks.some((t) => hyp(t.x - cx, t.y - cy) < Hh * 0.12)) {
      let me = null;
      for (const b of f.bullets) if (hyp(b.x - cx, b.y - cy) < Hh * 0.08 && b.r >= 6 && (!me || hyp(b.x - cx, b.y - cy) < hyp(me.x - cx, me.y - cy))) me = b;
      if (me && (!S.selfCol || sameTeam(me.col, S.selfCol))) {
        const keep = [];
        for (const b of f.bullets) (b === me || b.r >= me.r * 0.85 ? f.tanks : keep).push(b);
        f.bullets = keep; d.loose = true;
      }
    }
    f.diag = d;
    f.prims = []; // the raw primitives are not needed any more
  }

  /* ===================================================================== *
   *  Frame recorder: saves complete frames of draw calls so the detection can be checked against a real client
   * ===================================================================== */
  // Records EVERY canvas call (including the offscreen canvases the game draws sprites / text / the grid tile into) from one
  // full-canvas clear to the clear after the last requested frame, with only the changed context state per call. The wrappers are
  // installed for the duration of the recording only. The file is what test/replay.mjs replays through the hooks.
  const REC_METHODS = ['clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'rect', 'roundRect', 'arc', 'arcTo', 'ellipse', 'quadraticCurveTo', 'bezierCurveTo', 'fill', 'stroke', 'clip', 'save', 'restore', 'translate', 'rotate', 'scale', 'transform', 'setTransform', 'resetTransform', 'drawImage', 'fillText', 'strokeText', 'createPattern', 'setLineDash'];
  const REC_MAX = 60000;
  let recJob = null;
  function recordFrames(nFrames, done) {
    if (recJob) return false;
    const data = { format: 'diep-assist-frames/1', version: VERSION, host: location.host, when: new Date().toISOString(), dpr: window.devicePixelRatio, win: { w: innerWidth, h: innerHeight }, frames: nFrames, canvases: [], patterns: {}, calls: [], truncated: false };
    const job = recJob = { data, started: false, cleared: 0, idx: new Map(), state: [], pats: new WeakMap(), nPat: 0, saved: {}, timer: 0 };
    const cvIndex = (c) => {
      let i = job.idx.get(c);
      if (i === undefined) {
        i = data.canvases.length; job.idx.set(c, i); job.state.push({});
        const e = { id: c.id || '', w: c.width, h: c.height, main: c === S.canvas, tag: c.tagName || '' };
        const tr = textCanvas.get(c); // text cached in this canvas before the recording began: kept so the replay can redraw it
        if (tr && tr.texts.length) e.texts = tr.texts.map((t) => ({ t: t.text, x: Math.round(t.x * 10) / 10, y: Math.round(t.y * 10) / 10, s: Math.round(t.size * 10) / 10 }));
        data.canvases.push(e);
      }
      return i;
    };
    const patId = (p) => { // patterns made before the recording started are registered when first used
      let k = job.pats.get(p);
      if (k === undefined) { k = job.nPat++; job.pats.set(p, k); const info = patternInfo.get(p); data.patterns[k] = info ? { w: info.w, h: info.h, sx: info.sx, sy: info.sy } : { w: 50, h: 50, sx: 1, sy: 1 }; }
      return k;
    };
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const enc = (v) => {
      if (typeof v === 'number') return r3(v);
      if (typeof v === 'string') return v.slice(0, 80);
      if (v && typeof v === 'object') {
        if (typeof CanvasPattern !== 'undefined' && v instanceof CanvasPattern) return { pat: patId(v) };
        if (v.tagName === 'CANVAS' || (typeof OffscreenCanvas !== 'undefined' && v instanceof OffscreenCanvas)) return { cv: cvIndex(v) };
        if (typeof v.width === 'number') return { img: [v.width, v.height] };
        return typeof v;
      }
      return v;
    };
    const finish = (why) => {
      if (recJob !== job) return;
      recJob = null; clearTimeout(job.timer);
      for (const m of Object.keys(job.saved)) { if (proto[m] === job.saved[m].wrap) proto[m] = job.saved[m].prev; }
      data.ended = why;
      window.diepAssistRecording = data;
      try { done && done(data); } catch (e) { fail(e); }
    };
    for (const m of REC_METHODS) {
      const prev = proto[m];
      if (typeof prev !== 'function') continue;
      const wrap = function () {
        const ret = prev.apply(this, arguments);
        try {
          const c = this.canvas;
          const main = c === S.canvas;
          const isClear = m === 'clearRect' && main && arguments[2] >= c.width * 0.9 && arguments[3] >= c.height * 0.9;
          if (!job.started) { if (!isClear) return ret; job.started = true; }
          const ci = cvIndex(c), st = job.state[ci], d = {};
          const cur = { fs: this.fillStyle, ss: this.strokeStyle, lw: this.lineWidth, lc: this.lineCap, lj: this.lineJoin, ga: this.globalAlpha, ft: this.font, ta: this.textAlign };
          for (const k of Object.keys(cur)) {
            let v = cur[k];
            if (v && typeof v === 'object') v = typeof CanvasPattern !== 'undefined' && v instanceof CanvasPattern ? { pat: patId(v) } : '[object]';
            const key = typeof v === 'object' ? 'p' + v.pat : v;
            if (st[k] !== key) { st[k] = key; d[k] = typeof v === 'number' ? r3(v) : v; }
          }
          const t = this.getTransform(), tf = [t.a, t.b, t.c, t.d, t.e, t.f].map((x) => Math.round(x * 10000) / 10000), tk = tf.join();
          if (st.tf !== tk) { st.tf = tk; d.tf = tf; }
          const rec = { m, c: ci, a: Array.prototype.map.call(arguments, enc) };
          if (Object.keys(d).length) rec.d = d;
          if (m === 'createPattern' && ret) rec.p = patId(ret);
          data.calls.push(rec);
          if (isClear) { if (++job.cleared > nFrames) finish('complete'); }
          else if (data.calls.length >= REC_MAX) { data.truncated = true; finish('truncated'); }
        } catch (e) { /* never break the game */ }
        return ret;
      };
      job.saved[m] = { prev, wrap };
      proto[m] = wrap;
    }
    job.timer = setTimeout(() => finish(job.started ? 'timeout' : 'no-frame'), 6000 + nFrames * 400);
    return true;
  }
  function downloadJSON(name, obj) {
    const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  /* ===================================================================== *
   *  Reading score / name / health from what the game draws, and ranking targets
   * ===================================================================== */
  // "12.3k" -> 12300, "1,234" -> 1234, "1.5m" -> 1500000, "300" -> 300 (null when it is not a number)
  function parseScore(s) {
    const m = /^\s*(\d[\d,]*)(\.\d+)?\s*([kKmMbB])?\s*$/.exec(String(s));
    if (!m) return null;
    const n = parseFloat(m[1].replace(/,/g, '') + (m[2] || ''));
    const u = m[3] ? { k: 1e3, m: 1e6, b: 1e9 }[m[3].toLowerCase()] : 1;
    return n * u;
  }
  // leaderboard row "Name - 12.3k" (the LAST " - " splits name from score, so names may contain dashes)
  const fmtScore = (n) => (n < 1000 ? String(Math.round(n)) : n < 1e6 ? (n / 1000).toFixed(1) + 'k' : (n / 1e6).toFixed(1) + 'm');
  function parseRow(text) {
    const m = /^(.*\S)\s+[-–—]\s+(\d[\d.,]*\s*[kKmMbB]?)\s*$/.exec(String(text));
    if (!m) return null;
    const score = parseScore(m[2]);
    return score === null ? null : { name: m[1], score };
  }
  const normName = (s) => String(s).replace(/…|\.\.\.$/, '').trim().toLowerCase();
  // nameplate vs leaderboard name: equal, or one is a prefix of the other (the leaderboard may truncate)
  function sameName(a, b) {
    const x = normName(a), y = normName(b);
    if (!x || !y) return false;
    return x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x)));
  }
  // Health bars are two horizontal strokes: a dark back bar and a green bar from the same left end.
  // bars: [{x1, x2, y, kind:'back'|'fill'}] in canvas px; tanks: [{x, y, r}] -> Map(tankIndex -> hp 0..1)
  function matchHealth(bars, tanks) {
    const out = new Map();
    const backs = bars.filter((b) => b.kind === 'back'), fills = bars.filter((b) => b.kind === 'fill');
    for (const f of fills) {
      let back = null, bd = 1e9;
      for (const b of backs) {
        const len = b.x2 - b.x1;
        if (len < 4) continue;
        const d = Math.abs(f.x1 - b.x1) + Math.abs(f.y - b.y) * 2;
        if (d < Math.max(3, len * 0.08) + 4 && f.x2 <= b.x2 + 3 && d < bd) { bd = d; back = b; }
      }
      if (!back) continue;
      const hp = Math.max(0, Math.min(1, (f.x2 - f.x1) / (back.x2 - back.x1)));
      const cx = (back.x1 + back.x2) / 2;
      let best = -1, bs = 1e9;
      for (let i = 0; i < tanks.length; i++) {
        const t = tanks[i], dy = back.y - t.y;
        if (Math.abs(cx - t.x) > t.r * 0.6 || dy < t.r * 0.4 || dy > t.r * 3.4) continue;
        const sc = Math.abs(cx - t.x) + Math.abs(dy - t.r * 1.4);
        if (sc < bs) { bs = sc; best = i; }
      }
      if (best >= 0) out.set(best, hp);
    }
    return out;
  }
  // Minimum score of each level 1..45 (score keeps counting after 45) and the size rule: radius = 50 * 1.01^(level - 1)
  const LEVEL_MIN = [0, 4, 13, 28, 50, 78, 113, 157, 211, 275, 350, 437, 538, 655, 787, 948, 1109, 1301, 1516, 1767, 2026, 2325, 2647, 3035, 3433, 3883, 4379, 4925, 5525, 6184, 6907, 7698, 8537, 9426, 10368, 11367, 12426, 13549, 14739, 16000, 17337, 18754, 20256, 21849, 23536];
  function levelFromScore(sc) { let L = 1; for (let i = 0; i < LEVEL_MIN.length; i++) if (sc >= LEVEL_MIN[i]) L = i + 1; return L; }
  // geometric middle of a level's score range
  function scoreOfLevel(L) { const i = clamp(Math.round(L), 1, 45), lo = LEVEL_MIN[i - 1], hi = i < 45 ? LEVEL_MIN[i] : lo * 1.25; return Math.sqrt((lo + 1) * (hi + 1)); }
  // Without a score, a tank's drawn radius says how high its level is (radius grows ~1% per level and a level is worth
  // roughly +12% score), so strength ~ (r / r_max)^12. With a score the ratio is simply score / best score.
  function strengthRatio(c, best) {
    if (c.score !== null && best.score > 0) return Math.min(1, c.score / best.score);
    return Math.pow(Math.min(1, c.r / best.r), 12);
  }
  // candidates: [{ score|null, r, hp(0..1), dist(0..1 of range), curDist(0..1), shotAtMe (s since, Infinity), hitByMe (s since) }]
  // mode: auto | score | health | threat (closest/cursor are handled by the caller)
  function rankValue(c, mode, ratio) {
    const eng = 3 * Math.exp(-c.shotAtMe / 6) + 2 * Math.exp(-c.hitByMe / 5);
    const near = 1 - c.dist, str = ratio;
    switch (mode) {
      case 'score': return 4 * str + 0.4 * near + 0.5 * eng;
      case 'health': return 8 * (1 - c.hp) + 0.6 * near + 0.2 * str + 0.2 * eng;
      case 'threat': return 4 * eng + 0.8 * near + 0.6 * str;
      default: return eng + 2.2 * str + 1.6 * (1 - c.hp) + 1.2 * near + 0.4 * (1 - c.curDist);
    }
  }

  /* ===================================================================== *
   *  5. World model: camera and tracks
   * ===================================================================== */
  let idSeq = 0;
  const TRACK_WIN = 0.22; // s of history used for each position / velocity fit
  const cam = { x: 0, y: 0, zoom: 1, track: null, gridErr: 0, gridTrust: true, src: 'none', deadFor: 0 };

  // Weighted least-squares line through samples h[i0..i1): p(t) = p0 + v * (t - tRef). Newer samples weigh more, and a second
  // pass down-weights samples that sit far from the first fit (Huber), so one bad drawn position does not tilt the velocity.
  function lsq(h, i0, i1, tRef) {
    const n = i1 - i0;
    const w0 = new Array(n), wr = new Array(n).fill(1);
    for (let i = 0; i < n; i++) w0[i] = 1 + 1.5 * clamp(1 + (h[i0 + i].t - tRef) / 1000 / TRACK_WIN, 0, 1);
    let out = null;
    for (let pass = 0; pass < 2; pass++) {
      let sw = 0, st = 0, stt = 0, sx = 0, sy = 0, stx = 0, sty = 0;
      for (let i = 0; i < n; i++) {
        const q = h[i0 + i], tau = (q.t - tRef) / 1000, w = w0[i] * wr[i];
        sw += w; st += w * tau; stt += w * tau * tau;
        sx += w * q.x; sy += w * q.y; stx += w * tau * q.x; sty += w * tau * q.y;
      }
      const det = sw * stt - st * st;
      if (det < 1e-7 * Math.max(1, sw)) return out;
      const vx = (sw * stx - st * sx) / det, vy = (sw * sty - st * sy) / det;
      const x = (sx - vx * st) / sw, y = (sy - vy * st) / sw;
      const res = new Array(n);
      let e2 = 0, ws = 0;
      for (let i = 0; i < n; i++) {
        const q = h[i0 + i], tau = (q.t - tRef) / 1000, w = w0[i] * wr[i];
        res[i] = hyp(q.x - x - vx * tau, q.y - y - vy * tau);
        e2 += w * res[i] * res[i]; ws += w;
      }
      out = { x, y, vx, vy, res: Math.sqrt(e2 / ws) };
      if (pass === 0) {
        if (n < 5) break; // too few samples to tell an outlier from a turn
        const k = Math.max(1.5 * median(res), 2.5);
        for (let i = 0; i < n; i++) wr[i] = res[i] > k ? k / res[i] : 1;
      }
    }
    return out;
  }

  /* ===================================================================== *
   *  5a. Per-target predictor: constant velocity + learned strafing rhythm + learned dodging
   *      (source of truth: bench/predictors/adaptive.mjs, benchmarked with bench/run.mjs)
   * ===================================================================== */
  // Adaptive predictor: constant velocity with fading persistence (the baseline), plus two learned behaviours that are mixed in
  // as weighted hypotheses, so the solver can aim where most of the probability sits:
  //
  //  1. RHYTHM  - strafing players reverse direction on a beat (A, D, A, D ...). Reversals are detected from the fitted velocity;
  //               when the last few intervals agree, the next reversals are projected forward. Its weight follows how well the
  //               rhythm model has been predicting this target compared with plain constant velocity (self-scored at 0.45 s).
  //  2. DODGE   - a player who sees my bullet coming sidesteps after a reaction time, perpendicular to its path. Every bullet that
  //               threatens the target starts an "episode"; a sharp sideways change of velocity in its first 0.55 s counts as a dodge
  //               onset. The same measurement is taken with no bullet around ("control episodes") and a target only gets dodge
  //               hypotheses once it has dodged significantly more than that (z >= 2.2, excess >= 25 %). Then, while a bullet
  //               threatens: "no dodge / dodge left / dodge right" (weights from the learned rate and favoured side), or, once a dodge
  //               has begun, "keeps going / old motion resumes soon / resumes later".
  //
  // Benchmark (bench/run.mjs, 24 seeds, 8 + 5 behaviours): +6.8 points on beat-strafers, +1.5 on reactive dodgers, no loss anywhere else.
  //
  // Portable: plain JavaScript, no imports, no Date / Math.random.
  function createPredictor(opts = {}) {
    const TAU = opts.tau === undefined ? 1.2 : opts.tau;
    const WIN = 220;
    const DODGER_MIN = opts.dmin === undefined ? 0.25 : opts.dmin;
    const Z_MIN = opts.zmin === undefined ? 2.2 : opts.zmin;
    const WR_MAX = opts.wrmax === undefined ? 0.85 : opts.wrmax, RH_BAND = opts.rhband === undefined ? 0.05 : opts.rhband;
    const RH_SKILL = opts.rhs === undefined ? 0.5 : opts.rhs;
    const ONSET = opts.onset === undefined ? 150 : opts.onset;
    const PD_CAP = opts.pdcap === undefined ? 0.6 : opts.pdcap;
    const REACT = 0.2, DODGE_DUR = 0.5, EPISODE = 0.65;
    const decay = (h) => (TAU >= 20 ? h : TAU * (1 - Math.exp(-h / TAU)));
    const hist = [], lhist = [];                                    // lhist: positions of the last ~3 s (centre of a beat)
    let fit = { x: 0, y: 0, vx: 0, vy: 0 }, tNow = 0, started = false;

    function lsq(i0, i1, tRef) {
      let sw = 0, st = 0, stt = 0, sx = 0, sy = 0, stx = 0, sty = 0;
      for (let i = i0; i < i1; i++) {
        const tau_ = (hist[i].t - tRef) / 1000, w = 1 + 1.5 * Math.min(1, Math.max(0, 1 + (hist[i].t - tRef) / WIN));
        sw += w; st += w * tau_; stt += w * tau_ * tau_; sx += w * hist[i].x; sy += w * hist[i].y; stx += w * tau_ * hist[i].x; sty += w * tau_ * hist[i].y;
      }
      const det = sw * stt - st * st;
      if (det < 1e-7) return null;
      const vx = (sw * stx - st * sx) / det, vy = (sw * sty - st * sy) / det;
      return { x: (sx - vx * st) / sw, y: (sy - vy * st) / sw, vx, vy };
    }

    // ---- rhythm ----
    let dir = null;                          // unit vector of the current direction of travel along the axis of motion
    const revs = [];                          // reversal times (s)
    let vRef = 250;                           // typical steady speed
    const LAG = opts.lag === undefined ? 0.15 : opts.lag, HYST = 40;
    // reversals = the velocity along the axis of motion changes sign (with hysteresis); the timestamp is moved back by LAG, the delay between
    // the target deciding to turn and the fitted velocity showing it, so that the sequence of stamps is the sequence of decisions
    let posSide = 0; // +1 / -1: which way (along dir) the target was last moving clearly
    function trackRhythm(t, dt) {
      const sp = Math.hypot(fit.vx, fit.vy);
      if (!dir) { if (sp > 140) { dir = { x: fit.vx / sp, y: fit.vy / sp }; posSide = 1; } return; }
      const va = fit.vx * dir.x + fit.vy * dir.y;
      if (va > HYST) {
        if (posSide < 0) { // was going the other way: a reversal
          const tr = t - LAG;
          if (!revs.length || tr - revs[revs.length - 1] > 0.15) revs.push(tr);
          while (revs.length > 8) revs.shift();
        }
        posSide = 1;
        if (sp > 140 && va > 0.8 * sp) { // follow a slowly turning axis
          const nx = dir.x * 0.97 + (fit.vx / sp) * 0.03, ny = dir.y * 0.97 + (fit.vy / sp) * 0.03, nn = Math.hypot(nx, ny) || 1;
          dir = { x: nx / nn, y: ny / nn }; vRef += (sp - vRef) * 0.02;
        }
      } else if (va < -HYST) {
        if (posSide > 0) { // reversal: the axis keeps its line, its sign flips
          const tr = t - LAG;
          if (!revs.length || tr - revs[revs.length - 1] > 0.15) revs.push(tr);
          while (revs.length > 8) revs.shift();
          dir = { x: -dir.x, y: -dir.y }; posSide = 1;
        } else posSide = -1;
      }
      if (revs.length && t - revs[revs.length - 1] > 3) { revs.length = 0; }
    }
    function rhythm() { // { period, next, conf } or null
      if (revs.length < 4) return null;
      const iv = []; for (let i = 1; i < revs.length; i++) iv.push(revs[i] - revs[i - 1]);
      const use = iv.slice(-5), s = use.slice().sort((a, b) => a - b), med = s[s.length >> 1];
      if (med < 0.2 || med > 2.5) return null;
      const dev = use.map((v) => Math.abs(v - med) / med).sort((a, b) => a - b)[use.length >> 1];
      const conf = Math.max(0, 1 - dev / 0.22) * Math.min(1, (use.length - 1) / 3);
      if (conf < 0.15) return null;
      let next = revs[revs.length - 1] + med;
      while (next < tNow - 0.05) next += med;
      return { period: med, next, conf };
    }
    // position after h more seconds if the target keeps its beat: velocity flips at `next`, `next + period` ... (acceleration limited)
    function rhythmPos(r, h) {
      const A = 2000, dtS = 0.025;
      let x = fit.x, y = fit.y, vx = fit.vx, vy = fit.vy, t = 0;
      const ux = dir ? dir.x : 0, uy = dir ? dir.y : 0; // the direction of motion since the last reversal
      let sign = 1, tf = r.next - tNow;
      while (t < h - 1e-9) {
        const d = Math.min(dtS, h - t);
        if (t >= tf) { sign = -sign; tf += r.period; }
        const tvx = ux * vRef * sign, tvy = uy * vRef * sign;
        const ax = tvx - vx, ay = tvy - vy, am = Math.hypot(ax, ay);
        if (am > 1e-9) { const k = Math.min(am, A * d) / am; vx += ax * k; vy += ay * k; }
        x += vx * d; y += vy * d; t += d;
      }
      return { x, y };
    }
    // centre of the beat: mean position over the last full cycle (two reversals), drifting at the speed the centre has been moving
    function centre(r, h) {
      const T = 2 * r.period, now = tNow;
      if (now - lhist[0].t < T * 1.4) return null;
      let n1 = 0, x1 = 0, y1 = 0, n0 = 0, x0 = 0, y0 = 0;
      for (const q of lhist) {
        if (q.t > now - T) { n1++; x1 += q.x; y1 += q.y; } else if (q.t > now - 2 * T) { n0++; x0 += q.x; y0 += q.y; }
      }
      if (n1 < 6) return null;
      x1 /= n1; y1 /= n1;
      let vcx = 0, vcy = 0;
      if (n0 >= 6) { vcx = (x1 - x0 / n0) / T; vcy = (y1 - y0 / n0) / T; }
      const k = T / 2 + h;
      return { x: x1 + vcx * k, y: y1 + vcy * k };
    }
    // self-scoring: how well did each model predict this target 0.45 s later?
    const due = []; let errCV = 900, errRH = 900;

    // ---- dodge ----
    let sideP = 1, sideN = 2, dodgeSpeed = 260, retain = 0.4;   // retain: how much of its pre-dodge velocity the target takes back after a dodge   // Beta-ish counts: dodge probability, favoured side (+ = left of the bullet)
    const episodes = [], vring = [];                               // vring: fitted velocity of the last ~0.25 s
    let tN = 0, dLat = 0, dLon = 0;      // episodes judged; those with ONLY a sideways onset / ONLY an along-the-bullet onset
    function trackBullets(t, ctx) {
      const bl = ctx && ctx.bullets ? ctx.bullets : [];
      for (const b of bl) {
        const rx = fit.x - b.x, ry = fit.y - b.y, vx = b.vx - fit.vx, vy = b.vy - fit.vy, vv = vx * vx + vy * vy;
        if (vv < 1) continue;
        const tc = (rx * vx + ry * vy) / vv;
        if (tc < 0.05 || tc > 1.1) continue;
        const d = Math.hypot(rx - vx * tc, ry - vy * tc);
        if (d > 150) continue;
        const spawn = t - b.age, sp = Math.hypot(b.vx, b.vy) || 1;
        let e = null; for (const q of episodes) if (Math.abs(q.spawn - spawn) < 0.04) { e = q; break; }
        if (!e) episodes.push({ spawn, t0: t, n: { x: -b.vy / sp, y: b.vx / sp }, v0x: fit.vx, v0y: fit.vy, done: false, tc, tcT: t });
        else { e.tc = tc; e.tcT = t; }
      }
      vring.push({ t, vx: fit.vx, vy: fit.vy });
      while (vring.length > 2 && t - vring[0].t > 0.3) vring.shift();
      const past = vring.find((q) => t - q.t <= 0.16) || vring[0];
      for (let i = episodes.length - 1; i >= 0; i--) {
        const e = episodes[i], since = t - e.t0;
        // a dodge starts as a sharp sideways (relative to the bullet path) change of velocity shortly after the bullet appears; the same
        // measurement ALONG the bullet path is the control: a target that merely changes direction at random does both equally often
        if (!e.done && since >= 0.06 && since <= 0.55 && t - past.t > 0.08) {
          const k = 0.16 / (t - past.t), dx = fit.vx - past.vx, dy = fit.vy - past.vy;
          if (!e.onset) {
            const d = (dx * e.n.x + dy * e.n.y) * k;
            // a dodge moves AWAY from the bullet line (|sideways speed| grows); the return to the old course shrinks it and must not count as a side
            if (Math.abs(d) > ONSET) { e.onset = d > 0 ? 1 : -1; e.onsetT = t; e.out = Math.abs(fit.vx * e.n.x + fit.vy * e.n.y) > Math.abs(past.vx * e.n.x + past.vy * e.n.y); e.vPre = { x: past.vx, y: past.vy }; }
          }
          if (!e.onsetL && Math.abs((dx * e.n.y - dy * e.n.x) * k) > ONSET) e.onsetL = 1;
        }
        if (e.onset && e.out && !e.checked && t - e.onsetT >= 0.9) {
          e.checked = true;
          const pp = e.vPre.x * e.vPre.x + e.vPre.y * e.vPre.y;
          if (pp > 6400) retain += (Math.max(0, Math.min(1.2, (fit.vx * e.vPre.x + fit.vy * e.vPre.y) / pp)) - retain) * 0.2;
        }
        if (since >= EPISODE && !e.done) {
          e.done = true;
          tN += 1;
          if (e.onset && !e.onsetL) dLat += 1; else if (e.onsetL && !e.onset) dLon += 1;
          if (e.onset && e.out) { sideN += 1; if (e.onset > 0) sideP += 1; }
        }
        if (since > 2) episodes.splice(i, 1);
      }
    }
    function activeThreat(t) { // the soonest bullet that has not been judged yet
      let best = null;
      for (const e of episodes) if (!e.done && t - e.t0 < EPISODE && e.tc - (t - e.tcT) > -0.1 && (!best || e.tc - (t - e.tcT) < best.tc - (t - best.tcT))) best = e;
      return best;
    }

    function observe(t, x, y, ctx) {
      const dt = started ? Math.max(0.001, t - tNow) : 0.0167;
      started = true; tNow = t;
      hist.push({ t: t * 1000, x, y });
      lhist.push({ t, x, y });
      while (lhist.length > 2 && t - lhist[0].t > 3.2) lhist.shift();
      while (hist.length > 2 && t * 1000 - hist[0].t > 460) hist.shift();
      const n = hist.length, last = hist[n - 1];
      let i0 = n - 1; while (i0 > 0 && last.t - hist[i0 - 1].t <= WIN) i0--;
      const f = n - i0 >= 3 && last.t - hist[i0].t >= 50 ? lsq(i0, n, last.t) : null;
      if (f) fit = f;
      else { fit = { x: last.x, y: last.y, vx: fit.vx, vy: fit.vy }; if (n - i0 >= 2 && last.t - hist[i0].t >= 25) { const d = (last.t - hist[i0].t) / 1000; fit.vx = (last.x - hist[i0].x) / d; fit.vy = (last.y - hist[i0].y) / d; } }
      trackRhythm(t, dt);
      trackBullets(t, ctx);
      // score the models
      while (due.length && due[0].t <= t) {
        const q = due.shift();
        errCV += (Math.hypot(q.cx - x, q.cy - y) ** 2 - errCV) * 0.08;
        if (q.rx !== undefined) errRH += (Math.hypot(q.rx - x, q.ry - y) ** 2 - errRH) * 0.08;
      }
      if (n > 8 && Math.round(t * 60) % 4 === 0) {
        const r = rhythm(), a = decay(0.45), q = { t: t + 0.45, cx: fit.x + fit.vx * a, cy: fit.y + fit.vy * a };
        if (r) { const p = rhythmPos(r, 0.45); q.rx = p.x; q.ry = p.y; }
        due.push(q);
      }
    }

    function predict(h) {
      const r = rhythm();
      const a = decay(h);
      const cv = { x: fit.x + fit.vx * a, y: fit.y + fit.vy * a };
      let bases = [{ x: cv.x, y: cv.y, w: 1 }];
      if (r) {
        const skill = errCV / (errCV + errRH + 1e-6);               // > 0.5: the rhythm has been predicting better than constant velocity
        const wr = WR_MAX * Math.min(1, r.conf * 1.3) * Math.min(1, Math.max(0, (skill - RH_SKILL) / RH_BAND));
        if (wr > 0.05) {
          const p = rhythmPos(r, h), c = centre(r, h);
          // the solver aims where most weight lies within the hit radius: for a small beat the centre covers the whole swing
          bases = c ? [{ x: cv.x, y: cv.y, w: 1 - wr }, { x: p.x, y: p.y, w: wr * 0.6 }, { x: c.x, y: c.y, w: wr * 0.4 }] : [{ x: cv.x, y: cv.y, w: 1 - wr }, { x: p.x, y: p.y, w: wr }];
        }
      }
      const th = activeThreat(tNow);
      // a target gets dodge hypotheses only once it has shown that it sidesteps clearly MORE often when a bullet comes than it changes velocity
      // sideways anyway (control episodes without a bullet): two-proportion z test plus a minimum excess
      let pdE = 0;
      const nd = dLat + dLon;
      if (nd >= 8 && (dLat - dLon) / Math.sqrt(nd) >= Z_MIN) pdE = (dLat - dLon) / Math.max(1, tN);
      if (!th || pdE < DODGER_MIN) return bases;
      // a bullet is on its way: the target may sidestep (perpendicular to the bullet) after its reaction time
      const pd = Math.min(PD_CAP, pdE), pL = sideP / sideN; // the excess over what it does anyway
      const since = tNow - th.t0;
      const onset = Math.max(0.03, REACT - since);
      const out = [];
      const dv = (side) => ({ x: th.n.x * side * dodgeSpeed, y: th.n.y * side * dodgeSpeed });
      // velocity change already visible = it started; then only the rest of the dodge remains
      const started_ = !!th.onset;
      for (const b of bases) {
        if (started_) { // a dodge is under way (the fit carries it); it replaces the pre-dodge velocity for a while, then the old motion resumes
          const tin = Math.max(0, since - REACT), wk = Math.max(0.3, 1 - 0.75 * Math.min(1, retain));
          for (const [rem, w] of [[Infinity, wk], [Math.max(0.08, DODGE_DUR * 0.6 - tin), (1 - wk) / 2], [Math.max(0.15, DODGE_DUR * 1.4 - tin), (1 - wk) / 2]]) {
            if (rem === Infinity) { out.push({ x: b.x, y: b.y, w: b.w * w }); continue; }
            const k = Math.min(h, rem);
            out.push({ x: fit.x + fit.vx * decay(k) + th.v0x * Math.max(0, h - k) * 0.9, y: fit.y + fit.vy * decay(k) + th.v0y * Math.max(0, h - k) * 0.9, w: b.w * w });
          }
          continue;
        }
        out.push({ x: b.x, y: b.y, w: b.w * (1 - pd) });
        for (const side of [1, -1]) {
          const d = dv(side), te = Math.min(h, onset + DODGE_DUR), len = Math.max(0, te - onset);
          out.push({ x: b.x + (d.x - fit.vx) * len, y: b.y + (d.y - fit.vy) * len, w: b.w * pd * (side > 0 ? pL : 1 - pL) });
        }
      }
      return out;
    }
    return {
      observe, predict, onShot() {}, dbg: () => ({ retain, revs: revs.slice(), r: rhythm(), errCV, errRH, vRef, pd: tN ? Math.max(0, dLat - dLon) / tN : 0, tN, dLat, dLon, pL: sideP / sideN }),
      reset() { hist.length = 0; fit = { x: 0, y: 0, vx: 0, vy: 0 }; started = false; revs.length = 0; episodes.length = 0; due.length = 0; lhist.length = 0; tN = 0; dLat = 0; dLon = 0; dir = null; posSide = 0; vRef = 250; errCV = 900; errRH = 900; },
    };
  }

  class Track {
    constructor(kind, t, wx, wy) {
      this.kind = kind; this.id = ++idSeq; this.hist = [];
      this.x = wx; this.y = wy; this.vx = 0; this.vy = 0;
      this.first = t; this.last = t; this.n = 0; this.res = 0; this.acc = 0;
      this.rW = 0; this.col = null; this.sx = 0; this.sy = 0; this.seen = true;
      this.threat = null; this.pred = kind === 'tank' ? createPredictor() : null;
      this.name = null; this.score = null; this.scoreT = 0; this.hp = null; this.hpT = 0;
      this.shotAtMeT = 0; this.hitByMeT = 0; this.shotsAtMe = 0; this.lvlSm = 0; this.scoreSrc = 'board';
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

  // The camera is the world position of the screen centre (world = (screen - centre) / zoom + camera). Two things pin it down:
  //  - the background grid: its origin on screen is centre - zoom * camera (mod one tile), so the camera is read ABSOLUTELY from
  //    it, unwrapped against the prediction, which makes zoom changes (level-ups widen the view) harmless;
  //  - the shapes: nearly static in the world, so each one's last world position says where the camera has to be now.
  const wrapTo = (d, period) => d - period * Math.round(d / period);
  function updateCamera(f, prev) {
    const g = f.grid;
    if (g && g.zoom > 0.02 && g.zoom < 50) cam.zoom = g.zoom;
    if (!cam.track) cam.track = new Track('cam', f.t, cam.x, cam.y);
    if (!prev) {
      cam.src = 'none';
      if (g && g.tw > 4) { cam.x = (S.cw / 2 - g.e) / cam.zoom; cam.y = (S.ch / 2 - g.f) / cam.zoom; cam.track.hist.length = 0; cam.track.push(f.t, cam.x, cam.y); }
      f.camSnap = { x: cam.x, y: cam.y, zoom: cam.zoom, dx: 0, dy: 0 };
      return;
    }
    const dt = (f.t - prev.t) / 1000;
    if (dt < 0.002 || dt > 0.6) { cam.src = 'gap'; f.camSnap = { x: cam.x, y: cam.y, zoom: cam.zoom, dx: 0, dy: 0 }; return; }
    const Z = cam.zoom;
    const age = Math.min(0.1, dt);
    const px = cam.x + cam.track.vx * age, py = cam.y + cam.track.vy * age; // dead-reckoned camera
    const sx = (wx) => (wx - px) * Z + S.cw / 2, sy = (wy) => (wy - py) * Z + S.ch / 2;

    // from the shapes: where must the camera be so that last frame's shapes land on this frame's?
    let fromShapes = null, shapeN = 0;
    if (f.shapes.length >= 3 && prev.shapes.length >= 3 && prev.camSnap) {
      const cs = prev.camSnap, gate = 6 + 0.4 * hyp(cs.dx, cs.dy) * Z;
      const xs = [], ys = [];
      for (const s of f.shapes) {
        let best = null, bd = gate;
        for (const q of prev.shapes) {
          const wx = (q.x - S.cw / 2) / cs.zoom + cs.x, wy = (q.y - S.ch / 2) / cs.zoom + cs.y; // world position when it was seen
          const d = hyp(s.x - sx(wx), s.y - sy(wy));
          if (d < bd) { bd = d; best = { wx, wy }; }
        }
        if (best) { xs.push(best.wx - (s.x - S.cw / 2) / Z); ys.push(best.wy - (s.y - S.ch / 2) / Z); }
      }
      if (xs.length >= 3) { fromShapes = { x: median(xs), y: median(ys) }; shapeN = xs.length; }
    }
    // from the grid: absolute, then unwrapped to the nearest tile-multiple of the prediction
    let fromGrid = null;
    if (g && g.tw > 4 && g.th > 4) {
      const ax = (S.cw / 2 - g.e) / Z, ay = (S.ch / 2 - g.f) / Z;
      const rx = fromShapes ? fromShapes.x : px, ry = fromShapes ? fromShapes.y : py;
      const ux = rx + wrapTo(ax - rx, g.tw), uy = ry + wrapTo(ay - ry, g.th);
      const lim = Math.min(g.tw, g.th) * 0.3;
      if (hyp(ux - rx, uy - ry) < lim) fromGrid = { x: ux, y: uy };
    }
    let next;
    if (fromGrid && fromShapes) {
      cam.gridErr += (hyp(fromGrid.x - fromShapes.x, fromGrid.y - fromShapes.y) * Z - cam.gridErr) * 0.1;
      cam.gridTrust = cam.gridErr < 2.5;
      next = cam.gridTrust ? fromGrid : fromShapes; cam.src = cam.gridTrust ? 'grid' : 'shapes'; cam.deadFor = 0;
    } else if (fromGrid) {
      // nothing to cross-check with: a grid that agrees with the dead-reckoning is trusted again
      const dev = hyp(fromGrid.x - px, fromGrid.y - py) * Z;
      if (!cam.gridTrust && dev < 3) cam.gridOk = (cam.gridOk || 0) + 1; else if (dev >= 3) cam.gridOk = 0;
      if (cam.gridOk >= 5) { cam.gridTrust = true; cam.gridErr = 0; }
      if (cam.gridTrust) { next = fromGrid; cam.src = 'grid'; cam.deadFor = 0; }
    } else if (fromShapes) { next = fromShapes; cam.src = 'shapes'; cam.deadFor = 0; }
    if (!next) {
      cam.deadFor += dt;
      next = cam.deadFor < 0.5 ? { x: px, y: py } : { x: cam.x, y: cam.y };
      cam.src = 'dead';
    }
    cam.x = next.x; cam.y = next.y;
    cam.track.push(f.t, cam.x, cam.y);
    f.camSnap = { x: cam.x, y: cam.y, zoom: Z, dx: cam.track.vx * dt, dy: cam.track.vy * dt };
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
      if (t - tk.last > 300) { tk.hist.length = 0; tk.vx = 0; tk.vy = 0; tk.first = t; if (tk.pred) tk.pred.reset(); } // back after a gap: start the fit afresh
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

  // Level of a tank from how big it is drawn compared with mine (both in the same frame, so the zoom cancels).
  function levelEstimate(tk) {
    if (!S.tableOk || !S.me || !S.me.r) return null;
    const myL = S.myLevel || (S.myScore !== null ? levelFromScore(S.myScore) : null);
    if (!myL) return null;
    return clamp(myL + 100.5 * Math.log((tk.rW * cam.zoom) / S.me.r), 1, 45);
  }
  // Best available score of a tank: the leaderboard's (exact), else an estimate from its level (an unlisted tank cannot beat the 10th row).
  function scoreOf(tk) {
    if (tk.score !== null) return { v: tk.score, src: 'board' };
    const L = tk.lvlSm;
    if (!L) return null;
    let v = scoreOfLevel(L);
    if (S.leaderboard.length >= 10) v = Math.min(v, S.leaderboard[S.leaderboard.length - 1].score);
    return { v, src: 'est' };
  }

  // Names, scores and health of the tanks on screen, from the text and strokes the game drew this frame.
  function readMeta(f) {
    const t = f.t;
    const rows = [];
    for (const tx of f.texts) {
      const row = parseRow(tx.text);
      if (row && tx.x > S.cw * 0.45) { rows.push(row); continue; }
      let m = /^score:?\s*(.+)$/i.exec(tx.text);
      if (m) { const v = parseScore(m[1]); if (v !== null) S.myScore = v; continue; }
      m = /^(?:lvl|level|lv)\.?\s*(\d{1,2})\b/i.exec(tx.text);
      if (m) S.myLevel = +m[1];
    }
    if (rows.length) { S.leaderboard = rows; S.lbT = t; } else if (t - S.lbT > 5000) S.leaderboard = [];
    // does this server use the standard score table? (own score and own level must agree)
    if (S.myScore !== null && S.myLevel) S.tableOk = Math.abs(levelFromScore(S.myScore) - S.myLevel) <= 1;
    const plates = f.texts.filter((tx) => !parseRow(tx.text) && !/^(score|lvl|level|leaderboard|scoreboard)/i.test(tx.text));
    const seen = S.tanks.filter((tk) => tk.seen);
    const claimed = new Set();
    for (const tk of seen) {
      const rpx = tk.rW * cam.zoom;
      let best = null, bs = 1e9;
      for (const tx of plates) {
        const dx = Math.abs(tx.x - tk.sx), dy = tk.sy - tx.y;
        if (dx > rpx * 1.4 || dy < rpx * 0.3 || dy > rpx * 4) continue;
        const sc = dx + Math.abs(dy - rpx * 1.6);
        if (sc < bs) { bs = sc; best = tx; }
      }
      if (best) tk.name = best.text;
      const lv = levelEstimate(tk);
      if (lv !== null) tk.lvlSm = tk.lvlSm ? tk.lvlSm + (lv - tk.lvlSm) * 0.1 : lv; // median-ish: smoothed over ~10 frames
      if (tk.name && S.leaderboard.length) {
        const hits = S.leaderboard.filter((r) => sameName(r.name, tk.name));
        if (hits.length === 1 && !/^(unnamed|)$/i.test(normName(tk.name))) { tk.score = hits[0].score; tk.scoreT = t; claimed.add(hits[0]); }
      }
    }
    // blank / duplicate names: pair the remaining leaderboard rows with the remaining tanks by level (largest <-> highest score)
    if (S.tableOk && S.leaderboard.length) {
      const rest = S.leaderboard.filter((r) => !claimed.has(r) && !(S.myScore !== null && Math.abs(r.score - S.myScore) <= Math.max(1, S.myScore * 0.02)));
      const free = seen.filter((tk) => tk.score === null && tk.lvlSm).sort((a, b) => b.lvlSm - a.lvlSm);
      rest.sort((a, b) => b.score - a.score);
      for (const tk of free) {
        const i = rest.findIndex((r) => Math.abs(levelFromScore(r.score) - tk.lvlSm) <= 2.5);
        if (i < 0) continue;
        if (rest.filter((r) => Math.abs(levelFromScore(r.score) - tk.lvlSm) <= 2.5).length > 1 && free.filter((o) => Math.abs(o.lvlSm - tk.lvlSm) <= 2.5).length > 1) continue; // ambiguous
        tk.score = rest[i].score; tk.scoreT = t; tk.scoreSrc = 'level'; rest.splice(i, 1);
      }
    }
    for (const tk of seen) if (tk.score !== null && t - tk.scoreT > 8000) tk.score = null;
    // health bars: the last fraction seen is kept (a bar fades, it does not mean the tank healed)
    const hm = matchHealth(f.bars, seen.map((tk) => ({ x: tk.sx, y: tk.sy, r: tk.rW * cam.zoom })));
    seen.forEach((tk, i) => { if (hm.has(i)) { tk.hp = hm.get(i); tk.hpT = t; } });
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
    if (d < tk.rW + b.rW + 12) { S.stats.hits++; tk.hitByMeT = t; }
  }

  const eBullets = [];
  function updateEnemyBullets(f, t) {
    const me = S.selfTrack;
    if (!(cfg.espBullets || cfg.priority === 'auto' || cfg.priority === 'threat') || !me || !S.selfCol) { eBullets.length = 0; S.threats = 0; return; }
    const dets = [];
    for (const e of f.bullets) {
      if (sameTeam(e.col, S.selfCol) || e.col.gray || SHAPE_HEX.has(e.col.hex)) continue;
      dets.push({ wx: toWX(e.x), wy: toWY(e.y), r: e.r / cam.zoom, sx: e.x, sy: e.y, col: e.col });
    }
    matchTracks(eBullets, dets, t, 'ebullet', (tk, dt) => tk.rW * 3 + 30 + 1500 * dt);
    for (let i = eBullets.length - 1; i >= 0; i--) if (t - eBullets[i].last > 250) eBullets.splice(i, 1);
    for (const tk of eBullets) {
      if (tk.attr) continue;
      tk.attr = true; // who fired it: the enemy tank it first appeared next to
      let best = null, bd = 1e9;
      for (const e of S.tanks) {
        if (!e.seen) continue;
        const d = hyp(tk.x - e.x, tk.y - e.y);
        if (d > e.rW * 0.7 && d < e.rW * 3.6 + 40 && d < bd) { bd = d; best = e; }
      }
      tk.shooter = best;
    }
    let threats = 0;
    for (const tk of eBullets) {
      tk.threat = null;
      if (!tk.seen || tk.n < 3) continue;
      const rx = tk.x - me.x, ry = tk.y - me.y, ux = tk.vx - me.vx, uy = tk.vy - me.vy;
      const uu = ux * ux + uy * uy;
      if (uu < 1) continue;
      const tc = -(rx * ux + ry * uy) / uu;
      if (tc < 0 || tc > 1.2) continue;
      if (hyp(rx + ux * tc, ry + uy * tc) < (me.rW + tk.rW) * 1.2) {
        tk.threat = tc; threats++;
        if (tk.shooter && !tk.counted) { tk.counted = true; tk.shooter.shotAtMeT = t; tk.shooter.shotsAtMe++; } // it is shooting at me
      }
    }
    S.threats = threats;
  }

  /* ===================================================================== *
   *  7. Aim solver
   * ===================================================================== */
  const GRACE_MS = 250;
  const effLatency = () => clamp(cfg.autoTune && cfg.measured > 0 ? cfg.measured : cfg.latency / 1000, 0, 0.8);
  const SHAPE_VALUE = { '#768dfc': 3, '#f177dd': 2, '#fc7677': 1.8, '#ffe869': 1 };

  const ignoredName = (tk) => {
    if (!cfg.ignoreNames || !tk.name) return false;
    const n = normName(tk.name);
    return cfg.ignoreNames.split(',').some((x) => { x = normName(x); return x && (n === x || (x.length >= 3 && n.includes(x))); });
  };
  const sinceS = (ts, t) => (ts > 0 ? (t - ts) / 1000 : Infinity);

  // Who to shoot at. closest / cursor: geometry only. auto / score / health / threat: who is strongest, hurt or shooting
  // at me matters more than who happens to be nearest, and small fry (a 300-score bot next to a 9k tester) is ignored.
  function pickTarget(t) {
    const me = S.me;
    if (!me) return null;
    const rect = S.rect;
    const mx = (S.mouse.x - rect.left) / S.k, my = (S.mouse.y - rect.top) / S.k;
    const half = hyp(S.cw, S.ch) / 2;
    const maxD = (cfg.range / 100) * half + 1;
    const tau = cfg.persistence;
    let cands = [];
    const consider = (tk, scale) => {
      const age = (t - tk.last) / 1000;
      if (age * 1000 > GRACE_MS) return;
      const sx = toSX(tk.x + tk.vx * decay(age, tau)), sy = toSY(tk.y + tk.vy * decay(age, tau));
      const keep = tk === S.target; // the target we already have gets a wider band, so the edge does not flicker
      const mg = keep ? 40 : 0;
      if (sx < -mg || sx > S.cw + mg || sy < -mg || sy > S.ch + mg) return;
      const d = hyp(sx - me.x, sy - me.y);
      if (d > (keep ? maxD * 1.15 : maxD)) return;
      if (tk.kind === 'tank' && ignoredName(tk)) return;
      cands.push({ tk, d, curD: hyp(sx - mx, sy - my), scale, value: 0, ratio: 1 });
    };
    for (const tk of S.tanks) consider(tk, 1);
    const pinned = S.pinId ? cands.find((c) => c.tk.id === S.pinId) : null;
    if (S.pinId) { if (pinned) S.pinT = t; else if (t - S.pinT > 2000) S.pinId = 0; } // pinned tank is gone
    S.ignored = new Set();
    let shapes = false;
    if (!cands.length && cfg.farm) {
      shapes = true;
      for (const tk of S.shapes) consider(tk, cfg.farmPriority === 'value' ? SHAPE_VALUE[tk.col.hex] || 1 : 1);
    }
    if (!cands.length) { S.rank = []; return null; }

    const geometric = shapes || cfg.priority === 'closest' || cfg.priority === 'cursor';
    if (geometric) {
      for (const c of cands) c.value = -(cfg.priority === 'cursor' && !shapes ? c.curD : c.d) / c.scale;
    } else {
      let bestScore = 0, bestR = 0;
      for (const c of cands) { c.est = scoreOf(c.tk); if (c.est) bestScore = Math.max(bestScore, c.est.v); bestR = Math.max(bestR, c.tk.rW); }
      const ref = { score: bestScore, r: bestR };
      for (const c of cands) {
        c.ratio = strengthRatio({ score: c.est ? c.est.v : null, r: c.tk.rW }, ref);
        c.shot = sinceS(c.tk.shotAtMeT, t); c.hit = sinceS(c.tk.hitByMeT, t);
        c.engaged = c.shot < 6 || c.hit < 6;
      }
      if (cfg.ignoreSmall > 0 && cfg.priority !== 'health') { // small fry is skipped unless it is the one fighting me
        const keep = cands.filter((c) => c.ratio >= cfg.ignoreSmall / 100 || c.engaged);
        if (keep.length) { for (const c of cands) if (!keep.includes(c)) S.ignored.add(c.tk.id); cands = keep; }
      }
      for (const c of cands) {
        const hpAge = (t - c.tk.hpT) / 1000;
        c.value = rankValue({ hp: c.tk.hp === null ? 1 : c.tk.hp + (1 - c.tk.hp) * clamp((hpAge - 20) / 30, 0, 1), dist: Math.min(1, c.d / maxD), curDist: Math.min(1, c.curD / half), shotAtMe: c.shot, hitByMe: c.hit }, cfg.priority, c.ratio);
      }
    }
    cands.sort((a, b) => b.value - a.value);
    S.rank = cands.slice(0, 6).map((c) => ({ id: c.tk.id, name: c.tk.name, score: c.tk.score, hp: c.tk.hp, ratio: +c.ratio.toFixed(2), value: +c.value.toFixed(2), engaged: !!c.engaged }));
    if (pinned) return pinned.tk; // the player pinned this tank: nothing outranks it
    let best = cands[0];
    const cur = S.target && cands.find((c) => c.tk === S.target);
    if (cur && best.tk !== cur.tk) {
      const mature = t - S.targetSince >= 350;
      const s = cfg.stickiness / 100;
      const switchIt = geometric ? -best.value < -cur.value * (1 - s * 0.6) : best.value - cur.value > s * 1.2;
      if (!mature || !switchIt) { best = cur; S.chal = null; }
      else {
        if (!S.chal || S.chal.id !== best.tk.id) S.chal = { id: best.tk.id, since: t };
        if (t - S.chal.since < 250) best = cur; // the challenger has to stay better for a moment: no ping-pong between two close tanks
      }
    } else S.chal = null;
    return best.tk;
  }

  // Several weighted guesses for where a target will be: aim at the one (or the mean) covering the most weight within
  // the hit radius. With a single guess this is just that guess.
  function chooseAim(hyps, hitR) {
    if (hyps.length === 1) return hyps[0];
    const sw = hyps.reduce((a, h) => a + h.w, 0) || 1;
    const cands = hyps.map((h) => ({ x: h.x, y: h.y })).concat([{ x: hyps.reduce((a, h) => a + h.x * h.w, 0) / sw, y: hyps.reduce((a, h) => a + h.y * h.w, 0) / sw }]);
    let top = hyps[0]; for (const h of hyps) if (h.w > top.w) top = h;
    let best = null, bs = -1, bd = 1e18;
    for (const c of cands) {
      let sc = 0; for (const h of hyps) if (hyp(c.x - h.x, c.y - h.y) < hitR) sc += h.w;
      const d = hyp(c.x - top.x, c.y - top.y);
      if (sc > bs + 1e-9 || (Math.abs(sc - bs) <= 1e-9 && d < bd)) { bs = sc; bd = d; best = c; }
    }
    return best;
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
    const hitR = (tk.rW + 0.3 * Rw) * 0.85; // a bullet is ~0.3 tank radii
    // where the target will be h seconds after its last sample: weighted hypotheses (world units)
    const hypsAt = (h) => {
      if (tk.pred && cfg.dodge && lead > 0) {
        const hs = tk.pred.predict(h);
        return hs.map((q) => ({ x: tk.x + (q.x - tk.x) * lead, y: tk.y + (q.y - tk.y) * lead, w: q.w }));
      }
      const adv = decay(h, tau) * lead;
      return [{ x: tk.x + tvx * adv, y: tk.y + tvy * adv, w: 1 }];
    };
    const now0 = hypsAt(age)[0]; // where it is now
    let T = reachInv(Math.max(0, hyp(now0.x - Ps.x, now0.y - Ps.y) - m));
    let aim = now0, hs = [now0];
    for (let i = 0; i < 7; i++) {
      hs = hypsAt(age + L + T);
      aim = chooseAim(hs, hitR);
      const d = hyp(aim.x - Ps.x - inh * Vs.x * T, aim.y - Ps.y - inh * Vs.y * T);
      const Tn = Math.min(reachInv(Math.max(0, d - m)), 2.5);
      const done = Math.abs(Tn - T) < 0.004;
      T = Tn;
      if (done) break;
    }
    let ax = aim.x - inh * Vs.x * T, ay = aim.y - inh * Vs.y * T; // world point to aim at
    // a human notices a change of course a moment late: the lead (aim point minus where the tank is now) is low-passed
    const lagS = (cfg.human / 100) * 0.1;
    const bx = tk.x + tvx * decay(age, tau), by = tk.y + tvy * decay(age, tau); // the tank where it is now
    if (lagS > 0.004) {
      const dts = tk.solveT ? clamp((t - tk.solveT) / 1000, 0.001, 0.2) : 0.016;
      const lx = ax - bx, ly = ay - by;
      if (tk.leadX === undefined || t - tk.solveT > 400) { tk.leadX = lx; tk.leadY = ly; }
      else { const k = 1 - Math.exp(-dts / lagS); tk.leadX += (lx - tk.leadX) * k; tk.leadY += (ly - tk.leadY) * k; }
      ax = bx + tk.leadX; ay = by + tk.leadY;
    }
    tk.solveT = t;
    const dx = ax - Ps.x, dy = ay - Ps.y;
    const dist = hyp(dx, dy) || 1;
    const speed = hyp(tvx, tvy);
    const bulletSpeed = Math.max(reachAt(T) / Math.max(T, 0.05), 1);
    const stab = 1 / (1 + (tk.acc / (6 * Rw)) ** 2);
    const samples = clamp((tk.n - 2) / 6, 0, 1);
    const spread = hs.length > 1 ? hs.reduce((a, h) => a + (hyp(h.x - aim.x, h.y - aim.y) < hitR ? h.w : 0), 0) : 1; // share of the guesses the aim covers
    const conf = clamp(
      ((1 - T / (cfg.fireMaxFlight * 1.25)) * 0.45 + stab * 0.35 + samples * 0.2 - 0.3 * Math.max(0, speed / bulletSpeed - 0.8)) * (0.55 + 0.45 * spread),
      0, 1,
    );
    // how fast the aim point swings round me (rad/s) and in/out (css px/s): the cursor follows with a lag, this cancels it
    const rd = dx * dx + dy * dy || 1, Vx = tvx - Vs.x, Vy = tvy - Vs.y;
    return {
      tk, T, dist, conf, ax, ay, ux: dx / dist, uy: dy / dist, hyps: hs,
      tol: Math.atan2(tk.rW + 6, dist), t,
      w: (dx * Vy - dy * Vx) / rd, rr: ((dx * Vx + dy * Vy) / dist) * cam.zoom * S.k,
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
    kS: 1, wander: 0, fast: 0, yieldUntil: 0, armDelay: 0, armT: -1, lastEng: -1e9, suspended: false, reassert: false, err: 0,
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

  const gaussR = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());

  function canEngage() {
    if (!cfg.enabled || !cfg.aim || !S.playing || ctl.suspended || !S.sol || !S.pivot) return false;
    if (cfg.panelPause && S.panelHover) return false;
    if (nowMs() < ctl.yieldUntil) return false; // the player flicked the mouse: hand the barrel back for a moment
    // a tank spotted a moment ago has no velocity estimate yet: wait until it has one
    if (!ctl.on && (S.sol.tk.last - S.sol.tk.first < 60 || S.sol.tk.n < 3)) return false;
    if (cfg.autoFire) return true;
    if (cfg.aimMode === 'firing') return S.mouseL || S.spaceDown || F.belief;
    if (cfg.aimMode === 'hold') return S.holdDown;
    if (cfg.aimMode === 'near') { // assist: only help with tanks roughly where the player is already pointing
      const p = S.pivot, d = S.sol;
      const away = Math.abs(wrapAngle(Math.atan2(d.py - p.y, d.px - p.x) - Math.atan2(S.mouse.y - p.y, S.mouse.x - p.x)));
      return away <= (cfg.cone * Math.PI / 180) * (ctl.on ? 1.5 : 1);
    }
    return true;
  }

  function beginEngage(piv, t) {
    const mx = S.mouse.x - piv.x, my = S.mouse.y - piv.y;
    ctl.thA = ctl.thB = recordAngle(t, Math.atan2(my, mx));
    ctl.wA = ctl.wB = clamp(S.mouseW, -18, 18); // carry on at the speed the hand had
    ctl.rho = Math.max(hyp(mx, my), 12); ctl.rv = 0;
    ctl.kS = 1; ctl.fast = 0;
    ctl.on = true;
  }

  function control(dt, t) {
    const piv = S.pivot;
    let eng = canEngage();
    if (!ctl.on) {
      if (!eng) { ctl.armT = -1; ctl.err = 0; return; }
      if (ctl.armT < 0) { ctl.armT = t; ctl.armDelay = cfg.reaction * (1 + (Math.random() - 0.5) * 0.8 * (cfg.human / 100)); }
      // a short, slightly varying reaction time before a fresh lock-on (none when re-locking right after a release)
      if (t - ctl.lastEng > 400 && t - ctl.armT < ctl.armDelay) return;
      beginEngage(piv, t);
    }
    if (!piv) { releaseNow(S.mouse.x, S.mouse.y); return; }
    if (eng && cfg.override > 0) { // a big flick of the real mouse means "I want it back"
      ctl.fast = S.mouseSpeed > cfg.override ? ctl.fast + dt : Math.max(0, ctl.fast - dt * 2);
      if (ctl.fast > 0.12) { ctl.yieldUntil = t + 800; ctl.fast = 0; eng = false; }
    }

    const total = Math.max(cfg.smooth, 0) / 1000;
    let gTh, gRho;
    if (eng) {
      const d = S.sol;
      const dx = d.px - piv.x, dy = d.py - piv.y;
      gTh = Math.atan2(dy, dx); gRho = Math.max(hyp(dx, dy), 12);
      // the followers lag the goal by about their smoothing time: aim a little ahead along where the goal is going
      const effS = total * ctl.kS;
      gTh += (Number.isFinite(d.w) ? clamp(d.w, -12, 12) : 0) * effS;
      gRho += (Number.isFinite(d.rr) ? d.rr : 0) * effS;
      // nobody is dead on: a slow wander around the true aim, a fraction of the target's apparent size
      const k = Math.exp(-dt / 0.9);
      ctl.wander = ctl.wander * k + (cfg.human > 0 ? 0.25 * (cfg.human / 100) * d.tol * Math.sqrt(1 - k * k) * gaussR() : 0);
      gTh += ctl.wander;
      ctl.lastEng = t;
    } else {
      gTh = Math.atan2(S.mouse.y - piv.y, S.mouse.x - piv.x);
      gRho = Math.max(hyp(S.mouse.x - piv.x, S.mouse.y - piv.y), 12);
      ctl.wander *= 0.95;
    }

    // small corrections are quick, big swings are slow and smooth (as a hand moves): the follower speeds up as the error shrinks
    const xe = clamp(Math.abs(wrapAngle(gTh - ctl.thB)) / 0.9, 0, 1);
    const kT = eng ? 0.4 + 0.6 * xe * xe * (3 - 2 * xe) : 1;
    ctl.kS += (kT - ctl.kS) * (1 - Math.exp(-dt / (kT > ctl.kS ? 0.01 : 0.08))); // slow down at once for a big swing, speed up gradually
    const st = eng ? total * ctl.kS : t < ctl.yieldUntil ? 0.05 : Math.max(total, 0.12); // a flick gets the barrel back fast, otherwise hand it back gently
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
    // assist strength < 100: blend the player's own aim with the computed one instead of taking over completely
    let th = ctl.thB, rho = ctl.rho;
    if (eng && cfg.assist < 100) {
      const a = cfg.assist / 100, mTh = Math.atan2(S.mouse.y - piv.y, S.mouse.x - piv.x), mRho = Math.max(hyp(S.mouse.x - piv.x, S.mouse.y - piv.y), 12);
      th = mTh + a * wrapAngle(ctl.thB - mTh); rho = mRho + a * (ctl.rho - mRho);
    }
    ctl.x = piv.x + Math.cos(th) * rho;
    ctl.y = piv.y + Math.sin(th) * rho;
    recordAngle(t, th);
    ctl.err = eng ? Math.abs(wrapAngle(th - Math.atan2(S.sol.py - piv.y, S.sol.px - piv.x))) : 0;
    if (!eng && Math.abs(wrapAngle(ctl.thB - gTh)) < 0.008 && Math.abs(ctl.rho - gRho) < 2 && Math.abs(ctl.wB) < 0.3 && Math.abs(ctl.rv) < 30) {
      ctl.on = false; dispatchMouse(S.mouse.x, S.mouse.y); return;
    }
    dispatchMouse(ctl.x, ctl.y);
  }

  function releaseNow(x, y) {
    if (!ctl.on) return;
    ctl.on = false;
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
    readMeta(f);
    updateOwnBullets(f, f.t);
    updateEnemyBullets(f, f.t);
    if (cfg.dodge) feedPredictors(f.t);

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

  // each seen tank's predictor learns from its newest drawn position and from my bullets in flight (world coordinates)
  function feedPredictors(t) {
    const bl = [];
    for (const b of bullet.active) {
      if (b.n < 2 || !b.seen) continue;
      const sp = hyp(b.vx, b.vy);
      if (sp > 150) bl.push({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, age: (t - b.born) / 1000 });
    }
    const ctx = { bullets: bl };
    for (const tk of S.tanks) {
      if (!tk.seen || !tk.pred || !tk.hist.length) continue;
      const q = tk.hist[tk.hist.length - 1];
      tk.pred.observe(t / 1000, q.x, q.y, ctx);
    }
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
    if (t - S.mouseLastT > 90) S.mouseSpeed *= 0.7;
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
    if (cfg.clean) return;
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
        const shooting = tk.kind === 'tank' && sinceS(tk.shotAtMeT, S.frameT) < 4;
        const skipped = S.ignored.has(tk.id);
        ctx.strokeStyle = isT ? '#ffd23c' : tk.kind === 'shape' ? 'rgba(255,255,255,.35)' : skipped ? 'rgba(200,200,200,.4)' : shooting ? 'rgba(255,150,40,.95)' : 'rgba(255,70,70,.85)';
        ctx.lineWidth = isT || shooting ? 2.2 : 1.5;
        ctx.beginPath(); ctx.arc(X(sx), Y(sy), tk.rW * Z * k + 5, 0, Math.PI * 2); ctx.stroke();
        if (tk.kind === 'tank' && me) {
          const d = hyp(tk.x - S.selfTrack.x, tk.y - S.selfTrack.y) / (S.selfTrack.rW || 50);
          ctx.fillStyle = 'rgba(255,255,255,.85)';
          ctx.font = '11px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(d.toFixed(1) + 'R', X(sx), Y(sy) - tk.rW * Z * k - 9);
          if (cfg.labels) { // who it is, how strong, how hurt
            const bits = [];
            if (tk.name) bits.push(tk.name);
            if (tk.score !== null) bits.push(fmtScore(tk.score));
            if (tk.hp !== null) bits.push(Math.round(tk.hp * 100) + '%');
            if (skipped) bits.push('ignored');
            if (S.pinId === tk.id) bits.push('PINNED');
            if (bits.length) {
              const txt = bits.join(' \u00b7 '), ly = Y(sy) + tk.rW * Z * k + 18;
              ctx.font = '600 11px system-ui, sans-serif';
              const w = ctx.measureText(txt).width + 10;
              ctx.fillStyle = 'rgba(10,12,16,.6)'; ctx.fillRect(X(sx) - w / 2, ly - 11, w, 15);
              ctx.fillStyle = isT ? '#ffd23c' : '#e8eef5'; ctx.fillText(txt, X(sx), ly);
            }
          }
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

  function drawNote(ctx, W, text) {
    ctx.font = '12px ui-monospace, Menlo, Consolas, monospace'; ctx.textAlign = 'center';
    const w = Math.min(W - 20, ctx.measureText(text).width + 14);
    ctx.fillStyle = 'rgba(10,12,16,.55)'; ctx.fillRect(W / 2 - w / 2, 6, w, 17);
    ctx.fillStyle = '#ffd98a'; ctx.fillText(text.length > 140 ? text.slice(0, 137) + '...' : text, W / 2, 18);
  }
  function drawHud(ctx, W) {
    if (!cfg.hud) return;
    if (cfg.enabled && !S.playing) { if (S.noSelf > 180 && S.ready && !S.dom.menu && !S.dom.dead) drawNote(ctx, W, 'Diep Assist: ' + why()); return; }
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
        const tk = sol.tk, who = [];
        if (cfg.card && tk.kind === 'tank') {
          who.push(tk.name || '#' + tk.id);
          if (tk.score !== null) who.push(fmtScore(tk.score));
          if (tk.hp !== null) who.push(Math.round(tk.hp * 100) + '% hp');
          if (sinceS(tk.shotAtMeT, S.frameT) < 5) who.push('shooting at me');
          if (S.pinId === tk.id) who.push('pinned');
          if (cfg.dodge && tk.pred) { const d = tk.pred.dbg(); if (d.r && d.r.conf > 0.4) who.push('beat ' + d.r.period.toFixed(2) + 's'); if (d.tN >= 8 && d.pd > 0.5) who.push('dodges ' + Math.round(d.pd * 100) + '%'); }
        } else who.push('#' + tk.id + ' ' + tk.kind);
        lines.push(`${who.join(' \u00b7 ')}  ${(sol.dist / R).toFixed(1)}R  T ${sol.T.toFixed(2)}s  conf ${Math.round(sol.conf * 100)}%`);
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
   *  Settings export / import / profiles and the diagnostics report
   * ===================================================================== */
  function exportSettings() {
    const o = JSON.parse(JSON.stringify(cfg));
    delete o.ui; delete o.measured;
    return JSON.stringify({ diepAssist: 2, cfg: o });
  }
  function importSettings(str) {
    try {
      const j = JSON.parse(str), src = j && j.cfg ? j.cfg : j;
      if (!src || typeof src !== 'object') return false;
      let n = 0;
      for (const k of Object.keys(src)) {
        if (k === 'ui' || k === 'measured') continue;
        if (k === 'keys' && src.keys && typeof src.keys === 'object') { Object.assign(cfg.keys, src.keys); n++; }
        else if (k in cfg && typeof src[k] === typeof cfg[k]) { cfg[k] = src[k]; n++; }
      }
      save(); applyClean(); refreshAll();
      return n > 0;
    } catch { return false; }
  }
  // One-click strengths for hosting a game where the aim is a perk that players unlock in steps.
  const TIERS = {
    off: { aim: false, autoFire: false },
    assist: { aim: true, aimMode: 'near', cone: 20, assist: 45, predict: true, leadScale: 60, dodge: false, human: 70, smooth: 150, reaction: 120, autoFire: false },
    smart: { aim: true, aimMode: 'firing', assist: 80, predict: true, leadScale: 100, dodge: true, human: 50, smooth: 130, reaction: 90, autoFire: false },
    full: { aim: true, aimMode: 'always', assist: 100, predict: true, leadScale: 100, dodge: true, human: 40, smooth: 130, reaction: 70 },
  };
  function applyTier(name) {
    const t = TIERS[name];
    if (!t) return false;
    Object.assign(cfg, t); save(); refreshAll();
    return true;
  }
  const PROFILE_KEY = 'diepAssist.v2.profiles';
  const profiles = () => { try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}'); } catch { return {}; } };
  function saveProfile(n) { const p = profiles(); p[n] = exportSettings(); try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); return true; } catch { return false; } }
  function loadProfile(n) { const p = profiles()[n]; return p ? importSettings(p) : false; }

  // Everything needed to see what the script sees (paste it back when something does not line up on a server).
  function report() {
    const f = S.ready;
    return {
      version: VERSION, time: new Date().toISOString(), host: location.host, ua: navigator.userAgent,
      window: { w: innerWidth, h: innerHeight, dpr: window.devicePixelRatio },
      cfg: JSON.parse(exportSettings()).cfg,
      state: {
        playing: S.playing, canvas: S.canvas ? { id: S.canvas.id, w: S.canvas.width, h: S.canvas.height } : null,
        zoom: cam.zoom, camera: cam.src, gridTrusted: cam.gridTrust, selfSeen: !!S.self, selfColor: S.selfCol && S.selfCol.hex,
        tanks: S.tanks.map((t) => ({ id: t.id, name: t.name, score: t.score, hp: t.hp, seen: t.seen, r: Math.round(t.rW), shotsAtMe: t.shotsAtMe })),
        shapes: S.shapes.length, leaderboard: S.leaderboard, myScore: S.myScore, myLevel: S.myLevel, rank: S.rank,
        bulletProfileSeconds: bullet.valid > 2 ? (bullet.valid - 1) * BUCKET : null, muzzle: Math.round(muzzleDist()),
        measuredLatency: cfg.measured, loopSamples: S.loopSamples, stats: S.stats, dom: S.dom, lastError: S.lastError, errors: errorCount,
      },
      lastFrame: f ? { tanks: f.tanks.length, bullets: f.bullets.length, shapes: f.shapes.length, texts: f.texts.slice(0, 40), bars: f.bars.slice(0, 12), grid: f.grid } : null,
    };
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
      h('div', { class: 'da-row' }, h('div', { class: 'da-l' }, 'Strength', h('small', null, 'one-click levels, e.g. for an aim perk that unlocks in steps')),
        ...[['Off', 'off'], ['Assist', 'assist'], ['Smart', 'smart'], ['Full', 'full']].map(([n, k]) => h('button', { class: 'da-btn', onclick: () => { applyTier(k); toast('Aim strength: ' + n); } }, n))),
      rowToggle('aim', 'Auto aim', 'Move the cursor onto enemy tanks'),
      rowSelect('aimMode', 'Activation', [['always', 'Always'], ['firing', 'While I fire (LMB / Space / E)'], ['hold', 'While holding a key'], ['near', 'Assist: tanks near where I point']]),
      rowKey('Hold key', () => cfg.holdKey, (c) => setCfg('holdKey', c)),
      rowSlider('cone', 'Assist cone', 5, 90, 1, (v) => v + '\u00b0', 'for the assist activation mode'),
      sec('Prediction'),
      rowToggle('predict', 'Lead moving targets', 'Aim where the bullet and the tank will meet'),
      rowToggle('dodge', 'Learn rhythm and dodging', 'experimental: a strafing target is led through its next reversal; a target that dodges my bullets gets "dodge" guesses'),
      rowSlider('latency', 'Latency compensation', 0, 400, 5, (v) => v + 'ms', 'render + input delay; used until measured'),
      rowToggle('autoTune', 'Measure latency from my shots', 'matches each bullet\u2019s direction to where the cursor pointed; needs a moving cursor'),
      h('div', { class: 'da-row' }, h('div', { class: 'da-l' }, 'Measured latency'), h('span', { class: 'da-val', id: 'da-tune', style: 'width:auto' }),
        h('button', { class: 'da-btn', onclick: () => { cfg.measured = 0; loopHist.length = 0; save(); } }, 'reset')),
      rowSlider('persistence', 'Prediction persistence', 0.5, 8, 0.1, (v) => v.toFixed(1) + 's', 'how long straight-line motion is trusted'),
      rowSlider('leadScale', 'Lead strength', 0, 150, 5, (v) => v + '%'),
      rowToggle('inherit', 'Bullets inherit my velocity', 'enable if shots miss when you strafe'),
      sec('Feel'),
      h('div', { class: 'da-row' }, h('div', { class: 'da-l' }, 'Lock-on style', h('small', null, 'Natural is the default: eased swing with a short reaction')),
        ...[['Natural', 130, 70, 40], ['Quick', 70, 30, 20], ['Instant', 0, 0, 0]].map(([n, sm, re, hu]) => h('button', { class: 'da-btn', onclick: () => { cfg.smooth = sm; cfg.reaction = re; cfg.human = hu; save(); refreshAll(); } }, n))),
      rowSlider('smooth', 'Lock-on smoothness', 0, 300, 5, (v) => (v ? v + 'ms' : 'snap'), 'how long a swing onto a target takes to settle'),
      rowSlider('reaction', 'Lock-on delay', 0, 300, 10, (v) => v + 'ms', 'pause between spotting a target and moving'),
      rowSlider('human', 'Human touch', 0, 100, 5, (v) => v + '%', 'late notice of course changes, slight wander, varied reaction'),
      rowSlider('assist', 'Assist strength', 10, 100, 5, (v) => v + '%', '100 = full lock, less = blend with my own mouse'),
      rowSlider('override', 'Take back on flick', 0, 6000, 100, (v) => (v ? v + 'px/s' : 'off'), 'a fast mouse flick hands the barrel back briefly'),
      rowSlider('maxTurn', 'Max turn speed', 0, 3000, 50, (v) => (v ? v + '\u00b0/s' : 'off'), 'optional hard cap on the barrel swing'),
    ];
  }
  function tabTargets() {
    return [
      rowSelect('priority', 'Who to shoot', [['auto', 'Smart (fighting me, strong, hurt, near)'], ['score', 'Highest score'], ['health', 'Lowest health'], ['threat', 'Whoever shoots at me'], ['closest', 'Closest to my tank'], ['cursor', 'Closest to my mouse']],
        'score and health come from the leaderboard, nameplates and health bars; a size estimate fills the gaps'),
      rowSlider('ignoreSmall', 'Ignore small fry', 0, 90, 5, (v) => (v ? '<' + v + '%' : 'off'), 'skip tanks much weaker than the best one (unless they shoot me)'),
      rowText('ignoreNames', 'Never target', 'names, comma separated', 120),
      rowSlider('range', 'Max range', 10, 100, 1, (v) => v + '%', 'of the half screen diagonal'),
      rowSlider('stickiness', 'Target stickiness', 0, 100, 5, (v) => v + '%', 'higher = switches targets less'),
      sec('Pin'),
      rowKey('Pin / unpin current target', () => cfg.keys.lock, (c) => { cfg.keys.lock = c; save(); refreshAll(); }),
      rowKey('Next target', () => cfg.keys.cycle, (c) => { cfg.keys.cycle = c; save(); refreshAll(); }),
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
      rowToggle('labels', 'Name / score / health labels'),
      rowToggle('hud', 'Status display'),
      rowToggle('card', 'Target details in the status display'),
      rowToggle('clean', 'Clean view', 'hides every overlay and this menu (press the clean-view key to bring them back)', () => applyClean()),
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
      ...[['menu', 'Show / hide menu'], ['master', 'Master switch'], ['aim', 'Auto aim'], ['fire', 'Auto fire'], ['esp', 'ESP'], ['farm', 'Farm shapes'], ['predict', 'Prediction'], ['clean', 'Clean view']]
        .map(([a, l]) => rowKey(l, () => cfg.keys[a], (c) => { cfg.keys[a] = c; save(); refreshAll(); })),
      note('Click a key, then press the new one. Backspace clears, Esc cancels.'),
      sec('Settings'),
      h('div', { class: 'da-row' },
        h('button', { class: 'da-btn', onclick: () => { try { navigator.clipboard.writeText(exportSettings()); toast('Settings copied'); } catch { console.log(exportSettings()); toast('Settings logged to the console'); } } }, 'Copy settings'),
        h('button', { class: 'da-btn', onclick: () => { const t = prompt('Paste settings JSON'); if (t) toast(importSettings(t) ? 'Settings imported' : 'That is not valid settings JSON'); } }, 'Paste settings')),
      ...[1, 2, 3].map((n) => h('div', { class: 'da-row' }, h('div', { class: 'da-l' }, 'Profile ' + n),
        h('button', { class: 'da-btn', onclick: () => toast(saveProfile(n) ? 'Saved to profile ' + n : 'Could not save') }, 'Save'),
        h('button', { class: 'da-btn', onclick: () => toast(loadProfile(n) ? 'Loaded profile ' + n : 'Profile ' + n + ' is empty') }, 'Load'))),
      sec('Session'),
      h('div', { class: 'da-row' }, h('div', { class: 'da-l', id: 'da-why', style: 'opacity:.8' }, '')),
      h('div', { class: 'da-row' }, h('div', { class: 'da-l', id: 'da-stats' }, ''), h('button', { class: 'da-btn', onclick: () => { S.stats.shots = 0; S.stats.hits = 0; } }, 'reset')),
      h('div', { class: 'da-row' }, h('button', { class: 'da-btn', onclick: () => { try { navigator.clipboard.writeText(JSON.stringify(report(), null, 1)); toast('Diagnostics copied'); } catch { console.log(report()); toast('Diagnostics logged to the console'); } } }, 'Copy diagnostics'),
        h('span', { class: 'da-note', style: 'margin:0' }, 'paste it back when something does not line up')),
      sec('Calibration'),
      h('div', { class: 'da-row' }, h('button', { class: 'da-btn', onclick: () => {
        toast('Recording 2 frames...');
        if (!recordFrames(2, (d) => { downloadJSON('diep-frames-' + Date.now() + '.json', d); toast(d.calls.length ? `Saved ${d.calls.length} draw calls (${d.ended})` : 'No frame was drawn - is the game canvas running?'); })) toast('Already recording');
      } }, 'Record 2 frames to a file'),
        h('span', { class: 'da-note', style: 'margin:0' }, 'do it with a tank on screen and send the file back')),
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

  const TABS = { Aim: tabAim, Targets: tabTargets, Fire: tabFire, Visuals: tabVisuals, Build: tabBuild, Misc: tabMisc };
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
    applyClean();
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

  function applyClean() {
    if (panel) panel.style.display = cfg.ui.open && !cfg.clean ? '' : 'none';
    if (S.overlay) S.overlay.style.display = cfg.clean ? 'none' : '';
    if (cfg.clean) S.panelHover = false;
  }
  function togglePanel() {
    cfg.ui.open = !cfg.ui.open; save();
    applyClean();
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
  // A plain-language answer to "why is nothing happening?"
  function why() {
    if (!cfg.enabled) return 'switched off';
    if (!S.canvas) return 'no game canvas found yet';
    const f = S.ready;
    if (!f) return 'waiting for the first frame';
    if (nowMs() - f.t > 1500) return 'the game is not redrawing';
    if (S.dom.menu) return 'in the menu';
    if (S.dom.dead) return 'dead';
    if (!S.self && !S.playing) {
      const d = f.diag;
      if (d && d.circles + d.polys === 0) return 'nothing drawn yet';
      return `cannot find my tank at the screen centre (${f.tanks.length} tanks, ${f.bullets.length} round, ${f.drones.length} drones, ${f.shapes.length} shapes seen) - Misc > Record 2 frames`;
    }
    if (!S.playing) return 'not in game';
    if (!S.sol) return S.tanks.some((t) => t.seen) ? 'enemies are out of range or filtered out' : 'no enemy on screen';
    return 'locked on ' + (S.sol.tk.name || '#' + S.sol.tk.id);
  }
  function refreshPanelStatus() {
    if (!panel || !cfg.ui.open) return;
    const txt = !cfg.enabled ? 'off' : S.playing ? (S.sol ? 'target #' + S.sol.tk.id : 'no target') : 'not in game';
    if (txt !== lastStatus) { lastStatus = txt; statusEl.textContent = txt; dotEl.classList.toggle('on', cfg.enabled && S.playing); }
    const wy = document.getElementById('da-why');
    if (wy) { const w = why(); if (wy.textContent !== w) wy.textContent = w; }
    const st = document.getElementById('da-stats');
    if (st) st.textContent = `shots ${S.stats.shots}  hits ${S.stats.hits}  (${S.stats.shots ? Math.round((100 * S.stats.hits) / S.stats.shots) : 0}%)`;
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
    lock: () => { // pin the current target until it is gone (or press again)
      if (S.pinId) { S.pinId = 0; toast('Target unpinned'); return; }
      const tk = S.target;
      if (tk && tk.kind === 'tank') { S.pinId = tk.id; S.pinT = nowMs(); toast('Pinned ' + (tk.name || 'target')); } else toast('No target to pin');
    },
    cycle: () => { // pin the next tank in the ranking
      const r = S.rank;
      if (r.length < 2) { toast('No other target'); return; }
      const i = r.findIndex((x) => S.target && x.id === S.target.id), nx = r[(i + 1) % r.length];
      S.pinId = nx.id; S.pinT = nowMs(); toast('Target: ' + (nx.name || '#' + nx.id));
    },
    clean: () => { cfg.clean = !cfg.clean; save(); applyClean(); refreshAll(); },
  };

  function inUiZone(x, y) {
    const W = innerWidth, H = innerHeight;
    return x < W * 0.2 && (y < H * 0.4 || y > H * 0.62);
  }

  window.addEventListener('mousemove', (e) => {
    if (!e.isTrusted) return;
    S.mouse.x = e.clientX; S.mouse.y = e.clientY;
    {
      const tm = nowMs(), dtm = (tm - S.mouseLastT) / 1000;
      if (S.mouseLastT && dtm > 0.0005 && dtm < 0.1) S.mouseSpeed += (hyp(e.clientX - S.mouseLastX, e.clientY - S.mouseLastY) / dtm - S.mouseSpeed) * (1 - Math.exp(-dtm / 0.05));
      S.mouseLastT = tm; S.mouseLastX = e.clientX; S.mouseLastY = e.clientY;
    }
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
    version: VERSION, cfg, S, cam, ctl, bullet, F, applyBuild, scheduleBuild,
    rank: () => S.rank, report, recordFrames, tier: applyTier, why, exportSettings, importSettings, saveProfile, loadProfile,
    get: (key) => cfg[key],
    set: (key, value) => { if (key in cfg && key !== 'keys' && key !== 'ui') setCfg(key, value); }, // e.g. diepAssist.set('aim', true)
  };
})();
