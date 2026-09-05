"""Pickle Sensei — P0/P1 closure workflow (run via `run_workflow`).

    triage(finding) ×N on the CURRENT integration head ─► OPEN? ─► cluster ─► implement ×2 ─► review ∥ adversary ─► judge ─► (round 2)

Input: every confirmed P0/P1 finding of the audit + stress workflows
(`PS_CLOSURE_IN`, JSON list). A triage agent re-executes each finding's repro
and acceptance criteria on `PS_CLOSURE_BASE_SHA` — a finding is RESOLVED only
with a passing acceptance run AND a local production-only revert that makes the
regression test fail again; anything else is OPEN (or EXTERNAL) and enters the
fix loop. Findings whose fix is being produced by a named manual round
(`PS_CLOSURE_SKIP_IDS`) are triaged but not fixed here.

The runtime shim provides register_workflow/agent/pipeline/parallel/log and
WorkflowAgentError; do not import or define them.
"""

import asyncio
import json
import os
import re

REPO = "RaunakGengiti2725/Pickle-Sensei"
REPO_TOKEN = f"@{REPO}"
BASE_BRANCH = os.environ.get("PS_CLOSURE_BRANCH", "devin/1788500670-production-readiness")
# Run parameters (the workflow runtime passes no environment; edit here per run).
BASE_SHA = os.environ.get("PS_CLOSURE_BASE_SHA", "f702f0f8cc8d3d5b50323eb3f92f71897e4b0e15")
OUT_DIR = os.environ.get(
    "PS_CLOSURE_OUT",
    os.path.expanduser("~/repos/Pickle-Sensei/artifacts/production-readiness/run-1788500670/closure"),
)
IN_FILE = os.environ.get("PS_CLOSURE_IN", os.path.join(OUT_DIR, "input-p01.json"))
# Findings whose fix is produced by a named manual round: triaged here, not fixed here.
SKIP_IDS = {
    s
    for s in os.environ.get(
        "PS_CLOSURE_SKIP_IDS",
        "mobile-data-sync::MDS-2,permit-lifecycle::ADV7-PERMIT-REUSE-DELETE-REINSERT",
    ).split(",")
    if s
}
MAX_CONCURRENT = int(os.environ.get("PS_AUDIT_CONCURRENCY", "25"))
THROTTLE_MAX_ATTEMPTS = int(os.environ.get("PS_AUDIT_THROTTLE_ATTEMPTS", "240"))

COMMON_RULES = f"""Repository: {REPO_TOKEN} (public GitHub monorepo; shipping product = iOS app `apps/mobile`, backend = Supabase Edge Function `supabase/functions/api`).
START STATE: `git fetch origin && git checkout {BASE_SHA}` (branch `{BASE_BRANCH}`; this is the INTEGRATED head — many earlier fixes are already on it). All work is relative to this commit; never push to `main`; never open a pull request (the coordinator integrates).
Read `AGENTS.md`, `REVIEW.md`, `docs/devin/OPERATING_SYSTEM.md`, `APP_STORE_SUBMISSION.md` and the skills in `.agents/skills/` first.
Environment: Node 22.13+ (apps/mobile needs node:sqlite) + pnpm 10 are present. If `deno` is missing: `curl -fsSL https://deno.land/install.sh | sh` (adds ~/.deno/bin). `scripts/security-scan.sh` self-downloads a pinned gitleaks. Docker services: `docker compose up -d postgres postgres_test redis elasticmq` or pass `--start-services` to verify-cloud. apps/mobile uses npm (never pnpm inside it): `cd apps/mobile && npm ci`. Python ML tests: `tools/paddle-lab` needs numpy/torch(cpu)/opencv-python-headless/pytest in a venv.
Execution planes (never claim results from a plane you did not run):
- cloud (Linux): `scripts/verify-cloud.sh --tier pr|full --start-services` → `artifacts/verify-cloud/<run>/summary.json`; mobile `cd apps/mobile && npx tsc --noEmit && npx jest --ci --silent`; edge `(cd supabase/functions/api/__wf__ && deno task test)` (set `XC_PG_URL` to a disposable Postgres so live DB tests are not ignored); RLS `./supabase/tests/run_rls_tests.sh`; ML `python3 -m unittest discover -s ml/scripts -p 'test_*.py'`.
- bench: `pnpm --filter @pickle/evaluation bench:regression --out-dir /tmp/cand --run-id cand` then `pnpm -s --filter @pickle/evaluation bench:compare datasets/reports/regression/baseline.json /tmp/cand/cand.json --json > /tmp/cand/compare.json` on a CLEAN commit. Never edit `regression.tolerances.json`, `datasets/`, or the baseline. Linux CV numbers are a replay proxy, not Apple device truth.
- mac (Apple truth): the self-hosted M4 runner is ONE physical machine. You MUST NOT run `scripts/mac-full-verify.sh --remote`, push any `ci/mac-*` branch, or touch `.github/workflows/mac-*.yml`. Apple evidence for the pre-integration head 1fb0efd7 is GitHub Actions run 33909637479 (`gh run download 33909637479`). Never claim Swift/Vision/iOS runtime behaviour from Linux.
Hard rules: never weaken/skip/delete tests, never add `|| true`, never fabricate labels/metrics/evidence, never touch production Supabase (project ucqnaiwqwjtgvlduiuib) or App Store Connect, never store or print secrets, never modify the Mac runner, never modify applied migrations (add a new one, later than every existing file), never widen grants/policies, never use pnpm inside apps/mobile, never use destructive git commands. User-facing copy must follow `APP_STORE_SUBMISSION.md` (no Android/Google Play/guest mode/Live Court/DUPR/competitor mentions; no accuracy %, superlatives or AI-coach-equivalence claims).
Evidence standard: every claim carries the exact command, exit code and artifact path. Label statements VERIFIED (you ran it) / INFERRED (read code) / UNKNOWN. Upload key artifacts with the upload_attachment tool and return the URLs in `attachment_urls`. A skipped/unavailable stage is NOT a pass. Missing output is UNVERIFIED, never PASS."""

