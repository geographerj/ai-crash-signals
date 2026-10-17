/* Status logic. Mirrors fetch/compute_status.py; thresholds live in fetch/rules.json.
   Exposes window.SignalStatus.compute(rules, fred, manual, todayISO) -> {level, level_name, reason, indicators}. */
(function () {
  "use strict";
  var OPS = {
    "==": function (a, b) { return a === b; },
    ">=": function (a, b) { return a >= b; },
    "<=": function (a, b) { return a <= b; },
    ">": function (a, b) { return a > b; },
    "<": function (a, b) { return a < b; }
  };
  var FRED = "https://fred.stlouisfed.org/series/";

  function condTrue(c, numeric) {
    var v = numeric[c.field];
    if (v === null || v === undefined) return false;
    return OPS[c.op](v, c.value);
  }
  function anyGroup(groups, numeric) {
    return groups.some(function (g) { return g.every(function (c) { return condTrue(c, numeric); }); });
  }
  function manualStatus(rule, numeric) {
    if (anyGroup(rule.tripped, numeric)) return "tripped";
    if (anyGroup(rule.watch, numeric)) return "watch";
    return "clear";
  }
  function daysBetween(a, b) {
    return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
  }
  function fmt(n, d) { return Number(n).toLocaleString("en-US", { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
  function sgn(n, d) { return (n >= 0 ? "+" : "-") + Math.abs(n).toFixed(d); }

  function macroIndicators(rules, fred) {
    var m = rules.macro, d = fred.derived, out = [];
    function add(id, status, text, asOf, url) {
      out.push({ id: id, group: "macro", name: m[id].name, status: status, value_text: text,
        trigger_text: m[id].trigger_text, as_of: asOf, source_url: url, stale: false });
    }
    var sp = d.sp500, st;
    st = sp.last_month_end_below ? "tripped" : (sp.provisional_below ? "watch" : "clear");
    add("sp500_trend", st,
      "Close " + fmt(sp.latest_close) + " vs provisional 10-month average " + fmt(sp.provisional_sma) +
      (sp.provisional ? " (provisional until month-end)" : "") + "; last month-end avg " + fmt(sp.last_month_end_sma),
      sp.latest_date, FRED + "SP500");

    var y = d.yield_curve, r = m.yield_curve;
    st = y.neg_run >= r.tripped_consecutive_days ? "tripped" : ((y.latest >= 0 && y.latest <= r.watch_max) ? "watch" : "clear");
    add("yield_curve", st, "10y-3m " + sgn(y.latest, 2) + " pts; 10y-2y " + sgn(y.t10y2y, 2), y.date, FRED + "T10Y3M");

    var b = d.baa; r = m.baa_spread;
    st = (b.latest >= r.tripped_level || b.rise_bp >= r.tripped_rise_bp) ? "tripped" : (b.rise_bp >= r.watch_rise_bp ? "watch" : "clear");
    add("baa_spread", st, b.latest.toFixed(2) + " pts; " + sgn(b.rise_bp, 0) + " bp from 12-month low (" + b.low_12m.toFixed(2) + ")", b.date, FRED + "BAA10Y");

    var h = d.hy; r = m.hy_oas;
    st = (h.latest >= r.tripped_level || h.change_3m_bp >= r.tripped_rise_bp) ? "tripped" : (h.change_3m_bp >= r.watch_rise_bp ? "watch" : "clear");
    add("hy_oas", st, h.latest.toFixed(2) + " pts; " + sgn(h.change_3m_bp, 0) + " bp over 3 months", h.date, FRED + "BAMLH0A0HYM2");

    var c = d.claims; r = m.claims;
    st = c.pct_above_low >= r.tripped_pct ? "tripped" : (c.pct_above_low >= r.watch_pct ? "watch" : "clear");
    add("claims", st, "4-week avg " + fmt(c.latest_avg4) + "; " + sgn(c.pct_above_low, 1) + "% vs 52-week low (" + fmt(c.low_52w) + ")", c.date, FRED + "ICSA");

    var s = d.sahm; r = m.sahm;
    st = s.latest >= r.tripped_value ? "tripped" : (s.latest >= r.watch_value ? "watch" : "clear");
    add("sahm", st, s.latest.toFixed(2) + " (unemployment " + d.unrate.latest.toFixed(1) + "%)", s.date, FRED + "SAHMREALTIME");

    var f = d.fed, mv = f.last_move_60d;
    var mt = mv ? "last move a " + mv.direction + " on " + mv.date : "no move in the last 60 days";
    add("fed_path", "context",
      "Target range " + f.target_low.toFixed(2) + "-" + f.target_high.toFixed(2) + "%" + (f.estimated ? " (estimated)" : "") +
      "; effective " + f.effective.toFixed(2) + "%; " + mt, f.date, FRED + "DFF");
    return out;
  }

  function manualIndicators(rules, manual, today) {
    var all = Object.assign({}, rules.ai, rules.other_manual);
    return manual.indicators.map(function (ind) {
      var rule = all[ind.id];
      return { id: ind.id, group: ind.group, name: ind.name, status: manualStatus(rule, ind.numeric),
        value_text: ind.value, trigger_text: rule.trigger_text, as_of: ind.as_of, source_url: ind.source_url,
        stale: daysBetween(ind.as_of, today) > rules.stale_days };
    });
  }

  function phrase(rules, ind) {
    var rule = Object.assign({}, rules.macro, rules.ai, rules.other_manual)[ind.id];
    return ind.status === "tripped" ? rule.tripped_phrase : rule.watch_phrase;
  }

  function overall(rules, inds, fred, manual) {
    var by = {};
    inds.forEach(function (i) { by[i.id] = i; });
    var ai = rules.ai_ids;
    var aiTripped = ai.filter(function (i) { return by[i].status === "tripped"; }).length;
    var aiAny = ai.some(function (i) { return by[i].status === "tripped" || by[i].status === "watch"; });
    var confirming = by.sp500_trend.status === "tripped" || by.baa_spread.status === "tripped" || by.hy_oas.status === "tripped";
    var level2 = aiTripped >= 2 && confirming;
    var me = fred.derived.sp500.month_ends, n = me.length;
    var twoMonths = n >= 2 && me[n - 1][1] < me[n - 1][2] && me[n - 2][1] < me[n - 2][2];
    var credit = manual.indicators.filter(function (i) { return i.id === "ai_credit"; })[0];
    var junk = !!(credit && credit.numeric.oracle_junk);
    var hyLevel = fred.derived.hy.latest >= rules.macro.hy_oas.tripped_level;
    var level3 = level2 && twoMonths && (junk || by.ai_lab_funding.status === "tripped" || hyLevel);
    var watchAny = aiAny || by.yield_curve.status === "tripped" ||
      by.baa_spread.status === "tripped" || by.baa_spread.status === "watch";
    return level3 ? 3 : (level2 ? 2 : (watchAny ? 1 : 0));
  }

  function reason(rules, level, inds) {
    var name = rules.levels[String(level)].name;
    var flagged = function (i) { return i.status === "tripped" || i.status === "watch"; };
    var ai = inds.filter(function (i) { return rules.ai_ids.indexOf(i.id) >= 0 && flagged(i); }).map(function (i) { return phrase(rules, i); });
    var mac = inds.filter(function (i) { return i.group === "macro" && i.id !== "fed_path" && flagged(i); }).map(function (i) { return phrase(rules, i); });
    if (level === 0 && !ai.length && !mac.length) return "Normal: no AI or macro indicator is tripped or on watch.";
    var parts = [], tail;
    if (ai.length) parts.push(ai.length <= 2 ? ai.join(" and ") : ai.slice(0, -1).join(", ") + " and " + ai[ai.length - 1]);
    if (mac.length) { parts.push("macro flags: " + mac.join(", ")); tail = "."; } else { tail = "; all macro indicators clear."; }
    var body = parts.length ? parts.join("; ") : "no AI indicators flagged";
    return name + ": " + body + tail;
  }

  function compute(rules, fred, manual, today) {
    var inds = macroIndicators(rules, fred).concat(manualIndicators(rules, manual, today));
    var level = overall(rules, inds, fred, manual);
    return { level: level, level_name: rules.levels[String(level)].name, reason: reason(rules, level, inds), indicators: inds };
  }

  window.SignalStatus = { compute: compute };
})();
