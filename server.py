"""TERMINAL 02 壁纸数据服务。

GET /performance -> {"psutil": {...}, "qoder": {...}}
壁纸每秒轮询一次。仅监听 127.0.0.1。
"""
import json
import os
import socket
import subprocess
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import psutil

import agent_sessions
import search_panel
import usage_log
import usage_score
import zones_watcher

HOST = "127.0.0.1"
# 开发/验收时可换端口并行跑第二实例（watchdog 不设此变量，恒为 5000）
PORT = int(os.environ.get("QD_PORT", "5000"))
GPU_CACHE_TTL = 3.0
QODER_CACHE_TTL = 2.0
DECK_CACHE_TTL = 1.0
HISTORY_LEN = 300
QODER_ROOT = Path.home() / ".qoder-cn"
RUNNING_WINDOW = agent_sessions.RUNNING_WINDOW
ACTIVE_WINDOW = agent_sessions.ACTIVE_WINDOW
SESSION_ROOTS = {
    "qoder": QODER_ROOT,
    "hermes": Path.home() / "AppData" / "Local" / "hermes",
    "zcode": Path.home() / ".zcode",
    "kimicode": Path.home() / ".kimi-code",
    "kimiwork": Path.home() / "AppData" / "Roaming" / "kimi-desktop" / "kimi-agent",
}

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


def deck_state():
    now = time.monotonic()
    if _deck_cache["data"] is not None and now - _deck_cache["ts"] < DECK_CACHE_TTL:
        return _deck_cache["data"]
    try:
        sessions = agent_sessions.collect_sessions(SESSION_ROOTS, time.time())
    except Exception:
        sessions = []
    data = {
        "sessions": sessions,
        "history": {k: list(v) for k, v in _history.items()},
        "gauges": build_payload()["psutil"],
        "panel": search_panel.panel_rect(),
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
    done, total, current = agent_sessions.task_stats(latest["id"], QODER_ROOT)
    session = {
        "project": agent_sessions.project_name(latest["path"]),
        "running": latest["age"] <= RUNNING_WINDOW,
        "tasks_done": done,
        "tasks_total": total,
        "current_task": current,
    }
    result["session"] = session
    return result


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


def _usage_collector():
    """使用日志采集：独立线程、2s 一轮，不占用 1Hz 采样循环（见 spec 使用日志节）。"""
    try:
        collector = usage_log.Collector()
    except Exception as exc:
        print(f"usage-log: 初始化失败，采集停用：{exc}", flush=True)
        return
    usage_log.run_loop(collector)


def _zone_watcher():
    """桌面目录看门狗：新增/删除触发增量编排（见 zones_watcher 的漂移纠正语义）。"""
    try:
        zones_watcher.run_watch_loop()
    except Exception as exc:
        zones_watcher.log.exception("看门狗线程退出：%s", exc)


def main():
    # Windows 的 SO_REUSEADDR 允许双进程同绑一端口，故用 connect 探测做单实例守卫
    with socket.socket() as probe:
        try:
            probe.connect((HOST, PORT))
            return
        except OSError:
            pass
    threading.Thread(target=_cpu_sampler, daemon=True).start()
    threading.Thread(target=_usage_collector, daemon=True).start()
    threading.Thread(target=_zone_watcher, daemon=True).start()
    # 搜索面板窗口线程（ADR-0003）：能力在数据服务内；窗口崩溃被线程内
    # 兜住，不影响 /deck 轮询（验收：QD_PANEL_CRASH 注入崩溃后 /deck 仍 200）
    search_panel.start_thread()
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
