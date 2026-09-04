"""scripts/verify-cloud.sh — arg parsing, exit-75 semantics, summary.json contract, lifecycle.

Fast tests use `--only ml` (python unittests, ~0s) or `--only security` with a
controlled GITLEAKS_BIN so the real stage machinery runs without the heavy
gates. Slow tests (the real `test` stage) run only with CI_AUDIT_SLOW=1.

Classes:
  Invariants  — behaviour that holds on 4d812e1a (verified_ok pins).
  Defects     — each test asserts the CORRECT behaviour; it FAILS on 4d812e1a.
"""

from __future__ import annotations

import json
import os
import pathlib
import signal
import stat
import subprocess
import tempfile
import time
import unittest
import uuid

from _harness import (
    REPO,
    SCRIPTS,
    TempGitRepo,
    ci_yml_only_stage_lists,
    load_summary,
    path_without,
    processes_with_env_marker,
    run,
    skip_unless_slow,
    verify_cloud_stage_array,
)

VC = SCRIPTS / "verify-cloud.sh"


def _fake_gitleaks(dir_: pathlib.Path, body: str) -> str:
    p = dir_ / "fake-gitleaks"
    p.write_text('#!/usr/bin/env bash\n[ "${1:-}" = version ] && { echo 8.30.1; exit 0; }\n' + body)
    p.chmod(p.stat().st_mode | stat.S_IXUSR)
    return str(p)


