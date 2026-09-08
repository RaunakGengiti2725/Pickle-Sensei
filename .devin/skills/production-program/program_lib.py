"""Pickle Sensei production program — per-package dynamic-workflow coordinator.

One `run_workflow` run == ONE work package from `.devin/program/manifest.json`:

    implement (separate VM, branch devin/pp/<pkg>/impl-r<N>)
      -> independent review (separate VM, re-verifies EVERY acceptance criterion)
      -> adversary (separate VM, tries to break the candidate)
      -> deterministic judge (this module, no LLM)
      -> if rejected and rounds remain: rework implementer with the findings
      -> ledger record (artifacts/production-program/<pkg>/…)

Design rules (owner directive 2026-09-08):
- Base SHA is pinned by the launcher, never derived from `main` or the clock.
- Known baseline failures are recorded, not turned into waivers, and do not
  abort independent packages.
- Empty acceptance arrays and strings starting with "PASS" are not proof: each
  acceptance criterion must be covered exactly once by a structured record
  with exit code and counts, graded by `kind`.
- Candidate SHA must match across implementer, reviewer and adversary.
- Reviewers never approve their own work (three distinct agents per round).
- Failed / skipped / ignored / zero-executed test runs are non-passing.
- A rejected package is requeued (next round or `REQUEUE`), never dropped.
- All runtime primitives are injected so this module is unit-testable offline.

The launcher passes the shim's `register_workflow`, `agent`, `log` and
`WorkflowAgentError`; this module never imports them.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

LIB_VERSION = "2026-09-08.4"
REPO = "RaunakGengiti2725/Pickle-Sensei"
REPO_TOKEN = f"@{REPO}"
# Child sessions boot this repository's configured environment (separate VM).
CHILD_REPOS = (f"github.com/{REPO}",)
MAX_ROUNDS_DEFAULT = 2
SHA_RE = re.compile(r"^[0-9a-f]{40}$")

# ---------------------------------------------------------------------------
# Structured-output schemas (small, flat; only top-level `required` validated)
# ---------------------------------------------------------------------------

ACCEPTANCE_ITEM_DOC = (
    "one object per acceptance criterion id: {id, status: PASS|FAIL|UNKNOWN, command, exit_code, "
    "executed, passed, failed, skipped, artifact, note}. executed/passed/failed/skipped are integers "
    "(use 0 for non-test checks). artifact is a repo-relative log path or uploaded attachment URL. "
    "For kind=regress: exit_code is the PROOF outcome (0 only when the new tests FAIL on BASE_SHA and PASS "
    "on the candidate; otherwise 1) and executed/passed/failed/skipped are the candidate (HEAD) run's counts; "
    "put the base run's exit code, counts and log in `note`."
)

IMPLEMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "package_id": {"type": "string"},
        "branch": {"type": "string"},
        "head_sha": {"type": "string", "description": "40-hex sha of the pushed branch head (git rev-parse HEAD after push)"},
        "base_sha": {"type": "string"},
        "approach": {"type": "string"},
        "files_changed": {"type": "array", "items": {"type": "string"}},
        "out_of_scope_files": {"type": "array", "items": {"type": "string"}, "description": "changed files NOT under the package write_paths (must be empty or justified additive shared-path edits)"},
        "acceptance_results": {"type": "array", "items": {"type": "object"}, "description": ACCEPTANCE_ITEM_DOC},
        "regression_tests_added": {"type": "array", "items": {"type": "string"}},
        "baseline_failures_observed": {"type": "array", "items": {"type": "string"}, "description": "pre-existing failures on BASE_SHA you observed (recorded, not waived)"},
        "blocked": {"type": "boolean", "description": "true only if an external/permission dependency prevented completion"},
        "blocked_reason": {"type": "string"},
        "residual_risks": {"type": "array", "items": {"type": "string"}},
        "attachment_urls": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
    "required": ["package_id", "branch", "head_sha", "base_sha", "files_changed", "acceptance_results", "blocked", "summary"],
}

REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "package_id": {"type": "string"},
        "reviewed_sha": {"type": "string", "description": "git rev-parse HEAD after checking out the candidate branch"},
        "verdict": {"type": "string", "enum": ["approve", "request_changes", "reject"]},
        "acceptance_reverified": {"type": "array", "items": {"type": "object"}, "description": ACCEPTANCE_ITEM_DOC + " — YOUR OWN re-execution, not the implementer's numbers"},
        "regression_fails_on_base": {"type": "boolean", "description": "new regression tests FAIL on BASE_SHA and PASS on the candidate"},
        "scope_violation": {"type": "boolean", "description": "candidate edits files outside write_paths without justified additive shared-path use"},
        "invariant_violations": {"type": "array", "items": {"type": "string"}},
        "blocking_issues": {"type": "array", "items": {"type": "string"}},
        "non_blocking_issues": {"type": "array", "items": {"type": "string"}},
        "attachment_urls": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
    "required": ["package_id", "reviewed_sha", "verdict", "acceptance_reverified", "regression_fails_on_base", "scope_violation", "blocking_issues", "summary"],
}

ADVERSARY_SCHEMA = {
    "type": "object",
    "properties": {
        "package_id": {"type": "string"},
        "attacked_sha": {"type": "string"},
        "attacks_tried": {"type": "integer"},
        "breaks": {"type": "array", "items": {"type": "object"}, "description": "{severity: P0|P1|P2|P3, title, repro (exact command/test), observed, expected, test_file (pushed on attack_branch)}"},
        "attack_branch": {"type": "string", "description": "branch with the reproducing tests (empty if none)"},
        "attack_branch_sha": {"type": "string"},
        "attachment_urls": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
    "required": ["package_id", "attacked_sha", "attacks_tried", "breaks", "summary"],
}


# ---------------------------------------------------------------------------
# Manifest access
# ---------------------------------------------------------------------------


def load_manifest(path: str) -> dict:
    with open(path, encoding="utf8") as fh:
        m = json.load(fh)
    recorded = m.get("manifest_sha256")
    body = {k: v for k, v in m.items() if k != "manifest_sha256"}
    canonical = json.dumps(body, sort_keys=True, ensure_ascii=False, indent=2) + "\n"
    actual = hashlib.sha256(canonical.encode("utf8")).hexdigest()
    if recorded != actual:
        raise ValueError(f"manifest integrity mismatch: recorded {recorded} actual {actual}")
    return m


def find_package(manifest: dict, package_id: str) -> dict:
    for p in manifest["packages"]:
        if p["id"] == package_id:
            return p
    raise KeyError(f"package {package_id} not in manifest")


def dump(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# Deterministic grading
# ---------------------------------------------------------------------------


def _int(v: Any) -> int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, str) and v.strip().lstrip("-").isdigit():
        return int(v.strip())
    return None


def grade_acceptance(package: dict, records: Any) -> list[str]:
    """Return a list of failure reasons (empty == every criterion proven)."""
    reasons: list[str] = []
    if not isinstance(records, list) or not records:
        return ["acceptance_results empty or not a list"]
    expected = {a["id"]: a for a in package["acceptance"]}
    seen: dict[str, dict] = {}
    for rec in records:
        if not isinstance(rec, dict):
            reasons.append(f"non-object acceptance record: {rec!r}")
            continue
        rid = rec.get("id")
        if rid not in expected:
            reasons.append(f"unknown acceptance id {rid!r}")
            continue
        if rid in seen:
            reasons.append(f"duplicate acceptance record {rid}")
            continue
        seen[rid] = rec
    for rid, crit in expected.items():
        rec = seen.get(rid)
        if rec is None:
            reasons.append(f"{rid} not covered")
            continue
        status = str(rec.get("status", "")).strip().upper()
        if status != "PASS":
            reasons.append(f"{rid} status {status or 'missing'}")
            continue
        exit_code = _int(rec.get("exit_code"))
        if exit_code is None:
            reasons.append(f"{rid} exit_code missing")
            continue
        if exit_code != 0:
            reasons.append(f"{rid} exit_code {exit_code}")
            continue
        if not str(rec.get("command", "")).strip():
            reasons.append(f"{rid} command missing")
            continue
        kind = crit["kind"]
        if kind in ("test", "regress"):
            executed = _int(rec.get("executed"))
            failed = _int(rec.get("failed"))
            skipped = _int(rec.get("skipped"))
            if executed is None or failed is None or skipped is None:
                reasons.append(f"{rid} executed/failed/skipped counts missing")
                continue
            if executed <= 0:
                reasons.append(f"{rid} zero tests executed")
            if failed != 0:
                reasons.append(f"{rid} {failed} failed")
            if skipped != 0:
                reasons.append(f"{rid} {skipped} skipped/ignored")
        if kind == "manual" and not str(rec.get("artifact", "")).strip():
            reasons.append(f"{rid} manual criterion without artifact")
    return reasons


def blocking_breaks(adv: dict) -> list[dict]:
    out = []
    for b in adv.get("breaks") or []:
        if not isinstance(b, dict):
            out.append({"severity": "P0", "title": f"malformed break record {b!r}"})
            continue
        if str(b.get("severity", "")).upper() in ("P0", "P1"):
            out.append(b)
    return out


@dataclass
class Decision:
    accepted: bool
    reasons: list[str]
    criteria_examined: list[str]

    def as_dict(self) -> dict:
        return {"accepted": self.accepted, "reasons": self.reasons, "criteria_examined": self.criteria_examined}


def judge(package: dict, impl: dict, rev: dict, adv: dict) -> Decision:
    """Evidence-gated, deterministic. Every reason is recorded."""
    reasons: list[str] = []
    examined = [
        "implementer not blocked",
        "head_sha is a full sha",
        "reviewer and adversary examined the same sha",
        "implementer acceptance coverage",
        "reviewer independent re-verification",
        "regression tests fail on base",
        "reviewer verdict approve with no blocking issues",
        "no scope violation",
        "no invariant violations",
        "no unresolved P0/P1 adversarial break",
    ]
    if impl.get("blocked"):
        reasons.append(f"implementer blocked: {impl.get('blocked_reason') or 'no reason given'}")
    head = str(impl.get("head_sha", "")).strip().lower()
    if not SHA_RE.match(head):
        reasons.append(f"head_sha not a full 40-hex sha: {impl.get('head_sha')!r}")
    if str(rev.get("reviewed_sha", "")).strip().lower() != head:
        reasons.append("reviewer sha != candidate sha")
    if str(adv.get("attacked_sha", "")).strip().lower() != head:
        reasons.append("adversary sha != candidate sha")
    for r in grade_acceptance(package, impl.get("acceptance_results")):
        reasons.append(f"impl: {r}")
    for r in grade_acceptance(package, rev.get("acceptance_reverified")):
        reasons.append(f"review: {r}")
    needs_regress = any(a["kind"] == "regress" for a in package["acceptance"])
    if needs_regress and rev.get("regression_fails_on_base") is not True:
        reasons.append("regression tests not shown to fail on base")
    if rev.get("verdict") != "approve":
        reasons.append(f"reviewer verdict {rev.get('verdict')!r}")
    if rev.get("blocking_issues"):
        reasons.append(f"reviewer blocking issues: {len(rev['blocking_issues'])}")
    if rev.get("scope_violation"):
        reasons.append("scope violation")
    if rev.get("invariant_violations"):
        reasons.append(f"invariant violations: {len(rev['invariant_violations'])}")
    bb = blocking_breaks(adv)
    if bb:
        reasons.append(f"adversarial P0/P1 breaks: {len(bb)}")
    if _int(adv.get("attacks_tried")) in (None, 0):
        reasons.append("adversary tried zero attacks")
    return Decision(accepted=not reasons, reasons=reasons, criteria_examined=examined)


# ---------------------------------------------------------------------------
# Prompts (stable text => replayable)
# ---------------------------------------------------------------------------


def common_rules(base_sha: str, integration_branch: str) -> str:
    return f"""Repository: {REPO_TOKEN} (public GitHub monorepo). Shipping product: iOS app `apps/mobile` (iPhone-only, portrait, 2D v1). Production backend: Supabase Edge Function `supabase/functions/api` (Deno). `services/api` (Fastify) is legacy and NOT the mobile backend.
