import argparse
import json
import os
from datetime import datetime

from backtest.core.db import load_events, load_quotes
from backtest.core.sweep import sweep_grid
from backtest.core.report import write_summary, write_best


def parse_args():
    p = argparse.ArgumentParser(
        description="Offline backtesting CLI (sqlite events + quotes)"
    )
    p.add_argument("--db", required=True, help="Path to sqlite database, e.g. ./data/bot.sqlite")
    p.add_argument("--start", help="YYYY-MM-DD (optional)")
    p.add_argument("--end", help="YYYY-MM-DD (optional)")
    p.add_argument(
        "--grid",
        required=True,
        help="JSON string mapping param -> list, e.g. {\"ENTRY_MIN_SCORE\":[55,60]}",
    )
    p.add_argument("--tp", type=float, default=0.35, help="Take-profit threshold (fraction)")
    p.add_argument("--sl", type=float, default=0.25, help="Stop-loss threshold (fraction)")
    p.add_argument("--tmax_sec", type=int, default=900, help="Max hold time in seconds")
    p.add_argument("--size_small_sol", type=float, default=0.1, help="Entry size for SMALL (in SOL)")
    p.add_argument("--size_apex_sol", type=float, default=0.4, help="Entry size for APEX (in SOL)")
    p.add_argument("--out_dir", default="out/", help="Output directory for reports")
    return p.parse_args()


def parse_date_to_epoch(day: str | None) -> int | None:
    if not day:
        return None
    # Interpret as naive date (UTC midnight)
    dt = datetime.fromisoformat(day)
    return int(dt.timestamp())


def main():
    args = parse_args()
    grid = json.loads(args.grid)

    start_ts = parse_date_to_epoch(args.start)
    end_ts = parse_date_to_epoch(args.end)

    events_by_mint = load_events(args.db, start_ts, end_ts)
    quotes_by_mint = load_quotes(args.db, sizes=[args.size_small_sol, args.size_apex_sol])

    base_params = {
        # Logic defaults; swept values override these
        "ENTRY_MIN_SCORE": 60,
        "MIN_OBS_BUYERS": 7,
        "MIN_OBS_UNIQUE": 6,
        "SAME_FUNDER_LIMIT": 0.7,
        # Other strategy tunables (fixed unless provided in grid)
        "SAME_FUNDER_FATAL": 0.75,
        "APEX_SCORE_BOOST": 20,
        "COOLDOWN_SEC": 60,
    }
    # Allow grid to optionally include fixed keys with singletons
    for k, v in list(grid.items()):
        if not isinstance(v, list):
            base_params[k] = v
            grid.pop(k)

    trade_settings = {
        "tp": float(args.tp),
        "sl": float(args.sl),
        "tmax_sec": int(args.tmax_sec),
        "size_small_sol": float(args.size_small_sol),
        "size_apex_sol": float(args.size_apex_sol),
    }

    rows, best = sweep_grid(
        grid=grid,
        base_params=base_params,
        events_by_mint=events_by_mint,
        quotes_by_mint=quotes_by_mint,
        trade_settings=trade_settings,
        min_trades=10,
        max_drawdown=0.4,
    )

    os.makedirs(args.out_dir, exist_ok=True)
    write_summary(args.out_dir, rows)
    write_best(args.out_dir, best)

    # Print concise summary to stdout
    if best:
        print("Best params:")
        print(json.dumps(best.get("params", {}), separators=(",", ":")))
        m = best.get("metrics", {})
        print(
            f"trades={m.get('trades',0)} winrate={m.get('winrate',0):.2f} "
            f"pnl={m.get('total_pnl_sol',0.0):.4f} dd={m.get('max_drawdown',0.0):.3f} "
            f"avg_hold_sec={m.get('avg_hold_sec',0.0):.1f}"
        )
    else:
        print("No parameter set met constraints; see summary.csv for details.")


if __name__ == "__main__":
    main()

