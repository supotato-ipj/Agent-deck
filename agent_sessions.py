"""五工具会话采集（AGENT DECK 会话列表的数据来源）。

会话列表的唯一接缝 collect_sessions(roots, now)：roots 为 {工具名: 数据根路径}，now 为墙钟秒。
/performance 的 Qoder 状态块不经此接缝，但复用 task_stats/project_name 两个助手。
每工具一个严格只读的扫描器；任一工具扫描失败静默跳过、只记日志（ADR 0003）。
"""
import json
from pathlib import Path

RUNNING_WINDOW = 90.0
ACTIVE_WINDOW = 600.0


def collect_sessions(roots, now):
    sessions = []
    for tool, root in roots.items():
        scanner = SCANNERS.get(tool)
        if scanner is None:
            continue
        try:
            sessions.extend(scanner(Path(root), now))
        except Exception as exc:
            print(f"agent-sessions: {tool} 扫描失败，跳过：{exc}", flush=True)
    sessions.sort(key=lambda s: s["age"])
    return sessions


def task_stats(session_id, root):
    done = total = 0
    current = None
    tasks_dir = root / "tasks" / session_id
    if tasks_dir.is_dir():
        for tf in tasks_dir.glob("*.json"):
            try:
                task = json.loads(tf.read_text(encoding="utf-8"))
            except Exception:
                continue
            total += 1
            status = task.get("status")
            if status == "completed":
                done += 1
            elif status == "in_progress" and current is None:
                current = task.get("subject")
    return done, total, current


def _session_last(jsonl_path):
    """返回会话最近一条 assistant/user 记录的 (role, kind)。

    kind: tool = 最后动作是工具调用；text = 文本回复；user = 人工输入。
    """
    try:
        with open(jsonl_path, "rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - 131072))
            tail = fh.read().decode("utf-8", errors="ignore")
    except OSError:
        return None, None
    for line in reversed(tail.splitlines()):
        if '"type"' not in line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        role = rec.get("type")
        if role not in ("assistant", "user"):
            continue
        if role == "user":
            return role, "user"
        content = (rec.get("message") or {}).get("content")
        if isinstance(content, list) and content:
            last = content[-1] if isinstance(content[-1], dict) else {}
            return role, "tool" if last.get("type") == "tool_use" else "text"
        return role, "text"
    return None, None


def _session_state(age, role, kind):
    if age <= RUNNING_WINDOW:
        return "RUN"
    if kind == "tool":
        return "CONFIRM"
    if role == "assistant":
        return "DONE"
    return "IDLE"


def project_name(jsonl_path):
    try:
        with open(jsonl_path, "rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - 65536))
            tail = fh.read().decode("utf-8", errors="ignore")
        cwd = None
        for line in reversed(tail.splitlines()):
            if '"cwd"' not in line:
                continue
            try:
                cwd = json.loads(line).get("cwd")
            except Exception:
                continue
            if cwd:
                break
        if cwd:
            return Path(cwd).name
    except OSError:
        pass
    return jsonl_path.parent.name


def _scan_qoder_sessions(root, now):
    sessions = []
    projects_dir = root / "projects"
    if not projects_dir.is_dir():
        return sessions
    for proj in projects_dir.iterdir():
        if not proj.is_dir():
            continue
        for jf in proj.glob("*.jsonl"):
            try:
                mtime = jf.stat().st_mtime
            except OSError:
                continue
            age = now - mtime
            if age > ACTIVE_WINDOW:
                continue
            done, total, _current = task_stats(jf.stem, root)
            role, kind = _session_last(jf)
            sessions.append(
                {
                    "tool": "qoder",
                    "id": jf.stem,
                    "project": project_name(jf),
                    "running": age <= RUNNING_WINDOW,
                    "age": round(age),
                    "tasks_done": done,
                    "tasks_total": total,
                    "state": _session_state(age, role, kind),
                }
            )
    return sessions


SCANNERS = {
    "qoder": _scan_qoder_sessions,
}
