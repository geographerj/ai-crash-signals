/* Loads data/*.json, renders charts, tables and the check log. No external libraries. */
(function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";
  var V = "?v=" + Date.now();
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var $ = function (id) { return document.getElementById(id); };

  /* Prefer the .js twins (window.__DATA, works from file://); fall back to fetch() for missing keys. */
  function getData(key, path) {
    var D = window.__DATA || {};
    if (D[key] !== undefined) return Promise.resolve(D[key]);
    return fetch(path + V, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(path + " " + r.status);
      return r.json();
    });
  }
  function showError(msg) {
    $("level-name").textContent = "Error";
    $("level-reason").textContent = msg;
  }
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function sv(tag, attrs, text) {
    var n = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function fmtDate(d, monthly) {
    var p = d.split("-");
    return monthly ? MONTHS[+p[1] - 1] + " " + p[0] : MONTHS[+p[1] - 1] + " " + (+p[2]) + ", " + p[0];
  }
  function fmtET(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    var f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
    var parts = {};
    f.formatToParts(d).forEach(function (p) { parts[p.type] = p.value; });
    var t = parts.hour + (parts.minute === "00" ? "" : ":" + parts.minute) + " " + parts.dayPeriod.toLowerCase();
    return parts.month + " " + parts.day + ", " + parts.year + ", " + t + " ET";
  }
  function host(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return "link"; } }
  function varColor(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  /* ---------- chips ---------- */
  var CHIP_TEXT = { clear: "Clear", watch: "Watch", tripped: "Tripped", context: "Context" };
  function chip(status) { return el("span", { "class": "chip " + status }, CHIP_TEXT[status] || status); }

  /* ---------- scales ---------- */
  function niceStep(range, n) {
    var raw = range / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), r = raw / mag;
    var m = r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10;
    return m * mag;
  }
  function niceTicks(lo, hi) {
    var cands = [];
    for (var k = -4; k <= 7; k++) {
      [1, 2, 2.5, 5].forEach(function (m) {
        var step = m * Math.pow(10, k), t = [];
        if ((hi - lo) / step > 12) return;
        for (var v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) t.push(+v.toFixed(6));
        if (t.length >= 4 && t.length <= 5) cands.push({ step: step, t: t });
      });
    }
    if (cands.length) { cands.sort(function (p, q) { return q.step - p.step; }); return cands[0].t; }
    var step2 = niceStep(hi - lo, 4), t2 = [];
    for (var v2 = Math.ceil(lo / step2) * step2; v2 <= hi + 1e-9; v2 += step2) t2.push(+v2.toFixed(6));
    return t2;
  }
  function tsOf(d) { return Date.parse(d + "T00:00:00Z"); }

  /* ---------- line chart ---------- */
  /* cfg: {title, caption, status, color, series:[{name,color,pts:[[date,val]],dash,step,width}], refs:[{y,label,pos}],
            fmt, tipFmt, monthly, areaBelow, gapShade, legend} */
  var W = 340, H = 205, ML = 40, MR = 64, MT = 12, MB = 22;
  var tip = null;

  /* ---------- informational hover cards ---------- */
  var COPY = {}, RULES = {};
  function esc(t) { return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function cap(t) { return t.charAt(0).toUpperCase() + t.slice(1); }
  function pts(n, d) { return Math.abs(n).toFixed(d === undefined ? 2 : d); }
  /* Status in words, built from the live derived values. */
  function statusDetail(ind, fred) {
    var d = fred.derived, m = RULES.macro, st = ind.status, id = ind.id, w = cap(st) + ": ";
    if (id === "sp500_trend") return st === "tripped" ? w + "month-end close is below its 10-month average" : st === "watch" ? w + "latest close is below the provisional 10-month average" : w + "month-end close is above its 10-month average";
    if (id === "yield_curve") return st === "tripped" ? w + "inverted for " + d.yield_curve.neg_run + " straight daily readings" : st === "watch" ? w + "within " + m.yield_curve.watch_max.toFixed(2) + " pts of flat" : w + "upward sloping, " + d.yield_curve.latest.toFixed(2) + " pts";
    if (id === "baa_spread") return st === "clear" ? w + "only " + pts(d.baa.rise_bp, 0) + " bp above its 12-month low" : w + "up " + pts(d.baa.rise_bp, 0) + " bp from its 12-month low, now " + d.baa.latest.toFixed(2);
    if (id === "hy_oas") return st === "clear" ? w + (d.hy.change_3m_bp >= 0 ? "up " : "down ") + pts(d.hy.change_3m_bp, 0) + " bp in 3 months" : w + "up " + pts(d.hy.change_3m_bp, 0) + " bp in 3 months, now " + d.hy.latest.toFixed(2) + "%";
    if (id === "claims") return w + pts(d.claims.pct_above_low, 1) + "% above its 52-week low";
    if (id === "sahm") return w + d.sahm.latest.toFixed(2) + ", trigger at " + m.sahm.tripped_value.toFixed(2);
    if (id === "fed_path") return "Context only: never tripped";
    var rule = Object.assign({}, RULES.ai, RULES.other_manual)[id];
    if (st === "tripped") return w + rule.tripped_phrase;
    if (st === "watch") return w + rule.watch_phrase;
    return w + "no trigger met";
  }
  function cardHTML(o) {
    var c = COPY[o.id] || {};
    var h = '<div class="tip-top">' + o.top + "</div>";
    if (o.trig) h += '<div class="tip-trig">' + esc(o.trig) + "</div>";
    if (c.why) h += '<div class="tip-h">Why it&#39;s here</div><div>' + esc(c.why) + "</div>";
    if (c.record) h += '<div class="tip-h">Record</div><div>' + esc(c.record) + "</div>";
    h += '<div class="tip-st ' + o.status + '">' + esc(o.detail) + "</div>";
    return h;
  }
  /* Show the card near (x, y) and keep it inside boundRight and the viewport (flip left near the right edge). */
  function showCard(html, x, y, boundRight) {
    var t = $("tip");
    t.innerHTML = html;
    t.hidden = false;
    var w = t.offsetWidth, h = t.offsetHeight, right = Math.min(window.innerWidth - 8, boundRight || 1e9);
    var left = x + 16;
    if (left + w > right) left = x - w - 16;
    if (left < 8) left = 8;
    var top = y - 10;
    if (top + h > window.innerHeight - 8) top = window.innerHeight - 8 - h;
    if (top < 8) top = 8;
    t.style.left = left + "px"; t.style.top = top + "px";
  }
  function hideCard() { $("tip").hidden = true; }

  /* ---------- animation scheduler: one shared rAF loop for every chart ---------- */
  var ANIM = { DRAW: 12000, FADE: 800, HOLD: 4000, RESET: 600 };
  var CYCLE = ANIM.DRAW + ANIM.FADE + ANIM.HOLD + ANIM.RESET;
  var ctls = [], rafId = null, lastTs = 0;
  var stats = window.__animStats = { frames: 0, running: false };
  /* Reduced motion: Jay's own Windows machine has "Animation effects" off, which Chrome reports as
     prefers-reduced-motion: reduce, and he wants to see the motion. So the flag only turns off the
     endless loop: we still play ONE slow pass and stop (a click replays it once). Never finalize instantly. */
  function reducedMotion() { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); }
  function anyActive() { return !document.hidden && ctls.some(function (c) { return c.visible && !c.done; }); }
  function tick(now) {
    rafId = null;
    stats.frames++;
    if (!anyActive()) { stats.running = false; lastTs = 0; return; }
    var dt = lastTs ? Math.min(now - lastTs, 100) : 16;
    lastTs = now;
    var loop = !reducedMotion();
    ctls.forEach(function (c) {
      if (!c.visible || c.done) return;
      c.loop = loop;
      c.t += dt;
      var resetAt = ANIM.DRAW + ANIM.FADE + ANIM.HOLD;
      if (loop && !c.phased && c.t >= resetAt) { c.t -= c.phase; c.phased = true; }  // first hold is longer so charts drift out of sync
      if (loop && c.t >= CYCLE) c.t -= CYCLE;
      c.done = c.render(c.t, loop);
    });
    rafId = requestAnimationFrame(tick);
  }
  function kick() {
    if (rafId === null && anyActive()) { lastTs = 0; stats.running = true; rafId = requestAnimationFrame(tick); }
  }
  document.addEventListener("visibilitychange", function () { lastTs = 0; if (!document.hidden) kick(); });

  function buildChart(cfg) {
    var wrap = el("div", { "class": "chart" + (cfg.status === "watch" || cfg.status === "tripped" ? " flag-" + cfg.status : "") });
    var head = el("div", { "class": "chart-head" });
    head.appendChild(el("h3", null, cfg.title));
    head.appendChild(chip(cfg.status));
    wrap.appendChild(head);
    wrap.appendChild(el("p", { "class": "cap" }, cfg.caption));

    var all = [];
    cfg.series.forEach(function (s) { s.pts.forEach(function (p) { all.push(p[1]); }); });
    (cfg.refs || []).forEach(function (r) { all.push(r.y); });
    if (cfg.areaBelow !== undefined) all.push(cfg.areaBelow);
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    var pad = (hi - lo) * 0.1 || 1;
    if (cfg.floorZero && lo >= 0) lo = Math.max(0, lo - pad); else lo -= pad;
    hi += pad;
    var t0 = tsOf(cfg.series[0].pts[0][0]), t1 = tsOf(cfg.series[0].pts[cfg.series[0].pts.length - 1][0]);
    cfg.series.forEach(function (s) {
      t0 = Math.min(t0, tsOf(s.pts[0][0]));
      t1 = Math.max(t1, tsOf(s.pts[s.pts.length - 1][0]));
    });
    var pw = W - ML - MR, ph = H - MT - MB;
    var X = function (d) { return ML + (tsOf(d) - t0) / (t1 - t0) * pw; };
    var Y = function (v) { return MT + (hi - v) / (hi - lo) * ph; };

    var svg = sv("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": cfg.title + ". " + cfg.caption });
    var uid = "c" + Math.random().toString(36).slice(2, 7);

    var shade = sv("g", { opacity: 1 });

    niceTicks(lo, hi).forEach(function (t) {
      var y = Y(t);
      svg.appendChild(sv("line", { x1: ML, x2: ML + pw, y1: y, y2: y, stroke: varColor("--grid"), "stroke-width": 1 }));
      svg.appendChild(sv("text", { x: ML - 6, y: y + 3.5, "text-anchor": "end" }, cfg.axisFmt ? cfg.axisFmt(t) : cfg.fmt(t)));
    });
    var y0 = new Date(t0).getUTCFullYear(), y1 = new Date(t1).getUTCFullYear();
    for (var yr = y0 + 1; yr <= y1; yr++) {
      var tx = ML + (Date.UTC(yr, 0, 1) - t0) / (t1 - t0) * pw;
      if (tx < ML + 14 || tx > ML + pw - 14) continue;
      svg.appendChild(sv("line", { x1: tx, x2: tx, y1: MT + ph, y2: MT + ph + 3, stroke: varColor("--ink-3"), "stroke-width": 1 }));
      svg.appendChild(sv("text", { x: tx, y: H - 6, "text-anchor": "middle" }, String(yr)));
    }
    svg.appendChild(sv("line", { x1: ML, x2: ML + pw, y1: MT + ph, y2: MT + ph, stroke: varColor("--ink-3"), "stroke-width": 1 }));

    function pathOf(pts, step) {
      var d = "";
      pts.forEach(function (p, i) {
        var x = X(p[0]).toFixed(1), y = Y(p[1]).toFixed(1);
        if (i === 0) d += "M" + x + " " + y;
        else if (step) d += "H" + x + "V" + y;
        else d += "L" + x + " " + y;
      });
      return d;
    }
    var s0 = cfg.series[0];
    if (cfg.areaBelow !== undefined) {
      var zy = Y(cfg.areaBelow);
      var area = pathOf(s0.pts, s0.step) + "L" + X(s0.pts[s0.pts.length - 1][0]).toFixed(1) + " " + zy + "L" + X(s0.pts[0][0]).toFixed(1) + " " + zy + "Z";
      var cp = sv("clipPath", { id: uid + "b" });
      cp.appendChild(sv("rect", { x: ML, y: zy, width: pw, height: Math.max(0, MT + ph - zy) }));
      svg.appendChild(cp);
      shade.appendChild(sv("path", { d: area, fill: varColor("--garnet"), "fill-opacity": 0.28, "clip-path": "url(#" + uid + "b)" }));
    }
    if (cfg.gapShade) {
      var a = cfg.series[0].pts, b = cfg.series[1].pts, run = [];
      var flush = function () {
        if (run.length > 1) {
          var d = "M" + run.map(function (p) { return p.x.toFixed(1) + " " + p.c.toFixed(1); }).join("L");
          d += "L" + run.slice().reverse().map(function (p) { return p.x.toFixed(1) + " " + p.s.toFixed(1); }).join("L") + "Z";
          shade.appendChild(sv("path", { d: d, fill: varColor("--garnet"), "fill-opacity": 0.3 }));
        }
        run = [];
      };
      for (var i = 0; i < a.length; i++) {
        var below = a[i][1] < b[i][1];
        if (i > 0) {
          var pb = a[i - 1][1] < b[i - 1][1];
          if (pb !== below) {
            var d0 = a[i - 1][1] - b[i - 1][1], d1 = a[i][1] - b[i][1], f = d0 / (d0 - d1);
            var xc = X(a[i - 1][0]) + f * (X(a[i][0]) - X(a[i - 1][0]));
            var vc = a[i - 1][1] + f * (a[i][1] - a[i - 1][1]);
            run.push({ x: xc, c: Y(vc), s: Y(vc) });
            if (pb) flush();
          }
        }
        if (below) run.push({ x: X(a[i][0]), c: Y(a[i][1]), s: Y(b[i][1]) });
      }
      flush();
    }
    svg.appendChild(shade);
    (cfg.refs || []).forEach(function (r) {
      var y = Y(r.y);
      svg.appendChild(sv("line", { x1: ML, x2: ML + pw, y1: y, y2: y, stroke: varColor("--garnet"), "stroke-width": 1.25, "stroke-dasharray": "4 3" }));
      if (r.label) {
        svg.appendChild(sv("text", { x: ML + 4, y: (r.below ? y + 11 : y - 4) + (r.dy || 0), "class": "reflabel" }, r.label));
      }
    });

    // series: ghost (gray) line first, colored line drawn on top by animation
    var ends = [], anim = [], fades = [];
    var defs = sv("defs");
    svg.appendChild(defs);
    cfg.series.forEach(function (s, si) {
      var dpath = pathOf(s.pts, s.step);
      var lineAttrs = { d: dpath, fill: "none", "stroke-width": s.width || 2.75, "stroke-linejoin": "round", "stroke-linecap": "round" };
      if (s.noFill) {
        lineAttrs.stroke = varColor(s.color);
        lineAttrs["stroke-dasharray"] = s.dash || "";
        svg.appendChild(sv("path", lineAttrs));
      } else {
        var gid = uid + "g" + si, cid = uid + "c" + si;
        var grad = sv("linearGradient", { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
        grad.appendChild(sv("stop", { offset: "0%", "stop-color": varColor(s.color), "stop-opacity": 0.15 }));
        grad.appendChild(sv("stop", { offset: "100%", "stop-color": varColor("--bg"), "stop-opacity": 0 }));
        defs.appendChild(grad);
        var clip = sv("clipPath", { id: cid }), crect = sv("rect", { x: 0, y: 0, width: 0, height: H });
        clip.appendChild(crect);
        defs.appendChild(clip);
        var fillPath = sv("path", { d: dpath + "L" + X(s.pts[s.pts.length - 1][0]).toFixed(1) + " " + (MT + ph) + "L" + X(s.pts[0][0]).toFixed(1) + " " + (MT + ph) + "Z", fill: "url(#" + gid + ")", "clip-path": "url(#" + cid + ")" });
        svg.appendChild(fillPath);
        var ghost = sv("path", Object.assign({ stroke: varColor("--line-ghost") }, lineAttrs));
        var colored = sv("path", Object.assign({ stroke: varColor(s.color), visibility: "hidden" }, lineAttrs));
        svg.appendChild(ghost);
        svg.appendChild(colored);
        anim.push({ s: s, colored: colored, fill: fillPath, crect: crect, len: 0, dot: null });
      }
      var last = s.pts[s.pts.length - 1];
      ends.push({ s: s, x: X(last[0]), y: Y(last[1]), v: last[1] });
    });
    // end dots (they travel along the line) and callouts (hidden until the dot arrives)
    ends.sort(function (p, q) { return p.y - q.y; });
    ends.forEach(function (e, idx) {
      e.ly = idx === 0 ? e.y : Math.max(e.y, ends[idx - 1].ly + 12);
      var dot = sv("circle", { cx: e.x, cy: e.y, r: 5, fill: varColor(e.s.color), stroke: varColor("--bg"), "stroke-width": 1.5 });
      var txt = sv("text", { x: e.x + 10, y: e.ly + 4, "class": "endlabel", opacity: 0 }, cfg.fmt(e.v));
      svg.appendChild(dot);
      svg.appendChild(txt);
      fades.push(txt);
      var mine = anim.filter(function (a) { return a.s === e.s; })[0];
      if (mine) { mine.dot = dot; dot.setAttribute("visibility", "hidden"); } else { dot.setAttribute("opacity", 0); fades.push(dot); }
    });
    fades.push(shade);

    // Timeline per cycle: slow steady draw, callout fade-in, hold, fade back to gray, repeat.
    var T = ANIM;
    function setFade(f) { fades.forEach(function (n) { n.setAttribute("opacity", f); }); }
    function setOpacity(o) {
      anim.forEach(function (a) {
        a.colored.setAttribute("opacity", o); a.fill.setAttribute("opacity", o); a.dot.setAttribute("opacity", o);
      });
    }
    function setProgress(p) {
      anim.forEach(function (a) {
        if (!a.len) a.len = a.colored.getTotalLength();
        a.colored.style.strokeDasharray = a.len + " " + a.len;
        a.colored.style.strokeDashoffset = a.len * (1 - p);
        a.colored.setAttribute("visibility", "visible");
        var pt = a.colored.getPointAtLength(p * a.len);
        a.dot.setAttribute("cx", pt.x); a.dot.setAttribute("cy", pt.y); a.dot.setAttribute("visibility", "visible");
        a.crect.setAttribute("width", Math.max(0, pt.x));
      });
    }
    function showGhost() {
      anim.forEach(function (a) { a.colored.setAttribute("visibility", "hidden"); a.dot.setAttribute("visibility", "hidden"); a.crect.setAttribute("width", 0); });
      setFade(0);
    }
    /* Draws the chart at time t (ms into its cycle). Returns true when a single pass has finished. */
    function render(t, loop) {
      if (t < 0) { showGhost(); return false; }
      if (t < T.DRAW) { setOpacity(1); setProgress(t / T.DRAW); setFade(0); return false; }
      setProgress(1);
      var u = t - T.DRAW;
      if (u < T.FADE) { setOpacity(1); setFade(u / T.FADE); return false; }
      if (!loop) { setOpacity(1); setFade(1); return true; }
      u -= T.FADE;
      if (u < T.HOLD) { setOpacity(1); setFade(1); return false; }
      u -= T.HOLD;
      if (u < T.RESET) { var o = 1 - u / T.RESET; setOpacity(o); setFade(o); return false; }
      showGhost();
      return false;
    }
    showGhost();
    wrap._ctl = { render: render, t: 0, visible: false, done: false, loop: true, phased: false, phase: 0 };
    wrap.addEventListener("click", function () {
      var c = wrap._ctl; c.t = 0; c.done = false; c.phased = true; kick();
    });


    // hover layer
    var cross = sv("line", { y1: MT, y2: MT + ph, stroke: varColor("--ink-3"), "stroke-width": 1, visibility: "hidden" });
    svg.appendChild(cross);
    var dots = cfg.series.map(function (s) {
      var c = sv("circle", { r: 4.5, fill: varColor(s.color), stroke: varColor("--bg"), "stroke-width": 2, visibility: "hidden" });
      svg.appendChild(c);
      return c;
    });
    var hit = sv("rect", { x: ML, y: MT, width: pw, height: ph, fill: "transparent" });
    svg.appendChild(hit);
    function nearest(pts, t) {
      var lo2 = 0, hi2 = pts.length - 1;
      while (hi2 - lo2 > 1) { var mid = (lo2 + hi2) >> 1; if (tsOf(pts[mid][0]) < t) lo2 = mid; else hi2 = mid; }
      return Math.abs(tsOf(pts[lo2][0]) - t) <= Math.abs(tsOf(pts[hi2][0]) - t) ? pts[lo2] : pts[hi2];
    }
    function onMove(ev) {
      var r = svg.getBoundingClientRect();
      var px = (ev.clientX - r.left) / r.width * W;
      var t = t0 + (px - ML) / pw * (t1 - t0);
      var rows = [], xs = null, vals = [];
      cfg.series.forEach(function (s, i) {
        var p = nearest(s.pts, t);
        dots[i].setAttribute("cx", X(p[0])); dots[i].setAttribute("cy", Y(p[1])); dots[i].setAttribute("visibility", "visible");
        xs = X(p[0]);
        vals.push(p[1]);
        rows.push({ c: s.color, n: s.name, v: (cfg.tipFmt || cfg.fmt)(p[1]), d: p[0] });
      });
      cross.setAttribute("x1", xs); cross.setAttribute("x2", xs); cross.setAttribute("visibility", "visible");
      var top = "<b>" + fmtDate(rows[0].d, cfg.monthly) + "</b>";
      rows.forEach(function (rw) { top += "<br><i style='background:" + varColor(rw.c) + "'></i>" + (cfg.series.length > 1 ? rw.n + " " : "") + rw.v; });
      var gr = $("chart-grid").getBoundingClientRect();
      showCard(cardHTML({ id: cfg.id, top: top, trig: cfg.trig ? cfg.trig(vals) : "", status: cfg.status, detail: cfg.detail }), ev.clientX, ev.clientY, gr.right);
    }
    function onLeave() {
      cross.setAttribute("visibility", "hidden");
      dots.forEach(function (d) { d.setAttribute("visibility", "hidden"); });
      hideCard();
    }
    hit.addEventListener("pointermove", onMove);
    hit.addEventListener("pointerleave", onLeave);
    wrap.appendChild(svg);

    if (cfg.legend) {
      var lg = el("div", { "class": "legend" });
      cfg.series.forEach(function (s) {
        var sp = el("span");
        var i = el("i"); i.style.background = varColor(s.color);
        sp.appendChild(i); sp.appendChild(document.createTextNode(s.name));
        lg.appendChild(sp);
      });
      if (cfg.gapShade) { var g = el("span"); var gi = el("i"); gi.style.background = varColor("--garnet"); gi.style.opacity = "0.5"; g.appendChild(gi); g.appendChild(document.createTextNode("Close below average")); lg.appendChild(g); }
      wrap.appendChild(lg);
    }
    return wrap;
  }

  /* ---------- page assembly ---------- */
  function lastMonths(obs, n) {
    var end = obs[obs.length - 1][0].split("-");
    var cut = new Date(Date.UTC(+end[0], +end[1] - 1 - n, +end[2])).toISOString().slice(0, 10);
    return obs.filter(function (p) { return p[0] >= cut; });
  }
  function renderCharts(fred, status) {
    var by = {};
    status.indicators.forEach(function (i) { by[i.id] = i; });
    var s = fred.series, d = fred.derived, grid = $("chart-grid");
    function dtl(id) { return statusDetail(by[id], fred); }
    var charts = [];
    function addChart(g, make) {
      try { var n0 = make(); g.appendChild(n0); charts.push(n0); }
      catch (e) { var n = el("div", { "class": "chart" }); n.appendChild(el("p", { "class": "warn" }, "Chart failed to draw: " + e.message)); g.appendChild(n); }
    }
    var n0 = function (v) { return Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 }); };
    var n2 = function (v) { return Number(v).toFixed(2); };
    var k1 = function (v) { return (v / 1000).toFixed(1) + "k"; };
    var kAxis = function (v) { return (v / 1000).toFixed(0) + "k"; };

    var me = d.sp500.month_ends;
    addChart(grid, function () { return buildChart({
      title: "S&P 500 vs 10-month average", id: "sp500_trend", detail: dtl("sp500_trend"), trig: function (v) { var pc = (v[0] - v[1]) / v[1] * 100; return n0(v[0]) + " is " + pts(pc, 1) + "% " + (pc >= 0 ? "above" : "below") + " its 10-month average (trigger: month-end close below it)"; }, caption: "Month-end close, last " + me.length + " months", status: by.sp500_trend.status,
      series: [
        { name: "Month-end close", color: "--series-sp500", pts: me.map(function (r) { return [r[0], r[1]]; }) },
        { name: "10-month average", color: "--ink-3", width: 2, noFill: true, dash: "5 3", pts: me.map(function (r) { return [r[0], r[2]]; }) }
      ],
      fmt: n0, monthly: true, gapShade: true, legend: true
    }); });
    addChart(grid, function () { return buildChart({
      title: "Yield curve, 10y minus 3m", id: "yield_curve", detail: dtl("yield_curve"), trig: function (v) { return (v[0] >= 0 ? "+" : "-") + pts(v[0]) + " pts, inversion at 0, " + pts(v[0]) + " pts " + (v[0] >= 0 ? "above" : "below") + " it"; }, caption: "Percentage points, daily, 36 months", status: by.yield_curve.status,
      series: [{ name: "10y-3m", color: "--series-yield", pts: lastMonths(s.T10Y3M.obs, 36) }],
      refs: [{ y: 0, label: "Inversion (0)" }], areaBelow: 0, fmt: n2
    }); });
    addChart(grid, function () { return buildChart({
      title: "Baa spread to 10-year Treasury", id: "baa_spread", detail: dtl("baa_spread"), trig: function (v) { var tl = RULES.macro.baa_spread.tripped_level; return n2(v[0]) + " pts, trigger " + tl + ", " + pts(tl - v[0]) + " pts " + (v[0] <= tl ? "below" : "above") + " it"; }, caption: "Percentage points, daily, 36 months", status: by.baa_spread.status,
      series: [{ name: "BAA10Y", color: "--series-baa", pts: lastMonths(s.BAA10Y.obs, 36) }],
      refs: [{ y: 2.13, label: "Trigger 2.13" }], fmt: n2
    }); });
    addChart(grid, function () { return buildChart({
      title: "High-yield spread (OAS)", id: "hy_oas", detail: dtl("hy_oas"), trig: function (v) { var tl = RULES.macro.hy_oas.tripped_level; return n2(v[0]) + "%, trigger " + tl.toFixed(1) + "%, " + pts(tl - v[0]) + " pts " + (v[0] <= tl ? "below" : "above") + " it"; }, caption: "Percentage points, daily, 36 months", status: by.hy_oas.status,
      series: [{ name: "HY OAS", color: "--series-hy", pts: lastMonths(s.BAMLH0A0HYM2.obs, 36) }],
      refs: [{ y: 5.0, label: "Trigger 5.0" }], fmt: n2, floorZero: true
    }); });
    var low = d.claims.low_52w;
    addChart(grid, function () { return buildChart({
      title: "Initial claims, 4-week average", id: "claims", detail: dtl("claims"), trig: function (v) { var pc = (v[0] / low - 1) * 100; return k1(v[0]) + ", " + pts(pc, 1) + "% " + (pc >= 0 ? "above" : "below") + " 52-week low (trigger +" + RULES.macro.claims.tripped_pct + "%)"; }, caption: "Weekly, last " + d.claims.avg4.length + " weeks", status: by.claims.status,
      series: [{ name: "4-week average", color: "--series-claims", pts: d.claims.avg4 }],
      refs: [{ y: low, label: "52-week low", below: true }, { y: low * 1.2, label: "Trigger: +20%", dy: -8 }],
      fmt: k1, axisFmt: kAxis, monthly: false
    }); });
    addChart(grid, function () { return buildChart({
      title: "Sahm rule indicator", id: "sahm", detail: dtl("sahm"), trig: function (v) { var tl = RULES.macro.sahm.tripped_value; return n2(v[0]) + ", trigger " + tl.toFixed(2) + ", " + pts(tl - v[0]) + " " + (v[0] <= tl ? "below" : "above") + " it"; }, caption: "Percentage points, monthly", status: by.sahm.status,
      series: [{ name: "Sahm", color: "--series-sahm", pts: s.SAHMREALTIME.obs }],
      refs: [{ y: 0.5, label: "Trigger 0.50" }], fmt: n2, monthly: true, floorZero: true
    }); });
    addChart(grid, function () { return buildChart({
      title: "Federal funds effective rate", id: "fed_path", detail: dtl("fed_path"), trig: function (v) { return n2(v[0]) + "%, context only, no trigger"; }, caption: "Percent, daily, 36 months", status: "context",
      series: [{ name: "DFF", color: "--series-fed", step: true, pts: lastMonths(s.DFF.obs, 36) }],
      fmt: n2
    }); });
    var f = d.fed, ctx = el("div", { "class": "chart ctx" });
    ctx.appendChild(el("h3", null, "Fed path: regime context"));
    var mv = f.last_move_60d;
    ctx.appendChild(el("p", null, "Target range " + f.target_low.toFixed(2) + " to " + f.target_high.toFixed(2) + "%" + (f.estimated ? " (estimated from the effective rate)" : "") + ". " +
      (mv ? "The last move was a " + mv.direction + " on " + fmtDate(mv.date) + "." : "No move in the last 60 days.") +
      " This is context, not a trigger: every peak since 1987 came during tightening or just after the turn to easing."));
    grid.appendChild(ctx);

    // shared scheduler drives every chart; charts only advance while visible in the viewport
    charts.forEach(function (c, i) {
      var ctl = c._ctl;
      ctl.t = -((i % 3) * 150);   // wave start by column
      ctl.phase = i * 1700;       // per-chart phase so loops do not restart in sync
      ctls.push(ctl);
    });
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { en.target._ctl.visible = en.isIntersecting; });
        kick();
      }, { threshold: 0.25 });
      charts.forEach(function (c) { io.observe(c); });
    } else {
      charts.forEach(function (c) { c._ctl.visible = true; });
      kick();
    }
  }

  function renderTable(tbl, rows, fred) {
    var thead = tbl.querySelector("thead"), tb = tbl.querySelector("tbody");
    var tr = el("tr");
    ["Indicator", "Latest reading", "Trigger", "Status", "As of", "Source"].forEach(function (h) { tr.appendChild(el("th", null, h)); });
    thead.appendChild(tr);
    rows.forEach(function (r) {
      var row = el("tr");
      var nameTd = el("td", { "class": "name" }, r.name);
      nameTd.setAttribute("tabindex", "0");
      var tabletip = function (x, y) {
        showCard(cardHTML({ id: r.id, top: "<b>" + esc(r.name) + "</b><br>" + esc(r.value_text), trig: r.trigger_text, status: r.status, detail: statusDetail(r, fred) }), x, y, 1e9);
      };
      nameTd.addEventListener("mouseenter", function (e) { tabletip(e.clientX, e.clientY); });
      nameTd.addEventListener("mousemove", function (e) { tabletip(e.clientX, e.clientY); });
      nameTd.addEventListener("mouseleave", hideCard);
      nameTd.addEventListener("focus", function () { var b = nameTd.getBoundingClientRect(); tabletip(b.left + 20, b.bottom); });
      nameTd.addEventListener("blur", hideCard);
      row.appendChild(nameTd);
      row.appendChild(el("td", { "class": "val" }, r.value_text));
      row.appendChild(el("td", { "class": "trig" }, r.trigger_text));
      var st = el("td"); st.appendChild(chip(r.status)); row.appendChild(st);
      var as = el("td", { "class": "asof" }, fmtDate(r.as_of));
      if (r.stale) as.appendChild(el("span", { "class": "stale", title: "Older than 45 days" }, "Stale"));
      row.appendChild(as);
      var src = el("td", { "class": "src" });
      var a = el("a", { href: r.source_url, target: "_blank", rel: "noopener" }, host(r.source_url));
      src.appendChild(a); row.appendChild(src);
      tb.appendChild(row);
    });
  }

  function renderLog(log) {
    var tb = $("tbl-log").querySelector("tbody");
    log.forEach(function (e) {
      var row = el("tr");
      row.appendChild(el("td", null, fmtDate(e.date)));
      row.appendChild(el("td", { "class": "name" }, e.level + " " + e.level_name));
      row.appendChild(el("td", null, e.active.length ? e.active.join(", ") : "None"));
      row.appendChild(el("td", { "class": "trig" }, e.note));
      tb.appendChild(row);
    });
  }

  function renderLevels(rules) {
    var ol = $("levels");
    ["0", "1", "2", "3"].forEach(function (k) {
      var li = el("li");
      var sw = el("span", { "class": "sw" }); sw.style.setProperty("--c", varColor("--lvl-" + k));
      sw.appendChild(document.createTextNode(k + " " + rules.levels[k].name));
      li.appendChild(sw);
      li.appendChild(el("p", null, rules.levels[k].meaning));
      ol.appendChild(li);
    });
  }

  function renderHeader(status, fred) {
    $("updated").textContent = fmtET(fred.fetched_at);
    $("updated").setAttribute("datetime", fred.fetched_at);
    $("level").setAttribute("data-level", status.level);
    $("level-num").textContent = status.level;
    $("level-name").textContent = status.level_name;
    $("level-reason").textContent = status.reason;
  }

  function init() {
    tip = $("tip");
    Promise.all([getData("rules", "fetch/rules.json"), getData("fred", "data/fred.json"), getData("manual", "data/manual.json"), getData("status", "data/status.json"), getData("log", "data/log.json"), getData("copy", "fetch/copy.json")])
      .then(function (r) {
        try { RULES = r[0]; COPY = r[5]; render(r[0], r[1], r[2], r[3], r[4]); }
        catch (e) { showError("Page error: " + e.message); if (window.console) console.error(e); }
      }, function (e) {
        showError("Could not load data files (" + e.message + "). Open the page through python -m http.server 8765, or re-run fetch/compute_status.py to regenerate the data/*.js files.");
      });
  }
  function step(fn) { try { fn(); } catch (e) { showError("Page error: " + e.message); if (window.console) console.error(e); } }
  function render(rules, fred, manual, served, log) {
    var today = new Date().toISOString().slice(0, 10);
    var live = window.SignalStatus.compute(rules, fred, manual, today);
    var diffs = [];
    if (live.level !== served.level) diffs.push("level");
    var sm = {};
    served.indicators.forEach(function (i) { sm[i.id] = i.status; });
    live.indicators.forEach(function (i) { if (sm[i.id] !== i.status) diffs.push(i.id); });
    if (diffs.length) {
      var w = $("mismatch");
      w.hidden = false;
      w.textContent = "Warning: the browser calculation differs from data/status.json (" + diffs.join(", ") + "). Showing the browser calculation. Re-run fetch/compute_status.py.";
    }
    if (served.build) $("build").textContent = served.build;
    var ai = live.indicators.filter(function (i) { return i.group !== "macro"; });
    var mac = live.indicators.filter(function (i) { return i.group === "macro"; });
    step(function () { renderHeader(live, fred); });
    step(function () { renderTable($("tbl-ai"), ai, fred); });
    step(function () { renderTable($("tbl-macro"), mac, fred); });
    step(function () { renderLog(log); });
    step(function () { renderLevels(rules); });
    step(function () { renderCharts(fred, live); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
