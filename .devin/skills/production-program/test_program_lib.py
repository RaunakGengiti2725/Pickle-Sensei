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

    def test_rejects_duplicate_ids_and_ignores_extra_ids(self):
        impl = good_impl(self.pkg)
        impl["acceptance_results"].append(copy.deepcopy(impl["acceptance_results"][0]))
        d = pl.judge(self.pkg, impl, good_review(self.pkg), good_adv(self.pkg))
        self.assertTrue(any("duplicate" in r for r in d.reasons))
        # extra evidence (e.g. "format-check") is ignored, never graded and never a rejection
        impl = good_impl(self.pkg)
        impl["acceptance_results"].append({**impl["acceptance_results"][0], "id": "format-check", "status": "FAIL", "exit_code": 1})
        d = pl.judge(self.pkg, impl, good_review(self.pkg), good_adv(self.pkg))
        self.assertTrue(d.accepted, d.reasons)
        # ...but a required criterion can never be satisfied by an extra id
        impl["acceptance_results"] = [r for r in impl["acceptance_results"] if r["id"] != self.pkg["acceptance"][0]["id"]]
        d = pl.judge(self.pkg, impl, good_review(self.pkg), good_adv(self.pkg))
        self.assertIn("impl: " + self.pkg["acceptance"][0]["id"] + " not covered", d.reasons)

    def test_documented_skips_only_when_named_and_bounded(self):
        pkg = copy.deepcopy(self.pkg)
        test_crit = next(a for a in pkg["acceptance"] if a["kind"] == "test")
        test_crit["documented_skips"] = ["alpha.test.ts", "beta.test.ts"]

        def graded(skipped: int, note: str) -> list[str]:
            recs = ok_records(pkg)
            for r in recs:
                if r["id"] == test_crit["id"]:
                    r["skipped"] = skipped
                    r["note"] = note
            return pl.grade_acceptance(pkg, recs)

        self.assertEqual(graded(0, ""), [])
        self.assertEqual(graded(1, "skipped: alpha.test.ts (Mac artifact)"), [])
        self.assertEqual(graded(2, "alpha.test.ts and beta.test.ts skipped"), [])
        self.assertTrue(graded(1, "one unrelated skip"))  # unnamed skip => fail
        self.assertTrue(graded(2, "alpha.test.ts"))  # two skips, one named => fail
        self.assertTrue(graded(3, "alpha.test.ts beta.test.ts gamma"))  # more than documented => fail
        # criteria without documented_skips keep the strict rule
        undoc = copy.deepcopy(self.pkg)
        recs = ok_records(undoc, skipped=1)
        for r in recs:
            r["note"] = "alpha.test.ts"
        self.assertTrue(any("skipped" in r for r in pl.grade_acceptance(undoc, recs)))

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
        assert kw["phase"] in ("implement", "review", "adversary", "attack")
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

    def test_competing_lanes_lowest_accepted_lane_wins_and_findings_merge(self):
        pid = self.pid
        lane2_impl = good_impl(self.pkg)
        lane2_impl["branch"] = f"devin/pp/{pid.lower()}/impl-r1-c2"
        lane2_impl["head_sha"] = "b" * 40
        lane2_rev = good_review(self.pkg)
        lane2_rev["reviewed_sha"] = "b" * 40
        lane2_adv = good_adv(self.pkg)
        lane2_adv["attacked_sha"] = "b" * 40
        adv1 = good_adv(self.pkg)
        adv1["breaks"] = [{"severity": "P0", "title": "lane1 charged a partial", "repro": "npx jest x"}]
        rt = FakeRuntime(
            {
                f"implement-{pid}-r1": good_impl(self.pkg),
                f"review-{pid}-r1": good_review(self.pkg),
                f"adversary-{pid}-r1": adv1,
                f"implement-{pid}-r1-c2": lane2_impl,
                f"review-{pid}-r1-c2": lane2_rev,
                f"adversary-{pid}-r1-c2": lane2_adv,
            }
        )
        rec = run(rt, pid, competing=2)
        self.assertEqual(rec["status"], "ACCEPTED")
        self.assertEqual(rec["candidate"], {"branch": lane2_impl["branch"], "head_sha": "b" * 40, "round": 1, "lane": 2})
        self.assertEqual(rec["rounds"][0]["winning_lane"], 2)
        self.assertEqual(len(rec["rounds"][0]["lanes"]), 2)
        self.assertEqual(rec["agent_counts"], {"requested": 6, "launched": 6, "completed": 6, "failed": 0})
        self.assertEqual(sorted(rt.calls)[:2], [f"adversary-{pid}-r1", f"adversary-{pid}-r1-c2"])
        # Lane 2's implementer prompt names its own branch and the competing rule.
        self.assertIn("impl-r1-c2", pl.implement_prompt(self.pkg, BASE, "x", 1, None, lane=2))
        self.assertIn("COMPETING LANE 2", pl.implement_prompt(self.pkg, BASE, "x", 1, None, lane=2))
        self.assertNotIn("COMPETING LANE", pl.implement_prompt(self.pkg, BASE, "x", 1, None, lane=1))

        # Both lanes rejected: the next round's prior carries every lane's findings; a single blocked lane is not BLOCKED_EXTERNAL.
        both_bad_adv = good_adv(self.pkg)
        both_bad_adv["breaks"] = [{"severity": "P1", "title": "lane2 break", "repro": "deno test y"}]
        both_bad_adv["attacked_sha"] = "b" * 40
        blocked_impl = good_impl(self.pkg)
        blocked_impl["blocked"] = True
        blocked_impl["blocked_reason"] = "needs staging"
        blocked_impl["branch"] = f"devin/pp/{pid.lower()}/impl-r2"
        rt2 = FakeRuntime(
            {
                f"implement-{pid}-r1": good_impl(self.pkg),
                f"review-{pid}-r1": good_review(self.pkg),
                f"adversary-{pid}-r1": adv1,
                f"implement-{pid}-r1-c2": lane2_impl,
                f"review-{pid}-r1-c2": lane2_rev,
                f"adversary-{pid}-r1-c2": both_bad_adv,
                f"implement-{pid}-r2": blocked_impl,
                f"implement-{pid}-r2-c2": FakeRuntime.Err,
            }
        )
        rec2 = run(rt2, pid, competing=2)
        self.assertEqual(rec2["status"], "BLOCKED_EXTERNAL")
        r2_prompt = [c for c in rt2.calls if c == f"implement-{pid}-r2"]
        self.assertEqual(len(r2_prompt), 1)
        prior = pl.merge_lane_priors(rec2["rounds"][0]["lanes"])
        self.assertEqual(prior["head_sha"], HEAD)
        self.assertEqual(prior["findings"]["competing_lanes"][0]["lane"], 2)
        self.assertEqual(prior["findings"]["competing_lanes"][0]["findings"]["adversary_breaks"][0]["title"], "lane2 break")
        with self.assertRaises(ValueError):
            run(FakeRuntime({}), pid, competing=0)

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

    def test_prompts_carry_serial_group_ownership(self):
        sg = self.m["serial_group_paths"]
        ip = pl.implement_prompt(self.pkg, BASE, "codex/x", 1, None, sg)
        self.assertIn("apps/mobile/src/analysis/", ip)
        self.assertIn("SCOPE POLICY", ip)
        rp = pl.review_prompt(self.pkg, BASE, "codex/x", good_impl(self.pkg), sg)
        self.assertIn("mobile-analysis", rp)
        self.assertIn("no shipping code path calls", rp)

    def test_review_and_adversary_run_concurrently_on_same_candidate(self):
        started: list[str] = []
        release = asyncio.Event()

        class Rt(FakeRuntime):
            async def agent(self, prompt, **kw):
                if kw["phase"] in ("review", "adversary"):
                    started.append(kw["phase"])
                    if len(started) == 2:
                        release.set()
                    await asyncio.wait_for(release.wait(), 2)
                return await super().agent(prompt, **kw)

        rt = Rt({f"implement-{self.pid}-r1": good_impl(self.pkg), f"review-{self.pid}-r1": good_review(self.pkg), f"adversary-{self.pid}-r1": good_adv(self.pkg)})
        rec = run(rt, self.pid)
        self.assertEqual(rec["status"], "ACCEPTED")
        self.assertEqual(sorted(started), ["adversary", "review"])

    def test_requeue_continues_round_numbering_with_prior_findings(self):
        rev1 = good_review(self.pkg)
        rev1["verdict"] = "reject"
        rev1["blocking_issues"] = ["admission not wired into runCaptureAnalysis"]
        adv1 = good_adv(self.pkg)
        adv1["breaks"] = [{"severity": "P1", "title": "two strokes fused", "repro": "npx jest y"}, {"severity": "P3", "title": "nit", "repro": "n/a"}]
        adv1["attack_branch"] = "devin/pp/attack/x"
        rt1 = FakeRuntime({f"implement-{self.pid}-r1": good_impl(self.pkg), f"review-{self.pid}-r1": rev1, f"adversary-{self.pid}-r1": adv1})
        first = run(rt1, self.pid, max_rounds=1, wave_id="pilot")
        self.assertEqual(first["status"], "REQUEUE")
        prior, start = pl.prior_from_record(first)
        self.assertEqual(start, 2)
        self.assertEqual(prior["head_sha"], HEAD)
        self.assertEqual(prior["findings"]["review_blocking"], rev1["blocking_issues"])
        self.assertEqual([b["title"] for b in prior["findings"]["adversary_breaks"]], ["two strokes fused"])
        self.assertEqual(prior["findings"]["adversary_branch"], "devin/pp/attack/x")

        seen_prompts: list[str] = []

        class Rt(FakeRuntime):
            async def agent(self, prompt, **kw):
                seen_prompts.append(prompt)
                return await super().agent(prompt, **kw)

        impl2 = good_impl(self.pkg)
        impl2["branch"] = f"devin/pp/{self.pid.lower()}/impl-r2"
        rt2 = Rt({f"implement-{self.pid}-r2": impl2, f"review-{self.pid}-r2": good_review(self.pkg), f"adversary-{self.pid}-r2": good_adv(self.pkg)})
        second = run(rt2, self.pid, max_rounds=1, wave_id="wave-1", start_round=start, prior=prior)
        self.assertEqual(second["status"], "ACCEPTED")
        self.assertEqual(second["candidate"]["round"], 2)
        self.assertEqual(second["start_round"], 2)
        self.assertEqual(second["requeued_from"], prior)
        self.assertEqual(rt2.calls[0], f"implement-{self.pid}-r2")
        self.assertIn("admission not wired into runCaptureAnalysis", seen_prompts[0])
        self.assertIn("two strokes fused", seen_prompts[0])

    def test_prior_from_record_without_implementer_result(self):
        prior, start = pl.prior_from_record({"rounds": [{"round": 1, "implement": None, "decision": {"reasons": ["implementer session failed"]}}]})
        self.assertIsNone(prior)
        self.assertEqual(start, 2)
        # A later round whose implementer stopped as blocked carries no findings: the evaluated round before it does.
        prior, start = pl.prior_from_record(
            {
                "rounds": [
                    {"round": 3, "implement": {"branch": "b3", "head_sha": HEAD}, "adversary": {"breaks": [{"severity": "P0", "title": "x"}]}, "decision": {"reasons": ["adversarial P0/P1 breaks: 1"]}},
                    {"round": 4, "implement": {"branch": "b4", "head_sha": "c" * 40, "blocked": True}, "decision": {"reasons": ["blocked: deferred"]}},
                ]
            }
        )
        self.assertEqual(start, 5)
        self.assertEqual(prior["branch"], "b3")
        self.assertEqual(prior["findings"]["adversary_breaks"][0]["title"], "x")

    def test_wave_id_scopes_the_record_directory(self):
        rt = FakeRuntime({f"implement-{self.pid}-r1": good_impl(self.pkg), f"review-{self.pid}-r1": good_review(self.pkg), f"adversary-{self.pid}-r1": good_adv(self.pkg)})
        with tempfile.TemporaryDirectory() as tmp:
            asyncio.run(pl.run_package(package_id=self.pid, base_sha=BASE, integration_branch="codex/x", manifest_path=MANIFEST, out_root=tmp, runtime=rt.runtime(), wave_id="wave-7"))
            with open(os.path.join(tmp, self.pid, "wave-7", "record.json"), encoding="utf8") as fh:
                self.assertEqual(json.load(fh)["status"], "ACCEPTED")


