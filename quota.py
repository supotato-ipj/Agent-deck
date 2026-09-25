"""订阅额度/余额只读采集（fused-desktop 票 03）。

三个来源，全部只读、进程内缓存 60s、任何失败静默返回 None（绝不显示 0）：
- codex：会话文件尾部随 token_count / custom_tool_call_output 携带的 rateLimits
  快照，本地正则解析（票 01 的红利发现；usedPercent + windowDurationMins + resetsAt）
- dsh：官方文档的 GET https://api.deepseek.com/user/balance（API key 计费余额，
  Authorization: Bearer <key>；key 依次取环境变量 QD_DEEPSEEK_API_KEY、
  ~/.dsh/.credentials.yaml 中的 api key 字段）
- 可配置订阅端点：%LOCALAPPDATA%/qoder-deck/quota.json 的 "dsh_subscription"：
  {"url": ..., "token_env": 可选, "json_path_remaining": 可选}——DSH 订阅的
  5 小时窗/周额度端点未公开文档化，等具体路径确认后回填；不配置则该源为 None。

key 与余额数据不落日志、不落仓库；本模块不写任何文件。
"""
import json
import os
import re
import time
import urllib.request
from pathlib import Path

import agent_sessions

CACHE_TTL = 60.0
BALANCE_URL = "https://api.deepseek.com/user/balance"
BALANCE_TIMEOUT = 4.0

_cache = {"ts": 0.0, "data": {}}

# codex 快照字段（在多重转义的 JSON 文本里也直接子串可寻）
_USED_PCT_RE = re.compile(r'usedPercent[\\"]*:\s*[\\"]*(\d+)')
_WINDOW_MINS_RE = re.compile(r'windowDurationMins[\\"]*:\s*[\\"]*(\d+)')
_RESETS_AT_RE = re.compile(r'resetsAt[\\"]*:\s*[\\"]*(\d{9,12})')


def _window_label(minutes):
    if minutes and minutes <= 310:
        return "5h"
    if minutes and minutes <= 10090:
        return "weekly"
    return f"{minutes}m" if minutes else None


def codex_quota(root=None):
    """最近一个 codex 会话文件尾部的额度快照；无快照返回 None。"""
    root = Path(root) if root else Path.home() / ".codex"
    sessions_dir = root / "sessions"
    if not sessions_dir.is_dir():
        return None
    files = sorted(sessions_dir.glob("*/*/*/rollout-*.jsonl"), key=lambda p: p.stat().st_mtime if p.exists() else 0)
    for jf in reversed(files[-5:]):
        tail = agent_sessions._read_tail(jf)
        if '"usedPercent' not in tail and "usedPercent" not in tail:
            continue
        used = _USED_PCT_RE.findall(tail)
        window = _WINDOW_MINS_RE.findall(tail)
        resets = _RESETS_AT_RE.findall(tail)
        if used:
            used_pct = int(used[-1])
            return {
                "window": _window_label(int(window[-1])) if window else None,
                "remaining_pct": 100 - used_pct,
                "resets_at": int(resets[-1]) if resets else None,
                "source": "codex-local-snapshot",
            }
    return None


def _dsh_key():
    env = os.environ.get("QD_DEEPSEEK_API_KEY")
    if env:
        return env
    cred = Path.home() / ".dsh" / ".credentials.yaml"
    try:
        text = cred.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None
    # 最小 yaml 探测：形如 api_key: sk-xxx / apiKey: "sk-xxx" 的行
    m = re.search(r'(?im)^\s*(?:api_?key)\s*:\s*["\']?(sk-[\w-]+)', text)
    return m.group(1) if m else None


def _get_json(url, token, timeout=BALANCE_TIMEOUT):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def dsh_balance():
    """官方 /user/balance：{window:'balance', detail:…, source}；无 key/失败 None。"""
    token = _dsh_key()
    if not token:
        return None
    try:
        data = _get_json(BALANCE_URL, token)
    except Exception:
        return None
    infos = data.get("balance_infos") or []
    cny = next((i for i in infos if i.get("currency") == "CNY"), infos[0] if infos else None)
    if not cny:
        return None
    return {
        "window": "balance",
        "remaining_pct": None,
        "detail": {
            "is_available": bool(data.get("is_available")),
            "currency": cny.get("currency"),
            "total_balance": cny.get("total_balance"),
        },
        "source": "deepseek-user-balance",
    }


def _subscription_config():
    path = Path(os.environ.get("LOCALAPPDATA", "")) / "qoder-deck" / "quota.json"
    try:
        cfg = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    sub = cfg.get("dsh_subscription")
    return sub if isinstance(sub, dict) and sub.get("url") else None


def _extract_pct(data, path):
    """按点路径或常见字段名提取剩余百分比；0-1 归一化到 0-100。失败 None。"""
    node = data
    for part in (path or "").split("."):
        if not part:
            continue
        node = node.get(part) if isinstance(node, dict) else None
    if not isinstance(node, (int, float)) and isinstance(data, dict):
        for key in ("remaining_pct", "remaining", "left"):
            if isinstance(data.get(key), (int, float)):
                node = data[key]
                break
        else:
            for key in ("used_percent", "usedPercent"):
                if isinstance(data.get(key), (int, float)):
                    node = 100 - data[key]
                    break
    if not isinstance(node, (int, float)):
        return None
    pct = node * 100 if node <= 1 else node
    return round(pct, 1)


def dsh_subscription():
    """配置驱动的订阅额度端点（5h/周窗，端点路径待回填）。"""
    cfg = _subscription_config()
    if not cfg:
        return None
    token = os.environ.get(cfg.get("token_env") or "QD_DEEPSEEK_API_KEY") or _dsh_key()
    if not token:
        return None
    try:
        data = _get_json(cfg["url"], token)
    except Exception:
        return None
    pct = _extract_pct(data, cfg.get("json_path_remaining"))
    if pct is None:
        return None
    return {
        "window": cfg.get("window") or "5h",
        "remaining_pct": pct,
        "resets_at": data.get("resets_at") if isinstance(data, dict) else None,
        "source": "dsh-subscription-endpoint",
    }


def quota_state(now=None, codex_root=None):
    """全部额度源的当前值（/usage 的 quota 字段来源）。60s 缓存。"""
    now = time.monotonic() if now is None else now
    if now - _cache["ts"] < CACHE_TTL and _cache["data"]:
        return _cache["data"]
    data = {
        "codex": codex_quota(codex_root),
        "dsh": dsh_subscription() or dsh_balance(),
    }
    _cache.update(ts=now, data=data)
    return data
