"""Offline failure-path tests for the production-program coordinator.

    python3 -m unittest .devin/skills/production-program/test_program_lib.py

No network, no child sessions: the runtime primitives are faked.
"""

from __future__ import annotations

import asyncio
import copy
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import program_lib as pl  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
MANIFEST = os.path.join(ROOT, ".devin", "program", "manifest.json")
BASE = "c23d16013b9872cdba7541329c9151d23045090b"
HEAD = "a" * 40


def ok_records(pkg: dict, **override) -> list[dict]:
    out = []
    for a in pkg["acceptance"]:
        rec = {
            "id": a["id"],
            "status": "PASS",
            "command": a["command"],
            "exit_code": 0,
            "executed": 12 if a["kind"] in ("test", "regress") else 0,
            "passed": 12 if a["kind"] in ("test", "regress") else 0,
            "failed": 0,
            "skipped": 0,
            "artifact": "artifacts/x.log",
            "note": "",
        }
        rec.update(override)
        out.append(rec)
    return out


def good_impl(pkg: dict) -> dict:
    return {
        "package_id": pkg["id"],
        "branch": f"devin/pp/{pkg['id'].lower()}/impl-r1",
        "head_sha": HEAD,
        "base_sha": BASE,
        "files_changed": pkg["write_paths"][:1],
        "acceptance_results": ok_records(pkg),
        "blocked": False,
        "summary": "done",
    }


def good_review(pkg: dict) -> dict:
    return {
        "package_id": pkg["id"],
        "reviewed_sha": HEAD,
        "verdict": "approve",
        "acceptance_reverified": ok_records(pkg),
        "regression_fails_on_base": True,
        "scope_violation": False,
        "invariant_violations": [],
        "blocking_issues": [],
        "summary": "ok",
    }


def good_adv(pkg: dict) -> dict:
    return {"package_id": pkg["id"], "attacked_sha": HEAD, "attacks_tried": 7, "breaks": [], "summary": "held"}


class ManifestTests(unittest.TestCase):
    def test_manifest_integrity_and_graph(self):
        m = pl.load_manifest(MANIFEST)
        ids = {p["id"] for p in m["packages"]}
        self.assertGreater(len(ids), 70)
        for p in m["packages"]:
            for d in p["deps"]:
                self.assertIn(d, ids)
            self.assertTrue(p["acceptance"])
            for a in p["acceptance"]:
                self.assertIn(a["kind"], ("test", "check", "regress", "manual"))

    def test_tampered_manifest_rejected(self):
        with open(MANIFEST, encoding="utf8") as fh:
            m = json.load(fh)
        m["packages"][0]["objective"] += " tampered"
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump(m, fh)
        with self.assertRaises(ValueError):
            pl.load_manifest(fh.name)