TRIAGE_SCHEMA = {
    "type": "object",
    "properties": {
        "id": {"type": "string"},
        "status": {"type": "string", "enum": ["RESOLVED", "OPEN", "EXTERNAL", "UNVERIFIED"]},
        "repro_on_base": {"type": "string", "description": "exact command → exit code → observed (the original repro re-run on BASE_SHA)"},
        "acceptance_results": {"type": "array", "items": {"type": "string"}, "description": "one per acceptance criterion: 'PASS|FAIL|UNKNOWN — <criterion> — <command + exit>'"},
        "fix_commits": {"type": "array", "items": {"type": "string"}, "description": "commits on BASE_SHA that fix it (git log -S / blame)"},
        "revert_check": {"type": "string", "description": "production-only local revert kept the tests: which test(s) failed → exit; or why impossible"},
        "regression_test_files": {"type": "array", "items": {"type": "string"}},
        "residual_defect": {"type": "string", "description": "if OPEN: precise remaining failure mode, file:line, repro"},
        "files": {"type": "array", "items": {"type": "string"}, "description": "if OPEN: repo-relative file paths a fix will need"},
        "acceptance": {"type": "array", "items": {"type": "string"}, "description": "if OPEN: executable acceptance criteria for the fix"},
        "attachment_urls": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
    "required": ["id", "status", "repro_on_base", "acceptance_results", "fix_commits", "revert_check", "summary"],
}

IMPLEMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "branch": {"type": "string"},
        "head_sha": {"type": "string"},
        "approach": {"type": "string"},
        "acceptance_results": {"type": "array", "items": {"type": "string"}},
        "failing_test_first_commit": {"type": "string"},
        "cloud_pr_tier_exit": {"type": "integer"},
        "files_changed": {"type": "array", "items": {"type": "string"}},
        "bench_regressions": {"type": "integer"},
        "attachment_urls": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
    "required": ["branch", "head_sha", "acceptance_results", "cloud_pr_tier_exit", "files_changed", "summary"],
}

REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["approve", "request_changes", "reject"]},
        "blocking_issues": {"type": "array", "items": {"type": "string"}},
        "acceptance_verified": {"type": "array", "items": {"type": "string"}},
        "reverify_exit": {"type": "integer"},
        "test_fails_without_fix": {"type": "boolean"},
        "summary": {"type": "string"},
    },
    "required": ["verdict", "blocking_issues", "acceptance_verified", "reverify_exit", "test_fails_without_fix", "summary"],
}

