"""看门狗：Wallpaper Engine 运行中且 5000 端口空闲时，自动拉起壁纸数据服务。

以 pythonw.exe 无窗口运行；放入启动文件夹实现登录后常驻。
"""
import socket
import subprocess
import sys
import time
from pathlib import Path

import psutil

HERE = Path(__file__).resolve().parent
SERVER = HERE.parent / "server.py"
HOST, PORT = "127.0.0.1", 5000
CHECK_INTERVAL = 15
WE_PROCESSES = {"wallpaper64.exe", "wallpaper32.exe"}


def we_running():
    for proc in psutil.process_iter(["name"]):
        if (proc.info["name"] or "").lower() in WE_PROCESSES:
            return True
    return False


def port_free():
    with socket.socket() as s:
        try:
            s.bind((HOST, PORT))
            return True
        except OSError:
            return False


def spawn_server():
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    subprocess.Popen(
        [str(pythonw), str(SERVER)],
        cwd=str(SERVER.parent),
        creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
    )


def main():
    while True:
        try:
            if we_running() and port_free():
                spawn_server()
        except Exception:
            pass
        time.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    main()
