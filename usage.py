"""/usage 聚合：各 agent 今日 token 消耗 + 额度出口（fused-desktop 票 04）。

per_agent.today_tokens 为"今日本地 token 消耗"，各源口径：
- zcode：model_usage 按日窗 SQL 聚合（computed_total_tokens，按 model_id 分桶）——精确
- codex：今日有活动的 rollout 文件各自的会话累计 token 总和（新文件即今日会话，近似口径）
- kimicode：今日有活动的会话 wire.jsonl 里 token_counting.turn_recorded 的 tokens 求和
- hermes：messages.token_count 按日窗 SQL 求和
- qoder / kimiwork / dsh：null（本地无用量数据；dsh 待票 02 探明后并入）
quota 来自 quota.quota_state()。全部只读；聚合结果由调用方缓存。
"""
import json
import re
import sqlite3
from datetime import datetime
from pathlib import Path

import quota

_TOKENS_RE = re.compile(r'"tokens":\s*(\d+)')
_TURN_RE = re.compile(r'"type":\s*"token_counting\.turn_recorded"')


def _day_start(now=None):
    dt = datetime.fromtimestamp(now) if now is not None else datetime.now()
    return datetime(dt.year, dt.month, dt.day).timestamp()


def _open_ro(db_path):
    return sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=0.5)


def zcode_usage(root, day_start):
    """{today_tokens, models}；库缺失/损坏返回 None。"""
    db = Path(root) / "cli" / "db" / "db.sqlite"
    if not db.is_file():
        return None
    try:
        con = _open_ro(db)
        try:
            rows = con.execute(
                "SELECT model_id, SUM(computed_total_tokens) FROM model_usage"
                " WHERE started_at >= ? GROUP BY model_id",
                (day_start * 1000,),
            ).fetchall()
        finally:
            con.close()
    except Exception:
        return None
    if not rows:
        return {"today_tokens": 0, "models": {}}
    models = {m or "unknown": int(t or 0) for m, t in rows}
    return {"today_tokens": sum(models.values()), "models": models}


def codex_usage(root, day_start):
    sessions_dir = Path(root) / "sessions"
    if not sessions_dir.is_dir():
        return None
    import agent_sessions

    total = 0
    seen = False
    for jf in sessions_dir.glob("*/*/*/rollout-*.jsonl"):
        try:
            if jf.stat().st_mtime < day_start:
                continue
        except OSError:
            continue
        seen = True
        tokens = agent_sessions._codex_tokens(agent_sessions._read_tail(jf))
        if tokens and tokens.get("total"):
            total += tokens["total"]
    return {"today_tokens": total, "models": {}} if seen else None


def kimicode_usage(root, day_start):
    sessions_dir = Path(root) / "sessions"
    if not sessions_dir.is_dir():
        return None
    total = 0
    seen = False
    for wire in sessions_dir.glob("*/*/agents/main/wire.jsonl"):
        try:
            if wire.stat().st_mtime < day_start:
                continue
        except OSError:
            continue
        seen = True
        try:
            text = wire.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for line in text.splitlines():
            if _TURN_RE.search(line):
                total += sum(int(m) for m in _TOKENS_RE.findall(line))
    return {"today_tokens": total, "models": {}} if seen else None


def hermes_usage(root, day_start):
    db = Path(root) / "state.db"
    if not db.is_file():
        return None
    try:
        con = _open_ro(db)
        try:
            (total,) = con.execute(
                "SELECT SUM(token_count) FROM messages WHERE timestamp >= ?",
                (day_start,),
            ).fetchone()
        finally:
            con.close()
    except Exception:
        return None
    return {"today_tokens": int(total or 0), "models": {}}


def usage_state(roots, now=None, codex_root=None):
    day_start = _day_start(now)
    per_agent = {}
    for tool, fn in (
        ("zcode", zcode_usage),
        ("codex", codex_usage),
        ("kimicode", kimicode_usage),
        ("hermes", hermes_usage),
    ):
        root = roots.get(tool)
        per_agent[tool] = fn(root, day_start) if root else None
    per_agent.setdefault("qoder", None)
    per_agent.setdefault("kimiwork", None)
    per_agent.setdefault("dsh", None)
    return {
        "per_agent": per_agent,
        "quota": quota.quota_state(codex_root=codex_root),
        "day_start": day_start,
    }
