"""GitHub workflow contracts + tools/macos-ci, tools/devin, tools/diagnostics, scripts/*.sh.

Static pins read the YAML/shell sources; runtime tests execute the Linux-runnable
helpers with controlled inputs. Nothing here executes Apple tooling — a test that
needs xcrun/xcodebuild is not written (Apple truth is out of this plane).

Classes:
  Invariants  — behaviour that holds on 4d812e1a (verified_ok pins).
  Defects     — each test asserts the CORRECT behaviour; it FAILS on 4d812e1a.
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import shutil
import stat
import tempfile
import unittest

import yaml

from _harness import (
    REPO,
    SCRIPTS,
    TOOLS,
    WORKFLOWS,
    TempGitRepo,
    bash_syntax_ok,
    clean_env_without,
    run,
    workflow_text,
)

MACOS_CI = TOOLS / "macos-ci"


def _yaml(name: str) -> dict:
    d = yaml.safe_load(workflow_text(name))
    # PyYAML parses the bare `on:` key as boolean True.
    if True in d:
        d["on"] = d.pop(True)
    return d


class Invariants(unittest.TestCase):
    def test_all_shell_scripts_in_scope_parse(self) -> None:
        for p in [*SCRIPTS.glob("*.sh"), *MACOS_CI.glob("*.sh"), TOOLS / "devin" / "api_readiness.sh"]:
            with self.subTest(script=str(p.relative_to(REPO))):
                self.assertTrue(bash_syntax_ok(p), f"bash -n failed for {p}")
                self.assertTrue(os.access(p, os.X_OK), f"{p} is not executable")

    def test_ci_yml_is_least_privilege_and_thin(self) -> None:
        d = _yaml("ci.yml")
        self.assertEqual(d["permissions"], {"contents": "read"})
        self.assertEqual(sorted(d["on"].keys()), ["pull_request", "push"])
        self.assertEqual(d["on"]["push"], {"branches": ["main"]})
        for job, spec in d["jobs"].items():
            for step in spec.get("steps", []):
                cmd = step.get("run", "")
                if "verify-cloud" in cmd:
                    self.assertRegex(cmd.strip(), r"^scripts/verify-cloud\.sh --only [a-z,]+$", (job, cmd))
        self.assertIn("fetch-depth: 0", workflow_text("ci.yml"))  # history scan needs full clone

    def test_mac_full_verify_yml_has_no_pull_request_trigger(self) -> None:
        d = _yaml("mac-full-verify.yml")
        self.assertNotIn("pull_request", d["on"])
        self.assertNotIn("pull_request_target", d["on"])
        self.assertEqual(sorted(d["on"].keys()), ["push", "workflow_dispatch"])
        self.assertEqual(d["permissions"], {"contents": "read"})
        for job in d["jobs"].values():
            if "self-hosted" in job.get("runs-on", []):
                self.assertIn("timeout-minutes", job)
        self.assertIn("tools/macos-ci/apple-paths-changed.sh", workflow_text("mac-full-verify.yml"))

    def test_mac_smoke_test_yml_is_manual_only(self) -> None:
        d = _yaml("mac-smoke-test.yml")
        self.assertEqual(list(d["on"].keys()), ["workflow_dispatch"])

    def test_apple_paths_filter(self) -> None:
        with TempGitRepo() as tmp:
            tmp.copy_from_repo("tools/macos-ci/apple-paths-changed.sh")
            script = tmp.dir / "tools/macos-ci/apple-paths-changed.sh"
            script.chmod(0o755)
            tmp.write("README.md", "a\n")
            base = tmp.commit_all("base")
            tmp.write("README.md", "b\n")
            docs = tmp.commit_all("docs only")
            tmp.write("native/vision-core/Package.swift", "// swift\n")
            apple = tmp.commit_all("apple change")
            self.assertEqual(run([str(script), base, docs], cwd=tmp.dir).stdout.strip(), "false")
            self.assertEqual(run([str(script), docs, apple], cwd=tmp.dir).stdout.strip(), "true")
            zero = "0" * 40
            r = run([str(script), zero, apple], cwd=tmp.dir)
            self.assertEqual(r.stdout.strip(), "true")
            self.assertIn("no base commit", r.stderr)
            self.assertEqual(run([str(script), apple], cwd=tmp.dir).returncode, 2)
            # every Apple path class the workflow relies on
            for rel in [
                "apps/mobile/ios/Podfile",
                "apps/mobile/package.json",
                "apps/mobile/package-lock.json",
                "apps/mobile/Gemfile.lock",
                "scripts/mac-full-verify.sh",
                "tools/macos-ci/x.sh",
                ".github/workflows/mac-full-verify.yml",
            ]:
                tmp.write(rel, "x\n")
                after = tmp.commit_all(rel)
                self.assertEqual(run([str(script), apple, after], cwd=tmp.dir).stdout.strip(), "true", rel)
                apple = after

    def test_xcresult_summary_missing_bundle_is_reported(self) -> None:
        r = run(["python3", str(MACOS_CI / "xcresult-summary.py"), "/nonexistent.xcresult"])
        self.assertIn("(missing)", r.stdout)

    def test_describe_package_prints_summary_for_valid_json(self) -> None:
        payload = json.dumps(
            {
                "name": "VisionCore",
                "platforms": [{"name": "ios", "version": "16.0"}],
                "tools_version": "5.9",
                "targets": [{"name": "VisionCore", "type": "regular", "sources": ["a.swift"], "path": "Sources"}],
                "products": [{"name": "VisionCore", "type": {"library": ["automatic"]}}],
            }
        )
        r = run(["python3", str(MACOS_CI / "describe-package.py")], stdin=payload)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("package: VisionCore", r.stdout)
        self.assertIn("target VisionCore", r.stdout)

    def test_api_readiness_no_key_exit_2_and_never_prints_key(self) -> None:
        env = clean_env_without("DEVIN_API_KEY")
        r = run([str(TOOLS / "devin" / "api_readiness.sh")], env=env)
        self.assertEqual(r.returncode, 2)
        self.assertIn("NO_KEY", r.stderr)
        fake = "cog_audit_" + "z" * 24
        r = run(
            [str(TOOLS / "devin" / "api_readiness.sh")],
            env={"DEVIN_API_KEY": fake, "DEVIN_API_BASE": "http://127.0.0.1:9/api"},
        )
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertNotIn(fake, r.stdout + r.stderr)

    def test_local_api_probe_reports_unavailable_not_pass_when_no_api(self) -> None:
        env = clean_env_without("DEV_AUTH_SECRET")
        env["API_BASE_URL"] = "http://127.0.0.1:9"
        r = run(["node", str(TOOLS / "diagnostics" / "local_api_probe.mjs"), "--json"], env=env, timeout=120)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        out = json.loads(r.stdout)
        self.assertEqual(out["verdict"], "UNAVAILABLE")
        self.assertTrue(out["records"], out)
        self.assertTrue(all(rec["outcome"] == "unavailable" for rec in out["records"]), out)

    def test_verify_all_arg_errors_exit_2_and_no_mac_is_explicit(self) -> None:
        self.assertEqual(run([str(SCRIPTS / "verify-all.sh"), "--wat"]).returncode, 2)
        self.assertEqual(run([str(SCRIPTS / "verify-all.sh"), "--help"]).returncode, 0)
        with tempfile.TemporaryDirectory() as tmp:
            r = run(
                [str(SCRIPTS / "verify-all.sh"), "--no-mac", "--cloud-args", "--only ml"],
                env={"VERIFY_ARTIFACTS": tmp + "/a"},
            )
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("Apple verification SKIPPED (--no-mac)", r.stdout)
        self.assertIn("Apple-specific claims are unverified", r.stdout)

    def test_mac_full_verify_remote_refuses_tracked_modifications(self) -> None:
        with TempGitRepo() as tmp:
            tmp.copy_from_repo("scripts/mac-full-verify.sh")
            (tmp.dir / "scripts" / "mac-full-verify.sh").chmod(0o755)
            tmp.write("README.md", "a\n")
            tmp.commit_all("base")
            tmp.write("README.md", "modified\n")
            r = run([str(tmp.dir / "scripts" / "mac-full-verify.sh"), "--remote"], cwd=tmp.dir, env={"PATH": _path_with_fake_gh(tmp.dir)})
            self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
            self.assertIn("uncommitted changes", r.stderr)


def _path_with_fake_gh(dir_: pathlib.Path) -> str:
    """PATH where `gh` exists (so --remote passes its precondition) but does nothing."""
    bin_ = dir_ / "fakebin"
    bin_.mkdir(exist_ok=True)
    gh = bin_ / "gh"
    gh.write_text("#!/usr/bin/env bash\necho 'fake gh invoked' >&2\nexit 1\n")
    gh.chmod(0o755)
    return f"{bin_}{os.pathsep}{os.environ['PATH']}"


class Defects(unittest.TestCase):
    def test_mac_smoke_test_yml_declares_least_privilege_permissions(self) -> None:
        """DEFECT: REVIEW.md requires `permissions: contents: read` on workflows; mac-smoke-test.yml
        has no permissions block, so the job token gets the repository default scope."""
        d = _yaml("mac-smoke-test.yml")
        perms = d.get("permissions") or {j: s.get("permissions") for j, s in d["jobs"].items() if s.get("permissions")}
        self.assertTrue(perms, "no permissions block at workflow or job level")

    def test_xcresult_summary_unreadable_bundle_is_not_exit_0(self) -> None:
        """DEFECT: the docstring says the script 'can double as a gate', but a bundle that is a
        directory with no readable summary (or a missing bundle) exits 0 — a gate that passes
        when the evidence is absent."""
        with tempfile.TemporaryDirectory() as tmp:
            bogus = pathlib.Path(tmp) / "Broken.xcresult"
            bogus.mkdir()
            r = run(["python3", str(MACOS_CI / "xcresult-summary.py"), str(bogus), "/nonexistent.xcresult"])
        self.assertIn("(no test summary", r.stdout)
        self.assertIn("(missing)", r.stdout)
        self.assertNotEqual(r.returncode, 0, "exit 0 with zero readable test summaries:\n" + r.stdout)

    def test_describe_package_rejects_non_json_stdin_cleanly(self) -> None:
        """DEFECT: non-JSON stdin (a `swift package describe` error message) produces a raw
        Python traceback instead of a one-line diagnostic."""
        r = run(["python3", str(MACOS_CI / "describe-package.py")], stdin="error: no Package.swift\n")
        self.assertNotEqual(r.returncode, 0)
        self.assertNotIn("Traceback", r.stderr, r.stderr)

    def test_api_readiness_json_mode_emits_json_on_no_key(self) -> None:
        """DEFECT: `--json` promises machine-readable output but the NO_KEY path prints prose."""
        env = clean_env_without("DEVIN_API_KEY")
        r = run([str(TOOLS / "devin" / "api_readiness.sh"), "--json"], env=env)
        self.assertEqual(r.returncode, 2)
        try:
            json.loads(r.stdout or r.stderr)
        except json.JSONDecodeError:
            self.fail("--json NO_KEY output is not JSON:\n" + r.stdout + r.stderr)

    def test_mac_full_verify_remote_refuses_untracked_files(self) -> None:
        """DEFECT: the --remote dirty check is `git diff --quiet HEAD`, which ignores untracked
        files; a brand-new source file is silently absent from the commit the Mac builds."""
        with TempGitRepo() as tmp:
            tmp.copy_from_repo("scripts/mac-full-verify.sh")
            (tmp.dir / "scripts" / "mac-full-verify.sh").chmod(0o755)
            tmp.write("README.md", "a\n")
            tmp.commit_all("base")
            tmp.write("native/NewFile.swift", "// never committed\n")
            # break the remote so a push (the step AFTER the dirty check) fails fast instead of reaching gh
            tmp.git("remote", "set-url", "origin", str(tmp.dir / "does-not-exist.git"))
            r = run([str(tmp.dir / "scripts" / "mac-full-verify.sh"), "--remote"], cwd=tmp.dir, env={"PATH": _path_with_fake_gh(tmp.dir)})
            self.assertEqual(
                r.returncode,
                2,
                "untracked file did not stop --remote (it proceeded to push):\n" + r.stdout + r.stderr,
            )
            self.assertIn("uncommitted changes", r.stderr)

    def test_ci_yml_jobs_have_timeouts(self) -> None:
        """DEFECT: no job in ci.yml sets timeout-minutes; a hung pnpm test or docker pull holds
        the default 6 h runner slot (mac-full-verify.yml does set 150)."""
        d = _yaml("ci.yml")
        missing = [j for j, s in d["jobs"].items() if "timeout-minutes" not in s]
        self.assertEqual(missing, [], f"jobs without timeout-minutes: {missing}")

    def test_pod_install_does_not_mask_ruby_failure_in_export(self) -> None:
        """DEFECT (static): `export PATH="$(ruby -e …):$PATH"` — the assignment's exit status is
        export's (0), so under set -e a failing ruby is ignored and PATH gains a bogus ':' entry."""
        text = (MACOS_CI / "pod-install.sh").read_text()
        offending = [ln for ln in text.splitlines() if re.match(r'\s*export\s+\w+="?\$\(', ln)]
        self.assertEqual(offending, [], "export with command substitution masks its exit status: " + repr(offending))


if __name__ == "__main__":
    unittest.main()
