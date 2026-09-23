import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import usage_log as ul


class DetectStartsTest(unittest.TestCase):
    def test_new_exe_is_a_start(self):
        self.assertEqual(ul.detect_starts({"a.exe"}, {"a.exe", "b.exe"}), ["b.exe"])

    def test_exit_is_not_a_start(self):
        self.assertEqual(ul.detect_starts({"a.exe", "b.exe"}, {"a.exe"}), [])

    def test_empty_to_empty(self):
        self.assertEqual(ul.detect_starts(set(), set()), [])


class DetectFocusTest(unittest.TestCase):
    def test_switch_reports_new_focus(self):
        self.assertEqual(ul.detect_focus("a.exe", "b.exe"), "b.exe")

    def test_same_focus_reports_nothing(self):
        self.assertIsNone(ul.detect_focus("a.exe", "a.exe"))

    def test_none_foreground_reports_nothing(self):
        self.assertIsNone(ul.detect_focus("a.exe", None))


class AppendAndPruneTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def test_record_has_exactly_ts_and_exe(self):
        ul.append(self.dir, "start", r"C:\p\a.exe", datetime(2026, 9, 23, 12, 0, tzinfo=timezone.utc))
        files = list(self.dir.glob("start-*.jsonl"))
        self.assertEqual(len(files), 1)
        record = json.loads(files[0].read_text(encoding="utf-8").strip())
        self.assertEqual(set(record), {"ts", "exe"})
        self.assertEqual(record["exe"], r"C:\p\a.exe")

    def test_focus_and_start_go_to_separate_files(self):
        ts = datetime(2026, 9, 23, 12, 0, tzinfo=timezone.utc)
        ul.append(self.dir, "start", "a.exe", ts)
        ul.append(self.dir, "focus", "a.exe", ts)
        self.assertEqual(len(list(self.dir.glob("start-*.jsonl"))), 1)
        self.assertEqual(len(list(self.dir.glob("focus-*.jsonl"))), 1)

    def test_prune_deletes_only_old_days(self):
        now = datetime(2026, 9, 23, 12, 0, tzinfo=timezone.utc)
        old = now - timedelta(days=91)
        recent = now - timedelta(days=89)
        ul.append(self.dir, "start", "old.exe", old)
        ul.append(self.dir, "start", "new.exe", recent)
        ul.prune(self.dir, days=90, now=now)
        remaining = [json.loads(l)["exe"] for f in self.dir.glob("start-*.jsonl") for l in f.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(remaining, ["new.exe"])

    def test_append_failure_is_swallowed(self):
        blocker = self.dir / "blockfile"
        blocker.write_text("x", encoding="utf-8")
        # 目录位置被普通文件占用时 mkdir/open 必失败：不得抛错，服务不能因日志死掉
        ul.append(blocker / "sub", "start", "a.exe", datetime.now(timezone.utc))


class PrivacyGuardTest(unittest.TestCase):
    def test_module_never_reads_window_titles(self):
        source = Path(ul.__file__).read_text(encoding="utf-8")
        self.assertNotIn("GetWindowText", source)
        self.assertNotIn("window_title", source)
        self.assertNotIn("WindowTitle", source)


if __name__ == "__main__":
    unittest.main()
