"""scripts/security-scan.sh — pinned contract and demonstrated defects.

Every test invokes the real script. The gitleaks binary is resolved exactly as
the script does (SECURITY_SCAN_CACHE / download of the pinned release), so the
first run may download it.

Classes:
  Invariants  — behaviour that holds on 4d812e1a (verified_ok pins).
  Defects     — each test asserts the CORRECT behaviour; it FAILS on 4d812e1a.
"""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import stat
import subprocess
import tempfile
import unittest

from _harness import REPO, SCRIPTS, TempGitRepo, run

SCAN = SCRIPTS / "security-scan.sh"

# A PEM header + body is matched by gitleaks' `private-key` rule. Nothing here is a
# real key; the body is filler. Assembled at runtime so THIS file never trips the gate.
_MARK = " ".join(["RSA", "PRIVATE", "KEY"])
FAKE_PEM = (
    f"-----BEGIN {_MARK}-----\n"
    "MIIEowIBAAKCAQEAaudit0probe0not0a0real0key0" + "A" * 80 + "\n"
    f"-----END {_MARK}-----\n"
)


def _plant_in_artifacts() -> pathlib.Path:
    """Plant a fake secret in a gitignored, untracked location that `gitleaks dir .` still scans."""
    d = REPO / "artifacts" / "ci-audit-probe"
    d.mkdir(parents=True, exist_ok=True)
    p = d / "leak.txt"
    p.write_text(FAKE_PEM)
    return d


def _scan_repo_copy(tmp: TempGitRepo) -> None:
    """Give a temp repo the pieces security-scan.sh needs from its own REPO_ROOT."""
    tmp.copy_from_repo("scripts/security-scan.sh")
    tmp.copy_from_repo(".gitleaks.toml")
    (tmp.dir / "scripts" / "security-scan.sh").chmod(0o755)


class Invariants(unittest.TestCase):
    def test_pinned_gitleaks_and_clean_tree_pass(self) -> None:
        r = run([str(SCAN), "--tree"])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("gitleaks 8.30.1 at", r.stderr + r.stdout)
        self.assertIn("PASS: no secrets detected", r.stderr + r.stdout)

    def test_planted_secret_fails_tree_scan_and_is_redacted(self) -> None:
        d = _plant_in_artifacts()
        try:
            with tempfile.TemporaryDirectory() as report:
                r = run([str(SCAN), "--tree", "--verbose", "--report-dir", report])
                out = r.stdout + r.stderr
                self.assertEqual(r.returncode, 1, out)
                self.assertIn("FINDINGS", out)
                self.assertNotIn("audit0probe0not0a0real0key0", out, "secret material leaked into output")
                report_file = pathlib.Path(report) / "gitleaks-tree.json"
                self.assertTrue(report_file.exists(), "--report-dir JSON missing")
                findings = json.loads(report_file.read_text())
                self.assertGreaterEqual(len(findings), 1)
                self.assertTrue(all(f["File"].startswith("artifacts/ci-audit-probe/") for f in findings), findings)
                self.assertNotIn("audit0probe0not0a0real0key0", report_file.read_text())
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_offline_without_cache_is_setup_failure_exit_2(self) -> None:
        with tempfile.TemporaryDirectory() as cache:
            r = run(
                [str(SCAN), "--tree"],
                env={"SECURITY_SCAN_CACHE": cache, "SECURITY_SCAN_OFFLINE": "1"},
            )
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("SECURITY_SCAN_OFFLINE=1", r.stderr)

    def test_non_executable_gitleaks_bin_is_setup_failure_exit_2(self) -> None:
        with tempfile.NamedTemporaryFile() as f:
            r = run([str(SCAN), "--tree"], env={"GITLEAKS_BIN": f.name})
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)

    def test_head_history_of_this_checkout_is_clean(self) -> None:
        """The commits reachable from HEAD carry no secrets (what the gate SHOULD measure)."""
        r = run([str(SCAN), "--history", "--log-opts", "HEAD"])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_unknown_argument_exit_2(self) -> None:
        r = run([str(SCAN), "--bogus"])
        self.assertEqual(r.returncode, 2)


class Defects(unittest.TestCase):
    def test_history_verdict_depends_only_on_head_history(self) -> None:
        """DEFECT: `gitleaks git` defaults to `git log --all`, so a secret on ANY other ref in
        the clone (a sibling branch nobody merged) turns the history gate red for HEAD."""
        with TempGitRepo() as tmp:
            _scan_repo_copy(tmp)
            tmp.write("README.md", "clean\n")
            tmp.commit_all("clean main")
            tmp.git("checkout", "-q", "-b", "sibling")
            tmp.write("fixture.pem", FAKE_PEM)
            tmp.commit_all("sibling branch with a gitleaks-positive fixture")
            tmp.git("checkout", "-q", "main")
            r = run([str(tmp.dir / "scripts" / "security-scan.sh"), "--history"], cwd=tmp.dir)
            self.assertEqual(
                r.returncode,
                0,
                "history scan of a clean `main` is red because of an unrelated branch:\n" + r.stdout + r.stderr,
            )

    def test_in_situ_history_verdict_matches_head_only_verdict(self) -> None:
        """DEFECT (environment-dependent): in this checkout the default history scan and a
        HEAD-only scan must agree. They disagree whenever fetched sibling refs carry fixtures."""
        default = run([str(SCAN), "--history"])
        head_only = run([str(SCAN), "--history", "--log-opts", "HEAD"])
        self.assertEqual(
            default.returncode,
            head_only.returncode,
            f"default rc={default.returncode} vs HEAD-only rc={head_only.returncode}\n"
            + default.stdout
            + default.stderr,
        )

    def test_failure_output_names_the_findings_without_extra_flags(self) -> None:
        """DEFECT: without --verbose/--report-dir (how verify-cloud.sh and CI call it) a red
        scan prints 'FINDINGS — see output above' but gitleaks printed no finding at all."""
        d = _plant_in_artifacts()
        try:
            r = run([str(SCAN), "--tree"])
        finally:
            shutil.rmtree(d, ignore_errors=True)
        out = r.stdout + r.stderr
        self.assertEqual(r.returncode, 1, out)
        self.assertRegex(
            out,
            r"(RuleID|Finding|File:|private-key|ci-audit-probe)",
            "no rule/file/fingerprint of the finding appears in the default output:\n" + out,
        )

    def test_gitleaks_bin_override_must_be_a_real_gitleaks(self) -> None:
        """DEFECT: GITLEAKS_BIN pointing at a binary that is not gitleaks (here /bin/true) only
        warns, so a planted secret yields PASS exit 0 with no scan performed."""
        d = _plant_in_artifacts()
        try:
            r = run([str(SCAN), "--tree"], env={"GITLEAKS_BIN": "/bin/true"})
        finally:
            shutil.rmtree(d, ignore_errors=True)
        self.assertNotEqual(r.returncode, 0, "PASS with a planted secret and no scanner:\n" + r.stdout + r.stderr)

    def test_report_dir_json_must_exist_after_a_scan(self) -> None:
        """DEFECT: --report-dir is trusted blindly; a scanner that writes nothing still passes."""
        with tempfile.TemporaryDirectory() as report:
            r = run([str(SCAN), "--tree", "--report-dir", report], env={"GITLEAKS_BIN": "/bin/true"})
            written = (pathlib.Path(report) / "gitleaks-tree.json").exists()
        self.assertTrue(
            r.returncode != 0 or written,
            f"exit {r.returncode} and gitleaks-tree.json written={written}",
        )


if __name__ == "__main__":
    unittest.main()
