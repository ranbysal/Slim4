import sqlite3
from collections import defaultdict
from typing import Dict, List, Any, Iterable


def _row_columns(cur: sqlite3.Cursor, table: str) -> List[str]:
    cols = []
    for r in cur.execute(f"PRAGMA table_info({table})").fetchall():
        # PRAGMA table_info: (cid, name, type, notnull, dflt_value, pk)
        cols.append(r[1])
    return cols


def _find_table(cur: sqlite3.Cursor, candidates: Iterable[str]) -> str:
    tbls = {r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for c in candidates:
        if c in tbls:
            return c
    raise RuntimeError(f"None of the expected tables exist: {', '.join(candidates)}")


def _normalize_ts(ts_val: Any) -> int:
    try:
        ts = int(ts_val)
    except Exception:
        # Try to parse from common text format 'YYYY-MM-DD HH:MM:SS'
        # Fallback: 0
        try:
            from datetime import datetime

            ts = int(datetime.fromisoformat(str(ts_val)).timestamp())
        except Exception:
            ts = 0
    # Auto-detect ms
    if ts > 10**12:
        ts //= 1000
    return ts


def load_events(db_path: str, start_ts: int | None, end_ts: int | None) -> Dict[str, List[dict]]:
    """Load observation snapshots.

    Returns: dict[mint] -> list of {ts, buyers, unique, same, price_jumps, depth, origin}
    Ordered by ts asc per mint.
    """
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    table = _find_table(cur, ["events", "snapshots", "observations", "obs"])
    cols = set(_row_columns(cur, table))

    # Required logical columns (attempt best-effort mappings)
    def pick(*names: str) -> str:
        for n in names:
            if n in cols:
                return n
        raise RuntimeError(f"Missing required column in {table}: one of {names}")

    c_mint = pick("mint", "mint_address", "token", "asset")
    c_ts = pick("ts", "timestamp", "time")
    c_buy = pick("buyers", "obs_buyers", "n_buyers")
    c_uni = pick("unique", "obs_unique", "n_unique")
    c_same = pick("same", "same_funder", "same_funders", "same_funder_count")
    c_pj = pick("price_jumps", "jumps", "num_jumps")
    c_depth = pick("depth", "liq_depth", "orderbook_depth", "ob_depth")
    c_origin = pick("origin", "src", "source")

    rows = cur.execute(
        f"SELECT {c_mint} AS mint, {c_ts} AS ts, {c_buy} AS buyers, {c_uni} AS unique, "
        f"{c_same} AS same, {c_pj} AS price_jumps, {c_depth} AS depth, {c_origin} AS origin "
        f"FROM {table} ORDER BY ts ASC"
    ).fetchall()

    out: Dict[str, List[dict]] = defaultdict(list)
    for r in rows:
        ts = _normalize_ts(r["ts"])
        if start_ts is not None and ts < start_ts:
            continue
        if end_ts is not None and ts > end_ts:
            continue
        out[str(r["mint"])].append(
            {
                "ts": ts,
                "buyers": int(r["buyers"]) if r["buyers"] is not None else 0,
                "unique": int(r["unique"]) if r["unique"] is not None else 0,
                "same": int(r["same"]) if r["same"] is not None else 0,
                "price_jumps": int(r["price_jumps"]) if r["price_jumps"] is not None else 0,
                "depth": float(r["depth"]) if r["depth"] is not None else 0.0,
                "origin": str(r["origin"]) if r["origin"] is not None else "",
            }
        )

    # Ensure per-mint sorted by ts
    for mint in list(out.keys()):
        out[mint].sort(key=lambda x: x["ts"]) 

    con.close()
    return dict(out)


def load_quotes(db_path: str, sizes: List[float]) -> Dict[str, List[dict]]:
    """Load quotes filtered by desired sizes.

    Returns: dict[mint] -> list of {ts, size_sol, est_fill_price_sol} ordered by ts asc.
    """
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    table = _find_table(cur, ["quotes", "price_quotes", "px_quotes"]) 
    cols = set(_row_columns(cur, table))

    def pick(*names: str) -> str:
        for n in names:
            if n in cols:
                return n
        raise RuntimeError(f"Missing required column in {table}: one of {names}")

    c_mint = pick("mint", "mint_address", "token", "asset")
    c_ts = pick("ts", "timestamp", "time")
    c_size = pick("size_sol", "size", "quote_size_sol")
    c_price = pick("est_fill_price_sol", "price", "fill_price_sol", "est_price_sol")

    # Load all and filter in Python to be resilient to float matching
    rows = cur.execute(
        f"SELECT {c_mint} AS mint, {c_ts} AS ts, {c_size} AS size_sol, {c_price} AS est_fill_price_sol "
        f"FROM {table} ORDER BY ts ASC"
    ).fetchall()

    wanted = [round(float(s), 6) for s in sizes]
    out: Dict[str, List[dict]] = defaultdict(list)
    for r in rows:
        size = round(float(r["size_sol"]), 6)
        if size not in wanted:
            continue
        out[str(r["mint"])].append(
            {
                "ts": _normalize_ts(r["ts"]),
                "size_sol": size,
                "est_fill_price_sol": float(r["est_fill_price_sol"]) if r["est_fill_price_sol"] is not None else 0.0,
            }
        )

    for mint in list(out.keys()):
        out[mint].sort(key=lambda x: x["ts"]) 

    con.close()
    return dict(out)

