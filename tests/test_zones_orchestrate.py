import unittest

import zones_orchestrate as zo
from tests.records import Rec


def item(name, index, x, y, kind="file"):
    return Rec(name=name, kind=kind, index=index, mtime=1.0, x=x, y=y)


class Placement_Stub:
    def __init__(self, name, zone, pos):
        self.name = name
        self.zone = zone
        self.pos = pos
        self.slot = None


class MovesFromPlanTest(unittest.TestCase):
    def test_skips_unplaced_and_unchanged(self):
        items = [item("a.docx", 0, 13, 394), item("b.docx", 1, 13, 492), item("c.docx", 2, 13, 590)]
        plan = [
            Placement_Stub("a.docx", "doc", (13, 394)),   # 已在目标位
            Placement_Stub("b.docx", "doc", (13, 688)),   # 需要移动
            Placement_Stub("c.docx", "doc", None),        # 不落位
        ]
        moves = zo.moves_from_plan(items, plan)
        self.assertEqual(moves, [(1, "b.docx", (13, 688))])

    def test_empty_plan_no_moves(self):
        self.assertEqual(zo.moves_from_plan([], []), [])


class VerifyPositionsTest(unittest.TestCase):
    def test_reports_mismatch(self):
        plan = [Placement_Stub("a.docx", "doc", (13, 394))]
        self.assertEqual(zo.verify_positions([item("a.docx", 0, 13, 394)], plan), [])
        off = item("a.docx", 0, 999, 999)
        self.assertEqual(zo.verify_positions([off], plan), [("a.docx", (13, 394), (999, 999))])

    def test_unplaced_entries_are_not_verified(self):
        plan = [Placement_Stub("a.docx", "doc", None)]
        self.assertEqual(zo.verify_positions([item("a.docx", 0, 13, 2)], plan), [])

    def test_duplicate_names_are_skipped_not_guessed(self):
        plan = [
            Placement_Stub("same", "doc", (13, 492)),
            Placement_Stub("same", "doc", (163, 492)),
        ]
        current = [item("same", 0, 13, 394), item("same", 1, 163, 394)]
        self.assertEqual(zo.verify_positions(current, plan), [])


class PlanReportTest(unittest.TestCase):
    def test_report_shows_names_zones_and_both_coords(self):
        out = zo.plan_report([item("个人简历.docx", 0, 13, 2)], [Placement_Stub("个人简历.docx", "doc", (13, 394))])
        self.assertIn("个人简历.docx", out)
        self.assertIn("doc", out)
        self.assertIn("(  13,   2)", out)
        self.assertIn("(  13, 394)", out)

    def test_unplaced_shows_dash(self):
        out = zo.plan_report([item("overflow.docx", 0, 13, 2)], [Placement_Stub("overflow.docx", "doc", None)])
        self.assertIn("-", out.splitlines()[1])


if __name__ == "__main__":
    unittest.main()
