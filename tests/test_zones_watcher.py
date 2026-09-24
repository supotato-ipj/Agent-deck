import pathlib
import unittest

import zones_watcher as zw
from tests.records import Rec, doc, shortcut


class Plan_Stub:
    def __init__(self, name, zone, pos):
        self.name = name
        self.zone = zone
        self.pos = pos
        self.slot = None
        self.source = None


class ChangedTest(unittest.TestCase):
    def test_added_name_is_a_change(self):
        self.assertTrue(zw.changed({"a"}, {"a", "b"}))

    def test_removed_name_is_a_change(self):
        self.assertTrue(zw.changed({"a", "b"}, {"a"}))

    def test_content_only_is_not_a_change(self):
        self.assertFalse(zw.changed({"a", "b"}, {"b", "a"}))


class SettleTest(unittest.TestCase):
    def test_storm_collapses_to_one_final_set(self):
        sequence = iter([{"a"}, {"a", "b"}, {"a", "b", "c"}, {"a", "b", "c"}])
        calls = {"n": 0}

        def scan():
            calls["n"] += 1
            return next(sequence)

        final = zw.settle(scan, interval=0, max_rounds=5)
        self.assertEqual(final, {"a", "b", "c"})

    def test_settle_gives_up_after_max_rounds(self):
        growing = [{"a", str(i)} for i in range(100)]
        sequence = iter(growing)

        def scan():
            return next(sequence)

        final = zw.settle(scan, interval=0, max_rounds=3)
        self.assertEqual(len(final), 2)


class IncrementalMovesTest(unittest.TestCase):
    def moves_for(self, items, plans, prev):
        return zw.incremental_moves(items, plans, prev)

    def test_new_doc_is_placed(self):
        items = [doc("new.docx", 0)]
        plans = [Plan_Stub("new.docx", "doc", (13, 394))]
        moves = self.moves_for(items, plans, set())
        self.assertEqual(moves, [("new.docx", 13, 394)])

    def test_existing_doc_off_plan_is_cascaded(self):
        items = [doc("old.docx", 0, x=999, y=999)]
        plans = [Plan_Stub("old.docx", "doc", (13, 394))]
        moves = self.moves_for(items, plans, {"old.docx"})
        self.assertEqual(moves, [("old.docx", 13, 394)])

    def test_existing_app_off_plan_is_left_alone(self):
        items = [shortcut("Kimi", 0)]
        items[0] = Rec(name="Kimi", kind="shortcut", index=0, x=999, y=999)
        plans = [Plan_Stub("Kimi", "app", (13, 100))]
        moves = self.moves_for(items, plans, {"Kimi"})
        self.assertEqual(moves, [])

    def test_new_app_off_plan_is_placed(self):
        items = [Rec(name="Kimi", kind="shortcut", index=0, x=999, y=999)]
        plans = [Plan_Stub("Kimi", "app", (13, 100))]
        moves = self.moves_for(items, plans, set())
        self.assertEqual(moves, [("Kimi", 13, 100)])

    def test_same_round_add_and_remove_suspends_app_placement(self):
        # 重命名在 fs 差分里表现为"一增一删"；新名字不该被当全新项拖进栏位
        items = [Rec(name="Kimi2", kind="shortcut", index=0, x=999, y=999)]
        plans = [Plan_Stub("Kimi2", "app", (13, 100))]
        moves = zw.incremental_moves(items, plans, {"Kimi"}, removed_names={"Kimi"})
        self.assertEqual(moves, [])

    def test_app_icon_covering_label_band_is_moved(self):
        # 标签空行被用户拖来的图标压住时，可读性优先于"不碰用户摆位"
        import zones_geometry as geo

        band_y = geo.DOC_ORIGIN[1] - geo.ROW_STEP
        items = [Rec(name="Kimi", kind="shortcut", index=0, x=13, y=band_y)]
        plans = [Plan_Stub("Kimi", "app", (13, geo.APP_ORIGIN[1]))]
        moves = zw.incremental_moves(items, plans, {"Kimi"})
        self.assertEqual(moves, [("Kimi", 13, geo.APP_ORIGIN[1])])

    def test_recycle_is_never_moved_by_watcher(self):
        items = [Rec(name="Recycle Bin", kind="special", index=0, x=999, y=999)]
        plans = [Plan_Stub("Recycle Bin", "recycle", (13, 1276))]
        self.assertEqual(self.moves_for(items, plans, set()), [])

    def test_items_already_on_plan_are_skipped(self):
        items = [doc("a.docx", 0, x=13, y=394)]
        plans = [Plan_Stub("a.docx", "doc", (13, 394))]
        self.assertEqual(self.moves_for(items, plans, {"a.docx"}), [])

    def test_unplaced_entries_produce_no_moves(self):
        items = [doc("a.docx", 0, x=999, y=999)]
        plans = [Plan_Stub("a.docx", "doc", None)]
        self.assertEqual(self.moves_for(items, plans, set()), [])


class ArrangeLockTest(unittest.TestCase):
    """锁测试必须用临时目录：生产锁路径会被真实看门狗合法持有。"""

    def setUp(self):
        import tempfile

        import zones_lock

        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._real = zones_lock.lock_path
        zones_lock.lock_path = lambda: pathlib.Path(self.tmp.name) / "arrange.lock"
        self.addCleanup(setattr, zones_lock, "lock_path", self._real)

    def test_second_holder_is_refused(self):
        import zones_lock

        with zones_lock.ArrangeLock(wait_seconds=0):
            with self.assertRaises(zones_lock.ArrangeBusy):
                with zones_lock.ArrangeLock(wait_seconds=0):
                    pass

    def test_stale_lock_from_dead_pid_is_broken(self):
        import zones_lock

        lock = zones_lock.ArrangeLock(wait_seconds=0)
        lock.path.mkdir()
        lock.holder.write_text("999999999 0", encoding="utf-8")  # 不存在的 pid +  epoch 时间戳
        with zones_lock.ArrangeLock(wait_seconds=0):
            pass  # 陈旧锁应被打破而不是报忙

    def test_lock_is_released(self):
        import zones_lock

        with zones_lock.ArrangeLock(wait_seconds=0):
            pass
        with zones_lock.ArrangeLock(wait_seconds=0):
            pass


if __name__ == "__main__":
    unittest.main()
