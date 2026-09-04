"""Shared helpers for the CI-script audit tests (tests/ci-scripts).

These tests exercise the shell/Python entry points under scripts/, tools/ and
.github/workflows/ as black boxes: they invoke the real scripts with
controlled environments and assert on exit codes and produced artifacts.

Run everything:      python3 -m unittest discover -s tests/ci-scripts -p 'test_*.py' -v
Run one module:      python3 -m unittest tests.ci-scripts.test_verify_cloud   (or by path)

Environment knobs:
  CI_AUDIT_SLOW=1    also run the slow tests (need Docker services / full pnpm test)
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
SCRIPTS = REPO / "scripts"
WORKFLOWS = REPO / ".github" / "workflows"
TOOLS = REPO / "tools"

SLOW = os.environ.get("CI_AUDIT_SLOW") == "1"
skip_unless_slow = unittest.skipUnless(SLOW, "set CI_AUDIT_SLOW=1 to run (Docker services / minutes)")


def run(
    cmd: list[str],
    *,
    cwd: pathlib.Path | str = REPO,
    env: dict[str, str] | None = None,
    stdin: str | None = None,
    timeout: int = 600,
) -> subprocess.CompletedProcess[str]:
    """Run a command, capturing text output; never raises on non-zero exit."""
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    return subprocess.run(
        cmd,
        cwd=str(cwd),
        env=full_env,
        input=stdin,
        text=True,
        errors="replace",
        capture_output=True,
        timeout=timeout,
    )


def bash_syntax_ok(path: pathlib.Path) -> bool:
    return run(["bash", "-n", str(path)]).returncode == 0


def clean_env_without(*names: str) -> dict[str, str]:
    """Copy of os.environ with the given variables removed (returned as the env override)."""
    env = dict(os.environ)
    for n in names:
        env.pop(n, None)
    return env


def path_without(*fragments: str) -> str:
    """PATH with every entry containing one of the fragments removed."""
    parts = [p for p in os.environ.get("PATH", "").split(os.pathsep) if not any(f in p for f in fragments)]
    return os.pathsep.join(parts)


def load_summary(artifacts: pathlib.Path) -> dict:
    return json.loads((artifacts / "summary.json").read_text())


def workflow_text(name: str) -> str:
    return (WORKFLOWS / name).read_text()


def verify_cloud_stage_array(name: str) -> list[str]:
    """Parse `NAME=(a b c)` from scripts/verify-cloud.sh without executing it."""
    text = (SCRIPTS / "verify-cloud.sh").read_text()
    m = re.search(rf"^{re.escape(name)}=\(([^)]*)\)", text, re.M)
    if not m:
        raise AssertionError(f"{name}=(...) not found in scripts/verify-cloud.sh")
    return m.group(1).split()


def ci_yml_only_stage_lists() -> list[list[str]]:
    """Every `scripts/verify-cloud.sh --only a,b,c` invocation in ci.yml, as lists."""
    text = workflow_text("ci.yml")
    return [s.split(",") for s in re.findall(r"scripts/verify-cloud\.sh --only ([a-z,]+)", text)]


class TempGitRepo:
    """A throwaway git repository (with a bare `origin`) for exercising git-driven scripts."""

    def __init__(self) -> None:
        self.dir = pathlib.Path(tempfile.mkdtemp(prefix="ci-audit-repo-"))
        self.origin = pathlib.Path(tempfile.mkdtemp(prefix="ci-audit-origin-"))

    def __enter__(self) -> "TempGitRepo":
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "audit@example.invalid")
        self.git("config", "user.name", "audit")
        subprocess.run(["git", "init", "-q", "--bare", str(self.origin)], check=True)
        self.git("remote", "add", "origin", str(self.origin))
        return self

    def __exit__(self, *exc: object) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)
        shutil.rmtree(self.origin, ignore_errors=True)

    def git(self, *args: str) -> str:
        return subprocess.run(
            ["git", *args], cwd=self.dir, check=True, text=True, capture_output=True
        ).stdout.strip()

    def write(self, rel: str, content: str = "x\n") -> None:
        p = self.dir / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)

    def commit_all(self, msg: str) -> str:
        self.git("add", "-A")
        self.git("commit", "-q", "-m", msg)
        return self.git("rev-parse", "HEAD")

    def copy_from_repo(self, rel: str) -> None:
        src = REPO / rel
        dst = self.dir / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)


def processes_with_env_marker(marker_name: str, marker_value: str) -> list[int]:
    """PIDs of live processes whose environment carries marker_name=marker_value (Linux /proc)."""
    needle = f"{marker_name}={marker_value}".encode()
    pids: list[int] = []
    for entry in pathlib.Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            environ = (entry / "environ").read_bytes()
        except (OSError, PermissionError):
            continue
        if needle in environ.split(b"\0"):
            pids.append(int(entry.name))
    return pids