class Invariants(unittest.TestCase):
    def test_pr_tier_equals_union_of_ci_yml_job_stage_lists(self) -> None:
        pr = verify_cloud_stage_array("PR_STAGES")
        all_ = verify_cloud_stage_array("ALL_STAGES")
        ci_lists = ci_yml_only_stage_lists()
        self.assertEqual(len(ci_lists), 4, ci_lists)
        union = {s for lst in ci_lists for s in lst}
        self.assertEqual(union, set(pr))
        self.assertTrue(set(pr) <= set(all_))
        self.assertEqual(len(pr), len(set(pr)), "PR_STAGES has duplicates")
        for lst in ci_lists:
            self.assertTrue(set(lst) <= set(all_), lst)

    def test_bad_arguments_exit_2(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env = {"VERIFY_ARTIFACTS": tmp + "/a"}
            self.assertEqual(run([str(VC), "--wat"], env=env).returncode, 2)
            self.assertEqual(run([str(VC), "--tier", "nope"], env=env).returncode, 2)
            r = run([str(VC), "--only", "bogus"], env=env)
            self.assertEqual(r.returncode, 2)
            self.assertIn("unknown stage: bogus", r.stderr)
        self.assertEqual(run([str(VC), "--help"]).returncode, 0)

    def test_unavailable_stage_exit_75_is_recorded_and_fails_the_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            art = pathlib.Path(tmp) / "art"
            r = run(
                [str(VC), "--only", "edge"],
                env={"VERIFY_ARTIFACTS": str(art), "HOME": tmp, "PATH": path_without(".deno")},
            )
            self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
            s = load_summary(art)
        self.assertFalse(s["ok"])
        self.assertEqual(s["stages"][0]["status"], "unavailable")
        self.assertIn("missing required tool: deno", s["stages"][0]["note"])
        self.assertIn("UNAVAILABLE", r.stdout)
        self.assertNotIn("passed", s["stages"][0]["status"])

    def test_failed_stage_exit_code_is_preserved_in_summary(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            art = pathlib.Path(tmp) / "art"
            fake = _fake_gitleaks(pathlib.Path(tmp), "exit 7\n")
            r = run([str(VC), "--only", "security"], env={"VERIFY_ARTIFACTS": str(art), "GITLEAKS_BIN": fake})
            self.assertEqual(r.returncode, 1, r.stdout)
            s = load_summary(art)
            self.assertEqual(s["stages"][0]["status"], "failed")
            self.assertEqual(s["stages"][0]["note"], "exit 1")  # security-scan.sh maps scanner errors to 1
            self.assertTrue((art / "security.log").exists())
            self.assertIn("gitleaks failed with exit 7", (art / "security.log").read_text())

    def test_skipped_is_never_passed_and_passed_stage_summary_is_valid(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            art = pathlib.Path(tmp) / "art"
            r = run([str(VC), "--only", "ml,edge", "--skip", "edge"], env={"VERIFY_ARTIFACTS": str(art)})
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            s = load_summary(art)
            by = {x["name"]: x for x in s["stages"]}
            self.assertEqual(by["ml"]["status"], "passed")
            self.assertEqual(by["edge"]["status"], "skipped")
            self.assertEqual(by["edge"]["note"], "explicitly skipped")
            self.assertTrue(s["ok"])
            for k in ("tool", "git_sha", "dirty", "tier", "started_utc", "host", "node", "ok", "stages"):
                self.assertIn(k, s)
            head = run(["git", "rev-parse", "HEAD"]).stdout.strip()
            self.assertEqual(s["git_sha"], head)
            self.assertIsInstance(s["dirty"], bool)
            self.assertTrue(pathlib.Path(by["ml"]["log"]).exists())

    def test_dirty_flag_ignores_untracked_artifacts_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            art = pathlib.Path(tmp) / "art"
            probe = REPO / "artifacts" / f"ci-audit-{uuid.uuid4().hex}"
            probe.mkdir(parents=True)
            (probe / "x").write_text("x")
            try:
                run([str(VC), "--only", "ml"], env={"VERIFY_ARTIFACTS": str(art)})
                dirty_with_artifacts = load_summary(art)["dirty"]
            finally:
                (probe / "x").unlink()
                probe.rmdir()
            baseline = run(["git", "status", "--porcelain"]).stdout
            baseline_dirty = any(not ln.startswith("?? artifacts/") for ln in baseline.splitlines())
            self.assertEqual(dirty_with_artifacts, baseline_dirty)

    def test_no_stage_uses_or_true_to_hide_failure(self) -> None:
        code = "\n".join(ln for ln in VC.read_text().splitlines() if not ln.lstrip().startswith("#"))
        self.assertNotIn("|| true", code)


class Defects(unittest.TestCase):
    def test_sigterm_writes_summary_and_stops_the_stage_child(self) -> None:
        """DEFECT: no trap. SIGTERM (CI cancel / timeout) kills the bash parent, the stage child
        keeps running, and summary.json is never written."""
        marker = uuid.uuid4().hex
        with tempfile.TemporaryDirectory() as tmp:
            art = pathlib.Path(tmp) / "art"
            fake = _fake_gitleaks(pathlib.Path(tmp), "echo started; sleep 40\n")
            env = dict(os.environ, VERIFY_ARTIFACTS=str(art), GITLEAKS_BIN=fake, CI_AUDIT_MARKER=marker)
            proc = subprocess.Popen([str(VC), "--only", "security"], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            try:
                # wait until the fake scanner is running under the stage subshell
                log = art / "security.log"
                deadline = time.time() + 30
                while time.time() < deadline:
                    if log.exists() and "started" in log.read_text():
                        break
                    time.sleep(0.2)
                else:
                    self.fail("fake scanner never started")
                proc.send_signal(signal.SIGTERM)
                rc = proc.wait(timeout=20)
                time.sleep(1)
                alive = [p for p in processes_with_env_marker("CI_AUDIT_MARKER", marker) if p != proc.pid]
                summary_exists = (art / "summary.json").exists()
            finally:
                for p in processes_with_env_marker("CI_AUDIT_MARKER", marker):
                    try:
                        os.kill(p, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            self.assertTrue(
                summary_exists and not alive,
                f"verify-cloud exited {rc} on SIGTERM; summary.json written={summary_exists}; "
                f"stage child processes still alive: {alive}",
            )

    def test_duplicate_only_stage_runs_once(self) -> None:
        """DEFECT: `--only ml,ml` runs the stage twice and records two rows sharing one log path."""
        with tempfile.TemporaryDirectory() as tmp:
            art = pathlib.Path(tmp) / "art"
            r = run([str(VC), "--only", "ml,ml"], env={"VERIFY_ARTIFACTS": str(art)})
            self.assertEqual(r.returncode, 0, r.stdout)
            names = [x["name"] for x in load_summary(art)["stages"]]
        self.assertEqual(len(names), len(set(names)), f"duplicate stage rows in summary: {names}")

    def test_summary_json_is_valid_with_control_characters(self) -> None:
        """DEFECT: json_escape handles only \\ \" and newline; a TAB in an artifact path or in
        the unavailable-note ends up raw inside a JSON string (RFC 8259 forbids it)."""
        with tempfile.TemporaryDirectory() as tmp:
            art = pathlib.Path(tmp) / "a\tb"
            r = run([str(VC), "--only", "ml"], env={"VERIFY_ARTIFACTS": str(art)})
            self.assertEqual(r.returncode, 0, r.stdout)
            raw = (art / "summary.json").read_text()
            try:
                json.loads(raw)
            except json.JSONDecodeError as e:
                self.fail(f"summary.json is not valid JSON: {e}\n{raw}")

    def test_unknown_stage_does_not_create_an_artifact_dir(self) -> None:
        """DEFECT: the artifact directory is created before the stage list is validated, so
        every typo leaves an empty artifacts/verify-cloud/<stamp>/ behind."""
        with tempfile.TemporaryDirectory() as tmp:
            art = pathlib.Path(tmp) / "never"
            r = run([str(VC), "--only", "bogus"], env={"VERIFY_ARTIFACTS": str(art)})
            self.assertEqual(r.returncode, 2)
            self.assertFalse(art.exists(), "artifact dir created for a rejected invocation")

    def test_deps_stage_detects_stale_mobile_node_modules(self) -> None:
        """DEFECT: `npm ci` in apps/mobile is skipped whenever the directory exists, even when it
        is empty/stale relative to package-lock.json (local runs only; CI checkouts are fresh)."""
        with TempGitRepo() as tmp:
            tmp.copy_from_repo("scripts/verify-cloud.sh")
            (tmp.dir / "scripts" / "verify-cloud.sh").chmod(0o755)
            tmp.copy_from_repo("apps/mobile/package.json")
            tmp.copy_from_repo("apps/mobile/package-lock.json")
            (tmp.dir / "apps" / "mobile" / "node_modules").mkdir()  # exists but EMPTY
            (tmp.dir / "ml" / "scripts").mkdir(parents=True)
            tmp.commit_all("fixture")
            art = tmp.dir / "art"
            r = run([str(tmp.dir / "scripts" / "verify-cloud.sh"), "--only", "deps,mobile"], cwd=tmp.dir, env={"VERIFY_ARTIFACTS": str(art)})
            s = load_summary(art)
            deps = next(x for x in s["stages"] if x["name"] == "deps")
            log = (art / "deps.log").read_text()
        self.assertFalse(
            deps["status"] == "passed" and "skipping npm ci" in log,
            "deps PASSED while skipping npm ci over an empty apps/mobile/node_modules:\n" + log,
        )

    @skip_unless_slow
    def test_test_stage_fails_when_explicit_sqs_endpoint_is_unreachable(self) -> None:
        """DEFECT: with SQS_ENDPOINT_TEST explicitly set (as ci.yml does) but unreachable, the
        stage silently unsets it, the 3 @pickle/queue SQS suites self-skip and the stage PASSES.
        CI's elasticmq service has no health check, so this is a real green-without-coverage path."""
        with tempfile.TemporaryDirectory() as tmp:
            art = pathlib.Path(tmp) / "art"
            r = run(
                [str(VC), "--only", "test"],
                env={"VERIFY_ARTIFACTS": str(art), "SQS_ENDPOINT_TEST": "http://127.0.0.1:9"},
                timeout=1200,
            )
            s = load_summary(art)
            log = (art / "test.log").read_text()
        self.assertIn("unreachable", log)
        self.assertNotEqual(
            (r.returncode, s["stages"][0]["status"]),
            (0, "passed"),
            "test stage passed although the explicitly configured SQS endpoint was unreachable",
        )


if __name__ == "__main__":
    unittest.main()
