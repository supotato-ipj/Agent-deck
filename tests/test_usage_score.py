import unittest
from datetime import datetime, timedelta, timezone

import usage_score as us
from tests.records import Rec


def shortcut(name, target, index=0):
    return Rec(name=name, kind="shortcut", index=index, target=target)


NOW = datetime(2026, 9, 23, 12, 0, tzinfo=timezone.utc)


class DecayTest(unittest.TestCase):
    def test_half_life_is_fourteen_days(self):
        self.assertAlmostEqual(us.decay(14.0), 0.5)

    def test_zero_age_is_full_weight(self):
        self.assertAlmostEqual(us.decay(0.0), 1.0)

    def test_two_half_lives(self):
        self.assertAlmostEqual(us.decay(28.0), 0.25)


class ScoreStartsTest(unittest.TestCase):
    def test_single_start_decays_by_age(self):
        events = [(NOW - timedelta(days=14), "a.exe")]
        self.assertAlmostEqual(us.score_starts(events, NOW)["a.exe"], 0.5)

    def test_multiple_starts_sum_independent_decays(self):
        events = [(NOW, "a.exe"), (NOW - timedelta(days=14), "a.exe"), (NOW, "b.exe")]
        scores = us.score_starts(events, NOW)
        self.assertAlmostEqual(scores["a.exe"], 1.5)
        self.assertAlmostEqual(scores["b.exe"], 1.0)

    def test_current_time_is_a_parameter_not_read_internally(self):
        events = [(NOW - timedelta(days=14), "a.exe")]
        later = NOW + timedelta(days=14)
        self.assertAlmostEqual(us.score_starts(events, later)["a.exe"], 0.25)


class UserAssistParseTest(unittest.TestCase):
    def blob(self, count, filetime):
        data = bytearray(72)
        data[4:8] = count.to_bytes(4, "little")
        data[60:68] = filetime.to_bytes(8, "little")
        return bytes(data)

    def test_rot13_name_and_count_and_filetime(self):
        import codecs

        plain = r"C:\Program Files\app\app.exe"
        rotated = codecs.encode(plain, "rot_13")
        ft = 133000000000000000  # 任意合法 FILETIME
        name, count, last = us.parse_userassist(rotated, self.blob(145, ft))
        self.assertEqual(name, plain)
        self.assertEqual(count, 145)
        self.assertIsInstance(last, datetime)

    def test_short_blob_is_rejected(self):
        self.assertIsNone(us.parse_userassist("abc", b"\x00" * 10))


class FuseTest(unittest.TestCase):
    def test_empty_log_still_ranks_from_prior(self):
        prior = {"a.exe": (100, NOW - timedelta(days=7))}
        fused = us.fuse(prior, [], NOW)
        self.assertIn("a.exe", fused)
        self.assertGreater(fused["a.exe"], 0)

    def test_abundant_log_suppresses_prior(self):
        prior = {"a.exe": (1000, NOW)}
        events = [(NOW, "a.exe")] * 99
        raw_prior = 1000.0
        fused = us.fuse(prior, events, NOW)
        self.assertLess(fused["a.exe"] - 99.0, raw_prior * 0.01 + 1e-9)

    def test_unmapped_exes_still_scored_here(self):
        # 映射过滤是 map_to_icons 的职责，fuse 不做丢弃
        fused = us.fuse({}, [(NOW, "noise.exe")], NOW)
        self.assertIn("noise.exe", fused)


class MapToIconsTest(unittest.TestCase):
    def test_target_match_is_case_insensitive(self):
        items = [shortcut("Kimi", r"C:\P\Kimi.exe")]
        ranking = us.map_to_icons({r"c:\p\kimi.exe": 3.0}, items)
        self.assertEqual(ranking, {"Kimi": 3.0})

    def test_unmapped_exes_are_dropped_from_ranking(self):
        items = [shortcut("Kimi", r"C:\P\Kimi.exe")]
        ranking = us.map_to_icons({r"c:\p\kimi.exe": 3.0, "noise.exe": 9.0}, items)
        self.assertEqual(set(ranking), {"Kimi"})

    def test_non_shortcut_items_never_rank(self):
        items = [Rec("a.docx", "file", 0), Rec("Recycle Bin", "special", 1)]
        self.assertEqual(us.map_to_icons({"x.exe": 5.0}, items), {})

    def test_userassist_lnk_entries_map_by_stem(self):
        items = [shortcut("Kimi", r"C:\P\Kimi.exe")]
        ranking = us.map_to_icons({r"C:\x\TaskBar\Kimi.lnk": 2.0}, items)
        self.assertEqual(ranking, {"Kimi": 2.0})


class NoPrefetchTest(unittest.TestCase):
    def test_module_never_touches_prefetch(self):
        from pathlib import Path

        source = Path(us.__file__).read_text(encoding="utf-8")
        self.assertNotIn("Prefetch", source)


if __name__ == "__main__":
    unittest.main()
