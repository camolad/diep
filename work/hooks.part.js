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
    if (g) { f.prims.push({ g, fc: col, sc: null, sw: 0, a: ctx.globalAlpha, cap: '', pid: -1, ver: 0 }); f.calls++; }
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
    const p = { g, fc: col, sc: null, sw: 0, a: ctx.globalAlpha, cap: '', pid: PA.id, ver: PA.ver };
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
    f.diag = d;
    f.prims = []; // the raw primitives are not needed any more
  }
