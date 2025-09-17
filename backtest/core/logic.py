from typing import Optional, Dict, Any


def _get(d: Dict[str, Any], k: str, default):
    v = d.get(k)
    return default if v is None else v


def safety_gate(snapshot: Dict[str, Any], params: Dict[str, Any]) -> bool:
    """Hard filters. Fatal if same-funder ratio exceeds SAME_FUNDER_FATAL.

    same_funder_ratio = same / max(buyers, 1)
    """
    buyers = int(snapshot.get("buyers") or 0)
    same = int(snapshot.get("same") or 0)
    fatal = float(_get(params, "SAME_FUNDER_FATAL", 0.75))
    ratio = 0.0 if buyers <= 0 else min(1.0, same / float(buyers))
    if ratio > fatal:
        return False
    return True


def conviction(snapshot: Dict[str, Any], params: Dict[str, Any]) -> int:
    """Score 0..100 using soft buckets.

    Inputs considered: buyers, unique, price_jumps, depth, same_funder_ratio.
    Tunables: MIN_OBS_BUYERS, MIN_OBS_UNIQUE, SAME_FUNDER_LIMIT.
    """
    buyers = int(snapshot.get("buyers") or 0)
    uniq = int(snapshot.get("unique") or 0)
    same = int(snapshot.get("same") or 0)
    jumps = int(snapshot.get("price_jumps") or 0)
    depth = float(snapshot.get("depth") or 0.0)

    min_buyers = int(_get(params, "MIN_OBS_BUYERS", 7))
    min_unique = int(_get(params, "MIN_OBS_UNIQUE", 6))
    soft_same = float(_get(params, "SAME_FUNDER_LIMIT", 0.7))
    fatal = float(_get(params, "SAME_FUNDER_FATAL", 0.75))

    score = 0

    # Buyers buckets (+30/+20/+10)
    if buyers >= min_buyers:
        score += 30
    elif buyers == max(0, min_buyers - 1):
        score += 20
    elif buyers == max(0, min_buyers - 2):
        score += 10

    # Unique buckets (+20/+10)
    if uniq >= min_unique:
        score += 20
    elif uniq == max(0, min_unique - 1):
        score += 10

    # Price jumps (+30/+20/+10)
    if jumps >= 3:
        score += 30
    elif jumps == 2:
        score += 20
    elif jumps == 1:
        score += 10

    # Depth (+10/+5) — lightweight liquidity proxy
    if depth >= 3:
        score += 10
    elif depth >= 2:
        score += 5

    # Soft penalty for same-funder concentration beyond limit
    ratio = 0.0 if buyers <= 0 else min(1.0, same / float(buyers))
    if ratio > soft_same:
        # Scale penalty up to 40 as ratio approaches fatal
        span = max(1e-6, (fatal - soft_same))
        over = min(ratio - soft_same, span)
        penalty = int(round(40.0 * (over / span)))
        score -= penalty

    # Clamp
    if score < 0:
        score = 0
    if score > 100:
        score = 100

    return int(score)


def decide(previous_state: Dict[str, Any], snapshot: Dict[str, Any], params: Dict[str, Any]) -> Optional[str]:
    """Return None | 'SMALL' | 'APEX'.

    Simple cooldown semantics: no re-entry until now >= cooldown_until and not in_position.
    APEX requires stronger signal: ENTRY_MIN_SCORE + APEX_SCORE_BOOST.
    """
    now_ts = int(snapshot.get("ts") or 0)
    if previous_state.get("in_position", False):
        return None
    cooldown_until = int(previous_state.get("cooldown_until_ts", 0) or 0)
    if now_ts < cooldown_until:
        return None

    if not safety_gate(snapshot, params):
        return None

    score = conviction(snapshot, params)
    entry_min = int(_get(params, "ENTRY_MIN_SCORE", 60))
    apex_boost = int(_get(params, "APEX_SCORE_BOOST", 20))
    min_buyers = int(_get(params, "MIN_OBS_BUYERS", 7))
    min_unique = int(_get(params, "MIN_OBS_UNIQUE", 6))

    if score >= entry_min + apex_boost and snapshot.get("buyers", 0) >= (min_buyers + 1) and snapshot.get("unique", 0) >= min_unique:
        return "APEX"
    if score >= entry_min:
        return "SMALL"
    return None

