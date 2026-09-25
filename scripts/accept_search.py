"""搜索面板实机验收电池：python scripts/accept_search.py [--runs 2]

覆盖 listary-search 票 05 主链路：面板窗存在且几何落位 → 模拟点击激活 →
键入探针词 → 真实引擎返回结果 → 结果渲染断言 → Enter 打开验收专用的临时
探针文件 → Ctrl+Enter 资源管理器定位 → ESC/失焦退回待机态 → 全程截图存证
到 .scratch/listary-search/evidence/。探针文件与验收中打开的窗口、剪贴板、
被最小化的窗口在结束后清理/还原；幂等可重复执行，任一步失败非零退出并
指明失败步骤（--runs N 连跑 N 轮，全部通过才算通过）。

打字走剪贴板粘贴（Ctrl+V 绕开中文输入法合成，ticket 01 探针先例）；
面板当黑盒对待：只经 Win32（窗口矩形/类名/鼠标/关窗）与 /deck 契约观察，
不依赖进程内钩子。
"""
import argparse
import ctypes
import ctypes.wintypes as wt
import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

import listary_engine as engine  # noqa: E402

HOST, PORT = "127.0.0.1", 5000
DECK_URL = f"http://{HOST}:{PORT}/deck"
EVIDENCE_DEFAULT = ROOT / ".scratch" / "listary-search" / "evidence"
PS_HELPER = HERE / "accept_search_ui.ps1"

# 面板输入行中心相对窗口左上角的偏移（ticket 01/03 探针实测：屏幕 2250,183）
ENTRY_DX_FROM_LEFT = 268   # 面板宽 536 的一半
ENTRY_DY_FROM_TOP = 49

ENGINE_INDEX_TIMEOUT_S = 90.0   # 新文件入索引（USN）偶有滞后
UI_TIMEOUT_S = 20.0             # 防抖 + 引擎往返 + 渲染
CLOSE_TIMEOUT_S = 10.0

GEOM_TOLERANCE = 3              # Tk 定位取整容差（物理像素）
RESULTS_MIN_GROWTH = 35         # 一行结果 + TOTAL 行的最小展开高度

FAILURES = []


def check(run, name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        FAILURES.append(f"run{run} {name}")


def wait_for(predicate, timeout, step=0.5):
    """轮询到谓词真值。返回最后一次谓词值本身（真即成功，超时为最后的假值），
    调用方拿到的就是窗口列表/布尔等原生结果。"""
    result = predicate()
    deadline = time.monotonic() + timeout
    while not result and time.monotonic() < deadline:
        time.sleep(step)
        result = predicate()
    return result


# ---- PowerShell UI 动作（SendKeys/剪贴板/截图/最小化，探针同款技术）----

def ps(action, **kwargs):
    cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
           "-File", str(PS_HELPER), "-Action", action]
    for key, value in kwargs.items():
        cmd += [f"-{key.replace('_', '')}", str(value)]
    return subprocess.run(cmd, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=60,
                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def shot(evidence, name, rect):
    # 截图框随面板真实矩形走（外扩留上下文），不绑定某一台显示器的绝对坐标
    x, y, w, _h = rect
    result = ps("shot", path=evidence / f"{name}.png",
                x=max(0, x - 50), y=max(0, y - 34), w=w + 100, h=600)
    if result.returncode != 0:
        print(f"    (截图失败 {name}: {result.stderr.strip()[:120]})")


# ---- Win32：窗口枚举 / 矩形 / 鼠标 / 关窗 ----

user32 = ctypes.windll.user32


def _rect_of(hwnd):
    rect = wt.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return None
    return (rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top)


def visible_windows():
    """[(hwnd, class, title, (x, y, w, h))] — 当前桌面全部可见顶层窗。"""
    found = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def callback(hwnd, _l):
        if user32.IsWindowVisible(hwnd):
            cls = ctypes.create_unicode_buffer(64)
            title = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, cls, 64)
            user32.GetWindowTextW(hwnd, title, 256)
            rect = _rect_of(hwnd)
            if rect:
                found.append((hwnd, cls.value, title.value, rect))
        return True

    user32.EnumWindows(callback, 0)
    return found