START STATE: `git fetch origin {integration_branch} && git checkout {base_sha}`. ALL work is relative to this exact commit. Never push to `main`, never open a pull request, never force-push, never rewrite history, never push to `ci/mac-*` or run `scripts/mac-full-verify.sh --remote` (the Mac runner is one shared machine owned by the coordinator).
READ FIRST: `AGENTS.md` (in full), `REVIEW.md`, `docs/prompts/codex-production-readiness.md`, the latest continuation section (§11) of `docs/RELEASE_READINESS_2026-09-07.md`, `docs/devin/OPERATING_SYSTEM.md`, `APP_STORE_SUBMISSION.md`, and the skills under `.agents/skills/`.
ENVIRONMENT: Node 22+ and pnpm 10.15.1 (root `pnpm install --frozen-lockfile`); `apps/mobile` uses npm ONLY (`cd apps/mobile && npm ci`) — never pnpm inside it; Deno via `curl -fsSL https://deno.land/install.sh | sh` if missing (frozen checks use `npx --yes deno@2.5.6`). Postgres for Edge/RLS tests: `docker compose up -d postgres postgres_test` or `docker run -d -p 55432:5432 -e POSTGRES_PASSWORD=pg postgres:16` and export `XC_PG_URL`/`DATABASE_URL_TEST` accordingly. `./supabase/tests/run_rls_tests.sh` needs Docker or a local initdb.
HARD RULES (a violation makes the candidate ineligible): never weaken, skip, delete or reorder tests; no `|| true`, `--passWithNoTests`, `@ts-ignore`, `any`, `eslint-disable`, inflated timeouts or force-exit; never edit an applied migration (add a new file with a LATER timestamp than every existing one); never widen grants/RLS or weaken session checks; never touch production Supabase (ucqnaiwqwjtgvlduiuib), App Store Connect, secrets, dashboards or diagnostics transport; never store/print secrets; never add Android/3D/Live Court/guest-entry scope; user-facing copy must follow APP_STORE_SUBMISSION.md (no Android, Google Play, guest mode, Live Court, DUPR, competitor names, accuracy %, superlatives or AI-coach-equivalence claims); no fabricated labels, metrics, approvals or benchmark numbers; do not modify existing code comments; do not run pnpm inside apps/mobile; do not run Debug and Release builds against the same Pods directory.
PRODUCT INVARIANTS: charge only after BOTH independently validated outputs are durably delivered; partial/failed/withheld/replayed results never consume a credit; ambiguous commitment => HOLD/recover (never refund or retry under a new operation id); offline allocation != consumption and a disconnected device's allocation is never auto-reclaimed; Pro offline leases <= 7 days and <= verified entitlement expiry; never persist provider/access tokens (only the approved refresh credential in the Keychain vault); preserve owner generations, original-owner recovery and cross-account isolation; unknown/corrupt state never becomes fabricated empty history, authorization, successful deletion or completed payment recovery; count free ratings through lifetime_scored_count() under access_lock_key(); diagnostics transport stays disabled.
SCOPE POLICY: `write_paths` is the declared scope. When wiring the objective end to end genuinely requires editing another file, you may do so ONLY if that file is not under a `serial_group_paths` prefix of a group this package does not hold (see the manifest's `serial_group_paths`), the edit is the minimum needed for the objective, and you list it in `out_of_scope_files` with a one-line justification; the independent reviewer decides whether it is justified wiring (`scope_violation=false`) or a violation. A new module that nothing in the shipping app calls does not meet an objective phrased as behaviour.
EVIDENCE STANDARD: every claim carries the exact command, exit code, executed/passed/failed/skipped counts and an artifact (log path in the repo checkout or an uploaded attachment URL via the upload_attachment tool). Label statements VERIFIED (you ran it) / INFERRED (read code) / UNKNOWN. A skipped, ignored, unavailable or zero-test run is NOT a pass. Missing output is UNVERIFIED, never PASS. Do not report 'PASS' prose — fill the structured acceptance objects exactly."""


def implement_prompt(pkg: dict, base_sha: str, integration_branch: str, round_no: int, prior: dict | None, serial_group_paths: dict | None = None) -> str:
    serial_group_paths = serial_group_paths or {}
    branch = f"devin/pp/{pkg['id'].lower()}/impl-r{round_no}"
    prior_block = ""
    if prior:
        prior_block = "\n\nPRIOR ROUND FINDINGS (you MUST resolve every item; the previous candidate branch is " + prior["branch"] + " at " + prior["head_sha"] + " — start from BASE_SHA and cherry-pick/reuse what is sound):\n" + dump(prior["findings"])
    return f"""{common_rules(base_sha, integration_branch)}

ROLE: IMPLEMENTER for work package {pkg['id']} ({pkg['parent']}) — round {round_no}.
BASE_SHA: {base_sha}
WORK PACKAGE (frozen manifest entry):
{dump({k: pkg[k] for k in ('id', 'title', 'objective', 'severity', 'source_ids', 'plane', 'write_paths', 'additive_shared_paths', 'serial_groups', 'acceptance', 'invariants', 'external_blocker')})}
SERIAL GROUP PATHS (edit only under groups this package holds): {dump(serial_group_paths)}

PROCEDURE:
1. Reproduce/scope: read the relevant code and tests; write down (in `summary`) the concrete defect or gap you found on BASE_SHA with file:line references. If the package objective is already fully satisfied on BASE_SHA, prove it with the acceptance commands and say so — do not invent work.
2. Write the regression test FIRST (it must fail on BASE_SHA), commit it separately, then implement the minimal, general fix inside `write_paths`, wired into the shipping code path so the objective is met as behaviour (not just as an unused module). Files listed in `additive_shared_paths` may only receive additive edits (new exports/routes), never behavioural changes to existing symbols. Any other file follows the SCOPE POLICY above — list it in `out_of_scope_files` with its justification.
3. Run EVERY acceptance command from the manifest exactly as written (substitute placeholders with the real paths you created), plus root `pnpm format:check` and `git diff --check`. Fix all failures at the root cause.
4. Commit with clear messages, push branch `{branch}` to origin (this exact name), and record `head_sha` = `git rev-parse HEAD` (40 hex).
5. If a pre-existing failure on BASE_SHA is unrelated to your package, record it in `baseline_failures_observed` with the exact command — do not fix it silently, do not skip it, and do not count it as your failure unless it is inside your write_paths.
6. If an external/permission dependency truly prevents completion, set `blocked=true` with the precise dependency; still push whatever verified partial work you have.

Fill `acceptance_results` with one object per acceptance id: {ACCEPTANCE_ITEM_DOC}{prior_block}"""


def review_prompt(pkg: dict, base_sha: str, integration_branch: str, impl: dict, serial_group_paths: dict | None = None) -> str:
    serial_group_paths = serial_group_paths or {}
    return f"""{common_rules(base_sha, integration_branch)}

ROLE: INDEPENDENT REVIEWER for work package {pkg['id']}. You did NOT write this candidate. Your job is to re-verify, not to trust.
BASE_SHA: {base_sha}
CANDIDATE: branch `{impl['branch']}` at sha `{impl['head_sha']}` (fetch it: `git fetch origin {impl['branch']} && git checkout {impl['head_sha']}`; record `reviewed_sha` = `git rev-parse HEAD`).
WORK PACKAGE (frozen manifest entry):
{dump({k: pkg[k] for k in ('id', 'title', 'objective', 'severity', 'write_paths', 'additive_shared_paths', 'acceptance', 'invariants')})}
IMPLEMENTER CLAIMS (verify, do not copy):
{dump({k: impl.get(k) for k in ('approach', 'files_changed', 'out_of_scope_files', 'acceptance_results', 'regression_tests_added', 'baseline_failures_observed', 'residual_risks', 'summary')})}

PROCEDURE:
1. `git diff --stat {base_sha}..{impl['head_sha']}` — every changed file must be under write_paths, an additive edit inside additive_shared_paths, or a justified minimal wiring edit listed in the implementer's `out_of_scope_files` that is NOT under a serial-group path this package does not hold (serial groups held: {dump(pkg.get('serial_groups', []))}; group paths: {dump(serial_group_paths)}). Set `scope_violation` accordingly and name the offending file in `blocking_issues`.
1b. The objective must be met as shipped behaviour: if the candidate adds a module that no shipping code path calls, that is a blocking issue, not a note.
2. Re-run EVERY acceptance command yourself on the candidate; fill `acceptance_reverified` with YOUR counts and exit codes (one object per acceptance id: {ACCEPTANCE_ITEM_DOC}).
3. Regression proof: check out BASE_SHA, copy ONLY the new/changed test files from the candidate over it, run them — they must FAIL; then run them on the candidate — they must PASS. Set `regression_fails_on_base`.
4. Read the whole diff against REVIEW.md and the package invariants: security (RLS, grants, session checks), billing conservation, owner isolation, copy rules, no test weakening, no bypasses, no comment edits, no migration history edits. List each violation in `invariant_violations`.
5. `verdict`: `approve` only if scope is clean, every criterion re-verified PASS with executed>0 and failed==skipped==0, regression proof holds, and there are zero blocking issues. Otherwise `request_changes` (fixable) or `reject` (wrong approach). Each blocking issue must be concrete: file:line, what is wrong, how to reproduce."""


def adversary_prompt(pkg: dict, base_sha: str, integration_branch: str, impl: dict) -> str:
    return f"""{common_rules(base_sha, integration_branch)}

ROLE: ADVERSARIAL TESTER for work package {pkg['id']}. Try to BREAK the candidate at its failure boundaries with reproducible tests — not generic criticism.
BASE_SHA: {base_sha}
CANDIDATE: branch `{impl['branch']}` at sha `{impl['head_sha']}` (fetch and check out; record `attacked_sha` = `git rev-parse HEAD`).
WORK PACKAGE:
{dump({k: pkg[k] for k in ('id', 'title', 'objective', 'write_paths', 'acceptance', 'invariants')})}
IMPLEMENTER SUMMARY: {impl.get('summary', '')}

ATTACK SURFACE (pick what applies, try at least 6 distinct attacks): concurrency/reentrancy (double submit, interleaved account switch, crash between steps), replay and duplicate identities, boundary values (empty, max, negative, NaN, far-future/past clocks, clock rollback), corrupt/partial persisted state, network failure at each step (timeout, 429 + Retry-After, 5xx, redirect), unauthorised roles (anon, other user, service) for new SQL/Edge surfaces (allowed AND denied paths), free-rating conservation (partial/replayed outcomes must not charge), copy/accessibility violations, process death and restart.
PROCEDURE: write each attack as a real test (Jest / Deno test / SQL) on branch `devin/pp/{pkg['id'].lower()}/attack-{impl['head_sha'][:8]}`, run it against the candidate, push the branch, record `attack_branch_sha`. Report every confirmed break as an object {{severity, title, repro, observed, expected, test_file}}. Severity: P0 = money/data loss/leak/security/crash on a supported path; P1 = incorrect behaviour on a supported path; P2/P3 = minor. An attack that did not break anything is still reported in `attacks_tried`. Do not modify the candidate's own tests or production code."""


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

AgentFn = Callable[..., Awaitable[dict]]


@dataclass
class Runtime:
    register_workflow: Callable[[dict], Awaitable[Any]]
    agent: AgentFn
    log: Callable[[str], None]
    agent_error: type


def _save(out_dir: str, name: str, obj: Any) -> None:
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, name), "w", encoding="utf8") as fh:
        fh.write(dump(obj) + "\n")


