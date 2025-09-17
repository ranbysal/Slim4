Backtesting CLI
----------------

This simple, self‑contained backtester works offline (no internet) and only uses Python’s standard library (sqlite3, argparse, json, math, statistics, datetime).

Expected SQLite tables (minimal schema):
- events(mint TEXT, ts INTEGER, buyers INTEGER, unique INTEGER, same INTEGER, price_jumps INTEGER, depth REAL, origin TEXT)
- quotes(mint TEXT, ts INTEGER, size_sol REAL, est_fill_price_sol REAL)

Example usage:

```
python -m backtest.backtest \
  --db ./data/bot.sqlite \
  --start 2024-05-01 --end 2024-05-31 \
  --grid '{"ENTRY_MIN_SCORE":[55,60],"MIN_OBS_BUYERS":[6,7,8],"MIN_OBS_UNIQUE":[5,6],"SAME_FUNDER_LIMIT":[0.7,0.75]}' \
  --tp 0.35 --sl 0.25 --tmax_sec 900 \
  --size_small_sol 0.1 --size_apex_sol 0.4 \
  --out_dir out/
```

Outputs:
- out/summary.csv — rows for each parameter combo with metrics
- out/best.json — the best params + metrics (subject to constraints)

Notes:
- Timestamps are assumed to be seconds since epoch; milliseconds will be auto‑normalized if detected.
- If your schema differs, adjust table/column names in `backtest/core/db.py` or create views matching the expected names.