def find_panel(deck_panel):
    """按 /deck 契约的几何在真实桌面上找面板窗（Tk 无标题，矩形+类名即指纹；
    /deck 由同一服务给出，矩形比对的意义在「服务声称的几何 == 真实窗口几何」）。"""
    x, y, w = deck_panel["x"], deck_panel["y"], deck_panel["w"]
    for hwnd, cls, _title, (rx, ry, rw, _rh) in visible_windows():
        if (cls == "TkTopLevel"
                and abs(rx - x) <= GEOM_TOLERANCE and abs(ry - y) <= GEOM_TOLERANCE
                and abs(rw - w) <= GEOM_TOLERANCE):
            return hwnd, cls, (rx, ry, rw, _rh)
    return None, None, None


def click(x, y):
    user32.SetCursorPos(x, y)
    time.sleep(0.2)
    user32.mouse_event(0x0002, 0, 0, 0, 0)  # LEFTDOWN
    user32.mouse_event(0x0004, 0, 0, 0, 0)  # LEFTUP
    time.sleep(0.5)


def panel_height(hwnd):
    rect = _rect_of(hwnd)
    return rect[3] if rect else 0


def close_windows(hwnds):
    for hwnd in hwnds:
        user32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE
    return wait_for(lambda: not [h for h in hwnds if user32.IsWindowVisible(h)],
                    CLOSE_TIMEOUT_S)


def panel_is_foreground(hwnd):
    """键盘焦点是否在面板进程：SendKeys 只发给系统前台窗。"""
    fg = user32.GetForegroundWindow()
    if not fg:
        return False
    pid_panel, pid_fg = wt.DWORD(), wt.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid_panel))
    user32.GetWindowThreadProcessId(fg, ctypes.byref(pid_fg))
    return pid_fg.value == pid_panel.value


def panel_sendkeys(entry_x, entry_y, hwnd, keys):
    """物理点击把面板进程置前台（无框窗不经任务栏激活，点击是唯一可靠途径），
    确认后才发键——否则键会落进碰巧持有焦点的其他窗口。前台校验失败不发键，
    返回 False 由调用方终止本轮（后续断言会失真，且乱发键有副作用）。"""
    for _attempt in range(3):
        if panel_is_foreground(hwnd):
            break
        click(entry_x, entry_y)
    if not panel_is_foreground(hwnd):
        return False
    ps("sendkeys", text=keys)
    return True


WM_SYSCOMMAND = 0x0112
SC_MINIMIZE, SC_RESTORE = 0xF020, 0xF120
SHELL_CLASSES = {"Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Progman", "WorkerW", "Button"}


def minimize_desktop(skip_hwnd):
    """逐窗最小化桌面（跳过面板与 shell 桌面/任务栏），返回被最小化的句柄。

    不用 Shell 的 MinimizeAll/UndoMinimizeAll：那个循环会连无框面板一起卷进
    最小化-还原，还原时 Tk overrideredirect 窗口的几何会被重置（实测
    536×64+1982+134 漂成 268×60@(991,67)，面板直接报废，需杀服务自愈）。"""
    targets = [h for h, c, _t, _r in visible_windows()
               if h != skip_hwnd and c not in SHELL_CLASSES]
    for h in targets:
        user32.PostMessageW(h, WM_SYSCOMMAND, SC_MINIMIZE, 0)
    time.sleep(1.5)
    return targets


def restore_windows(hwnds):
    for h in hwnds:
        if user32.IsWindow(h):
            user32.PostMessageW(h, WM_SYSCOMMAND, SC_RESTORE, 0)


def windows_titled(token):
    return [(h, c, t) for h, c, t, _r in visible_windows() if token in t]


# ---- 验收链 ----