class JudgeTests(unittest.TestCase):
    def setUp(self):
        self.m = pl.load_manifest(MANIFEST)
        self.pkg = pl.find_package(self.m, "W01-05")  # has test + regress + check kinds

    def test_accepts_complete_evidence(self):
        d = pl.judge(self.pkg, good_impl(self.pkg), good_review(self.pkg), good_adv(self.pkg))
        self.assertTrue(d.accepted, d.reasons)

    def test_rejects_empty_acceptance(self):
        impl = good_impl(self.pkg)
        impl["acceptance_results"] = []
        d = pl.judge(self.pkg, impl, good_review(self.pkg), good_adv(self.pkg))
        self.assertFalse(d.accepted)
        self.assertTrue(any("empty" in r for r in d.reasons))

    def test_rejects_pass_prefixed_strings(self):
        impl = good_impl(self.pkg)
        impl["acceptance_results"] = ["PASS all good", "PASS"]
        d = pl.judge(self.pkg, impl, good_review(self.pkg), good_adv(self.pkg))
        self.assertFalse(d.accepted)

    def test_rejects_missing_criterion(self):
        impl = good_impl(self.pkg)
        impl["acceptance_results"] = impl["acceptance_results"][:-1]
        d = pl.judge(self.pkg, impl, good_review(self.pkg), good_adv(self.pkg))
        self.assertIn("impl: " + self.pkg["acceptance"][-1]["id"] + " not covered", d.reasons)

    def test_rejects_duplicate_and_unknown_ids(self):
        impl = good_impl(self.pkg)
        impl["acceptance_results"].append(copy.deepcopy(impl["acceptance_results"][0]))
        impl["acceptance_results"].append({**impl["acceptance_results"][0], "id": "BOGUS"})
        d = pl.judge(self.pkg, impl, good_review(self.pkg), good_adv(self.pkg))
        self.assertTrue(any("duplicate" in r for r in d.reasons))
        self.assertTrue(any("unknown" in r for r in d.reasons))

    def test_zero_tests_skipped_and_failed_are_non_passing(self):
        for override, needle in (
            ({"executed": 0, "passed": 0}, "zero tests"),
            ({"skipped": 1}, "skipped"),
            ({"failed": 1}, "failed"),
            ({"exit_code": 1}, "exit_code 1"),
            ({"exit_code": None}, "exit_code missing"),
            ({"status": "SKIPPED"}, "status SKIPPED"),
            ({"status": "PASS (see notes)"}, "status PASS (SEE NOTES)"),
        ):
            impl = good_impl(self.pkg)
            impl["acceptance_results"] = ok_records(self.pkg, **override)
            d = pl.judge(self.pkg, impl, good_review(self.pkg), good_adv(self.pkg))
            self.assertFalse(d.accepted, override)
            self.assertTrue(any(needle in r for r in d.reasons), (override, d.reasons))

    def test_reviewer_must_reverify_independently(self):
        rev = good_review(self.pkg)
        rev["acceptance_reverified"] = []
        d = pl.judge(self.pkg, good_impl(self.pkg), rev, good_adv(self.pkg))
        self.assertTrue(any(r.startswith("review: ") for r in d.reasons))

    def test_sha_mismatch_rejected(self):
        rev = good_review(self.pkg)
        rev["reviewed_sha"] = "b" * 40
        d = pl.judge(self.pkg, good_impl(self.pkg), rev, good_adv(self.pkg))
        self.assertIn("reviewer sha != candidate sha", d.reasons)
        adv = good_adv(self.pkg)
        adv["attacked_sha"] = "abc"
        d = pl.judge(self.pkg, good_impl(self.pkg), good_review(self.pkg), adv)
        self.assertIn("adversary sha != candidate sha", d.reasons)

    def test_short_or_missing_head_sha_rejected(self):
        impl = good_impl(self.pkg)
        impl["head_sha"] = HEAD[:12]
        d = pl.judge(self.pkg, impl, good_review(self.pkg), good_adv(self.pkg))
        self.assertTrue(any("40-hex" in r for r in d.reasons))

    def test_regression_must_fail_on_base(self):
        rev = good_review(self.pkg)
        rev["regression_fails_on_base"] = False
        d = pl.judge(self.pkg, good_impl(self.pkg), rev, good_adv(self.pkg))
        self.assertIn("regression tests not shown to fail on base", d.reasons)

    def test_review_verdict_scope_invariants(self):
        for field, value, needle in (
            ("verdict", "request_changes", "reviewer verdict"),
            ("blocking_issues", ["x"], "blocking issues"),
            ("scope_violation", True, "scope violation"),
            ("invariant_violations", ["widened grant"], "invariant violations"),
        ):
            rev = good_review(self.pkg)
            rev[field] = value
            d = pl.judge(self.pkg, good_impl(self.pkg), rev, good_adv(self.pkg))
            self.assertTrue(any(needle in r for r in d.reasons), (field, d.reasons))

    def test_adversary_breaks_and_zero_attacks(self):
        adv = good_adv(self.pkg)
        adv["breaks"] = [{"severity": "P1", "title": "double charge"}]
        d = pl.judge(self.pkg, good_impl(self.pkg), good_review(self.pkg), adv)
        self.assertTrue(any("adversarial P0/P1" in r for r in d.reasons))
        adv = good_adv(self.pkg)
        adv["breaks"] = [{"severity": "P3", "title": "nit"}]
        self.assertTrue(pl.judge(self.pkg, good_impl(self.pkg), good_review(self.pkg), adv).accepted)
        adv["attacks_tried"] = 0
        self.assertFalse(pl.judge(self.pkg, good_impl(self.pkg), good_review(self.pkg), adv).accepted)

    def test_blocked_impl_rejected(self):
        impl = good_impl(self.pkg)
        impl["blocked"] = True
        impl["blocked_reason"] = "needs staging creds"
        d = pl.judge(self.pkg, impl, good_review(self.pkg), good_adv(self.pkg))
        self.assertTrue(any("blocked" in r for r in d.reasons))

    def test_manual_requires_artifact(self):
        pkg = pl.find_package(self.m, "W05-01")
        impl = good_impl(pkg)
        impl["acceptance_results"] = ok_records(pkg, artifact="")
        self.assertTrue(any("artifact" in r for r in pl.grade_acceptance(pkg, impl["acceptance_results"])))


