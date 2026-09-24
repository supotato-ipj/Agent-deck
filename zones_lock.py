"""编排互斥锁：手动 apply / 还原 / 看门狗增量编排不得并发写图标。

用目录的原子 mkdir 做跨进程锁（Windows 上 mkdir 已存在即失败）。目录内再写
一个 holder 标记（pid + 时间戳）用于陈旧检测：持锁进程被杀（实机踩过：
Stop-Process 撞在看门狗编排上）会留下孤儿锁，把看门狗和命令行永久堵死。
拿不到锁的一方：看门狗跳过本轮，命令行等待数秒后明确报错退出——宁可这次
不排，也不能两个写者交错落位。
"""
import os
import time
from pathlib import Path

import psutil

STALE_SECONDS = 60.0


class ArrangeBusy(Exception):
    """另一个编排者正持有锁。"""


def lock_path():
    root = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")))
    return root / "qoder-deck" / "arrange.lock"


class ArrangeLock:
    def __init__(self, wait_seconds=5.0, poll=0.25):
        self.path = lock_path()
        self.holder = self.path / "holder"
        self.wait_seconds = wait_seconds
        self.poll = poll

    def _stale(self):
        try:
            pid, stamp = self.holder.read_text(encoding="utf-8").split()
        except (OSError, ValueError):
            return True  # 没有 holder 标记 = 半死锁
        if time.time() - float(stamp) > STALE_SECONDS:
            return True
        return not psutil.pid_exists(int(pid))

    def _break_stale(self):
        try:
            self.holder.unlink()
        except OSError:
            pass
        try:
            os.rmdir(self.path)
        except OSError:
            return False
        return True

    def __enter__(self):
        deadline = time.monotonic() + self.wait_seconds
        while True:
            try:
                os.mkdir(self.path)
                self.holder.write_text(f"{os.getpid()} {time.time()}", encoding="utf-8")
                return self
            except FileExistsError:
                if self._stale() and self._break_stale():
                    continue
                if time.monotonic() >= deadline:
                    raise ArrangeBusy(f"编排锁被占用：{self.path}")
                time.sleep(self.poll)

    def __exit__(self, *exc):
        try:
            self.holder.unlink()
        except OSError:
            pass
        try:
            os.rmdir(self.path)
        except OSError:
            pass
        return False