def deck_panel_contract():
    try:
        with urllib.request.urlopen(DECK_URL, timeout=5) as resp:
            panel = json.loads(resp.read()).get("panel")
    except (OSError, ValueError):
        return None
    return panel if isinstance(panel, dict) and {"x", "y", "w", "h"} <= set(panel) else None


def engine_has_probe_first(word, probe_path):
    """直连真实引擎：探针文件已入索引且排首位（Enter 打开的是选中首行）。
    搜词用完整文件名（含扩展名）——裸 token 会把同名探针目录顶到首位。"""
    try:
        payload = engine.http_search(word)
    except OSError:
        return False
    items = engine.parse_response(payload).items
    return bool(items) and items[0].path.lower() == probe_path.lower()


def run_chain(run, evidence):
    token = f"zzdeck05-{time.strftime('%H%M%S')}-{run}"
    probe_dir = Path(tempfile.gettempdir()) / token
    probe_file = probe_dir / f"{token}.txt"
    word = probe_file.name  # 搜完整文件名：唯一且必排首位（目录不匹配 .txt）

    # 预检：部署契约 + 引擎在线（失败即停在带名字的步骤上）
    deck_panel = deck_panel_contract()
    check(run, "数据服务 /deck panel 契约", deck_panel is not None, str(deck_panel))
    if not deck_panel:
        return

    saved_clip = ps("clip-get").stdout
    pt = wt.POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    saved_cursor = (pt.x, pt.y)
    minimized = []

    try:
        # 探针文件（唯一名；结束即删）
        probe_dir.mkdir(parents=True)
        probe_file.write_text("listary-search acceptance probe\n", encoding="utf-8")
        check(run, "探针文件已创建", probe_file.exists(), str(probe_file))

        ok = wait_for(lambda: engine_has_probe_first(word, str(probe_file)),
                      ENGINE_INDEX_TIMEOUT_S, step=1.5)
        check(run, "真实引擎返回探针结果（直连且首位）", ok)

        # 面板窗存在且几何落位
        hwnd, cls, rect = find_panel(deck_panel)
        check(run, "面板窗存在且几何落位", hwnd is not None,
              f"actual={rect} contract=({deck_panel['x']},{deck_panel['y']},{deck_panel['w']}) class={cls}")
        if not hwnd:
            return
        entry_x, entry_y = rect[0] + ENTRY_DX_FROM_LEFT, rect[1] + ENTRY_DY_FROM_TOP

        def send(keys):
            """带前台门的安全发键：焦点拿不到就不发（乱发键有副作用）并终止本轮。"""
            if not panel_sendkeys(entry_x, entry_y, hwnd, keys):
                check(run, "键盘焦点在面板进程", False, f"发 {keys} 前前台校验失败")
                return False
            return True

        def activate_and_type():
            """点击激活 → 粘探针词 → 等窗口展开（链中三处共用）。"""
            click(entry_x, entry_y)
            return send("^v") and wait_for(
                lambda: panel_height(hwnd) >= base_h + RESULTS_MIN_GROWTH, UI_TIMEOUT_S)

        suffix = f"-r{run}"
        minimized = minimize_desktop(hwnd)

        # 基线门：先前的交互可能把面板留在活动态（展开态高度会让基线锚错、
        # 后续断言全部失真）；归位失败则本轮作废，清理仍走 finally
        settled = False
        for _attempt in range(2):
            if not send("{ESC}"):
                break
            if wait_for(lambda: panel_height(hwnd) <= deck_panel["h"] + GEOM_TOLERANCE, 3.0):
                settled = True
                break
        check(run, "面板归位待机态（基线高度）", settled, f"h={panel_height(hwnd)}")
        if not settled:
            return
        base_h = panel_height(hwnd)
        shot(evidence, "22-idle" + suffix, rect)

        # 模拟点击激活 → 键入探针词：断言的是防抖-引擎-渲染管线打通（窗口展开）。
        # 「首行确为探针文件」由下一步 Enter 打开实证——空结果/OFFLINE 同样会展开，
        # 高度区分不了，故此步不冒充渲染正确性
        click(entry_x, entry_y)
        shot(evidence, "23-active" + suffix, rect)
        ps("clip-set", text=word)
        expanded = activate_and_type()
        check(run, "键入探针词后防抖-引擎-渲染管线打通（窗口展开）", expanded,
              f"h={panel_height(hwnd)} base={base_h}")
        if not expanded:
            return
        shot(evidence, "24-results" + suffix, rect)

        # Enter 打开探针文件（默认应用无关：新窗标题含唯一文件名）
        if not send("{ENTER}"):
            return
        opened = wait_for(lambda: windows_titled(word), UI_TIMEOUT_S)
        check(run, "Enter 打开验收探针文件", bool(opened),
              str([t for _h, _c, t in opened][:2]))
        shot(evidence, "25-open" + suffix, rect)
        check(run, "打开的窗口已关闭", close_windows([h for h, _c, _t in opened]))

        # Ctrl+Enter 资源管理器定位（CabinetWClass 标题含探针目录名）
        if not activate_and_type():
            return
        if not send("^{ENTER}"):
            return
        revealed = wait_for(
            lambda: [(h, t) for h, c, t, _r in visible_windows()
                     if c == "CabinetWClass" and token in t],
            UI_TIMEOUT_S)
        check(run, "Ctrl+Enter 资源管理器定位", bool(revealed), str(revealed[:1]))
        shot(evidence, "26-reveal" + suffix, rect)
        check(run, "资源管理器窗口已关闭", close_windows([h for h, _t in revealed]))

        # ESC 收起结果退回待机态（高度回基线）
        if not activate_and_type():
            return
        if not send("{ESC}"):
            return
        idle = wait_for(lambda: panel_height(hwnd) <= base_h + GEOM_TOLERANCE, UI_TIMEOUT_S)
        check(run, "ESC 退回待机态（窗口收回）", idle,
              f"h={panel_height(hwnd)} base={base_h}")
        shot(evidence, "27-idle-after-esc" + suffix, rect)

        # 失焦退待机：前台交还桌面（等效「点击桌面别处」），面板应自行收起
        if not activate_and_type():
            return
        shell_hwnd = user32.GetShellWindow()
        blurred = bool(shell_hwnd) and bool(user32.SetForegroundWindow(shell_hwnd))
        idle2 = blurred and wait_for(
            lambda: panel_height(hwnd) <= base_h + GEOM_TOLERANCE, UI_TIMEOUT_S)
        check(run, "失焦退回待机态（窗口收回）", idle2,
              f"h={panel_height(hwnd)} base={base_h}")
        shot(evidence, "28-idle-after-blur" + suffix, rect)

    finally:
        # 兜底清理对崩溃/失败路径同样生效：先关探针窗口（explorer 持句柄会卡住删目录）
        closed = close_windows([h for h, _c, _t in windows_titled(token)])
        for _attempt in range(3):  # explorer 缩略图线程可能晚放句柄
            shutil.rmtree(probe_dir, ignore_errors=True)
            if not probe_dir.exists():
                break
            time.sleep(1.0)
        check(run, "收尾清理（探针窗口与目录）", closed and not probe_dir.exists(),
              str(probe_dir) if probe_dir.exists() else "")
        ps("clip-set", text=saved_clip)
        restore_windows(minimized)
        user32.SetCursorPos(*saved_cursor)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--runs", type=int, default=1, help="连续执行轮数（默认 1）")
    args = parser.parse_args()
    user32.SetProcessDPIAware()  # 物理像素坐标（面板几何即物理像素）

    evidence = EVIDENCE_DEFAULT
    evidence.mkdir(parents=True, exist_ok=True)

    for run in range(1, args.runs + 1):
        print(f"=== 第 {run}/{args.runs} 轮 ===")
        run_chain(run, evidence)
        time.sleep(2.0)

    print()
    if FAILURES:
        print(f"验收失败 {len(FAILURES)} 项：{FAILURES}")
        return 1
    print(f"验收电池全部通过（{args.runs} 轮一致）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
