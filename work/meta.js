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
