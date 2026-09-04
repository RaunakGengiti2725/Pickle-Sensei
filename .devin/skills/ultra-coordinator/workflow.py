"""Pickle Sensei — Ultra coordinator workflow (run via the `run_workflow` tool).

Fan-out / evaluate / fan-in over independent workstreams:

    baseline ─┬─ implement(ws, variant) ─┬─ review ──┐
              │                          └─ adversary ┴─ judge (deterministic) ─┐
              └─ ...                                                             ├─ integrate
                                                                                 ┘
Every agent is a separate-VM child session with its own clone of
RaunakGengiti2725/Pickle-Sensei; code moves between stages ONLY via git
branches named in structured output. Nothing here trusts prose: the judge
selects a candidate only when the implementer's own evidence, an independent
reviewer, and an adversarial tester all agree, and ties are broken by
benchmark deltas from `bench:compare`, never by description.

Inputs (read at start, recorded in the run):
  $PS_WORKSTREAMS  path to a workstreams JSON (see workstreams.schema.json);
                   defaults to .devin/skills/ultra-coordinator/workstreams.json
                   under $PS_REPO_ROOT (or the cwd's git toplevel), then to
                   workstreams.example.json.

The runtime shim provides register_workflow/agent/pipeline/parallel/log and
WorkflowAgentError; do not import or define them.
"""

import asyncio
import json
import os
import subprocess

REPO = "RaunakGengiti2725/Pickle-Sensei"
REPO_TOKEN = f"@{REPO}"
SKILL_DIR = ".devin/skills/ultra-coordinator"

# ---------------------------------------------------------------------------
# Deterministic input inventory
# ---------------------------------------------------------------------------


def repo_root() -> str:
    env = os.environ.get("PS_REPO_ROOT")
    if env:
        return env
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=True,
        )
        return out.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return os.getcwd()


def load_workstreams() -> dict:
    root = repo_root()
    candidates = [
        os.environ.get("PS_WORKSTREAMS"),
        os.path.join(root, SKILL_DIR, "workstreams.json"),
        os.path.join(root, SKILL_DIR, "workstreams.example.json"),
    ]
    for path in candidates:
        if path and os.path.isfile(path):
            with open(path, encoding="utf8") as fh:
                spec = json.load(fh)
            spec["_source"] = os.path.relpath(path, root)
            return spec
    raise FileNotFoundError("no workstreams JSON found (set PS_WORKSTREAMS)")


def glob_prefix(pattern: str) -> str:
    for i, ch in enumerate(pattern):
        if ch in "*?[":
            return pattern[:i]
    return pattern


def validate(spec: dict) -> list[dict]:
    if not isinstance(spec.get("objective"), str) or len(spec["objective"]) < 10:
        raise ValueError("objective must be a string of >= 10 chars")
    streams = spec.get("workstreams")
    if not isinstance(streams, list) or not streams:
        raise ValueError("workstreams must be a non-empty list")
    ids: set[str] = set()
    prefixes: list[tuple[str, str]] = []
    for ws in streams:
        for key in ("id", "title", "plane", "scope_paths", "acceptance"):
            if key not in ws:
                raise ValueError(f"workstream missing '{key}': {ws}")
        if ws["id"] in ids:
            raise ValueError(f"duplicate workstream id {ws['id']}")
        ids.add(ws["id"])
        if ws["plane"] not in ("cloud", "mac", "bench"):
            raise ValueError(f"{ws['id']}: plane must be cloud|mac|bench")
        competing = int(ws.get("competing", 1))
        if not 1 <= competing <= 3:
            raise ValueError(f"{ws['id']}: competing must be 1..3")
        ws["competing"] = competing
        if not ws["scope_paths"] or not ws["acceptance"]:
            raise ValueError(f"{ws['id']}: scope_paths and acceptance must be non-empty")
        for pat in ws["scope_paths"]:
            p = glob_prefix(pat)
            for other_id, other_p in prefixes:
                if other_id != ws["id"] and (p.startswith(other_p) or other_p.startswith(p)):
                    raise ValueError(
                        f"scope overlap: {ws['id']} '{pat}' vs {other_id} '{other_p}' — "
                        "workstreams must own disjoint paths"
                    )
            prefixes.append((ws["id"], p))
    return sorted(streams, key=lambda w: w["id"])


# ---------------------------------------------------------------------------
# Shared prompt fragments
# ---------------------------------------------------------------------------

