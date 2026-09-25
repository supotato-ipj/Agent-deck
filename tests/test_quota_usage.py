"""quota / usage 接缝测试：fixture 数据 + mock HTTP，不碰真实网络与真实 key。"""
import json
import os
import sqlite3
import tempfile
import time
import unittest
from datetime import datetime
from pathlib import Path

import quota
import usage


def _write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    t = time.time()
    os.utime(path, (t, t))


def _codex_file(root, rel, lines):
    jf = Path(root) / "sessions" / rel
    _write(jf, "\n".join(lines) + "\n")
    return jf


class CodexQuotaTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)

    def test_snapshot_parsed_from_tail(self):
        snap = {"rateLimits": {"primary": {
            "usedPercent": 19, "windowDurationMins": 10080, "resetsAt": 1790662039}}}
        outer = {"type": "response_item", "payload": {
            "type": "custom_tool_call_output", "output": [
                {"type": "input_text",
                 "text": "Output:\n" + json.dumps(snap).replace('"', '\\"') + "\n"}]}}
        _codex_file(self.root, "2026/09/25/rollout-a.jsonl", [json.dumps(outer)])
        got = quota.codex_quota(self.root)
        self.assertEqual(got["window"], "weekly")
        self.assertEqual(got["remaining_pct"], 81)
        self.assertEqual(got["resets_at"], 1790662039)

    def test_5h_window_label(self):
        snap = '{"usedPercent":40,"windowDurationMins":300,"resetsAt":1790662039}'
        _codex_file(self.root, "2026/09/25/rollout-b.jsonl", ['x' + snap])
        self.assertEqual(quota.codex_quota(self.root)["window"], "5h")

    def test_no_snapshot_yields_none(self):
        _codex_file(self.root, "2026/09/25/rollout-c.jsonl", ['{"type":"response_item"}'])
        self.assertIsNone(quota.codex_quota(self.root))

    def test_latest_snapshot_wins(self):
        _codex_file(self.root, "2026/09/25/rollout-d.jsonl", [
            '{"usedPercent":10,"windowDurationMins":10080,"resetsAt":1}',
            '{"usedPercent":25,"windowDurationMins":10080,"resetsAt":2}',
        ])
        self.assertEqual(quota.codex_quota(self.root)["remaining_pct"], 75)

    def test_empty_root_none(self):
        self.assertIsNone(quota.codex_quota(Path(self._tmp.name) / "nope"))


class BalanceTest(unittest.TestCase):
    def test_balance_parsed(self):
        orig_get, orig_key = quota._get_json, quota._dsh_key
        quota._get_json = lambda url, token, timeout=4: {
            "is_available": True,
            "balance_infos": [{"currency": "CNY", "total_balance": "12.34"}],
        }
        quota._dsh_key = lambda: "sk-test"
        try:
            got = quota.dsh_balance()
        finally:
            quota._get_json, quota._dsh_key = orig_get, orig_key
        self.assertEqual(got["window"], "balance")
        self.assertEqual(got["detail"]["total_balance"], "12.34")

    def test_http_failure_silent_none(self):
        def boom(url, token, timeout=4):
            raise OSError("net down")
        orig = quota._get_json
        quota._get_json = boom
        try:
            self.assertIsNone(quota.dsh_balance())
        finally:
            quota._get_json = orig

    def test_no_key_none(self):
        env = os.environ.pop("QD_DEEPSEEK_API_KEY", None)
        home = Path.home
        try:
            Path.home = lambda: Path(tempfile.gettempdir())  # 无 .credentials.yaml
            self.assertIsNone(quota.dsh_balance())
        finally:
            Path.home = home
            if env:
                os.environ["QD_DEEPSEEK_API_KEY"] = env


