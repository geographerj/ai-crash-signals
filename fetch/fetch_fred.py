"""Fetch FRED series and derived values, write data/fred.json.

Reads FRED_API_KEY from the environment. Exits nonzero if any required FRED call fails.
"""
import json
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "fred.json"
UA = {"User-Agent": "Mozilla/5.0 (compatible; ai-crash-signals/1.0)"}
SERIES = ["SP500", "T10Y3M", "T10Y2Y", "BAA10Y", "BAMLH0A0HYM2", "ICSA",
          "SAHMREALTIME", "DFF", "UNRATE", "DFEDTARL", "DFEDTARU"]
OPTIONAL = {"DFEDTARL", "DFEDTARU"}  # target range; falls back to an estimate from DFF


def months_ago(d, n):
    y, m = d.year, d.month - n
    while m <= 0:
        m += 12
        y -= 1
    return date(y, m, min(d.day, 28))


def fetch_series(sid, key, start):
    r = requests.get(
        "https://api.stlouisfed.org/fred/series/observations",
        params={"series_id": sid, "api_key": key, "file_type": "json",
                "observation_start": start.isoformat()},
        headers=UA, timeout=30)
    r.raise_for_status()
    obs = []
    for o in r.json()["observations"]:
        if o["value"] in (".", "", None):
            continue
        obs.append([o["date"], float(o["value"])])
    if not obs:
        raise RuntimeError(f"{sid}: no observations")
    return obs


def month_ends(obs):
    last = {}
    for d, v in obs:
        last[d[:7]] = (d, v)
    return [[last[k][0], last[k][1]] for k in sorted(last)]


def month_complete(latest_date):
    d = datetime.strptime(latest_date, "%Y-%m-%d").date()
    nxt = date(d.year + (d.month == 12), d.month % 12 + 1, 1)
    last_day = nxt - timedelta(days=1)
    while last_day.weekday() >= 5:
        last_day -= timedelta(days=1)
    return d >= last_day


def derive(series, today):
    out = {}
    sp = series["SP500"]
    latest_d, latest_v = sp[-1]
    complete = month_complete(latest_d)
    me = month_ends(sp)
    if not complete:
        me = me[:-1]  # current month is not finished
    closes = [v for _, v in me]
    rows = []
    for i, (d, v) in enumerate(me):
        if i >= 9:
            rows.append([d, v, sum(closes[i - 9:i + 1]) / 10])
    rows = rows[-36:]
    # provisional SMA: last 9 completed month-ends plus the latest daily close
    prov_sma = (sum(closes[-9:]) + latest_v) / 10
    out["sp500"] = {
        "month_ends": rows,  # [date, close, sma10]
        "latest_close": latest_v, "latest_date": latest_d,
        "provisional_sma": prov_sma,
        "provisional_below": latest_v < prov_sma,
        "provisional": not complete,
        "last_month_end_below": rows[-1][1] < rows[-1][2],
        "last_month_end_date": rows[-1][0],
        "last_month_end_sma": rows[-1][2],
    }
    t = series["T10Y3M"]
    run = 0
    for _, v in reversed(t):
        if v < 0:
            run += 1
        else:
            break
    out["yield_curve"] = {"latest": t[-1][1], "date": t[-1][0], "neg_run": run,
                          "t10y2y": series["T10Y2Y"][-1][1]}
    b = series["BAA10Y"]
    cut = (today - timedelta(days=365)).isoformat()
    low = min(v for d, v in b if d >= cut)
    out["baa"] = {"latest": b[-1][1], "date": b[-1][0], "low_12m": low,
                  "rise_bp": round((b[-1][1] - low) * 100, 1)}
    h = series["BAMLH0A0HYM2"]
    c3 = months_ago(datetime.strptime(h[-1][0], "%Y-%m-%d").date(), 3).isoformat()
    past = [v for d, v in h if d <= c3]
    base = past[-1] if past else h[0][1]
    out["hy"] = {"latest": h[-1][1], "date": h[-1][0], "value_3m_ago": base,
                 "change_3m_bp": round((h[-1][1] - base) * 100, 1)}
    ic = series["ICSA"]
    avg = [[ic[i][0], sum(x[1] for x in ic[i - 3:i + 1]) / 4] for i in range(3, len(ic))]
    cut = (today - timedelta(days=364)).isoformat()
    low = min(v for d, v in avg if d >= cut)
    out["claims"] = {"avg4": avg[-130:], "latest_avg4": avg[-1][1], "date": avg[-1][0],
                     "low_52w": low, "pct_above_low": round((avg[-1][1] / low - 1) * 100, 1),
                     "latest_weekly": ic[-1][1]}
    s = series["SAHMREALTIME"]
    out["sahm"] = {"latest": s[-1][1], "date": s[-1][0]}
    out["unrate"] = {"latest": series["UNRATE"][-1][1], "date": series["UNRATE"][-1][0]}
    rules = json.loads((ROOT / "fetch" / "rules.json").read_text(encoding="utf-8"))["macro"]["fed_path"]
    f = series["DFF"]
    move = None
    cut = (today - timedelta(days=rules["regime_days"])).isoformat()
    for i in range(len(f) - 1, 0, -1):
        if f[i][0] < cut:
            break
        diff = f[i][1] - f[i - 1][1]
        if abs(diff) > rules["regime_change"]:
            move = {"date": f[i][0], "direction": "hike" if diff > 0 else "cut", "size": round(diff, 2)}
            break
    fed = {"effective": f[-1][1], "date": f[-1][0], "last_move_60d": move}
    if "DFEDTARL" in series and "DFEDTARU" in series:
        fed["target_low"] = series["DFEDTARL"][-1][1]
        fed["target_high"] = series["DFEDTARU"][-1][1]
    else:
        lo = round((f[-1][1] - 0.08) / 0.25) * 0.25
        fed["target_low"], fed["target_high"] = lo, lo + 0.25
        fed["estimated"] = True
    out["fed"] = fed
    return out


