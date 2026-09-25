"""搜索面板：数据服务自有的常驻无边框窗口（ADR-0003，ticket 01）。

待机态伪装成 DECK 右窄栏顶部的静态视觉（黑底、Decima Mono Cyr、
#2c2c2c 分隔线），与壁纸黑底无缝融合；点击转活动态，原生输入框可打字
（中文输入法可用）；ESC/失焦退回待机态并清空查询词。引擎接入（Listary
HTTP API）在 ticket 02，本模块不涉及；活动态空输入时显示 AWAITING
ENGINE 占位。

窗口绘制 SEARCH 面板头与输入行两层视觉，壁纸侧只为它让出固定高度的
空位（几何常量见 PANEL，/deck 以 panel 字段暴露给壁纸）。
"""

import ctypes
import os
import threading
import time
import traceback

# ---- 几何（物理像素，2560×1440 @100% 缩放；与 DECK 布局常量对应）----
# x 对齐 DECK #right 内容区左缘：2560 − 2.6rem(41.6) − 36rem(576)
# + 1px 左边框 + 2.4rem(38.4) 内边距 = 1981.8 ≈ 1982；
# y = 2.2rem + 顶栏 4.6rem + 行距 1.6rem = 134.4 ≈ 134
PANEL = {"x": 1982, "y": 134, "w": 536, "h": 64}
_measured = {"h": None}  # 窗口实测高度（面板线程写入，panel_rect 读取；GIL 下原子）

# ---- 视觉（与 DECK index.html 同源）----
FONT_PATH = r"D:\Steam\steamapps\common\wallpaper_engine\projects\myprojects\qoder-deck\fonts\DecimaMonoCyr.ttf"
FONT_FAMILY = "Decima Mono Cyr"  # TTF 实际族名（CSS 里的 "Decima Mono" 只是别名）
FONT_SIZE_PX = 17  # ≈ DECK body 1.05rem
BG = "#000000"
WHITE = "#ffffff"   # 面板头（同 .panel-head）
FG = "#d6d6d6"      # 输入文本（同 body 色）
DIM = "#616161"     # 待机提示 / 占位（≈ #d6d6d6 @45% 压在黑底上）
LINE = "#2c2c2c"    # 分隔线
HEAD_TEXT = "SEARCH"
HINT_TEXT = "CLICK TO SEARCH_"
PLACEHOLDER_TEXT = "AWAITING ENGINE (02)_"  # 活动态空输入占位：引擎在 ticket 02 接入


class PanelStateMachine:
    """待机态 ⇄ 活动态的转移规则（纯逻辑，离线可测）。

    事件：click（点击面板）、esc（按 Esc）、blur（焦点移出）。
    esc 与 blur 是同一转移的两种触发，保留两个事件名以对齐操作集
    词汇；退回待机态时清空查询词——下次激活从空查询开始。
    """

    IDLE = "IDLE"
    ACTIVE = "ACTIVE"

    def __init__(self):
        self.state = self.IDLE
        self.query = ""

    def set_query(self, text):
        if self.state == self.ACTIVE:
            self.query = text

    def on_event(self, event):
        if self.state == self.IDLE:
            if event == "click":
                self.state = self.ACTIVE
        elif event in ("esc", "blur"):
            self.state = self.IDLE
            self.query = ""
        return self.state


def panel_rect():
    """窗口矩形（/deck 的 panel 字段来源）。窗口未运行时返回静态默认。"""
    return dict(PANEL, h=_measured["h"] or PANEL["h"])


