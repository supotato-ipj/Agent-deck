"""TERMINAL 02 壁纸数据服务。

GET /performance -> {"psutil": {...}, "qoder": {...}}
壁纸每秒轮询一次。仅监听 127.0.0.1。
"""
import json
import socket
import subprocess
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import psutil

HOST, PORT = "127.0.0.1", 5000
GPU_CACHE_TTL = 3.0
QODER_CACHE_TTL = 2.0
DECK_CACHE_TTL = 1.0
HISTORY_LEN = 300
QODER_ROOT = Path.home() / ".qoder-cn"
RUNNING_WINDOW = 90.0
ACTIVE_WINDOW = 600.0

_gpu_cache = {"ts": 0.0, "data": {}}
_qoder_cache = {"ts": 0.0, "data": None}
_deck_cache = {"ts": 0.0, "data": None}
_net_prev = None
_cpu = {"percent": 0.0}
_history = {
    "cpu": deque(maxlen=HISTORY_LEN),
    "dl": deque(maxlen=HISTORY_LEN),
    "up": deque(maxlen=HISTORY_LEN),
    "gpu": deque(maxlen=HISTORY_LEN),
}


def _cpu_sampler():
    # psutil 的 cpu_percent(interval=None) 状态是线程本地的，
    # 而每个 HTTP 请求都在新线程中处理，因此固定在本线程内采样。
    prev_net = psutil.net_io_counters()
    prev_ts = time.monotonic()
    while True:
        percent = psutil.cpu_percent(interval=1)
        _cpu["percent"] = percent
        now = time.monotonic()
        cur_net = psutil.net_io_counters()
        dt = now - prev_ts
        dl = max(0.0, (cur_net.bytes_recv - prev_net.bytes_recv) / dt / 1024) if dt > 0 else 0.0
        up = max(0.0, (cur_net.bytes_sent - prev_net.bytes_sent) / dt / 1024) if dt > 0 else 0.0
        prev_net, prev_ts = cur_net, now
        gpu = gpu_metrics().get("gpu_usage")
        _history["cpu"].append(round(percent, 1))
        _history["dl"].append(round(dl, 1))
        _history["up"].append(round(up, 1))
        _history["gpu"].append(round(gpu, 1) if gpu is not None else None)


def gpu_metrics():
    now = time.monotonic()
    if now - _gpu_cache["ts"] < GPU_CACHE_TTL:
        return _gpu_cache["data"]
    data = {}
    try:
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
            # 父进程是 pythonw（无控制台）时，不压制子进程控制台会每 3 秒闪一个终端窗
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if out.returncode == 0 and out.stdout.strip():
            util, temp, mused, mtotal = (float(x) for x in out.stdout.strip().splitlines()[0].split(","))
            data = {
                "gpu_usage": util,
                "gpu_temp": temp,
                "vram_usage": round(mused / mtotal * 100, 1) if mtotal else None,
            }
    except Exception:
        data = {}
    _gpu_cache.update(ts=now, data=data)
    return data


def net_metrics():
    global _net_prev
    c = psutil.net_io_counters()
    now = time.monotonic()
    result = {}
    if _net_prev is not None:
        prev_sent, prev_recv, prev_ts = _net_prev
        dt = now - prev_ts
        if dt > 0:
            result["download_speed"] = round(max(0.0, (c.bytes_recv - prev_recv) / dt / 1024), 1)
            result["upload_speed"] = round(max(0.0, (c.bytes_sent - prev_sent) / dt / 1024), 1)
    _net_prev = (c.bytes_sent, c.bytes_recv, now)
    return result


def qoder_state():
    now = time.monotonic()
    if _qoder_cache["data"] is not None and now - _qoder_cache["ts"] < QODER_CACHE_TTL:
        return _qoder_cache["data"]
    data = {"active_sessions": 0, "session": None}
    try:
        data = _scan_qoder()
    except Exception:
        data = {"active_sessions": 0, "session": None}
    _qoder_cache.update(ts=now, data=data)
    return data


def _task_stats(session_id):
    done = total = 0
    current = None
    tasks_dir = QODER_ROOT / "tasks" / session_id
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


def _scan_sessions():
    wall = time.time()
    sessions = []
    projects_dir = QODER_ROOT / "projects"
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
            age = wall - mtime
            if age > ACTIVE_WINDOW:
                continue
            done, total, current = _task_stats(jf.stem)
            role, kind = _session_last(jf)
            sessions.append(
                {
                    "id": jf.stem,
                    "project": _project_name(jf),
                    "running": age <= RUNNING_WINDOW,
                    "age": round(age),
                    "tasks_done": done,
                    "tasks_total": total,
                    "state": _session_state(age, role, kind),
                }
            )
    sessions.sort(key=lambda s: s["age"])
    return sessions


def deck_state():
    now = time.monotonic()
    if _deck_cache["data"] is not None and now - _deck_cache["ts"] < DECK_CACHE_TTL:
        return _deck_cache["data"]
    try:
        sessions = _scan_sessions()
    except Exception:
        sessions = []
    data = {
        "sessions": sessions,
        "history": {k: list(v) for k, v in _history.items()},
        "gauges": build_payload()["psutil"],
        "ts": time.time(),
    }
    _deck_cache.update(ts=now, data=data)
    return data


def _scan_qoder():
    wall = time.time()
    projects_dir = QODER_ROOT / "projects"
    sessions = []
    if projects_dir.is_dir():
        for proj in projects_dir.iterdir():
            if not proj.is_dir():
                continue
            for jf in proj.glob("*.jsonl"):
                try:
                    mtime = jf.stat().st_mtime
                except OSError:
                    continue
                age = wall - mtime
                if age > ACTIVE_WINDOW:
                    continue
                sessions.append({"mtime": mtime, "age": age, "id": jf.stem, "path": jf})
    sessions.sort(key=lambda s: s["mtime"], reverse=True)
    result = {"active_sessions": len(sessions), "session": None}
    if not sessions:
        return result
    latest = sessions[0]
    done, total, current = _task_stats(latest["id"])
    session = {
        "project": _project_name(latest["path"]),
        "running": latest["age"] <= RUNNING_WINDOW,
        "tasks_done": done,
        "tasks_total": total,
        "current_task": current,
    }
    result["session"] = session
    return result


def _project_name(jsonl_path):
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


def build_payload():
    mem = psutil.virtual_memory()
    data = {
        "cpu": _cpu["percent"],
        "memory": mem.percent,
        "memory_gb": f"{mem.used / 2**30:05.2f} GB/{mem.total / 2**30:05.2f} GB",
    }
    data.update(gpu_metrics())
    data.update(net_metrics())
    return {"psutil": data, "qoder": qoder_state()}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/performance":
            payload = build_payload()
        elif path == "/deck":
            payload = deck_state()
        else:
            self.send_error(404)
            return
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(f"[{time.strftime('%H:%M:%S')}] {self.address_string()} {fmt % args}", flush=True)


def main():
    # Windows 的 SO_REUSEADDR 允许双进程同绑一端口，故用 connect 探测做单实例守卫
    with socket.socket() as probe:
        try:
            probe.connect((HOST, PORT))
            return
        except OSError:
            pass
    threading.Thread(target=_cpu_sampler, daemon=True).start()
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError:
        return  # 端口已被占用（另一实例在跑），静默退出
    print(f"serving http://{HOST}:{PORT}/performance  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