ADVERSARY_SCHEMA = {
    "type": "object",
    "properties": {
        "break_found": {"type": "boolean"},
        "breaks": {"type": "array", "items": {"type": "string"}, "description": "'P0|P1|P2|P3 <what broke> — <exact repro> — <observed vs expected>'"},
        "attack_branch": {"type": "string"},
        "attacks_tried": {"type": "integer"},
        "summary": {"type": "string"},
    },
    "required": ["break_found", "breaks", "attacks_tried", "summary"],
}


def dump(obj) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False)


def save(name: str, obj) -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, name), "w", encoding="utf8") as fh:
        json.dump(obj, fh, indent=2, sort_keys=True, ensure_ascii=False)


_SEM: asyncio.Semaphore | None = None


def sem() -> asyncio.Semaphore:
    global _SEM
    if _SEM is None:
        _SEM = asyncio.Semaphore(MAX_CONCURRENT)
    return _SEM


def _is_throttle(msg: str) -> bool:
    return (
        "429" in msg
        or "concurrent session limit" in msg
        or "could not create session" in msg
        or "Too Many Requests" in msg
    )


async def safe_agent(prompt, **kwargs):
    for attempt in range(THROTTLE_MAX_ATTEMPTS):
        throttled = False
        async with sem():
            try:
                return await agent(prompt, **kwargs)
            except WorkflowAgentError as err:
                msg = str(err)
                if _is_throttle(msg):
                    throttled = True
                else:
                    log(f"agent {kwargs.get('label')} FAILED: {err}")
                    return None
        if throttled:
            log(f"agent {kwargs.get('label')}: session creation throttled (attempt {attempt + 1}/{THROTTLE_MAX_ATTEMPTS}); backing off")
            await asyncio.sleep(min(600, 120 + 30 * attempt))
    log(f"agent {kwargs.get('label')} FAILED: gave up after repeated session-creation throttling")
    return None


def _brief(f: dict) -> dict:
    return {k: f.get(k) for k in ("id", "severity", "area", "title", "files", "repro", "expected", "evidence", "acceptance") if f.get(k) is not None}


def _slug(s: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]+", "-", s)[:60].strip("-")


# ---------------------------------------------------------------------------
# Phase 1 — triage every P0/P1 on the integrated head
# ---------------------------------------------------------------------------


async def triage(f: dict) -> dict | None:
    prompt = f"""{COMMON_RULES}

ROLE: P0/P1 TRIAGE AUDITOR. One finding, one verdict, all evidence executable. Finding (confirmed by an independent adjudicator on the pre-fix base 4d812e1a): {dump(_brief(f))}
On `{BASE_SHA}` (the integrated head) do, in order:
1. Re-run the finding's ORIGINAL repro exactly (adapt only paths/plumbing if files moved; say so). Record command → exit → observed in `repro_on_base`. If the repro was a test on an adjudication/attack branch, fetch that branch and run the test file against this head.
2. Run EVERY acceptance criterion (one `acceptance_results` line each, PASS/FAIL/UNKNOWN with command + exit). If a criterion has no executable form, write the smallest test that pins it and run it.
3. Identify the commit(s) on this head that fix it: `git log --oneline 4d812e1a..{BASE_SHA[:8]} -- <files>`, `git log -S<symbol>`; list them in `fix_commits` (empty if none).
4. Revert check: on a scratch worktree, `git revert --no-commit` (or `git checkout 4d812e1a -- <production files>`) ONLY the production change(s), keep every test, run the regression test(s) → they must FAIL. Record which failed and how in `revert_check`. If no regression test exists on this head, that alone makes the finding OPEN (fix has no regression protection).
5. Verdict: RESOLVED only if the repro no longer fails, every acceptance criterion is PASS, and the revert check made a real test fail. EXTERNAL only if closure needs a human/credential/device (say precisely what). UNVERIFIED if you could not execute (say why). Otherwise OPEN: fill `residual_defect`, `files` (repo-relative paths a fixer must edit, tests included) and `acceptance` (executable criteria, including the ones that still FAIL).
Never modify `{BASE_BRANCH}`; you may push a branch `devin/triage-{_slug(f['id'])}` with any new pinning test. Never trigger a Mac run. Prose is not evidence."""
    return await safe_agent(prompt, phase="triage", schema=TRIAGE_SCHEMA, label=f"triage-{_slug(f['id'])}", soft_time_limit_minutes=50)


# ---------------------------------------------------------------------------
# Phase 2 — cluster OPEN findings, fix with competing implementers
# ---------------------------------------------------------------------------


def norm_file(f: str) -> str:
    return f.strip().split(":")[0].strip().lstrip("./")


