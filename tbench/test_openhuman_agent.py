import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tbench.openhuman_agent import task_budget_secs, turn_timeout_setting


class TimeoutSettingsTests(unittest.TestCase):
    def write_task(self, cache: Path, dataset: str, key: str, seconds: int) -> None:
        task = cache / dataset / key
        task.mkdir(parents=True)
        (task / "task.toml").write_text(f"[agent]\ntimeout_sec = {seconds}\n", encoding="utf8")

    def test_task_budget_applies_harbor_override_cap_and_multiplier(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            with patch.dict(os.environ, {
                "HARBOR_TASK_CACHE": temp,
                "BENCH_AGENT_TIMEOUT_OVERRIDE_S": "2400",
                "BENCH_AGENT_TIMEOUT_MAX_S": "1800",
                "BENCH_AGENT_TIMEOUT_MULTIPLIER": "1.5",
            }, clear=False):
                self.assertEqual(task_budget_secs("task"), "2700")

    def test_conflicting_task_caches_disable_the_inner_budget(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            self.write_task(Path(temp), "dataset-a", "task", 3600)
            self.write_task(Path(temp), "dataset-b", "task", 7200)
            with patch.dict(os.environ, {"HARBOR_TASK_CACHE": temp}, clear=False):
                self.assertEqual(task_budget_secs("task"), "0")

    def write_packaged_task(self, cache: Path, dataset: str, key: str, digest: str, seconds: int) -> None:
        """Harbor's newer layout: packages/<dataset>/<task>/<content-hash>/task.toml."""
        task = cache / "packages" / dataset / key / digest
        task.mkdir(parents=True)
        (task / "task.toml").write_text(f"[agent]\ntimeout_sec = {seconds}\n", encoding="utf8")

    def test_task_budget_reads_the_packaged_cache_layout(self) -> None:
        # Reading only the flat layout lost the budget entirely, and an empty
        # budget falls through to TASK_TIMEOUT_S (86400) in turn-budget.mjs, so
        # the turn ceiling became ~24h and nothing bounded a runaway command.
        with tempfile.TemporaryDirectory() as temp:
            self.write_packaged_task(Path(temp), "terminal-bench", "task", "ed92bf0b", 28800)
            with patch.dict(os.environ, {"HARBOR_TASK_CACHE": temp}, clear=False):
                self.assertEqual(task_budget_secs("task"), "28800")

    def test_both_layouts_agreeing_on_one_budget_is_not_a_conflict(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            self.write_task(Path(temp), "dataset-a", "task", 1800)
            self.write_packaged_task(Path(temp), "terminal-bench", "task", "ed92bf0b", 1800)
            with patch.dict(os.environ, {"HARBOR_TASK_CACHE": temp}, clear=False):
                self.assertEqual(task_budget_secs("task"), "1800")

    def test_layouts_disagreeing_disable_the_inner_budget(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            self.write_task(Path(temp), "dataset-a", "task", 1800)
            self.write_packaged_task(Path(temp), "terminal-bench", "task", "ed92bf0b", 28800)
            with patch.dict(os.environ, {"HARBOR_TASK_CACHE": temp}, clear=False):
                self.assertEqual(task_budget_secs("task"), "0")

    def test_ambiguous_budget_disables_default_but_keeps_explicit_setting(self) -> None:
        self.assertEqual(turn_timeout_setting("", "0"), "0")
        self.assertEqual(turn_timeout_setting("2400", "0"), "2400")
        self.assertEqual(turn_timeout_setting("", "3600"), "")


if __name__ == "__main__":
    unittest.main()