COMMON_RULES = f"""Repository: {REPO_TOKEN} (public GitHub monorepo; the shipping product is the iOS app).
Read `AGENTS.md`, `REVIEW.md`, `docs/devin/OPERATING_SYSTEM.md` and the repo skills under `.agents/skills/` BEFORE editing. Work ONLY inside the scope paths given below; other agents own everything else concurrently.
Execution planes (never claim results from a plane you did not run):
- cloud: `scripts/verify-cloud.sh --tier pr --start-services` (full: `--tier full`). Machine-readable result: `artifacts/verify-cloud/<run>/summary.json`.
- mac: `scripts/mac-full-verify.sh --remote` — pushes a `ci/mac-*` branch and runs the REAL Apple verification on the user's self-hosted M4 runner (labels self-hosted, macOS, ARM64); wait for it and download artifacts (`run.json`, `.xcresult`, vision summary). You have no Mac locally.
- bench: `pnpm --filter @pickle/evaluation bench:regression --out-dir /tmp/cand --run-id cand` then `pnpm -s --filter @pickle/evaluation bench:compare datasets/reports/regression/baseline.json /tmp/cand/cand.json --json > /tmp/cand/compare.json` on a CLEAN commit (gitDirty must be false; do NOT put `--` between the script name and its flags — pnpm forwards it literally and the CLI rejects it; `-s` keeps pnpm's banner out of the JSON). Never edit `regression.tolerances.json`, `datasets/`, or the baseline.
Hard rules: never weaken/skip/delete tests, never add `|| true`, never fabricate labels or metrics, never touch production Supabase (project ucqnaiwqwjtgvlduiuib) or App Store Connect, never store secrets, never re-register or modify the Mac runner, never access anything on the Mac outside the workflow, never push to `main`. User-facing copy must follow `APP_STORE_SUBMISSION.md` (no Android/Google Play/guest mode/Live Court/DUPR/competitor mentions, no accuracy or superlative claims).
Evidence standard: every claim carries the exact command, exit code, and artifact path. Label statements VERIFIED (you ran it) / INFERRED (read code) / UNKNOWN."""

BASELINE_SCHEMA = {
    "type": "object",
    "properties": {
        "base_sha": {"type": "string"},
        "cloud_summary_path": {"type": "string"},
        "cloud_failed_stages": {"type": "array", "items": {"type": "string"}},
        "bench_metric_count": {"type": "integer"},
        "bench_summary_attachment_url": {"type": "string"},
        "notes": {"type": "string"},
    },
    "required": ["base_sha", "cloud_failed_stages", "bench_metric_count"],
}

IMPLEMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "branch": {"type": "string"},
        "head_sha": {"type": "string"},
        "approach": {"type": "string"},
        "acceptance_results": {
            "type": "array",
            "items": {"type": "string"},
            "description": "one entry per acceptance criterion: 'PASS|FAIL|UNKNOWN — <criterion> — <command + exit code>'",
        },
        "cloud_pr_tier_exit": {"type": "integer"},
        "mac_run_url": {"type": "string"},
        "bench_improvements": {"type": "integer"},
        "bench_regressions": {"type": "integer"},
        "summary": {"type": "string"},
    },
    "required": ["branch", "head_sha", "acceptance_results", "cloud_pr_tier_exit", "summary"],
}

REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["approve", "request_changes", "reject"]},
        "blocking_issues": {"type": "array", "items": {"type": "string"}},
        "acceptance_verified": {"type": "array", "items": {"type": "string"}},
        "reverify_exit": {"type": "integer"},
        "summary": {"type": "string"},
    },
    "required": ["verdict", "blocking_issues", "acceptance_verified", "reverify_exit", "summary"],
}

ADVERSARY_SCHEMA = {
    "type": "object",
    "properties": {
        "break_found": {"type": "boolean"},
        "breaks": {
            "type": "array",
            "items": {"type": "string"},
            "description": "each: '<what broke> — <exact reproduction command> — <observed vs expected>'",
        },
        "attack_branch": {"type": "string"},
        "attacks_tried": {"type": "integer"},
        "summary": {"type": "string"},
    },
    "required": ["break_found", "breaks", "attacks_tried", "summary"],
}