def build_clusters(open_items: list[dict]) -> list[dict]:
    items = sorted(open_items, key=lambda c: (c["severity"], c["id"]))
    parent = list(range(len(items)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    owner: dict[str, int] = {}
    for i, it in enumerate(items):
        for f in sorted({norm_file(x) for x in it.get("files", []) if x.strip()}):
            if f in owner:
                union(i, owner[f])
            else:
                owner[f] = i
    groups: dict[int, list[dict]] = {}
    for i, it in enumerate(items):
        groups.setdefault(find(i), []).append(it)
    clusters = []
    for root in sorted(groups):
        members = sorted(groups[root], key=lambda c: (c["severity"], c["id"]))
        parts = [members[i : i + 3] for i in range(0, len(members), 3)]
        for part in parts:
            sev = min(m["severity"] for m in part)
            files = sorted({norm_file(f) for m in part for f in m.get("files", []) if f.strip()})
            clusters.append(
                {
                    "cluster_id": "+".join(m["id"] for m in part),
                    "severity": sev,
                    "files": files,
                    "items": part,
                    "shared_files_with_siblings": len(parts) > 1,
                    "competing": 2,
                }
            )
    return clusters


def cluster_brief(cl: dict) -> str:
    return dump([{k: it.get(k) for k in ("id", "severity", "title", "repro", "expected", "evidence", "acceptance", "files", "residual_defect")} for it in cl["items"]])


async def implement(cl: dict, variant: int) -> dict | None:
    n = cl["competing"]
    slug = _slug(cl["cluster_id"])
    variant_note = f"You are implementer {variant + 1} of {n} working INDEPENDENTLY; the winner is chosen on evidence. Variant {variant + 1}: {'take the most direct root-cause fix' if variant == 0 else 'take a genuinely different approach (different layer or mechanism) from the obvious one and state it in `approach`'}."
    criteria = [a for it in cl["items"] for a in it.get("acceptance", [])]
    prompt = f"""{COMMON_RULES}

ROLE: IMPLEMENTER. Fix cluster `{cl['cluster_id']}` (severity {cl['severity']}). {variant_note}
Defects still OPEN on the integrated head (each re-executed by a triage auditor on {BASE_SHA[:8]}): {cluster_brief(cl)}
Files you may edit (the ONLY paths; other fixers own everything else concurrently{' — sibling fixers may also touch some of these files: keep your diff minimal and localized' if cl.get('shared_files_with_siblings') else ''}): {dump(cl['files'])} — if a correct fix truly needs another file, add it, keep the addition minimal, and list it in `files_changed` with a justification in `summary`.
Acceptance criteria, in order (one `acceptance_results` line per criterion): {dump(criteria)}
Required loop: REPRODUCE → write the regression test and commit it FAILING on the unfixed code (record that sha in `failing_test_first_commit`) → FIX the root cause (no workaround, no broad try/catch, no weakened assertion, no `|| true`) → test PASSES → run the full relevant suite(s) → `scripts/verify-cloud.sh --tier pr --start-services` (exit → `cloud_pr_tier_exit`; run `--tier full` if you touched db/edge/rls; if ONLY the security stage fails and gitleaks points at commits that are not ancestors of your HEAD, say so verbatim in `summary` and also run `scripts/security-scan.sh --history --log-opts {BASE_SHA[:8]}..HEAD` + `--tree` and report both exits) → bench-plane changes also need `bench:compare` with 0 regressions. Migrations: NEW file only, sorting after every existing one, grants sized to the writes. User-facing copy rules apply.
Branch `devin/close-{slug}-v{variant + 1}` from {BASE_SHA[:8]}; commit, push (NO pull request), report `branch`, `head_sha`, `files_changed`. If a criterion cannot be met, report FAIL honestly."""
    return await safe_agent(prompt, phase="fix-implement", schema=IMPLEMENT_SCHEMA, label=f"close-{slug}-v{variant + 1}", soft_time_limit_minutes=60)


async def review(cl: dict, cand: dict) -> dict | None:
    criteria = [a for it in cl["items"] for a in it.get("acceptance", [])]
    prompt = f"""{COMMON_RULES}

ROLE: INDEPENDENT REVIEWER. Do NOT trust the implementer; verify everything yourself.
Cluster `{cl['cluster_id']}` ({cl['severity']}): {cluster_brief(cl)}
Candidate branch `{cand['branch']}` at `{cand['head_sha']}`; implementer claims: {dump(cand.get('acceptance_results', []))}; claimed files: {dump(cand.get('files_changed', []))}.
Allowed files: {dump(cl['files'])}. Acceptance criteria: {dump(criteria)}.
1. `git diff {BASE_SHA[:8]}...{cand['branch']}` — every changed path must be inside the allowed files (or justified in the implementer's summary); unrelated changes, weakened/removed assertions, skipped tests, `|| true`, broad catches, copy-rule violations, migration edits to applied files, grant widening → blocking.
2. Apply `REVIEW.md` + `AGENTS.md` (auth/RLS/grants, error bodies, model versioning, Apple lifecycle, privacy, copy).
3. Re-run yourself on the candidate: the new regression test(s), the relevant suites, and `scripts/verify-cloud.sh --tier pr --start-services` (exit → `reverify_exit`). Then locally revert ONLY the production change (keep the test) and confirm the new test FAILS (`test_fails_without_fix`); restore afterwards. Bench-plane: re-run `bench:compare`.
4. One `acceptance_verified` line per criterion: 'VERIFIED|NOT VERIFIED — <criterion> — <how>'.
`approve` only if every criterion is VERIFIED, reverify_exit is 0 (or the only failing stage is the shared-remote gitleaks history stage, stated verbatim), test_fails_without_fix is true, and there are no blocking issues. Do not edit the branch."""
    return await safe_agent(prompt, phase="fix-review", schema=REVIEW_SCHEMA, label=f"review-{cand['branch'][-40:]}", soft_time_limit_minutes=50)


async def adversary(cl: dict, cand: dict) -> dict | None:
    prompt = f"""{COMMON_RULES}

ROLE: ADVERSARIAL TESTER. Break candidate branch `{cand['branch']}` (at `{cand['head_sha']}`) which claims to fix cluster `{cl['cluster_id']}`: {cluster_brief(cl)}
Attack the FIX and its neighbourhood at DOUBLE the original scale: does the original repro still fail in any variant (different ordering, concurrency with two real sessions/connections, unicode, boundary sizes, cancellation mid-flight, stale/expired sessions, RLS/grant boundaries, background/foreground, clock skew, malformed/NULL payloads, pre-existing bad rows, upgrade path old-app/new-server and new-app/old-server)? Did the fix introduce a regression elsewhere (run the suites of every module that imports the changed files)? Compare behaviour with {BASE_SHA[:8]} — only regressions or bugs in the changed code count as breaks. Write NEW failing tests that expose real bugs on branch `devin/attack-close-{cand['head_sha'][:8]}` and push it (`attack_branch`). Grade every break P0-P3 as the first token of the string. Report `break_found` only with an exact, deterministic repro and observed-vs-expected. Never modify the candidate branch. Never trigger a Mac run."""
    return await safe_agent(prompt, phase="fix-adversary", schema=ADVERSARY_SCHEMA, label=f"adversary-{cand['branch'][-40:]}", soft_time_limit_minutes=50)


_P3_BREAK = re.compile(r"^\W*(p3|severity\W*p3)\b", re.IGNORECASE)


def blocking_breaks(adv: dict) -> list[str]:
    return [b for b in adv.get("breaks", []) if not _P3_BREAK.match(str(b))]


def judge(cl: dict, evaluated: list[tuple[dict, dict | None, dict | None]]) -> dict | None:
    eligible = []
    for cand, rev, adv in evaluated:
        if not rev or not adv:
            log(f"judge {cl['cluster_id']}: {cand['branch']} missing review/adversary output -> rejected")
            continue
        all_pass = bool(cand["acceptance_results"]) and all(r.strip().upper().startswith("PASS") for r in cand["acceptance_results"])
        blocking = blocking_breaks(adv)
        followups = [b for b in adv.get("breaks", []) if b not in blocking]
        verified_clean = cand["cloud_pr_tier_exit"] == 0 or rev["reverify_exit"] == 0
        ok = all_pass and rev["verdict"] == "approve" and rev["test_fails_without_fix"] and not blocking and int(cand.get("bench_regressions", 0) or 0) == 0
        cand["judge"] = {"verified_clean_on_child": verified_clean, "needs_integration_verify": not verified_clean, "adversary_p3_followups": followups}
        log(
            f"judge {cl['cluster_id']}: {cand['branch']} impl_pass={all_pass} verify={cand['cloud_pr_tier_exit']} review={rev['verdict']}/{rev['reverify_exit']} "
            f"test_fails_without_fix={rev['test_fails_without_fix']} adversary_break={adv['break_found']} blocking_breaks={len(blocking)} p3_followups={len(followups)} -> {'ELIGIBLE' if ok else 'rejected'}"
        )
        if ok:
            eligible.append((cand, rev, adv))
    if not eligible:
        return None
    eligible.sort(key=lambda t: (0 if t[0]["judge"]["verified_clean_on_child"] else 1, len(t[1]["blocking_issues"]), -int(t[2]["attacks_tried"]), len(t[0].get("files_changed", [])), t[0]["branch"]))
    return eligible[0][0]


def pick_round2_base(evaluated):
    usable = [(c, r, a) for c, r, a in evaluated if r and a]
    if not usable:
        return None
    usable.sort(key=lambda t: (len(blocking_breaks(t[2])), len(t[1]["blocking_issues"]), 0 if t[1]["verdict"] == "approve" else 1, t[0]["branch"]))
    return usable[0]


async def implement_round2(cl: dict, cand: dict, rev: dict, adv: dict, rnd: int) -> dict | None:
    slug = _slug(cl["cluster_id"])
    criteria = [a for it in cl["items"] for a in it.get("acceptance", [])]
    extra = [f"REVIEW BLOCKER: {b}" for b in rev.get("blocking_issues", [])] + [f"ADVERSARY BREAK: {b}" for b in blocking_breaks(adv)]
    prompt = f"""{COMMON_RULES}

ROLE: IMPLEMENTER (ROUND {rnd}). Cluster `{cl['cluster_id']}` (severity {cl['severity']}): {cluster_brief(cl)}
Previous candidate `{cand['branch']}` at `{cand['head_sha']}` (approach: {cand.get('approach', 'n/a')}) was REJECTED by the independent gate. Its reviewer said: {dump(rev.get('summary', ''))}. Its adversary said: {dump(adv.get('summary', ''))}{(' — attack branch with failing tests: ' + adv['attack_branch']) if adv.get('attack_branch') else ''}.
Start from `{cand['branch']}` (branch `devin/close-{slug}-r{rnd}` from it). Fetch the attack branch and copy its tests in FIRST (record the failing run); they must go from fail to pass unchanged. Keep what was right; fix EVERY item below at the root cause (a proven regression means the previous approach was wrong there — change the approach, do not paper over it; if an adversary test is wrong, prove it with evidence in `summary`, otherwise adopt it as a regression test):
{dump(extra)}
Original acceptance criteria (still required, one `acceptance_results` line per criterion, then one per extra item above): {dump(criteria)}
Allowed files: {dump(cl['files'])} plus files the previous candidate already changed; any other file must be justified in `summary`.
Required loop: REPRODUCE each item → failing test committed first (`failing_test_first_commit`) → fix → passing → full relevant suites → `scripts/verify-cloud.sh --tier pr --start-services` (exit → `cloud_pr_tier_exit`; `--tier full` if you touched db/edge/rls). Bench plane: `bench:compare` with 0 regressions. No PR. Report `branch`, `head_sha`, `files_changed`; report FAIL honestly for anything unmet."""
    return await safe_agent(prompt, phase="fix-implement-r2", schema=IMPLEMENT_SCHEMA, label=f"close-{slug}-r{rnd}", soft_time_limit_minutes=60)


MAX_ROUNDS = int(os.environ.get("PS_CLOSURE_ROUNDS", "3"))


async def fix_cluster(cl: dict) -> dict:
    log(f"fix cluster {cl['cluster_id']} ({cl['severity']}, {cl['competing']} implementer(s), files={len(cl['files'])})")
    cands = [c for c in await asyncio.gather(*[implement(cl, v) for v in range(cl["competing"])]) if c]
    if not cands:
        return {"cluster": cl, "winner": None, "rounds": [], "reason": "no candidate produced"}

    async def evaluate(cand):
        rev, adv = await asyncio.gather(review(cl, cand), adversary(cl, cand))
        return cand, rev, adv

    evaluated = list(await asyncio.gather(*[evaluate(c) for c in cands]))
    winner = judge(cl, evaluated)
    rounds = [[{"candidate": c, "review": r, "adversary": a} for c, r, a in evaluated]]
    rnd = 1
    while not winner and rnd < MAX_ROUNDS:
        base = pick_round2_base(evaluated)
        if not base:
            break
        rnd += 1
        cand, rev, adv = base
        r2 = await implement_round2(cl, cand, rev, adv, rnd)
        if not r2:
            break
        rev2, adv2 = await asyncio.gather(review(cl, r2), adversary(cl, r2))
        evaluated = [(r2, rev2, adv2)]
        winner = judge(cl, evaluated)
        rounds.append([{"candidate": r2, "review": rev2, "adversary": adv2}])
    log(f"fix cluster {cl['cluster_id']}: winner = {winner['branch'] if winner else 'NONE (nothing proven)'} after {len(rounds)} round(s)")
    return {"cluster": cl, "winner": winner, "rounds": rounds, "reason": "" if winner else "no candidate passed implementer+reviewer+adversary gates"}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


async def main():
    with open(IN_FILE, encoding="utf8") as fh:
        findings = json.load(fh)
    findings = sorted(
        [f for f in findings if (f.get("severity") or "").upper().strip()[:2] in ("P0", "P1")],
        key=lambda f: (f["severity"], f["id"]),
    )
    await register_workflow(
        {
            "name": "pickle-sensei-p1-closure",
            "description": f"Re-execute every confirmed P0/P1 ({len(findings)}) on integrated head {BASE_SHA[:8]}; fix what is still OPEN with competing implementers + independent reviewer + adversary, up to {MAX_ROUNDS} rounds.",
            "product": "Pickle Sensei (RaunakGengiti2725/Pickle-Sensei)",
            "soft_time_limit_minutes": 50,
            "phases": [
                {"title": "triage", "detail": "repro + acceptance + revert check per P0/P1 on the integrated head", "labels": [f"triage-{_slug(f['id'])}" for f in findings]},
                {"title": "fix-implement", "detail": "two competing implementers per OPEN cluster (failing test first)"},
                {"title": "fix-review", "detail": "independent reviewer re-verifies + revert check"},
                {"title": "fix-adversary", "detail": "adversarial retest at double scale"},
                {"title": "fix-implement-r2", "detail": "follow-up implementer per rejected cluster, fed reviewer blockers + adversary breaks; fresh reviewer ∥ adversary"},
            ],
        }
    )
    log(f"closure on {BASE_SHA} ({BASE_BRANCH}); {len(findings)} P0/P1 findings; skip-fix ids={sorted(SKIP_IDS)}; out={OUT_DIR}")

    triaged = await asyncio.gather(*[triage(f) for f in findings])
    ledger = []
    open_items = []
    for f, t in zip(findings, triaged):
        entry = {"finding": _brief(f), "triage": t or {"id": f["id"], "status": "UNVERIFIED", "summary": "triage agent produced no output"}}
        ledger.append(entry)
        status = entry["triage"]["status"]
        log(f"triage {f['id']}: {status}")
        if status in ("OPEN", "UNVERIFIED") and f["id"] not in SKIP_IDS:
            item = dict(f)
            if t:
                item["files"] = t.get("files") or f.get("files") or []
                item["acceptance"] = t.get("acceptance") or f.get("acceptance") or []
                item["residual_defect"] = t.get("residual_defect", "")
            open_items.append(item)
    save("triage-ledger.json", ledger)
    counts = {}
    for e in ledger:
        counts[e["triage"]["status"]] = counts.get(e["triage"]["status"], 0) + 1
    log(f"triage summary: {dump(counts)}; {len(open_items)} entering fix loop")

    clusters = build_clusters(open_items)
    save("clusters.json", clusters)
    log(f"{len(clusters)} OPEN clusters → fix loop")
    results = await asyncio.gather(*[fix_cluster(cl) for cl in clusters])
    save("fix-results.json", results)
    winners = [r["winner"] for r in results if r["winner"]]
    save("winners.json", winners)
    unresolved = [r["cluster"]["cluster_id"] for r in results if not r["winner"]]
    log(f"closure done: {len(winners)} winners, {len(unresolved)} unresolved clusters: {dump(unresolved)}")
    return {
        "base_sha": BASE_SHA,
        "triage_counts": counts,
        "winners": [{"cluster": r["cluster"]["cluster_id"], "branch": r["winner"]["branch"], "head_sha": r["winner"]["head_sha"]} for r in results if r["winner"]],
        "unresolved_clusters": unresolved,
        "out_dir": OUT_DIR,
    }


asyncio.run(main())
