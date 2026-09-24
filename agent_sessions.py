"""五工具会话采集（AGENT DECK 会话列表的数据来源）。

会话列表的唯一接缝 collect_sessions(roots, now)：roots 为 {工具名: 数据根路径}，now 为墙钟秒。
/performance 的 Qoder 状态块不经此接缝，但复用 task_stats/project_name 两个助手。
每工具一个严格只读的扫描器；任一工具扫描失败静默跳过、只记日志（ADR 0003）。
"""
import json
import sqlite3
from datetime import datetime
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
                _session(
                    "qoder",
                    jf.stem,
                    project_name(jf),
                    age,
                    _session_state(age, role, kind),
                    tasks=(done, total),
                )
            )
    return sessions


def _open_ro(db_path):
    # busy timeout 调短：库被写方独占时快速失败走静默跳过，不拖住 /deck 轮询
    return sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=0.5)


def _dir_name(path_str):
    return Path(path_str).name if path_str else ""


def _session(tool, sid, project, age, state, running=None, tasks=None):
    return {
        "tool": tool,
        "id": sid,
        "project": project,
        "running": (age <= RUNNING_WINDOW) if running is None else running,
        "age": round(age),
        "tasks_done": None if tasks is None else tasks[0],
        "tasks_total": None if tasks is None else tasks[1],
        "state": state,
    }


def _hermes_leases(root):
    """活跃租约里的会话 id 集合；租约文件坏了只当没有，不连累整工具。"""
    try:
        data = json.loads((root / "runtime" / "active_sessions.json").read_text(encoding="utf-8"))
    except Exception:
        return set()
    return {e.get("session_id") for e in data.get("entries", []) if e.get("session_id")}


def _scan_hermes(root, now):
    leases = _hermes_leases(root)
    sessions = []
    con = _open_ro(root / "state.db")
    try:
        rows = con.execute(
            "SELECT id, cwd, last_activity_at, started_at, end_reason, archived FROM sessions"
        ).fetchall()
    finally:
        con.close()
    for sid, cwd, last_act, started, end_reason, archived in rows:
        if archived:
            continue
        act = last_act if last_act is not None else started
        if act is None:
            continue
        age = now - act
        if age > ACTIVE_WINDOW:
            continue
        running = sid in leases or (end_reason is None and age <= RUNNING_WINDOW)
        state = "RUN" if running else ("IDLE" if end_reason is None else "DONE")
        sessions.append(_session("hermes", sid, _dir_name(cwd), age, state, running=running))
    return sessions


def _scan_zcode(root, now):
    con = _open_ro(root / "cli" / "db" / "db.sqlite")
    try:
        rows = con.execute(
            "SELECT id, directory, time_updated, time_archived FROM session"
        ).fetchall()
        todo_rows = con.execute(
            "SELECT session_id, SUM(status = 'completed'), COUNT(*) FROM todo GROUP BY session_id"
        ).fetchall()
    finally:
        con.close()
    counts = {sid: (done, total) for sid, done, total in todo_rows}
    sessions = []
    for sid, directory, upd, archived in rows:
        if archived or upd is None:
            continue
        age = now - upd / 1000.0
        if age > ACTIVE_WINDOW:
            continue
        running = age <= RUNNING_WINDOW
        sessions.append(
            _session(
                "zcode",
                sid,
                _dir_name(directory),
                age,
                "RUN" if running else "DONE",
                tasks=counts.get(sid, (0, 0)),
            )
        )
    return sessions


def _scan_kimicode(root, now):
    sessions = []
    sessions_dir = root / "sessions"
    if not sessions_dir.is_dir():
        return sessions
    for ws in sessions_dir.iterdir():
        if not ws.is_dir():
            continue
        for sd in ws.iterdir():
            if not sd.is_dir():
                continue
            state_file = sd / "state.json"
            wire_file = sd / "agents" / "main" / "wire.jsonl"
            try:
                state = json.loads(state_file.read_text(encoding="utf-8"))
                mtimes = [state_file.stat().st_mtime]
                if wire_file.exists():
                    mtimes.append(wire_file.stat().st_mtime)
            except Exception:
                continue
            age = now - max(mtimes)
            if age > ACTIVE_WINDOW:
                continue
            running = age <= RUNNING_WINDOW
            sessions.append(
                _session(
                    "kimicode",
                    sd.name,
                    _dir_name(state.get("workDir")),
                    age,
                    "RUN" if running else "DONE",
                )
            )
    return sessions


def _scan_kimiwork(root, now):
    """降级扫描：只有状态与更新时间，没有标题/项目（正文锁在上游私有存储）。"""
    statuses = json.loads((root / "conversation-statuses.json").read_text(encoding="utf-8"))
    usage = json.loads((root / "conversation-context-usage.json").read_text(encoding="utf-8"))
    sessions = []
    for key, status in statuses.items():
        entry = usage.get(key)
        updated = (entry or {}).get("updatedAt")
        if not updated:
            continue
        age = now - datetime.fromisoformat(updated.replace("Z", "+00:00")).timestamp()
        if age > ACTIVE_WINDOW:
            continue
        running = age <= RUNNING_WINDOW
        state = "RUN" if running else ("DONE" if status == "completed" else "IDLE")
        sessions.append(_session("kimiwork", key.rsplit(":", 1)[-1], "", age, state))
    return sessions


SCANNERS = {
    "qoder": _scan_qoder_sessions,
    "hermes": _scan_hermes,
    "zcode": _scan_zcode,
    "kimicode": _scan_kimicode,
    "kimiwork": _scan_kimiwork,
}