class WaveTests(unittest.TestCase):
    def setUp(self):
        self.m = pl.load_manifest(MANIFEST)
        self.a = pl.find_package(self.m, "W01-05")
        self.b = pl.find_package(self.m, "H07-01")

    def _script(self, *pkgs):
        s = {}
        for p in pkgs:
            s[f"implement-{p['id']}-r1"] = good_impl(p)
            s[f"review-{p['id']}-r1"] = good_review(p)
            s[f"adversary-{p['id']}-r1"] = good_adv(p)
        return s

    def _wave(self, rt: FakeRuntime, packages: list[dict], tmp: str, group_limit: int = 1) -> dict:
        return asyncio.run(pl.run_wave(wave_id="wave-9", packages=packages, base_sha=BASE, integration_branch="codex/x", manifest_path=MANIFEST, out_root=tmp, runtime=rt.runtime(), serial_group_limit=group_limit))

    def test_packages_run_concurrently_with_one_registration_and_own_records(self):
        started: list[str] = []
        release = asyncio.Event()

        class Rt(FakeRuntime):
            async def agent(self, prompt, **kw):
                if kw["phase"] == "implement":
                    started.append(kw["label"])
                    if len(started) == 2:
                        release.set()
                    await asyncio.wait_for(release.wait(), 2)
                return await super().agent(prompt, **kw)

        rt = Rt(self._script(self.a, self.b))
        with tempfile.TemporaryDirectory() as tmp:
            summary = self._wave(rt, [{"package_id": self.a["id"]}, {"package_id": self.b["id"]}], tmp)
            self.assertEqual(summary["packages"][self.a["id"]]["status"], "ACCEPTED")
            self.assertEqual(summary["packages"][self.b["id"]]["status"], "ACCEPTED")
            self.assertEqual(sorted(started), sorted([f"implement-{self.a['id']}-r1", f"implement-{self.b['id']}-r1"]))
            for pid in (self.a["id"], self.b["id"]):
                with open(os.path.join(tmp, pid, "wave-9", "record.json"), encoding="utf8") as fh:
                    self.assertEqual(json.load(fh)["status"], "ACCEPTED")
            with open(os.path.join(tmp, "_waves", "wave-9.json"), encoding="utf8") as fh:
                self.assertEqual(set(json.load(fh)["packages"]), {self.a["id"], self.b["id"]})
        self.assertEqual(rt.registered["name"], "pickle-sensei-program-wave-9")
        self.assertEqual(rt.registered["phases"][0]["count"], 4)
        self.assertEqual(len(rt.calls), 6)

    def test_one_failing_package_does_not_sink_the_wave(self):
        script = self._script(self.a, self.b)
        script[f"implement-{self.b['id']}-r1"] = FakeRuntime.Err
        script[f"implement-{self.b['id']}-r2"] = FakeRuntime.Err
        rt = FakeRuntime(script)
        with tempfile.TemporaryDirectory() as tmp:
            summary = self._wave(rt, [{"package_id": self.a["id"]}, {"package_id": self.b["id"], "max_rounds": 2}], tmp)
        self.assertEqual(summary["packages"][self.a["id"]]["status"], "ACCEPTED")
        self.assertEqual(summary["packages"][self.b["id"]]["status"], "REQUEUE")

    def test_wave_refuses_shared_serial_group(self):
        other = next(p for p in self.m["packages"] if p["id"] != self.a["id"] and set(p.get("serial_groups", [])) & set(self.a["serial_groups"]))
        rt = FakeRuntime({})
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                self._wave(rt, [{"package_id": self.a["id"]}, {"package_id": other["id"]}], tmp)
        self.assertIsNone(rt.registered)

    def test_group_limit_allows_bounded_sharing_and_freezes_integration_order(self):
        shared = set(self.a["serial_groups"])
        others = [p for p in self.m["packages"] if p["id"] != self.a["id"] and set(p.get("serial_groups", [])) & shared and p["plane"] not in ("external", "docs")]
        other = others[0]
        rt = FakeRuntime(self._script(self.a, other))
        with tempfile.TemporaryDirectory() as tmp:
            summary = self._wave(rt, [{"package_id": self.a["id"]}, {"package_id": other["id"]}], tmp, group_limit=2)
        self.assertEqual(summary["serial_group_limit"], 2)
        group = next(iter(shared & set(other["serial_groups"])))
        self.assertEqual(summary["integration_order"][group], [self.a["id"], other["id"]])
        self.assertEqual(summary["packages"][other["id"]]["status"], "ACCEPTED")
        # a third holder of the same group still exceeds the limit
        third = next((p for p in others[1:] if set(p["serial_groups"]) & {group}), None)
        if third is not None:
            with tempfile.TemporaryDirectory() as tmp:
                with self.assertRaises(ValueError):
                    self._wave(FakeRuntime({}), [{"package_id": self.a["id"]}, {"package_id": other["id"]}, {"package_id": third["id"]}], tmp, group_limit=2)
        with self.assertRaises(ValueError):
            self._wave(FakeRuntime({}), [{"package_id": self.a["id"]}], "/nonexistent", group_limit=0)

    def test_implement_prompt_states_shared_path_discipline(self):
        text = pl.implement_prompt(self.a, BASE, "codex/x", 1, None, self.m.get("serial_group_paths"))
        self.assertIn("SHARED-PATH DISCIPLINE", text)
        self.assertIn("integrated in a fixed order", text)

    def test_requeue_entry_continues_round_numbering(self):
        p = self.a
        rt = FakeRuntime({f"implement-{p['id']}-r3": good_impl(p), f"review-{p['id']}-r3": good_review(p), f"adversary-{p['id']}-r3": good_adv(p)})
        prior = {"branch": "devin/pp/x", "head_sha": HEAD, "findings": {"judge": ["adversarial P0/P1 breaks: 1"]}}
        with tempfile.TemporaryDirectory() as tmp:
            summary = self._wave(rt, [{"package_id": p["id"], "max_rounds": 1, "start_round": 3, "prior": prior}], tmp)
        self.assertEqual(summary["packages"][p["id"]]["status"], "ACCEPTED")
        self.assertEqual(summary["packages"][p["id"]]["candidate"]["round"], 3)
        self.assertEqual(rt.calls[0], f"implement-{p['id']}-r3")