def fetch_tsmc():
    """Best effort. Returns a dict or None. The page is often script-rendered, so None is normal."""
    try:
        r = requests.get("https://investor.tsmc.com/english/monthly-revenue", headers=UA, timeout=30)
        r.raise_for_status()
        rows = []
        for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", r.text, flags=re.S | re.I):
            cells = [re.sub(r"<[^>]+>", "", c).strip().replace(",", "")
                     for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, flags=re.S | re.I)]
            if len(cells) >= 3 and re.match(r"^(20\d\d)[-/ ]?\d{1,2}|^[A-Z][a-z]+\.? ?20\d\d", cells[0]):
                nums = [c for c in cells[1:] if re.match(r"^-?\d+(\.\d+)?%?$", c)]
                if len(nums) >= 2:
                    rows.append({"month": cells[0], "cells": cells[1:]})
        if len(rows) < 6:
            print(f"TSMC page parsed but only {len(rows)} table rows found", file=sys.stderr)
            return None
        return {"source": "investor.tsmc.com", "rows": rows[:36]}
    except Exception as e:  # noqa: BLE001
        print(f"TSMC fetch failed: {e}", file=sys.stderr)
        return None


def main():
    key = os.environ.get("FRED_API_KEY")
    if not key:
        print("FRED_API_KEY not set", file=sys.stderr)
        sys.exit(1)
    today = datetime.now(timezone.utc).date()
    start = months_ago(today, 40)
    series = {}
    for sid in SERIES:
        try:
            series[sid] = fetch_series(sid, key, start)
            print(f"ok   {sid}: {len(series[sid])} obs, latest {series[sid][-1]}")
        except Exception as e:  # noqa: BLE001
            msg = str(e).replace(key, "***")
            if sid in OPTIONAL:
                print(f"skip {sid}: {msg}")
                continue
            print(f"FAIL {sid}: {msg}", file=sys.stderr)
            sys.exit(1)
    derived = derive(series, today)
    out_series = {sid: {"obs": obs, "latest": {"date": obs[-1][0], "value": obs[-1][1]}}
                  for sid, obs in series.items()}
    tsmc = fetch_tsmc()
    print("TSMC:", "ok" if tsmc else "null (page falls back to manual entry)")
    doc = {"fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "series": out_series, "derived": derived, "tsmc": tsmc}
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    (OUT.parent / "fred.js").write_text(
        "/* generated by fetch/fetch_fred.py; do not edit */\n"
        "window.__DATA = window.__DATA || {};\n"
        "window.__DATA.fred = " + json.dumps(doc, separators=(",", ":")) + ";\n",
        encoding="utf-8")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
