"""搜索面板：数据服务自有的常驻无边框窗口（ADR-0003，ticket 01/02）。

待机态伪装成 DECK 右窄栏顶部的静态视觉（黑底、Decima Mono Cyr、
#2c2c2c 分隔线），与壁纸黑底无缝融合；点击转活动态，原生输入框可打字
（中文输入法可用）；ESC/失焦退回待机态并清空查询词。

引擎链路（ticket 02）：输入经防抖（listary_engine.Debouncer，约 200ms）
后由工作线程调用 Listary 本地 HTTP API，结果经队列回传 Tk 线程自绘为
约 8 行（名称 + 截断父路径 + 总数）；引擎不可达显示 ENGINE OFFLINE 并
自动重试，限流静默退避。查询词不写入任何日志与追踪文件（ADR-0002 精神，
QD_PANEL_TRACE 只记事件与长度，不记内容）。

窗口绘制 SEARCH 面板头与输入行两层视觉，壁纸侧只为它让出固定高度的
空位（几何常量见 PANEL，/deck 以 panel 字段暴露给壁纸）。
"""

import ctypes
import os
import queue
import subprocess
import threading
import time
import traceback

import tkinter as tk
from tkinter import font as tkfont

import listary_engine as engine

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
PLACEHOLDER_TEXT = "TYPE TO SEARCH FILES_"
NO_RESULTS_TEXT = "NO RESULTS"
OFFLINE_TEXT = "ENGINE OFFLINE"
NAME_CHARS = 26   # 结果行名称截断（保留头部）
PATH_CHARS = 22   # 结果行父路径截断（保留尾部，辨识段在结尾）
ROW_H = 22        # 结果行高（与输入行 30 区分：列表更紧凑）
CTRL_MASK = 0x0004  # Tk event.state 的 Control 位（X11/Win32 一致）


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
        self._debouncer = engine.Debouncer()
        self._results_q = queue.Queue()
        self._search_gen = 0        # 单飞行代际：新查询作废旧响应
        self._rate_attempt = 0      # 限流退避次数（成功清零）
        self._sel = engine.SelectionModel()  # 选中项（结果刷新重置回首项）
        self._items = []            # 当前渲染的结果（动作按索引取路径）
        self._rows = []             # 行控件 [(frame, name_label, path_label)]

    def _trace(self, tag):
        # QD_PANEL_TRACE=<路径> 时追加事件流水（验收电池/排障用）。
        # 只记事件与查询长度，绝不记查询内容（ADR-0002 精神）。
        path = os.environ.get("QD_PANEL_TRACE")
        if path:
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(f"{time.time():.3f} {tag} state={self.machine.state} "
                         f"qlen={len(self.machine.query)} "
                         f"hwnd={getattr(self, 'root', None) and self.root.winfo_id()}\n")

    def run(self):
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
        self.var = tk.StringVar(root)
        # 文本变化走 StringVar 追踪（而非 KeyRelease）：中文输入法合成提交
        # 对 var 生效但不一定逐键触发 KeyRelease
        self.var.trace_add("write", lambda *_: self._on_text_changed())
        self.entry = tk.Entry(self.box, textvariable=self.var, fg=FG, bg=BG, font=self.font,
                              insertbackground=FG, relief="flat",
                              selectbackground=LINE, selectforeground=WHITE,
                              highlightthickness=0, takefocus=True)
        self.placeholder = tk.Label(self.box, text=PLACEHOLDER_TEXT, fg=DIM, bg=BG,
                                    font=self.font, anchor="w")
        self.sep = tk.Frame(root, bg=LINE, height=1)
        self.sep.pack(fill="x", pady=(2, 0))
        # 结果区：渲染在分隔线下方，窗口随内容向下展开（活动态临时盖住
        # 壁纸会话列表，ESC 即收起——搜索面板的既有交互惯例）
        self.results_host = tk.Frame(root, bg=BG)
        self.results_host.pack(fill="x")

        # 事件：点击（任意部位，含分隔线与占位）激活；Esc/失焦退待机
        for w in (root, self.head, self.box, self.hint, self.sep, self.placeholder):
            w.bind("<Button-1>", lambda e: self._activate(), add="+")
        self.entry.bind("<Button-1>", lambda e: self._activate(), add="+")
        self.entry.bind("<Escape>", lambda e: self._deactivate("esc"))
        self.entry.bind("<FocusOut>", lambda e: self._deactivate("blur"))
        # 结果操作集（ticket 03）：键→动作的判一出口在 engine.decide_action，
        # 这里只翻译 Tk 键名；"break" 吞掉 ↑↓ 移动光标的默认行为
        self.entry.bind("<Up>", lambda e: self._on_key("up", e))
        self.entry.bind("<Down>", lambda e: self._on_key("down", e))
        self.entry.bind("<Return>", lambda e: self._on_key("return", e))

        root.update_idletasks()
        _measured["h"] = max(PANEL["h"], root.winfo_reqheight())
        self._base_h = _measured["h"]
        root.after(50, self._tick)  # 防抖到期检查 + 结果队列回传（Tk 线程内）

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
        self._search_gen += 1      # 作废在途响应
        self._debouncer.reset()
        self._rate_attempt = 0
        self.machine.on_event(event)  # 转移本身已清空查询词
        self.entry.delete(0, "end")   # 触发 var 追踪，但状态已 IDLE 不再喂防抖
        self._clear_results()
        self._apply_height()
        self._render_idle()

    def _on_text_changed(self):
        text = self.var.get()
        self.machine.set_query(text)
        self._render_active()  # 空输入显示占位、有输入显示文本
        if self.machine.state == PanelStateMachine.ACTIVE:
            self._debouncer.feed(text, time.monotonic())
            if not text:
                self._clear_results()
                self._apply_height()

    # ---- 引擎链路（防抖到期 → 工作线程请求 → 队列回传 → 渲染）----

    def _tick(self):
        try:
            due = self._debouncer.due(time.monotonic())
            if due:
                self._start_search(due)
            self._drain_results()
        finally:
            self.root.after(50, self._tick)

    def _start_search(self, query):
        self._trace(f"search len={len(query)}")
        self._search_gen += 1
        gen = self._search_gen

        def work():
            try:
                payload = engine.http_search(query)
                self._results_q.put((gen, query, payload, None))
            except Exception as exc:  # 连接失败/超时：交给错误分类
                self._results_q.put((gen, query, None, exc))

        threading.Thread(target=work, name="search-panel-query", daemon=True).start()

    def _schedule_rate_backoff(self):
        # 限流静默退避：保持现有展示，按退避曲线重试当前词
        self._rate_attempt += 1
        delay = engine.backoff_delay(self._rate_attempt)
        self.root.after(int(delay * 1000), self._retry_now)

    def _schedule_offline_retry(self):
        self.root.after(int(engine.OFFLINE_RETRY_S * 1000), self._retry_now)

    def _retry_now(self):
        # 重试入口：仍活动且有词才重发（feed_due 绕过防抖但保留同词去重）
        if self.machine.state != PanelStateMachine.ACTIVE:
            return
        self._trace("retry")
        self._debouncer.feed_due(self.var.get())

    def _drain_results(self):
        latest = None
        while True:
            try:
                item = self._results_q.get_nowait()
            except queue.Empty:
                break
            latest = item  # 同批多次响应只保留最后一个
        if not latest:
            return
        gen, query, payload, exc = latest
        if gen != self._search_gen:
            return  # 过期响应（用户已继续输入或已退待机）
        if exc is not None:
            kind = engine.classify_failure(exc)      # 连接失败 → offline
        else:
            kind = engine.classify_failure(payload)  # ok → None；错误载荷 → 分类
        if kind is None:
            self._rate_attempt = 0
            model = engine.parse_response(payload)
            self._trace(f"results total={model.total} n={len(model.items)}")
            self._render_results(model)
        elif kind == "rate_limited":
            # 仅限流走静默退避重试（spec：TOO_MANY_REQUESTS 静默退避）
            self._trace(kind)
            self._schedule_rate_backoff()
        elif kind == "error":
            # 引擎在线但响应异常：不冒充离线也不自动重试，等下次输入
            self._trace(kind)
        else:  # offline：引擎不可达/未就绪
            self._trace("offline")
            self._render_offline()
            self._schedule_offline_retry()

    # ---- 结果操作集（ticket 03）----

    def _on_key(self, key, event):
        action = engine.decide_action(key, ctrl=bool(event.state & CTRL_MASK))
        if action:
            self._on_action(action)
            return "break"
        return None

    def _on_action(self, action):
        if action in ("prev", "next"):
            self._move_selection(-1 if action == "prev" else 1)
            return
        idx = self._sel.index
        if idx < 0 or idx >= len(self._items):
            return
        self._act(self._items[idx].path, reveal=(action == "reveal"))

    def _move_selection(self, delta):
        # 列表恒 ≤8 行且窗口随行数展开，选中项天然可见，无需滚动
        self._sel.move(delta)
        self._apply_selection()

    def _act(self, path, reveal):
        # 动作由数据服务进程直接执行（ADR-0003：能力在数据服务内）。
        # startfile 走 ShellExecute；explorer 亦按仓库先例带 CREATE_NO_WINDOW，
        # 双保险保证不闪控制台
        self._trace("reveal" if reveal else "open")
        try:
            if reveal:
                subprocess.Popen(["explorer", "/select,", path],
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            else:
                os.startfile(path)  # noqa: S606 — 面板本义就是打开用户选中的路径
        except Exception:
            traceback.print_exc()
        # 动作完成即收起：走 ESC 同款待机转移（打开的窗口随即接管焦点）
        self._deactivate("esc")

    def _apply_selection(self):
        for i, (row, name_lbl, path_lbl) in enumerate(self._rows):
            if i == self._sel.index:  # 反白选中（同壁纸 st-CONFIRM/OFFLINE 语言）
                row.configure(bg=FG)
                name_lbl.configure(bg=FG, fg=BG)
                path_lbl.configure(bg=FG, fg=BG)
            else:
                row.configure(bg=BG)
                name_lbl.configure(bg=BG, fg=WHITE)
                path_lbl.configure(bg=BG, fg=DIM)

    # ---- 结果渲染 ----

    def _render_results(self, model):
        host = self.results_host
        self._clear_results()
        if not model.items:
            tk.Label(host, text=NO_RESULTS_TEXT, fg=DIM, bg=BG,
                     font=self.font, anchor="w").pack(fill="x", pady=(6, 0))
        else:
            shown = model.items[: engine.DEFAULT_LIMIT]
            self._items = shown
            for i, item in enumerate(shown):
                row = tk.Frame(host, bg=BG, height=ROW_H)
                row.pack_propagate(False)
                row.pack(fill="x")
                name, parent = engine.display_parts(item.path)
                name_lbl = tk.Label(row, text=engine.elide_right(name, NAME_CHARS),
                                    fg=WHITE, bg=BG, font=self.font, anchor="w")
                name_lbl.pack(side="left")
                path_lbl = tk.Label(row, text=engine.elide_left(parent, PATH_CHARS),
                                    fg=DIM, bg=BG, font=self.font, anchor="e")
                path_lbl.pack(side="right")
                self._rows.append((row, name_lbl, path_lbl))
                for w in (row, name_lbl, path_lbl):
                    w.bind("<Button-1>", self._row_click_handler(i), add="+")
            self._sel.set_count(len(shown))  # 结果刷新：选中重置回首项
            self._apply_selection()
        tk.Label(host, text=f"TOTAL {model.total}", fg=DIM, bg=BG,
                 font=self.font, anchor="w").pack(fill="x", pady=(4, 0))
        self._apply_height()

    def _on_row_click(self, idx):
        if 0 <= idx < len(self._items):
            self._act(self._items[idx].path, reveal=False)

    def _row_click_handler(self, idx):
        # 返回 "break" 阻止点击行时再触发窗口级激活绑定
        def handler(_event):
            self._on_row_click(idx)
            return "break"
        return handler

    def _render_offline(self):
        self._clear_results()
        badge = tk.Label(self.results_host, text=OFFLINE_TEXT, fg=BG, bg=FG,
                         font=self.font, anchor="w", padx=6)
        badge.pack(fill="x", pady=(6, 0))
        self._apply_height()

    def _clear_results(self):
        for child in self.results_host.winfo_children():
            child.destroy()
        self._items = []
        self._rows = []
        self._sel.set_count(0)

    def _apply_height(self):
        self.results_host.update_idletasks()
        h = self._base_h + self.results_host.winfo_reqheight()
        self.root.geometry(f"{PANEL['w']}x{h}+{PANEL['x']}+{PANEL['y']}")

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
