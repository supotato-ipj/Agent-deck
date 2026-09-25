"""搜索面板状态机的纯逻辑测试（ticket 01）。

窗口层不做单测（视觉行为，走截图验收）；这里只锁定
待机态 ⇄ 活动态的转移规则与查询词清空语义。
"""

import unittest

from search_panel import PanelStateMachine


class TestPanelStateMachine(unittest.TestCase):
    def setUp(self):
        self.m = PanelStateMachine()

    def test_initial_state_is_idle(self):
        self.assertEqual(self.m.state, "IDLE")
        self.assertEqual(self.m.query, "")

    def test_click_activates(self):
        self.assertEqual(self.m.on_event("click"), "ACTIVE")
        self.assertEqual(self.m.state, "ACTIVE")

    def test_esc_deactivates_and_clears_query(self):
        self.m.on_event("click")
        self.m.set_query("abc")
        self.assertEqual(self.m.on_event("esc"), "IDLE")
        self.assertEqual(self.m.query, "")

    def test_blur_deactivates_and_clears_query(self):
        self.m.on_event("click")
        self.m.set_query("合同")
        self.assertEqual(self.m.on_event("blur"), "IDLE")
        self.assertEqual(self.m.query, "")

    def test_esc_in_idle_is_noop(self):
        self.assertEqual(self.m.on_event("esc"), "IDLE")

    def test_blur_in_idle_is_noop(self):
        self.assertEqual(self.m.on_event("blur"), "IDLE")

    def test_click_in_active_keeps_state_and_query(self):
        self.m.on_event("click")
        self.m.set_query("xyz")
        self.assertEqual(self.m.on_event("click"), "ACTIVE")
        self.assertEqual(self.m.query, "xyz")

    def test_activate_after_deactivate_starts_clean(self):
        self.m.on_event("click")
        self.m.set_query("old")
        self.m.on_event("esc")
        self.m.on_event("click")
        self.assertEqual(self.m.query, "")


if __name__ == "__main__":
    unittest.main()


class TestPanelRenderLogic(unittest.TestCase):
    """窗口渲染逻辑（withdrawn Tk，无屏幕依赖）：待机提示/活动占位/文本三态。"""

    def _stacked(self, w):
        # withdrawn 窗口上 ismapped 恒 0；用几何管理器归属断言堆叠关系
        return w.winfo_manager() != ""

    def _app(self):
        import tkinter as tk
        app = __import__("search_panel").SearchPanelApp()
        # 复刻 run() 的构件搭建（不进 mainloop、不显示）
        app.root = tk.Tk()
        app.root.withdraw()
        import tkinter.font as tkfont
        app.font = tkfont.Font(family="Courier", size=-17)
        from tkinter import ttk  # noqa: F401
        app.head = tk.Label(app.root)
        app.box = tk.Frame(app.root, height=30)
        app.box.pack_propagate(False)
        app.hint = tk.Label(app.box)
        app.hint.pack(fill="both", expand=True)
        app.entry = tk.Entry(app.box)
        app.placeholder = tk.Label(app.box)
        app.sep = tk.Frame(app.root)
        return app

    def test_idle_shows_hint_only(self):
        app = self._app()
        app.root.update_idletasks()
        self.assertTrue(self._stacked(app.hint))
        self.assertFalse(self._stacked(app.entry))
        self.assertFalse(self._stacked(app.placeholder))
        app.root.destroy()

    def test_active_empty_shows_entry_and_placeholder(self):
        app = self._app()
        app._render_active()
        app.root.update_idletasks()
        self.assertFalse(self._stacked(app.hint))
        self.assertTrue(self._stacked(app.entry))
        self.assertTrue(self._stacked(app.placeholder))
        app.root.destroy()

    def test_active_with_text_hides_placeholder(self):
        app = self._app()
        app.machine.on_event("click")
        app.entry.insert(0, "ok")
        app._render_active()
        app.root.update_idletasks()
        self.assertTrue(self._stacked(app.entry))
        self.assertFalse(self._stacked(app.placeholder))
        app.root.destroy()

    def test_deactivate_restores_hint(self):
        app = self._app()
        app.machine.on_event("click")
        app.entry.insert(0, "ok")
        app._render_active()
        app._deactivate("esc")
        app.root.update_idletasks()
        self.assertEqual(app.machine.state, "IDLE")
        self.assertEqual(app.machine.query, "")
        self.assertTrue(self._stacked(app.hint))
        self.assertFalse(self._stacked(app.entry))
        self.assertFalse(self._stacked(app.placeholder))
        app.root.destroy()