class FakeRuntime:
    """Scripted agent responses keyed by label; records calls."""

    class Err(Exception):
        pass

    def __init__(self, script: dict):
        self.script = script
        self.calls: list[str] = []
        self.logs: list[str] = []
        self.registered = None

    async def register_workflow(self, meta):
        self.registered = meta

    async def agent(self, prompt, **kw):
        label = kw["label"]
        self.calls.append(label)
        assert kw["phase"] in ("implement", "review", "adversary")
        assert isinstance(kw["schema"], dict) and kw["schema"]["type"] == "object"
        assert 1 <= kw["soft_time_limit_minutes"] <= 60
        assert BASE in prompt and "never push to `main`" in prompt.lower() or "Never push to `main`" in prompt
        resp = self.script[label]
        if resp is FakeRuntime.Err:
            raise FakeRuntime.Err(f"{label} died")
        return copy.deepcopy(resp)

    def log(self, msg):
        self.logs.append(msg)

    def runtime(self):
        return pl.Runtime(self.register_workflow, self.agent, self.log, FakeRuntime.Err)


def run(rt: FakeRuntime, pkg_id: str, **kw) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        return asyncio.run(
            pl.run_package(
                package_id=pkg_id,
                base_sha=BASE,
                integration_branch="codex/production-continuation-20260907",
                manifest_path=MANIFEST,
                out_root=tmp,
                runtime=rt.runtime(),
                **kw,
            )
        )


