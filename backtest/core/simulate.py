from bisect import bisect_right
from collections import defaultdict
from typing import Dict, List, Any, Tuple

from .logic import decide


def _index_quotes_by_size(quotes_by_mint: Dict[str, List[dict]]) -> Dict[str, Dict[float, List[dict]]]:
    out: Dict[str, Dict[float, List[dict]]] = {}
    for mint, quotes in quotes_by_mint.items():
        m: Dict[float, List[dict]] = defaultdict(list)
        for q in quotes:
            size = round(float(q.get("size_sol", 0.0)), 6)
            m[size].append(q)
        for s in list(m.keys()):
            m[s].sort(key=lambda x: int(x["ts"]))
        out[mint] = dict(m)
    return out


def _nearest_past_quote(quotes: List[dict], ts: int) -> Tuple[int, dict | None]:
    if not quotes:
        return -1, None
    times = [int(q["ts"]) for q in quotes]
    idx = bisect_right(times, int(ts)) - 1
    if idx >= 0:
        return idx, quotes[idx]
    return -1, None


def _first_exit_after(quotes: List[dict], start_idx: int, entry_ts: int, entry_price: float, tp: float, sl: float, tmax_sec: int) -> Tuple[int, dict | None]:
    """Scan forward in quotes for exit condition (TP, SL, or time)."""
    if not quotes or start_idx < 0:
        return -1, None
    deadline = entry_ts + int(tmax_sec)
    n = len(quotes)
    # Ensure we start at first strictly after or equal to entry_ts
    i = start_idx
    while i < n and int(quotes[i]["ts"]) < entry_ts:
        i += 1
    chosen_idx = -1
    for j in range(i, n):
        q = quotes[j]
        ts = int(q["ts"]) 
        px = float(q["est_fill_price_sol"]) or 0.0
        if px <= 0.0:
            continue
        # Time exit
        if ts - entry_ts >= tmax_sec:
            chosen_idx = j
            break
        # Price exits
        ret = (px - entry_price) / entry_price
        if ret >= tp or ret <= -sl:
            chosen_idx = j
            break
    if chosen_idx == -1:
        # Fallback: use last available quote after entry if any
        last_idx = -1
        for j in range(n - 1, -1, -1):
            if int(quotes[j]["ts"]) >= entry_ts:
                last_idx = j
                break
        if last_idx != -1:
            return last_idx, quotes[last_idx]
        return -1, None
    return chosen_idx, quotes[chosen_idx]


def run_simulation(
    events_by_mint: Dict[str, List[dict]],
    quotes_by_mint: Dict[str, List[dict]],
    params: Dict[str, Any],
    trade_settings: Dict[str, Any],
) -> Dict[str, Any]:
    """Simulate across all mints.

    Returns metrics: trades, winrate, total_pnl_sol, pnl_by_origin, max_drawdown, avg_hold_sec
    """
    tp = float(trade_settings.get("tp", 0.35))
    sl = float(trade_settings.get("sl", 0.25))
    tmax = int(trade_settings.get("tmax_sec", 900))
    size_small = round(float(trade_settings.get("size_small_sol", 0.1)), 6)
    size_apex = round(float(trade_settings.get("size_apex_sol", 0.4)), 6)
    cooldown_sec = int(params.get("COOLDOWN_SEC", 60))

    quotes_by_size = _index_quotes_by_size(quotes_by_mint)

    trades = 0
    wins = 0
    total_pnl = 0.0
    pnl_by_origin: Dict[str, float] = defaultdict(float)
    hold_secs_sum = 0
    equity = 0.0
    peak = 0.0
    max_dd = 0.0

    for mint, snapshots in events_by_mint.items():
        state = {"in_position": False, "cooldown_until_ts": 0}
        # Sorted by ts expected
        for snap in snapshots:
            # Skip if we don't have quotes for this mint
            if mint not in quotes_by_size:
                continue

            # Only decide when flat
            if state.get("in_position", False):
                continue

            action = decide(state, snap, params)
            if action is None:
                continue

            # Determine size & quotes list
            if action == "APEX":
                size = size_apex
            else:
                size = size_small

            qs = quotes_by_size[mint].get(size)
            if not qs:
                continue
            idx, q_entry = _nearest_past_quote(qs, int(snap["ts"]))
            if q_entry is None:
                continue
            entry_ts = int(q_entry["ts"])  # may be <= snap ts
            entry_px = float(q_entry["est_fill_price_sol"]) or 0.0
            if entry_px <= 0:
                continue

            # Find exit
            exit_idx, q_exit = _first_exit_after(qs, idx, entry_ts, entry_px, tp, sl, tmax)
            if q_exit is None:
                continue

            exit_ts = int(q_exit["ts"]) 
            exit_px = float(q_exit["est_fill_price_sol"]) or entry_px
            hold_secs = max(0, exit_ts - entry_ts)

            # PnL in SOL: size * ((exit/entry) - 1)
            ret = (exit_px / entry_px) - 1.0
            pnl = size * ret

            trades += 1
            if pnl > 0:
                wins += 1
            total_pnl += pnl
            origin = str(snap.get("origin") or "")
            pnl_by_origin[origin] += pnl
            hold_secs_sum += hold_secs

            # Equity curve for drawdown
            equity += pnl
            if equity > peak:
                peak = equity
            dd = 0.0 if peak <= 0 else (peak - equity) / max(1e-12, abs(peak))
            if dd > max_dd:
                max_dd = dd

            # Cooldown
            state["in_position"] = False
            state["cooldown_until_ts"] = exit_ts + cooldown_sec

    winrate = (wins / trades) if trades > 0 else 0.0
    avg_hold = (hold_secs_sum / trades) if trades > 0 else 0.0

    return {
        "trades": trades,
        "winrate": winrate,
        "total_pnl_sol": total_pnl,
        "pnl_by_origin": dict(pnl_by_origin),
        "max_drawdown": max_dd,
        "avg_hold_sec": avg_hold,
    }

