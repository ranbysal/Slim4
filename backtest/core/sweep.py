import itertools
from typing import Dict, List, Any, Tuple

from .simulate import run_simulation


def _param_product(grid: Dict[str, List[Any]]) -> List[Dict[str, Any]]:
    if not grid:
        return [{}]
    keys = sorted(grid.keys())
    vals = [grid[k] for k in keys]
    out = []
    for combo in itertools.product(*vals):
        d = {k: combo[i] for i, k in enumerate(keys)}
        out.append(d)
    return out


def sweep_grid(
    grid: Dict[str, List[Any]],
    base_params: Dict[str, Any],
    events_by_mint: Dict[str, List[dict]],
    quotes_by_mint: Dict[str, List[dict]],
    trade_settings: Dict[str, Any],
    min_trades: int = 10,
    max_drawdown: float = 0.4,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any] | None]:
    """Evaluate all parameter combinations and pick the best row.

    Best is highest total_pnl_sol subject to constraints.
    """
    rows: List[Dict[str, Any]] = []
    best = None
    best_score = None
    # Track unconstrained best as fallback so best.json is never empty
    best_any = None
    best_any_score = None

    for override in _param_product(grid):
        params = dict(base_params)
        params.update(override)
        metrics = run_simulation(events_by_mint, quotes_by_mint, params, trade_settings)

        row = {
            "params": params,
            "metrics": metrics,
        }
        rows.append(row)

        # Update unconstrained best
        score_any = float(metrics.get("total_pnl_sol", 0.0) or 0.0)
        if best_any is None or score_any > best_any_score:
            best_any = row
            best_any_score = score_any

        # Constraint check for primary selection
        t = metrics.get("trades", 0)
        dd = float(metrics.get("max_drawdown", 0.0) or 0.0)
        if t < int(min_trades) or dd > float(max_drawdown):
            continue

        score = float(metrics.get("total_pnl_sol", 0.0) or 0.0)
        if best is None or score > best_score:
            best = row
            best_score = score

    # Fallback to unconstrained best if constraints yield none
    if best is None:
        best = best_any
    return rows, best