class SearchPanelApp:
    """Tk 窗口层：只在本线程内触碰 Tk（线程安全性由调用方保证）。"""

    def __init__(self):
        self.machine = PanelStateMachine()

    def _trace(self, tag):
        # QD_PANEL_TRACE=<路径> 时追加事件流水（验收电池/排障用）
        path = os.environ.get("QD_PANEL_TRACE")
        if path:
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(f"{time.time():.3f} {tag} state={self.machine.state} "
                         f"query={self.machine.query!r} hwnd={getattr(self, 'root', None) and self.root.winfo_id()}\n")

    def run(self):
        import tkinter as tk
        from tkinter import font as tkfont

        self._load_deck_font()
        root = tk.Tk()
        root.overrideredirect(True)  # 无边框：视觉即壁纸的一部分
        root.configure(bg=BG)
        root.geometry(f"{PANEL['w']}x{PANEL['h']}+{PANEL['x']}+{PANEL['y']}")
        self.root = root
        self.font = tkfont.Font(family=FONT_FAMILY, size=-FONT_SIZE_PX)

        # 布局：面板头 / 输入行 / 分隔线
        self.head = tk.Label(root, text=HEAD_TEXT, fg=WHITE, bg=BG,
                             font=self.font, anchor="w")
        self.head.pack(fill="x")
        self.box = tk.Frame(root, bg=BG, height=30)
        self.box.pack_propagate(False)
        self.box.pack(fill="x", pady=(13, 0))
        self.hint = tk.Label(self.box, text=HINT_TEXT, fg=DIM, bg=BG,
                             font=self.font, anchor="w")
        self.hint.pack(fill="both", expand=True)
        self.entry = tk.Entry(self.box, fg=FG, bg=BG, font=self.font,
                              insertbackground=FG, relief="flat",
                              selectbackground=LINE, selectforeground=WHITE,
                              highlightthickness=0, takefocus=True)
        self.placeholder = tk.Label(self.box, text=PLACEHOLDER_TEXT, fg=DIM, bg=BG,
                                    font=self.font, anchor="w")
        self.sep = tk.Frame(root, bg=LINE, height=1)
        self.sep.pack(fill="x", pady=(2, 0))

        # 事件：点击（任意部位，含分隔线与占位）激活；Esc/失焦退待机
        for w in (root, self.head, self.box, self.hint, self.sep, self.placeholder):
            w.bind("<Button-1>", lambda e: self._activate(), add="+")
        self.entry.bind("<Button-1>", lambda e: self._activate(), add="+")
        self.entry.bind("<Escape>", lambda e: self._deactivate("esc"))
        self.entry.bind("<FocusOut>", lambda e: self._deactivate("blur"))
        self.entry.bind("<KeyRelease>", self._on_key, add="+")

        root.update_idletasks()
        _measured["h"] = max(PANEL["h"], root.winfo_reqheight())

        crash_after = os.environ.get("QD_PANEL_CRASH")
        if crash_after:
            # 验收钩子：到点销毁窗口退出 mainloop，再在线程体内抛错，
            # 使窗口线程真实终结（Tk 回调里的异常会被吞掉，杀不死线程）
            root.after(int(float(crash_after) * 1000), self._crash_for_test)
        autoactivate = os.environ.get("QD_PANEL_AUTOACTIVATE")
        if autoactivate:
            # 验收钩子：程序化激活（不依赖外部鼠标；截图取证/电池用）
            root.after(int(float(autoactivate) * 1000), self._activate)

        root.mainloop()
        if self._crash_requested:
            raise RuntimeError("search-panel: QD_PANEL_CRASH boom")

    # ---- 内部 ----
    _crash_requested = False

    @staticmethod
    def _load_deck_font():
        # DECK 字体未安装到系统；进程内私有加载，Tk 即可按族名取用
        try:
            ctypes.windll.gdi32.AddFontResourceExW(FONT_PATH, 0x10, 0)  # FR_PRIVATE
        except Exception:
            traceback.print_exc()

    def _activate(self):
        # 活动态下重复点击 = 摆放光标，不重置查询（状态机对 click 幂等）
        self._trace("click")
        self.machine.on_event("click")
        self._render_active()
        self.entry.focus_set()

    def _deactivate(self, event):
        self._trace(event)
        self.machine.on_event(event)  # 转移本身已清空查询词
        self.entry.delete(0, "end")
        self._render_idle()

    def _on_key(self, *_):
        self.machine.set_query(self.entry.get())
        self._trace("key")
        self._render_active()  # 空输入显示占位、有输入显示文本

    def _render_active(self):
        # 用几何管理器归属判断（winfo_manager），不依赖窗口是否已映射：
        # pack 与映射之间有时间窗，按 ismapped 判断会让组件卡在堆叠里
        if self.hint.winfo_manager():
            self.hint.pack_forget()
        if not self.entry.winfo_manager():
            self.entry.pack(fill="both", expand=True)
        show_placeholder = not self.entry.get()
        if show_placeholder and not self.placeholder.winfo_manager():
            self.placeholder.place(in_=self.box, relwidth=1, relheight=1)
        elif not show_placeholder and self.placeholder.winfo_manager():
            self.placeholder.place_forget()

    def _render_idle(self):
        if self.entry.winfo_manager():
            self.entry.pack_forget()
        if self.placeholder.winfo_manager():
            self.placeholder.place_forget()
        if not self.hint.winfo_manager():
            self.hint.pack(fill="both", expand=True)

    def _crash_for_test(self):
        # 验收用：人为让窗口线程终结，验证数据服务本体不受影响（ticket 01）
        self._crash_requested = True
        self.root.destroy()


def run_app():
    """窗口入口：任何异常只终结本线程，绝不外溢到数据服务。"""
    try:
        ctypes.windll.user32.SetProcessDPIAware()  # 物理像素几何（100% 缩放下恒等）
    except Exception:
        pass
    try:
        SearchPanelApp().run()
    except Exception:
        traceback.print_exc()
        print("search-panel: 窗口线程退出，数据服务不受影响", flush=True)


def start_thread():
    t = threading.Thread(target=run_app, name="search-panel", daemon=True)
    t.start()
    return t
