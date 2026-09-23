"""编排互斥锁：手动 apply / 还原 / 看门狗增量编排不得并发写图标。

用目录的原子 mkdir 做跨进程锁（Windows 上 mkdir 已存在即失败）。拿不到锁
的一方：看门狗跳过本轮，命令行等待数秒后明确报错退出——宁可这次不排，
也不能两个写者交错落位（实机踩过：文档错位一行）。
"""
import os
import time
from pathlib import Path


class ArrangeBusy(Exception):
    """另一个编排者正持有锁。"""


def lock_path():
    root = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")))
    return root / "qoder-deck" / "arrange.lock"


class ArrangeLock:
    def __init__(self, wait_seconds=5.0, poll=0.25):
        self.path = lock_path()
        self.wait_seconds = wait_seconds
        self.poll = poll

    def __enter__(self):
        deadline = time.monotonic() + self.wait_seconds
        while True:
            try:
                os.mkdir(self.path)
                return self
            except FileExistsError:
                if time.monotonic() >= deadline:
                    raise ArrangeBusy(f"编排锁被占用：{self.path}")
                time.sleep(self.poll)

    def __exit__(self, *exc):
        try:
            os.rmdir(self.path)
        except OSError:
            pass
        return False
