import csv
import json
import os
from typing import List, Dict, Any


def write_summary(out_dir: str, rows: List[Dict[str, Any]]):
    path = os.path.join(out_dir, "summary.csv")

    # Collect param keys union and fixed metric keys
    param_keys = set()
    for r in rows:
        param_keys.update((r.get("params") or {}).keys())
    param_keys = sorted(param_keys)

    metric_keys = [
        "trades",
        "winrate",
        "total_pnl_sol",
        "max_drawdown",
        "avg_hold_sec",
        "pnl_by_origin",
    ]

    header = [f"param.{k}" for k in param_keys] + metric_keys

    os.makedirs(out_dir, exist_ok=True)
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        for r in rows:
            p = r.get("params", {})
            m = r.get("metrics", {})
            row = [p.get(k) for k in param_keys]
            row.extend([
                m.get("trades", 0),
                f"{m.get('winrate', 0.0):.6f}",
                f"{m.get('total_pnl_sol', 0.0):.8f}",
                f"{m.get('max_drawdown', 0.0):.6f}",
                f"{m.get('avg_hold_sec', 0.0):.3f}",
                json.dumps(m.get("pnl_by_origin", {}), separators=(",", ":")),
            ])
            w.writerow(row)


def write_best(out_dir: str, best_row: Dict[str, Any] | None):
    path = os.path.join(out_dir, "best.json")
    os.makedirs(out_dir, exist_ok=True)
    with open(path, "w") as f:
        json.dump(best_row or {}, f, indent=2, sort_keys=True)