class OrchestrationTests(unittest.TestCase):
    def setUp(self):
        self.m = pl.load_manifest(MANIFEST)
        self.pkg = pl.find_package(self.m, "W01-05")
        self.pid = self.pkg["id"]

    def test_happy_path_one_round_three_distinct_agents(self):
        rt = FakeRuntime({f"implement-{self.pid}-r1": good_impl(self.pkg), f"review-{self.pid}-r1": good_review(self.pkg), f"adversary-{self.pid}-r1": good_adv(self.pkg)})
        rec = run(rt, self.pid)
        self.assertEqual(rec["status"], "ACCEPTED")
        self.assertEqual(rec["candidate"]["head_sha"], HEAD)
        self.assertEqual(rt.calls, [f"implement-{self.pid}-r1", f"review-{self.pid}-r1", f"adversary-{self.pid}-r1"])
        self.assertEqual(rec["agent_counts"], {"requested": 3, "launched": 3, "completed": 3, "failed": 0})
        self.assertEqual(rt.registered["name"], f"pickle-sensei-program-{self.pid.lower()}")

    def test_rejection_requeues_with_findings_then_accepts(self):
        adv1 = good_adv(self.pkg)
        adv1["breaks"] = [{"severity": "P0", "title": "partial outcome charged", "repro": "npx jest x"}]
        impl2 = good_impl(self.pkg)
        impl2["branch"] = f"devin/pp/{self.pid.lower()}/impl-r2"
        rt = FakeRuntime(
            {
                f"implement-{self.pid}-r1": good_impl(self.pkg),
                f"review-{self.pid}-r1": good_review(self.pkg),
                f"adversary-{self.pid}-r1": adv1,
                f"implement-{self.pid}-r2": impl2,
                f"review-{self.pid}-r2": good_review(self.pkg),
                f"adversary-{self.pid}-r2": good_adv(self.pkg),
            }
        )
        rec = run(rt, self.pid)
        self.assertEqual(rec["status"], "ACCEPTED")
        self.assertEqual(rec["candidate"]["round"], 2)
        self.assertFalse(rec["rounds"][0]["decision"]["accepted"])
        self.assertEqual(len(rt.calls), 6)

    def test_exhausted_rounds_requeue_not_dropped(self):
        rev = good_review(self.pkg)
        rev["verdict"] = "reject"
        rev["blocking_issues"] = ["wrong approach"]
        rt = FakeRuntime({f"{r}-{self.pid}-r{n}": (rev if r == "review" else good_impl(self.pkg) if r == "implement" else good_adv(self.pkg)) for r in ("implement", "review", "adversary") for n in (1, 2)})
        rec = run(rt, self.pid)
        self.assertEqual(rec["status"], "REQUEUE")
        self.assertNotIn("candidate", rec)

    def test_insufficient_impl_evidence_skips_review_and_adversary(self):
        impl = good_impl(self.pkg)
        impl["acceptance_results"] = []
        rt = FakeRuntime({f"implement-{self.pid}-r1": impl, f"implement-{self.pid}-r2": impl})
        rec = run(rt, self.pid)
        self.assertEqual(rec["status"], "REQUEUE")
        self.assertEqual(rt.calls, [f"implement-{self.pid}-r1", f"implement-{self.pid}-r2"])

    def test_blocked_impl_stops_as_external(self):
        impl = good_impl(self.pkg)
        impl["blocked"] = True
        impl["blocked_reason"] = "owner staging credentials required"
        rt = FakeRuntime({f"implement-{self.pid}-r1": impl})
        rec = run(rt, self.pid)
        self.assertEqual(rec["status"], "BLOCKED_EXTERNAL")
        self.assertEqual(len(rt.calls), 1)

    def test_agent_death_is_recorded_and_requeued(self):
        rt = FakeRuntime({f"implement-{self.pid}-r1": FakeRuntime.Err, f"implement-{self.pid}-r2": good_impl(self.pkg), f"review-{self.pid}-r2": FakeRuntime.Err, f"adversary-{self.pid}-r2": good_adv(self.pkg)})
        rec = run(rt, self.pid)
        self.assertEqual(rec["status"], "REQUEUE")
        self.assertEqual(rec["agent_counts"]["failed"], 2)
        self.assertEqual(rec["agent_counts"]["completed"], 2)
        self.assertEqual(rec["rounds"][0]["decision"]["reasons"], ["implementer session failed"])

    def test_external_and_docs_planes_not_launchable(self):
        rt = FakeRuntime({})
        for pid in ("EXT-DEVICE", "W12-01"):
            with self.assertRaises(ValueError):
                run(rt, pid)

    def test_short_base_sha_rejected(self):
        rt = FakeRuntime({})
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                asyncio.run(pl.run_package(package_id=self.pid, base_sha=BASE[:12], integration_branch="x", manifest_path=MANIFEST, out_root=tmp, runtime=rt.runtime()))

    def test_prompts_are_stable(self):
        a = pl.implement_prompt(self.pkg, BASE, "codex/x", 1, None)
        b = pl.implement_prompt(self.pkg, BASE, "codex/x", 1, None)
        self.assertEqual(a, b)
        self.assertIn("never edit an applied migration", a)
        self.assertIn("W01-05-AC1", a)
        rp = pl.review_prompt(self.pkg, BASE, "codex/x", good_impl(self.pkg))
        self.assertIn("You did NOT write this candidate", rp)
        self.assertIn(HEAD, rp)


if __name__ == "__main__":
    unittest.main()