async def _call(rt: Runtime, ledger: list[dict], role: str, prompt: str, schema: dict, label: str, phase: str, minutes: int, mode: str | None) -> dict | None:
    entry = {"role": role, "label": label, "phase": phase, "status": "launched", "prompt_sha256": hashlib.sha256(prompt.encode("utf8")).hexdigest()}
    ledger.append(entry)
    rt.log(f"[{label}] launching {role}")
    kwargs: dict[str, Any] = {"phase": phase, "schema": schema, "label": label, "soft_time_limit_minutes": minutes, "repos": list(CHILD_REPOS)}
    if mode:
        kwargs["mode"] = mode
    try:
        result = await rt.agent(prompt, **kwargs)
    except rt.agent_error as err:  # type: ignore[misc]
        entry["status"] = "failed"
        entry["failure_reason"] = str(err)
        rt.log(f"[{label}] {role} FAILED: {err}")
        return None
    entry["status"] = "completed"
    return result


def prior_from_record(record: dict) -> tuple[dict | None, int]:
    """Findings the next round must resolve and the next round number, from a saved REQUEUE record.

    Only the last round that produced an implementer result contributes findings;
    the round counter continues so candidate branch names never collide.
    """
    rounds = record.get("rounds") or []
    next_round = max([int(r.get("round", 0)) for r in rounds] + [0]) + 1
    for rnd in reversed(rounds):
        impl = rnd.get("implement")
        if not impl:
            continue
        decision = rnd.get("decision") or {}
        rev = rnd.get("review") or {}
        adv = rnd.get("adversary") or {}
        findings: dict[str, Any] = {"judge": decision.get("reasons", [])}
        if rev:
            findings["review_blocking"] = rev.get("blocking_issues", [])
            findings["review_invariants"] = rev.get("invariant_violations", [])
        if adv:
            findings["adversary_breaks"] = blocking_breaks(adv)
            findings["adversary_branch"] = adv.get("attack_branch", "")
        return {"branch": impl.get("branch", ""), "head_sha": impl.get("head_sha", ""), "findings": findings}, next_round
    return None, next_round


