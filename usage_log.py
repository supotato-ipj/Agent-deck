"""应用使用日志：只记进程可执行路径与时间戳，绝不记窗口标题。

用户的窗口标题里常带案号、当事人名、项目名（见 ADR-0002），而标题对
"哪个应用常用"这个判断毫无贡献，所以采集路径上根本不获取标题文本——
不是"获取了但不写"。tests/test_usage_log.py 里有常驻隐私断言盯着这一点。

两类事件各写各的按天 JSONL 文件（start- / focus- 前缀），每条记录只有
ts 与 exe 两个字段；07 票的"真启动次数"读 start 文件。90 天滚动清理。
"""
import json
import os
import sys
from ctypes import wintypes
from datetime import datetime, timedelta, timezone
from pathlib import Path

RETENTION_DAYS = 90

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def log_dir():
    root = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")))
    return root / "qoder-deck" / "usage"


def detect_starts(previous, current):
    """进程集合差分：从无到有的可执行路径即一次真启动。"""
    return sorted(current - previous)


def detect_focus(last, current):
    """前台切换到不同可执行路径时返回它，否则 None。"""
    if current is None or current == last:
        return None
    return current


def _day_file(directory, kind, ts):
    return Path(directory) / f"{kind}-{ts.strftime('%Y%m%d')}.jsonl"


def append(directory, kind, exe, ts):
    """追加一条 {ts, exe} 记录。任何写入失败都吞掉：日志不能拖死服务。"""
    try:
        Path(directory).mkdir(parents=True, exist_ok=True)
        with _day_file(directory, kind, ts).open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"ts": ts.isoformat(timespec="seconds"), "exe": exe}, ensure_ascii=False) + "\n")
    except OSError:
        pass


def prune(directory, days=RETENTION_DAYS, now=None):
    """删除超过保留期的按天文件。"""
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=days)
    for path in Path(directory).glob("*-*.jsonl"):
        try:
            day = datetime.strptime(path.name.split("-")[-1].split(".")[0], "%Y%m%d").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if day < cutoff:
            try:
                path.unlink()
            except OSError:
                pass


def foreground_exe():
    """前台窗口所属进程的可执行路径。刻意不读取窗口标题。"""
    import ctypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return None
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if not pid.value:
        return None
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
    if not handle:
        return None
    try:
        buf = ctypes.create_unicode_buffer(512)
        size = wintypes.DWORD(512)
        ok = kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size))
        return buf.value if ok else None
    finally:
        kernel32.CloseHandle(handle)


def running_exes():
    import psutil

    exes = set()
    for proc in psutil.process_iter(["exe"]):
        exe = proc.info.get("exe")
        if exe:
            exes.add(exe)
    return exes


class Collector:
    """一次 collect() = 一轮前台轮询 + 进程差分，返回并落盘本轮事件。"""

    def __init__(self, directory=None):
        self.directory = Path(directory) if directory else log_dir()
        self.previous = None
        self.last_focus = None

    def collect(self, now=None):
        now = now or datetime.now(timezone.utc)
        events = []
        current = running_exes()
        if self.previous is not None:
            for exe in detect_starts(self.previous, current):
                events.append(("start", exe))
        self.previous = current
        focus = foreground_exe()
        switched = detect_focus(self.last_focus, focus)
        if switched:
            events.append(("focus", switched))
            self.last_focus = switched
        for kind, exe in events:
            append(self.directory, kind, exe, now)
        return events


def main(argv):
    sys.stdout.reconfigure(encoding="utf-8")
    interval = float(argv[0]) if argv else 2.0
    collector = Collector()
    prune(collector.directory)
    print(f"usage-log: 采集到 {collector.directory}，每 {interval}s 一轮；Ctrl-C 退出")
    import time

    last_prune = time.monotonic()
    try:
        while True:
            for kind, exe in collector.collect():
                print(f"  {kind}: {exe}")
            if time.monotonic() - last_prune > 3600:
                prune(collector.directory)
                last_prune = time.monotonic()
            time.sleep(interval)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
