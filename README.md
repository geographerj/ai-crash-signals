# AI Crash Signals

A static dashboard that tracks public market indicators and computes a four-level signal (0 Normal, 1 Watch, 2 Confirmed, 3 Severe). It is not investment advice.

Macro indicators are pulled from FRED every weekday by a GitHub Action. AI-specific indicators are entered by hand in `data/manual.json` with an as-of date and show a stale badge after 45 days.

## Set up on GitHub

1. Create a public repository on your personal GitHub account and push this folder to it.
2. Settings > Pages > Deploy from branch, `main`, `/(root)`.
3. Register a free FRED key at https://fred.stlouisfed.org/docs/api/api_key.html.
4. Settings > Secrets and variables > Actions > New repository secret. Name it `FRED_API_KEY` and paste the key.
5. Enable Actions, then run the "Update data" workflow manually once (Actions > Update data > Run workflow).

The workflow runs at 13:15 UTC on weekdays (after the 8:30 am ET data releases), refreshes `data/fred.json` and `data/status.json`, and commits them if they changed. It also adds a row to `data/log.json` when the level changes.

## Update the manual indicators

Edit `data/manual.json`. For each indicator change `value` (the text shown), `numeric` (the numbers the rules read), `as_of`, `source_url` and `note`, then commit. The trigger rules for each indicator read the `numeric` fields, so keep the field names. Leave a numeric field as `null` when there is no reading.

## Run locally

Windows:

```
set FRED_API_KEY=your_key_here && python fetch/fetch_fred.py && python fetch/compute_status.py && python -m http.server 8765
```

macOS or Linux:

```
FRED_API_KEY=your_key_here python fetch/fetch_fred.py && python fetch/compute_status.py && python -m http.server 8765
```

Then open http://localhost:8765. Opening `index.html` by double-click also works, because the generated .js twins carry the data. The local server is still the safest way to view it. The fetch script needs Python 3.11+ and `requests`.

## Generated .js twins

`data/fred.js`, `data/status.js`, `data/manual.js`, `data/log.js` and `data/rules.js` are generated copies of the JSON files that assign to `window.__DATA`. They let the page work when `index.html` is opened by double-click (file://), where browsers block fetch() of local JSON. Do not edit them. After editing `data/manual.json` (or `data/log.json` or `fetch/rules.json`), re-run `python fetch/compute_status.py` to refresh them. The GitHub Action does this on every run. The page uses the twins when present and falls back to fetch() only for missing keys.

## Trigger rules

All thresholds and trigger text live in `fetch/rules.json`. `fetch/compute_status.py` and `assets/status.js` both read it and implement the same level logic. The page recomputes the level in the browser and shows a warning if it disagrees with `data/status.json`. If you change the level logic itself (not just thresholds), change both files.

## Notes

- The TSMC monthly revenue page often blocks automated requests. When the fetch returns nothing, `tsmc` is `null` in `fred.json` and the manual entry is used.
- Extra series `DFEDTARL` and `DFEDTARU` supply the Fed target range. If they are unavailable the range is estimated from the effective rate.
- Never commit your FRED key. The script reads it from the `FRED_API_KEY` environment variable only.