def wave_phases(agent_slots: int) -> list[dict]:
    """Phase table for register_workflow: `agent_slots` implementer/reviewer/adversary calls each."""
    return [
        {"title": "implement", "detail": "one implementer per package round; regression test first", "count": agent_slots},
        {"title": "review", "detail": "independent reviewer re-executes every acceptance criterion", "count": agent_slots},
        {"title": "adversary", "detail": "adversarial tester attacks failure boundaries with real tests", "count": agent_slots},
    ]


async def run_wave(
    *,
    wave_id: str,
    packages: list[dict],
    base_sha: str,
    integration_branch: str,
    manifest_path: str,
    out_root: str,
    runtime: Runtime,
    mode: str | None = None,
) -> dict:
    """Run many packages concurrently inside ONE workflow run.

    `packages` is a frozen list of {package_id, max_rounds, start_round, prior};
    each package gets its own implementer → (reviewer ‖ adversary) → judge
    pipeline and its own ledger record. The wave is registered once; a
    package whose pipeline raises is recorded as FAILED rather than taking the
    wave down. Serial-group exclusivity is the scheduler's job (schedule.py
    plan) — this function refuses a wave that violates it.
    """
    manifest = load_manifest(manifest_path)
    ids = [p["package_id"] for p in packages]
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate package ids in wave")
    held: dict[str, str] = {}
    for pid in ids:
        for group in find_package(manifest, pid).get("serial_groups", []):
            if group in held:
                raise ValueError(f"{pid} and {held[group]} both hold serial group {group}")
            held[group] = pid
    slots = sum(int(p.get("max_rounds", MAX_ROUNDS_DEFAULT)) for p in packages)
    await runtime.register_workflow(
        {
            "name": f"pickle-sensei-program-{wave_id}",
            "description": f"{wave_id}: {len(ids)} packages ({', '.join(ids)}) each implement → independent review ‖ adversary → deterministic judge (base {base_sha[:12]}, manifest {manifest['manifest_sha256'][:12]})",
            "product": "Pickle Sensei (RaunakGengiti2725/Pickle-Sensei) — apps/mobile + supabase/functions/api",
            "soft_time_limit_minutes": 60,
            "phases": wave_phases(slots),
        }
    )

    async def one(p: dict) -> dict:
        try:
            return await run_package(
                package_id=p["package_id"],
                base_sha=base_sha,
                integration_branch=integration_branch,
                manifest_path=manifest_path,
                out_root=out_root,
                runtime=runtime,
                max_rounds=int(p.get("max_rounds", MAX_ROUNDS_DEFAULT)),
                mode=mode,
                wave_id=wave_id,
                start_round=int(p.get("start_round", 1)),
                prior=p.get("prior"),
                register=False,
            )
        except Exception as exc:  # noqa: BLE001 — one package must not sink the wave
            runtime.log(f"{p['package_id']} FAILED: {type(exc).__name__}: {exc}")
            return {"package_id": p["package_id"], "status": "FAILED", "error": f"{type(exc).__name__}: {exc}", "candidate": None, "agent_counts": {}}

    records = list(await asyncio.gather(*(one(p) for p in packages)))
    summary = {
        "wave_id": wave_id,
        "base_sha": base_sha,
        "packages": {r["package_id"]: {k: r.get(k) for k in ("status", "candidate", "agent_counts")} for r in records},
    }
    _save(os.path.join(out_root, "_waves"), f"{wave_id}.json", summary)
    return summary