class AdversaryFanoutTests(unittest.TestCase):
    def _run(self, rt: FakeRuntime, areas, tmp):
        return asyncio.run(pl.run_adversary_fanout(fanout_id="adv-1", head_sha=BASE, integration_branch="codex/x", out_root=tmp, runtime=rt.runtime(), areas=areas))

    def test_one_agent_per_area_records_breaks_and_untrusted_sha(self):
        lbl = lambda a: f"int-adversary-{a}-{BASE[:8]}"  # noqa: E731
        ok = {"package_id": "INT-auth-session", "attacked_sha": BASE, "attacks_tried": 9, "breaks": [{"severity": "P0", "title": "x", "repro": "cmd", "observed": "o", "expected": "e", "test_file": "t"}, {"severity": "P3", "title": "y", "repro": "c", "observed": "o", "expected": "e", "test_file": "t"}], "summary": "s"}
        wrong = dict(ok, attacked_sha=HEAD, package_id="INT-offline-lease")
        rt = FakeRuntime({lbl("auth-session"): ok, lbl("offline-lease"): wrong, lbl("e2e-journeys"): FakeRuntime.Err})
        with tempfile.TemporaryDirectory() as tmp:
            s = self._run(rt, ["auth-session", "offline-lease", "e2e-journeys"], tmp)
            with open(os.path.join(tmp, "_adversary", "adv-1", "auth-session.json"), encoding="utf8") as fh:
                self.assertEqual(len(json.load(fh)["breaks"]), 2)
            with open(os.path.join(tmp, "_adversary", "adv-1", "summary.json"), encoding="utf8") as fh:
                self.assertEqual(json.load(fh)["head_sha"], BASE)
        self.assertEqual(s["areas"]["auth-session"], {"status": "DONE", "breaks": 2, "blocking": 1})
        self.assertEqual(s["areas"]["offline-lease"]["status"], "SHA_MISMATCH")
        self.assertEqual(s["areas"]["offline-lease"]["breaks"], 0)
        self.assertEqual(s["areas"]["e2e-journeys"]["status"], "FAILED")
        self.assertEqual(rt.registered["phases"][0]["count"], 3)
        self.assertEqual(len(rt.calls), 3)
        self.assertEqual(sum(1 for a in s["agents"] if a["status"] == "failed"), 1)

    def test_rejects_unknown_area_bad_sha_and_defaults_to_all_areas(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                self._run(FakeRuntime({}), ["nope"], tmp)
            with self.assertRaises(ValueError):
                self._run(FakeRuntime({}), ["auth-session", "auth-session"], tmp)
            with self.assertRaises(ValueError):
                asyncio.run(pl.run_adversary_fanout(fanout_id="x", head_sha="abc", integration_branch="b", out_root=tmp, runtime=FakeRuntime({}).runtime()))
            rt = FakeRuntime({f"int-adversary-{a}-{BASE[:8]}": FakeRuntime.Err for a in pl.INTEGRATION_AREAS})
            s = self._run(rt, None, tmp)
        self.assertEqual(set(s["areas"]), set(pl.INTEGRATION_AREAS))
        for a in pl.INTEGRATION_AREAS:
            self.assertIn(a, pl.integration_adversary_prompt(a, pl.INTEGRATION_AREAS[a], BASE, "codex/x"))


if __name__ == "__main__":
    unittest.main()