INTEGRATE_SCHEMA = {
    "type": "object",
    "properties": {
        "integration_branch": {"type": "string"},
        "pr_url": {"type": "string"},
        "cloud_full_exit": {"type": "integer"},
        "mac_run_url": {"type": "string"},
        "mac_exit": {"type": "integer"},
        "bench_improvements": {"type": "integer"},
        "bench_regressions": {"type": "integer"},
        "merged_branches": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
    "required": ["integration_branch", "cloud_full_exit", "bench_regressions", "merged_branches", "summary"],
}


def plane_instructions(plane: str) -> str:
    if plane == "mac":
        return (
            "PLANE = mac. Apple truth comes ONLY from `scripts/mac-full-verify.sh --remote`; run it and report the run URL. "
            "Also run `scripts/verify-cloud.sh --tier pr --start-services` (mobile TS/Jest run on Linux)."
        )
    if plane == "bench":
        return (
            "PLANE = bench. Intelligence is judged by `bench:compare` against the committed baseline on a clean commit: "
            "report improvements/regressions counts exactly as the compare CLI prints them. Bump the estimator/model version "
            "per `docs/EVALUATION.md` whenever behaviour changes. Also run `scripts/verify-cloud.sh --tier pr --start-services`."
        )
    return "PLANE = cloud. `scripts/verify-cloud.sh --tier pr --start-services` must exit 0; run `--tier full` if you touched db/edge/rls."


# ---------------------------------------------------------------------------
# Stages
# ---------------------------------------------------------------------------


async def baseline(spec: dict) -> dict:
    base = spec.get("base_branch", "main")
    prompt = f"""{COMMON_RULES}

TASK — establish the BASELINE for objective: {spec['objective']}
1. `git checkout origin/{base}` (record the SHA — that is `base_sha`).
2. `scripts/verify-cloud.sh --tier full --start-services`; report the summary.json path and the list of stages whose status is `fail` (empty if green; `skipped`/`unavailable` are NOT failures — list them in notes).
3. `pnpm --filter @pickle/evaluation bench:regression --out-dir /tmp/baseline --run-id baseline` and `pnpm -s --filter @pickle/evaluation bench:compare datasets/reports/regression/baseline.json /tmp/baseline/baseline.json --json > /tmp/baseline/compare.json`; report the metric count and confirm the committed baseline still matches `main` (0 improvements, 0 regressions). If it does not, say so in notes — do NOT regenerate the baseline.
4. Upload `/tmp/baseline/baseline.json` as an attachment and return its URL in `bench_summary_attachment_url`.
Do not change any file."""
    return await agent(prompt, phase="baseline", schema=BASELINE_SCHEMA, label="baseline", soft_time_limit_minutes=45)


async def implement(spec: dict, ws: dict, variant: int, base: dict) -> dict | None:
    n = ws["competing"]
    variant_note = (
        f"You are implementer {variant + 1} of {n} working INDEPENDENTLY on the same problem; the winner is chosen on identical benchmarks. "
        f"Choose a genuinely different approach from the obvious one if variant > 1 (variant={variant + 1}); state it in `approach`."
        if n > 1
        else ""
    )
    prompt = f"""{COMMON_RULES}

ROLE: IMPLEMENTER. Objective: {spec['objective']}
Workstream `{ws['id']}` — {ws['title']}
{plane_instructions(ws['plane'])}
Scope (the ONLY paths you may edit): {json.dumps(ws['scope_paths'], sort_keys=True)}
Acceptance criteria (all must be executable-verified): {json.dumps(ws['acceptance'], sort_keys=True)}
Baseline: {json.dumps({k: base.get(k) for k in ('base_sha', 'cloud_failed_stages', 'bench_metric_count')}, sort_keys=True)}
{variant_note}
Procedure: branch `devin/ws-{ws['id']}-v{variant + 1}` from `{base['base_sha']}`; follow `docs/devin/playbooks/feature.md` (discover → implement → verify → evidence). Add regression tests for every behaviour change. Commit, push the branch (NO pull request — the integrator opens one), and report `branch`, `head_sha`, one `acceptance_results` entry per criterion in the given order, the exit code of `scripts/verify-cloud.sh --tier pr`, bench counts (bench plane) or Mac run URL (mac plane). If you cannot satisfy a criterion, report FAIL honestly — do not lower the bar."""
    try:
        return await agent(
            prompt,
            phase="implement",
            schema=IMPLEMENT_SCHEMA,
            label=f"implement-{ws['id']}-v{variant + 1}",
            soft_time_limit_minutes=60,
        )
    except WorkflowAgentError as err:
        log(f"implement {ws['id']} v{variant + 1} FAILED: {err}")
        return None


async def review(spec: dict, ws: dict, cand: dict) -> dict:
    prompt = f"""{COMMON_RULES}

ROLE: INDEPENDENT REVIEWER. Do NOT trust the implementer's description; verify everything yourself.
Workstream `{ws['id']}` — {ws['title']} ({plane_instructions(ws['plane'])})
Candidate branch: `{cand['branch']}` at `{cand['head_sha']}`. Implementer claims: {json.dumps(cand['acceptance_results'], sort_keys=True)}
Acceptance criteria: {json.dumps(ws['acceptance'], sort_keys=True)}
1. `git diff {spec.get('base_branch', 'main')}...{cand['branch']}` — confirm every changed path is inside {json.dumps(ws['scope_paths'], sort_keys=True)}; any file outside scope is a blocking issue.
2. Apply `REVIEW.md` and `AGENTS.md` rules (auth/RLS/grants, error bodies, model versioning, migrations, Apple lifecycle, privacy, copy rules).
3. Re-run verification yourself on the candidate commit: `scripts/verify-cloud.sh --tier pr --start-services` (report exit code as `reverify_exit`); bench plane: re-run `bench:compare`; mac plane: inspect the implementer's Mac run artifacts (do not start a second Mac run unless none exists).
4. For each acceptance criterion write 'VERIFIED|NOT VERIFIED — <criterion> — <how>'.
Verdict `approve` only if every criterion is VERIFIED, reverify_exit is 0, and there are no blocking issues. Do not edit the branch."""
    return await agent(prompt, phase="review", schema=REVIEW_SCHEMA, label=f"review-{cand['branch']}", soft_time_limit_minutes=45)


async def adversary(spec: dict, ws: dict, cand: dict) -> dict:
    prompt = f"""{COMMON_RULES}

ROLE: ADVERSARIAL TESTER. Your job is to BREAK candidate branch `{cand['branch']}` (at `{cand['head_sha']}`) for workstream `{ws['id']}` — {ws['title']}.
{plane_instructions(ws['plane'])}
Attack surface: edge cases (empty/corrupt/unsupported media, no player, multiple players, low light, partial visibility), concurrency and cancellation, auth expiry/refresh, RLS/grant boundaries, oversized inputs and rate limits, background/foreground transitions, model-version mismatches, and anything `REVIEW.md` marks dangerous. Write NEW failing tests that expose real bugs (put them on branch `devin/attack-{ws['id']}-{cand['head_sha'][:8]}` and push it; report as `attack_branch`), run the existing suites in unusual orders, and compare behaviour with `{spec.get('base_branch', 'main')}` to separate pre-existing bugs from regressions — only regressions or bugs in the changed code count as breaks.
Report `break_found` = true only with an exact reproduction command and observed-vs-expected. Report how many distinct attacks you tried. Never modify the candidate branch itself."""
    return await agent(prompt, phase="adversary", schema=ADVERSARY_SCHEMA, label=f"adversary-{cand['branch']}", soft_time_limit_minutes=45)


def judge(ws: dict, evaluated: list[tuple[dict, dict, dict]]) -> dict | None:
    """Deterministic winner selection: evidence-gated, benchmark-ranked."""
    eligible = []
    for cand, rev, adv in evaluated:
        all_pass = all(r.strip().upper().startswith("PASS") for r in cand["acceptance_results"])
        ok = (
            cand["cloud_pr_tier_exit"] == 0
            and all_pass
            and rev["verdict"] == "approve"
            and rev["reverify_exit"] == 0
            and not adv["break_found"]
            and (ws["plane"] != "bench" or cand.get("bench_regressions", 1) == 0)
        )
        log(
            f"judge {ws['id']}: {cand['branch']} implementer_pass={all_pass} review={rev['verdict']} "
            f"adversary_break={adv['break_found']} bench(+{cand.get('bench_improvements', 0)}/-{cand.get('bench_regressions', 0)}) -> {'ELIGIBLE' if ok else 'rejected'}"
        )
        if ok:
            eligible.append((cand, rev, adv))
    if not eligible:
        return None
    eligible.sort(
        key=lambda t: (
            -int(t[0].get("bench_improvements", 0)),
            len(t[1]["blocking_issues"]),
            -int(t[2]["attacks_tried"]),
            t[0]["branch"],
        )
    )
    return eligible[0][0]


async def run_workstream(spec: dict, ws: dict, base: dict) -> dict | None:
    log(f"workstream {ws['id']}: {ws['competing']} implementer(s), plane={ws['plane']}")
    cands = await asyncio.gather(*[implement(spec, ws, v, base) for v in range(ws["competing"])])
    cands = [c for c in cands if c]
    if not cands:
        log(f"workstream {ws['id']}: no candidate produced")
        return None

    async def evaluate(cand: dict) -> tuple[dict, dict, dict]:
        rev, adv = await asyncio.gather(review(spec, ws, cand), adversary(spec, ws, cand))
        return cand, rev, adv

    evaluated = await asyncio.gather(*[evaluate(c) for c in cands])
    winner = judge(ws, list(evaluated))
    log(f"workstream {ws['id']}: winner = {winner['branch'] if winner else 'NONE (nothing proven)'}")
    return winner


async def integrate(spec: dict, base: dict, winners: list[dict], streams: list[dict]) -> dict:
    branches = sorted(w["branch"] for w in winners)
    prompt = f"""{COMMON_RULES}

ROLE: INTEGRATOR. Objective: {spec['objective']}
Proven winner branches (each already passed an independent review and an adversarial pass): {json.dumps(branches, sort_keys=True)}
Base: `{spec.get('base_branch', 'main')}` at `{base['base_sha']}`.
1. Create `devin/integration-{base['base_sha'][:8]}` from the base and merge the winners in the listed order; resolve only clerical conflicts (imports, adjacent lines, lockfiles) — if two winners conflict substantively, DROP the later one, report it in `summary`, and continue.
2. Cross-product verification on the integrated commit: `scripts/verify-cloud.sh --tier full --start-services` (exit → `cloud_full_exit`), `bench:compare` against the committed baseline (counts → bench fields; any regression beyond tolerance means STOP: do not open the PR, report which branch introduced it by bisecting the merges), and — if any winner is from the mac plane or touched native/, apps/mobile/ios/, or Vision/CoreML code — `scripts/mac-full-verify.sh --remote` (run URL and exit code).
3. Only when everything is green open ONE draft PR to `{spec.get('base_branch', 'main')}` (fetch the PR template first) whose body lists each merged branch, its workstream and acceptance evidence, the verification commands with exit codes, and artifact paths; return `pr_url`. Never merge the PR."""
    return await agent(prompt, phase="integrate", schema=INTEGRATE_SCHEMA, label="integrate", soft_time_limit_minutes=60)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


async def main():
    spec = load_workstreams()
    streams = validate(spec)
    impl_labels = [f"implement-{w['id']}-v{v + 1}" for w in streams for v in range(w["competing"])]
    await register_workflow(
        {
            "name": "pickle-sensei-ultra-coordinator",
            "description": f"{spec['objective']} — baseline → competing implementers → independent review + adversarial testing → deterministic judge → integrate ({spec['_source']})",
            "product": "Pickle Sensei (RaunakGengiti2725/Pickle-Sensei)",
            "soft_time_limit_minutes": 45,
            "phases": [
                {"title": "baseline", "detail": "verify-cloud --tier full + bench on the base commit", "count": 1},
                {"title": "implement", "detail": "one branch per implementer; competing variants for hard problems", "labels": impl_labels},
                {"title": "review", "detail": "independent reviewer re-verifies every acceptance criterion", "count": len(impl_labels)},
                {"title": "adversary", "detail": "adversarial tester tries to break each candidate", "count": len(impl_labels)},
                {"title": "integrate", "detail": "merge proven winners, cross-product verification, one draft PR", "count": 1},
            ],
        }
    )
    log(f"workstreams from {spec['_source']}: {[w['id'] for w in streams]}")

    base = await baseline(spec)
    log(f"baseline {base['base_sha']}: failed stages={base['cloud_failed_stages']} bench metrics={base['bench_metric_count']}")
    if base["cloud_failed_stages"]:
        log("base branch is RED — fix main before improving it; aborting workstreams")
        return

    winners = [w for w in await asyncio.gather(*[run_workstream(spec, ws, base) for ws in streams]) if w]
    if not winners:
        log("no workstream produced a proven candidate; nothing to integrate")
        return

    result = await integrate(spec, base, winners, streams)
    log(
        f"integration {result['integration_branch']}: cloud_full_exit={result['cloud_full_exit']} "
        f"bench_regressions={result['bench_regressions']} pr={result.get('pr_url') or 'not opened'}"
    )
    log(result["summary"])


asyncio.run(main())