async def run_package(
    *,
    package_id: str,
    base_sha: str,
    integration_branch: str,
    manifest_path: str,
    out_root: str,
    runtime: Runtime,
    max_rounds: int = MAX_ROUNDS_DEFAULT,
    mode: str | None = None,
    wave_id: str = "",
    start_round: int = 1,
    prior: dict | None = None,
    register: bool = True,
) -> dict:
    if not SHA_RE.match(base_sha):
        raise ValueError(f"base_sha must be a full 40-hex sha, got {base_sha!r}")
    if start_round < 1:
        raise ValueError("start_round must be >= 1")
    manifest = load_manifest(manifest_path)
    pkg = find_package(manifest, package_id)
    sg_paths = manifest.get("serial_group_paths", {})
    if pkg["plane"] in ("external", "docs"):
        raise ValueError(f"{package_id} is {pkg['plane']}-plane and is not launched through this workflow")
    out_dir = os.path.join(out_root, package_id, wave_id) if wave_id else os.path.join(out_root, package_id)
    ledger: list[dict] = []
    record: dict[str, Any] = {
        "lib_version": LIB_VERSION,
        "manifest_version": manifest["manifest_version"],
        "manifest_sha256": manifest["manifest_sha256"],
        "package_id": package_id,
        "wave_id": wave_id,
        "base_sha": base_sha,
        "integration_branch": integration_branch,
        "start_round": start_round,
        "requeued_from": prior,
        "rounds": [],
        "agents": ledger,
        "status": "RUNNING",
    }
    _save(out_dir, "record.json", record)

    minutes = max(1, min(60, int(pkg.get("estimate_minutes", 60))))
    if register:
        await runtime.register_workflow(
            {
                "name": f"pickle-sensei-program-{package_id.lower()}",
                "description": f"{package_id}: {pkg['title']} — implement → independent review → adversary → deterministic judge (base {base_sha[:12]}, manifest {manifest['manifest_sha256'][:12]})",
                "product": "Pickle Sensei (RaunakGengiti2725/Pickle-Sensei) — apps/mobile + supabase/functions/api",
                "soft_time_limit_minutes": minutes,
                "phases": wave_phases(max_rounds),
            }
        )

    final_status = "REQUEUE"
    for round_no in range(start_round, start_round + max_rounds):
        runtime.log(f"{package_id} round {round_no}/{start_round + max_rounds - 1} on base {base_sha[:12]}")
        rnd: dict[str, Any] = {"round": round_no}
        record["rounds"].append(rnd)
        impl = await _call(runtime, ledger, "implementer", implement_prompt(pkg, base_sha, integration_branch, round_no, prior, sg_paths), IMPLEMENT_SCHEMA, f"implement-{package_id}-r{round_no}", "implement", minutes, mode)
        rnd["implement"] = impl
        _save(out_dir, "record.json", record)
        if impl is None:
            rnd["decision"] = {"accepted": False, "reasons": ["implementer session failed"], "criteria_examined": []}
            final_status = "REQUEUE"
            continue
        if impl.get("blocked"):
            runtime.log(f"{package_id}: implementer blocked — {impl.get('blocked_reason')}")
            rnd["decision"] = {"accepted": False, "reasons": [f"blocked: {impl.get('blocked_reason')}"], "criteria_examined": []}
            final_status = "BLOCKED_EXTERNAL"
            break
        pre = grade_acceptance(pkg, impl.get("acceptance_results"))
        if not SHA_RE.match(str(impl.get("head_sha", "")).lower()) or pre:
            # Do not spend reviewer/adversary on a candidate that already fails its own evidence.
            rnd["decision"] = {"accepted": False, "reasons": [f"impl: {r}" for r in pre] or ["impl: head_sha invalid"], "criteria_examined": ["implementer acceptance coverage"]}
            runtime.log(f"{package_id} round {round_no}: implementer evidence insufficient ({len(rnd['decision']['reasons'])} reasons)")
            prior = {"branch": impl.get("branch", ""), "head_sha": impl.get("head_sha", ""), "findings": {"judge": rnd["decision"]["reasons"]}}
            _save(out_dir, "record.json", record)
            continue
        # Reviewer and adversary examine the same frozen candidate sha independently, so they run concurrently.
        rev, adv = await asyncio.gather(
            _call(runtime, ledger, "reviewer", review_prompt(pkg, base_sha, integration_branch, impl, sg_paths), REVIEW_SCHEMA, f"review-{package_id}-r{round_no}", "review", minutes, mode),
            _call(runtime, ledger, "adversary", adversary_prompt(pkg, base_sha, integration_branch, impl), ADVERSARY_SCHEMA, f"adversary-{package_id}-r{round_no}", "adversary", minutes, mode),
        )
        rnd["review"] = rev
        rnd["adversary"] = adv
        _save(out_dir, "record.json", record)
        if rev is None or adv is None:
            rnd["decision"] = {"accepted": False, "reasons": ["reviewer or adversary session failed"], "criteria_examined": []}
            final_status = "REQUEUE"
            continue
        decision = judge(pkg, impl, rev, adv)
        rnd["decision"] = decision.as_dict()
        _save(out_dir, "record.json", record)
        if decision.accepted:
            runtime.log(f"{package_id} ACCEPTED at {impl['head_sha'][:12]} ({impl['branch']})")
            record["candidate"] = {"branch": impl["branch"], "head_sha": impl["head_sha"], "round": round_no}
            final_status = "ACCEPTED"
            break
        runtime.log(f"{package_id} round {round_no} REJECTED: " + "; ".join(decision.reasons[:6]))
        prior = {
            "branch": impl.get("branch", ""),
            "head_sha": impl.get("head_sha", ""),
            "findings": {
                "judge": decision.reasons,
                "review_blocking": rev.get("blocking_issues", []),
                "review_invariants": rev.get("invariant_violations", []),
                "adversary_breaks": blocking_breaks(adv),
                "adversary_branch": adv.get("attack_branch", ""),
            },
        }
        final_status = "REQUEUE"
    record["status"] = final_status
    record["agent_counts"] = {
        "requested": len(ledger),
        "launched": len(ledger),
        "completed": sum(1 for e in ledger if e["status"] == "completed"),
        "failed": sum(1 for e in ledger if e["status"] == "failed"),
    }
    _save(out_dir, "record.json", record)
    runtime.log(f"{package_id} FINAL {final_status} agents={record['agent_counts']}")
    return record
