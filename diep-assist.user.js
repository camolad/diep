// ==UserScript==
// @name         Diep Assist (private server testing)
// @namespace    https://github.com/camolad/diep
// @version      1.0.0
// @description  Auto aim, auto fire, ESP overlay, auto stat upgrade and other helpers for a private diep.io-style server you run yourself.
// @match        http://localhost/*
// @match        http://localhost:*/*
// @match        http://127.0.0.1/*
// @match        http://127.0.0.1:*/*
// @match        https://YOUR-PRIVATE-SERVER.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * SETUP: edit the @match lines above so they only cover your own private server.
 * It is intentionally NOT matched against the public diep.io.
 *
 * HOTKEYS (ignored while typing in a text field)
 *   \   toggle auto aim            [   toggle auto fire
 *   ]   toggle ESP overlay         ;   toggle auto stat upgrade
 *   '   toggle prediction (lead)   Insert  show / hide the panel
 *
 * HOW IT WORKS
 *   diep draws everything on a <canvas>, so there is no DOM to query. The script
 *   wraps the 2D context's beginPath/arc/fill calls, collects the filled circles
 *   drawn each frame (tank bodies, bullets, drones), and classifies them by fill
 *   colour and size. The player's own tank is the big circle at screen centre.
 *   Enemy = a team-coloured circle that is not our colour and is big enough to be
 *   a tank (not a bullet). Aiming is done by dispatching synthetic mousemove
 *   events at the chosen target.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- settings
  const STORE_KEY = 'diepAssist.v1';
  const DEFAULTS = {
    aim: true,
    autoFire: false,
    esp: true,
    predict: true,
    autoUpgrade: false,
    autoSpin: false,     // spin the cursor in a circle when no target (looks like "idle spin")
    lockMouse: true,     // swallow your real mouse movement while a target is locked
    targetMode: 'center',// 'center' = closest to your tank, 'cursor' = closest to mouse
    fov: 900,            // max target distance in screen px (0 = unlimited)
    minRadiusRatio: 0.55,// enemy circle must be >= this * own tank radius (filters bullets/drones)
    leadFrames: 6,       // prediction strength, in frames of relative velocity
    smoothing: 0,        // 0 = snap, 0.5 = smoother, closer to 1 = very slow
    upgradeBuild: '5555566666777778888', // stat keys 1-8 pressed in order, repeated
    showPanel: true,
  };

  let cfg = { ...DEFAULTS };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); } catch (_) {}
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (_) {} };

  // Known diep team / tank body colours (lowercase #rrggbb).
  const TEAM_COLORS = new Set(['#00b2e1', '#f14e54', '#bf7ff5', '#00e16e']);

  // -------------------------------------------------------- canvas hooks
  let frame = [];       // circles collected during the frame currently being drawn
  let lastFrame = [];   // completed previous frame
  let pathArcs = [];

  const P = CanvasRenderingContext2D.prototype;
  const _beginPath = P.beginPath, _arc = P.arc, _fill = P.fill;

  function toHex(c) {
    if (typeof c !== 'string') return '';
    if (c[0] === '#') return c.length === 4
      ? '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]
      : c.toLowerCase();
    const m = c.match(/\d+/g);
    if (!m || m.length < 3) return '';
    return '#' + m.slice(0, 3).map(n => (+n).toString(16).padStart(2, '0')).join('');
  }

  P.beginPath = function () {
    pathArcs.length = 0;
    return _beginPath.apply(this, arguments);
  };

  P.arc = function (x, y, r, a0, a1) {
    // Only full circles matter.
    if (Math.abs(a1 - a0) > 6) {
      const cv = this.canvas;
      if (cv && cv.width > 300) { // ignore tiny helper canvases
        const m = this.getTransform();
        const k = cv.clientWidth ? cv.clientWidth / cv.width : 1;
        pathArcs.push({
          x: (m.a * x + m.c * y + m.e) * k,
          y: (m.b * x + m.d * y + m.f) * k,
          r: r * Math.hypot(m.a, m.b) * k,
          cv,
        });
      }
    }
    return _arc.apply(this, arguments);
  };

  P.fill = function () {
    if (pathArcs.length) {
      const color = toHex(this.fillStyle);
      if (color) for (const a of pathArcs) { a.color = color; frame.push(a); }
      pathArcs = [];
    }
    return _fill.apply(this, arguments);
  };

  // Frame boundary: when the page's next animation frame begins, the previous
  // frame's drawing is complete.
  let lastRafTs = -1;
  const _raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    return _raf(function (ts) {
      if (ts !== lastRafTs) { lastRafTs = ts; endFrame(); }
      return cb(ts);
    });
  };

  // -------------------------------------------------------------- state
  const state = {
    center: { x: 0, y: 0 },
    own: null,        // {x,y,r,color}
    enemies: [],      // [{x,y,r,vx,vy,color}]
    target: null,
    aimPoint: null,
    mouse: { x: 0, y: 0 },
    spin: 0,
    firing: false,
  };
  let prevEnemies = [];

  function mainCanvas() {
    let best = null;
    for (const c of document.getElementsByTagName('canvas')) {
      if (c === overlay) continue;
      if (!best || c.width * c.height > best.width * best.height) best = c;
    }
    return best;
  }

  function endFrame() {
    lastFrame = frame; frame = []; pathArcs = [];
    analyse();
    act();
    drawOverlay();
  }

  function analyse() {
    const cv = mainCanvas();
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    state.center.x = cv.clientWidth / 2;
    state.center.y = cv.clientHeight / 2;
    state.rect = rect;
    state.cv = cv;

    // Own tank: biggest team-coloured circle nearest the screen centre.
    let own = null, ownD = Infinity;
    for (const c of lastFrame) {
      if (c.cv !== cv || !TEAM_COLORS.has(c.color)) continue;
      const d = Math.hypot(c.x - state.center.x, c.y - state.center.y);
      if (d < 40 * (cv.clientWidth / 1000 + 0.5) && (d < ownD - 1 || (Math.abs(d - ownD) <= 1 && c.r > own.r))) {
        own = c; ownD = d;
      }
    }
    state.own = own;

    const ownR = own ? own.r : 20;
    const minR = ownR * cfg.minRadiusRatio;
    const found = [];
    for (const c of lastFrame) {
      if (c === own || c.cv !== cv) continue;
      if (!TEAM_COLORS.has(c.color)) continue;
      if (own && c.color === own.color) continue;           // teammate / own bullets
      if (c.r < minR) continue;                             // bullet / drone
      if (Math.hypot(c.x - state.center.x, c.y - state.center.y) < ownR * 0.8) continue;
      // de-duplicate outline/inner circles of the same tank
      if (found.some(f => Math.hypot(f.x - c.x, f.y - c.y) < Math.max(f.r, c.r) * 0.5)) continue;
      found.push({ x: c.x, y: c.y, r: c.r, color: c.color, vx: 0, vy: 0 });
    }

    // Velocity estimate: match to nearest enemy in the previous frame.
    for (const e of found) {
      let best = null, bd = 80;
      for (const p of prevEnemies) {
        const d = Math.hypot(p.x - e.x, p.y - e.y);
        if (d < bd) { bd = d; best = p; }
      }
      if (best) { e.vx = e.x - best.x; e.vy = e.y - best.y; }
    }
    prevEnemies = found;
    state.enemies = found;
  }

  // ---------------------------------------------------------- targeting
  function pickTarget() {
    const ref = cfg.targetMode === 'cursor' ? state.mouse : state.center;
    let best = null, bd = Infinity;
    for (const e of state.enemies) {
      const dc = Math.hypot(e.x - state.center.x, e.y - state.center.y);
      if (cfg.fov && dc > cfg.fov) continue;
      const d = Math.hypot(e.x - ref.x, e.y - ref.y);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  // ------------------------------------------------------------ input
  function mouseTarget() { return state.cv || document.body; }

  function sendMouse(type, x, y, buttons) {
    const cv = mouseTarget();
    const r = state.rect || cv.getBoundingClientRect();
    const ev = new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: r.left + x, clientY: r.top + y,
      screenX: r.left + x, screenY: r.top + y,
      button: 0, buttons: buttons || 0,
    });
    cv.dispatchEvent(ev);
  }

  function sendKey(type, key, code, keyCode) {
    const ev = new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'keyCode', { get: () => keyCode });
    Object.defineProperty(ev, 'which', { get: () => keyCode });
    (document.activeElement && document.activeElement !== document.body
      ? document.activeElement : window).dispatchEvent(ev);
  }

  function pressStat(n) {
    const key = String(n);
    sendKey('keydown', key, 'Digit' + key, 48 + n);
    setTimeout(() => sendKey('keyup', key, 'Digit' + key, 48 + n), 30);
  }

  // Track the real mouse, and optionally swallow it while locked on a target.
  window.addEventListener('mousemove', e => {
    if (!e.isTrusted) return;
    const r = state.rect;
    if (r) { state.mouse.x = e.clientX - r.left; state.mouse.y = e.clientY - r.top; }
    if (cfg.aim && cfg.lockMouse && state.aimPoint) e.stopImmediatePropagation();
  }, true);

  // ------------------------------------------------------------- actions
  let sx = null, sy = null, upgradeIdx = 0, lastUpgrade = 0;

  function act() {
    const now = performance.now();
    state.target = cfg.aim ? pickTarget() : null;

    // Aim point (with optional lead + smoothing)
    let ap = null;
    if (state.target) {
      const t = state.target;
      const lead = cfg.predict ? cfg.leadFrames : 0;
      ap = { x: t.x + t.vx * lead, y: t.y + t.vy * lead };
    } else if (cfg.aim && cfg.autoSpin && state.cv) {
      state.spin += 0.12;
      const R = Math.min(state.cv.clientWidth, state.cv.clientHeight) * 0.3;
      ap = { x: state.center.x + Math.cos(state.spin) * R, y: state.center.y + Math.sin(state.spin) * R };
    }

    if (ap) {
      if (cfg.smoothing > 0 && sx !== null) {
        ap = { x: sx + (ap.x - sx) * (1 - cfg.smoothing), y: sy + (ap.y - sy) * (1 - cfg.smoothing) };
      }
      sx = ap.x; sy = ap.y;
      state.aimPoint = ap;
      sendMouse('mousemove', ap.x, ap.y, state.firing ? 1 : 0);
    } else {
      state.aimPoint = null; sx = sy = null;
    }

    // Auto fire while a real target exists
    const shouldFire = cfg.autoFire && !!state.target;
    if (shouldFire && !state.firing) { state.firing = true; sendMouse('mousedown', state.aimPoint.x, state.aimPoint.y, 1); }
    else if (!shouldFire && state.firing) { state.firing = false; sendMouse('mouseup', state.mouse.x, state.mouse.y, 0); }

    // Auto stat upgrade
    if (cfg.autoUpgrade && cfg.upgradeBuild && now - lastUpgrade > 400) {
      lastUpgrade = now;
      const n = +cfg.upgradeBuild[upgradeIdx++ % cfg.upgradeBuild.length];
      if (n >= 1 && n <= 8) pressStat(n);
    }
  }

  // ---------------------------------------------------------- overlay (ESP)
  let overlay = null, octx = null;
  function ensureOverlay() {
    if (overlay || !document.body) return;
    overlay = document.createElement('canvas');
    overlay.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483000;';
    document.body.appendChild(overlay);
    octx = overlay.getContext('2d');
  }

  function drawOverlay() {
    ensureOverlay();
    if (!overlay) return;
    const dpr = window.devicePixelRatio || 1;
    const w = innerWidth, h = innerHeight;
    if (overlay.width !== w * dpr || overlay.height !== h * dpr) { overlay.width = w * dpr; overlay.height = h * dpr; }
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, w, h);
    const r = state.rect;
    if (!cfg.esp || !r) return;
    const ox = r.left, oy = r.top;
    const cx = ox + state.center.x, cy = oy + state.center.y;

    octx.lineWidth = 1.5;
    for (const e of state.enemies) {
      const isT = e === state.target;
      octx.strokeStyle = isT ? '#ffe000' : 'rgba(255,60,60,0.85)';
      octx.beginPath(); octx.arc(ox + e.x, oy + e.y, e.r + 6, 0, Math.PI * 2); octx.stroke();
      octx.beginPath(); octx.moveTo(cx, cy); octx.lineTo(ox + e.x, oy + e.y); octx.stroke();
      if (isT && state.aimPoint) {
        octx.fillStyle = '#ffe000';
        octx.beginPath(); octx.arc(ox + state.aimPoint.x, oy + state.aimPoint.y, 4, 0, Math.PI * 2); octx.fill();
      }
    }
    if (cfg.fov) {
      octx.strokeStyle = 'rgba(255,255,255,0.15)';
      octx.beginPath(); octx.arc(cx, cy, cfg.fov, 0, Math.PI * 2); octx.stroke();
    }
    octx.fillStyle = 'rgba(255,255,255,0.9)';
    octx.font = '12px monospace';
    octx.fillText(`enemies: ${state.enemies.length}`, ox + 10, oy + h - 10);
    updatePanelStatus();
  }

  // -------------------------------------------------------------- panel
  let panel = null, statusEl = null;
  const TOGGLES = [
    ['aim', 'Auto aim', '\\'],
    ['autoFire', 'Auto fire', '['],
    ['esp', 'ESP overlay', ']'],
    ['autoUpgrade', 'Auto stat upgrade', ';'],
    ['predict', 'Lead prediction', "'"],
    ['autoSpin', 'Spin when idle', ''],
    ['lockMouse', 'Lock real mouse on target', ''],
  ];
  const checks = {};

  function buildPanel() {
    if (panel || !document.body) return;
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483001;background:rgba(20,20,24,.88);' +
      'color:#eee;font:12px/1.5 monospace;padding:8px 10px;border-radius:6px;min-width:210px;user-select:none;';
    let html = '<b>Diep Assist</b> <span style="opacity:.6">(Insert: hide)</span><br>';
    for (const [k, label, key] of TOGGLES) {
      html += `<label style="display:block;cursor:pointer"><input type="checkbox" data-k="${k}"> ${label}` +
        (key ? ` <span style="opacity:.5">[${key}]</span>` : '') + '</label>';
    }
    html += '<div style="margin-top:6px">Target: <select data-s="targetMode"><option value="center">closest to me</option><option value="cursor">closest to cursor</option></select></div>';
    html += slider('fov', 'FOV px', 0, 2000, 50);
    html += slider('leadFrames', 'Lead', 0, 20, 1);
    html += slider('smoothing', 'Smooth', 0, 0.95, 0.05);
    html += slider('minRadiusRatio', 'Min size', 0.2, 1.2, 0.05);
    html += '<div style="margin-top:6px">Build: <input data-t="upgradeBuild" style="width:130px;background:#111;color:#eee;border:1px solid #444"></div>';
    html += '<div id="da-status" style="margin-top:6px;opacity:.75"></div>';
    panel.innerHTML = html;
    document.body.appendChild(panel);
    statusEl = panel.querySelector('#da-status');

    panel.querySelectorAll('input[type=checkbox]').forEach(el => {
      checks[el.dataset.k] = el; el.checked = !!cfg[el.dataset.k];
      el.addEventListener('change', () => { cfg[el.dataset.k] = el.checked; save(); });
    });
    panel.querySelectorAll('input[type=range]').forEach(el => {
      el.value = cfg[el.dataset.r];
      el.addEventListener('input', () => { cfg[el.dataset.r] = +el.value; el.nextElementSibling.textContent = el.value; save(); });
    });
    const sel = panel.querySelector('select'); sel.value = cfg.targetMode;
    sel.addEventListener('change', () => { cfg.targetMode = sel.value; save(); });
    const bt = panel.querySelector('[data-t=upgradeBuild]'); bt.value = cfg.upgradeBuild;
    bt.addEventListener('input', () => { cfg.upgradeBuild = bt.value.replace(/[^1-8]/g, ''); upgradeIdx = 0; save(); });
    // Don't let typing in the panel reach the game.
    panel.addEventListener('keydown', e => e.stopPropagation());
    panel.style.display = cfg.showPanel ? '' : 'none';
  }

  function slider(k, label, min, max, step) {
    return `<div>${label}: <input type="range" data-r="${k}" min="${min}" max="${max}" step="${step}" style="width:100px;vertical-align:middle">` +
      `<span>${cfg[k]}</span></div>`;
  }

  function updatePanelStatus() {
    if (!statusEl) return;
    statusEl.textContent = state.own ? `self r=${state.own.r.toFixed(0)} | targets ${state.enemies.length}` : 'self: not detected';
  }

  function toggle(k) {
    cfg[k] = !cfg[k]; save();
    if (checks[k]) checks[k].checked = cfg[k];
  }

  window.addEventListener('keydown', e => {
    if (!e.isTrusted) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const map = { '\\': 'aim', '[': 'autoFire', ']': 'esp', ';': 'autoUpgrade', "'": 'predict' };
    if (map[e.key]) { toggle(map[e.key]); e.preventDefault(); e.stopImmediatePropagation(); }
    else if (e.key === 'Insert' && panel) {
      cfg.showPanel = !cfg.showPanel; save();
      panel.style.display = cfg.showPanel ? '' : 'none';
    }
  }, true);

  const init = () => { buildPanel(); ensureOverlay(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