class SubscriptionTest(unittest.TestCase):
    def test_unconfigured_none(self):
        orig = quota._subscription_config
        quota._subscription_config = lambda: None
        try:
            self.assertIsNone(quota.dsh_subscription())
        finally:
            quota._subscription_config = orig

    def test_configured_fraction_and_percent(self):
        orig_cfg, orig_get, orig_key = quota._subscription_config, quota._get_json, quota._dsh_key
        quota._subscription_config = lambda: {"url": "https://x/quota", "window": "5h"}
        quota._get_json = lambda url, token, timeout=4: {"remaining": 0.35}
        quota._dsh_key = lambda: "sk-test"
        try:
            self.assertEqual(quota.dsh_subscription()["remaining_pct"], 35.0)
            quota._get_json = lambda url, token, timeout=4: {"remaining": 62}
            self.assertEqual(quota.dsh_subscription()["remaining_pct"], 62.0)
        finally:
            quota._subscription_config, quota._get_json, quota._dsh_key = orig_cfg, orig_get, orig_key


class UsageAggregateTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.now = time.time()
        self.day_start = datetime.fromtimestamp(self.now).replace(
            hour=0, minute=0, second=0, microsecond=0).timestamp()

    def _in_day(self, mtime=None):
        return self.day_start + 60

    def test_zcode_models_aggregate(self):
        db = self.root / "zcode" / "cli" / "db" / "db.sqlite"
        db.parent.mkdir(parents=True)
        con = sqlite3.connect(db)
        con.execute("CREATE TABLE model_usage (model_id TEXT, started_at INTEGER, computed_total_tokens INTEGER)")
        con.executemany("INSERT INTO model_usage VALUES (?,?,?)", [
            ("glm", int((self.day_start + 100) * 1000), 100),
            ("glm", int((self.day_start + 200) * 1000), 50),
            ("ds", int((self.day_start + 300) * 1000), 30),
            ("old", int((self.day_start - 1000) * 1000), 999),   # 昨日排除
        ])
        con.commit(); con.close()
        got = usage.zcode_usage(self.root / "zcode", self.day_start)
        self.assertEqual(got["today_tokens"], 180)
        self.assertEqual(got["models"], {"glm": 150, "ds": 30})

    def test_codex_today_files_summed(self):
        day_dir = "2026/09/" + f"{datetime.fromtimestamp(self.now):%d}"
        _codex_file(self.root / "codex", f"{day_dir}/rollout-a.jsonl",
                    ['{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":500}}}}'])
        got = usage.codex_usage(self.root / "codex", self.day_start - 1)
        self.assertEqual(got["today_tokens"], 500)

    def test_codex_stale_file_excluded(self):
        jf = _codex_file(self.root / "codex2", "2026/09/25/rollout-a.jsonl",
                         ['{"total_token_usage":{"total_tokens":700}}'])
        t = self.day_start - 5000
        os.utime(jf, (t, t))
        self.assertIsNone(usage.codex_usage(self.root / "codex2", self.day_start))

    def test_kimicode_turn_tokens_summed(self):
        wire = self.root / "kc" / "sessions" / "wd" / "s1" / "agents" / "main" / "wire.jsonl"
        _write(wire, "\n".join([
            '{"type":"token_counting.turn_recorded","tokens":120}',
            '{"type":"token_counting.measured","tokens":7}',
            '{"type":"token_counting.turn_recorded","tokens":80}',
        ]))
        got = usage.kimicode_usage(self.root / "kc", self.day_start - 1)
        self.assertEqual(got["today_tokens"], 200)

    def test_hermes_day_window_sum(self):
        db = self.root / "hermes" / "state.db"
        db.parent.mkdir(parents=True)
        con = sqlite3.connect(db)
        con.execute("CREATE TABLE messages (token_count INTEGER, timestamp REAL)")
        con.executemany("INSERT INTO messages VALUES (?,?)", [
            (10, self.day_start + 10), (5, self.day_start + 20), (99, self.day_start - 1),
        ])
        con.commit(); con.close()
        got = usage.hermes_usage(self.root / "hermes", self.day_start)
        self.assertEqual(got["today_tokens"], 15)

    def test_usage_state_shape(self):
        orig = quota.quota_state
        quota.quota_state = lambda codex_root=None: {"codex": None, "dsh": None}
        try:
            got = usage.usage_state({}, now=self.now)
        finally:
            quota.quota_state = orig
        self.assertEqual(set(got["per_agent"]),
                         {"zcode", "codex", "kimicode", "hermes", "qoder", "kimiwork", "dsh"})
        self.assertTrue(all(v is None for v in got["per_agent"].values()))


if __name__ == "__main__":
    unittest.main()
