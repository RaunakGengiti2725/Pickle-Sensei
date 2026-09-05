# Production-readiness audit — run-1788500670 — final report

**Verdict: NOT PRODUCTION_READY** (machine-readable: `scoreboard-final.json` beside this file; raw per-unit map/audit/adjudicate/stress/closure JSON lives in the gitignored `artifacts/production-readiness/run-1788500670/` on the coordinator box).

Every executable gate passes on the integrated tree `590e90c1` on both planes, but
12 independently confirmed P1 findings are still OPEN or only partially closed,
so the "no unresolved P1" gate fails. Nothing was submitted, released, or
published.

## What is proven (exact SHA 590e90c1, clean tree)

| Gate                                                           | Result                                              | Evidence                                     |
| -------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------- |
| `scripts/verify-cloud.sh --tier full --start-services`         | ok, 15/15 stages                                    | `evidence/verify-full-590e90c1.summary.json` |
| `bench:compare` vs `datasets/reports/regression/baseline.json` | 0 regressed / 104 unchanged / 96 informational      | `evidence/bench_590e90c1_compare.json`       |
| `scripts/mac-full-verify.sh --remote` (M4)                     | ok: environment, swift-native, ios-app              | GH run 33940249594, `evidence/mac-590e90c1/` |
| Native XCTest                                                  | 63/63 macOS, 63/63 iOS Simulator                    | same run                                     |
| Real Apple Vision extraction                                   | 1286/1461 frames with pose, 29590 ball trajectories | same run                                     |
| Release simulator build                                        | launched, alive 25 s, 0 crash reports               | same run                                     |

(`evidence/` = `/home/ubuntu/evidence` on the coordinator box; per-stage logs
are also under `artifacts/verify-cloud/` and `artifacts/mac-full-verify/`.)

## Fixed and integrated during the audit (140 commits over origin/main)

Auth outage 503 gateway (EACR partial), revoked-session fence at the auth cache
(XC-SEC-1/RS-03), WebView gate, identity ledger for late-linked identities
(DB-01), permit-gated scored `shots` INSERT + CHECK (DB-02), settled-permit
tombstones (ADV7/ADV-11/17), media-worker deletion starvation (SMW-01), bench
runner (EVAL-BENCH-01), SQLite-failure hydrate (XC-ADJ-LP-1), pose-quality gate
on the phone scoring path (XC-ADJ-VIS-1), rightsForLicense (SL-01), sessionKeeper
30 s floor / permit id typing / practice-set unmount (3bd08da5), Welcome/SignIn
scroll + Library error state (XC-UAI-04/05), pinned gitleaks gate. Each went
through implementer → independent reviewer → adversarial retest before
integration; every fix carries a regression test that fails without it.

## Open P1 (blocking)

See `scoreboard-final.json#p1_open`. Highest-value next steps, all with
existing candidate branches from the closure workflow:

1. `devin/close-mobile-auth-session-MAS-1-r2`, `devin/close-mobile-billing-paywall-MBP-1-r2`,
   `devin/close-security-secrets-deps-SSD-1-security-secrets-deps-SSD-2-v1`,
   `devin/close-xc-cv-XC-CV-1-v1`, `devin/close-pkg-swing-lab-ADJ-02-r2` —
   reviewer-approved, no blocking adversary break; rejected only because the
   implementer's own `verify-cloud --tier pr` self-report was missing. Re-run the
   gate on each, then integrate.
2. MSA-P1-1 / MSA-P1-2 / ADJ-VG-01 / A2 — candidates broken by adversaries; need a
   new round.
3. `services-api-legacy-admin-web::ADJ-01..05` — legacy Fastify API only (not
   called by the shipping app); decide whether to fix or formally retire.

## Native round 11 (not integrated)

`devin/fix11-native@e0369e84`: PoseFrame domain filter (`[-1,2]` coords,
`[0,1]` visibility, one most-visible landmark per joint), gap/clock-safe
readiness window, core-joint stillness geometry, bounded history. Linux shadow
suite 91/91; reviewer ACCEPT_WITH_NITS; adversary found only P2/P3 at ≥568 fps
(unreachable for Apple Vision) plus a pre-existing teleport-stroke P3. Apple
verification run 33943338843 was still executing at session end — the branch
stays UNVERIFIED on Apple until it completes.

## Orchestration

Stress workflow `wfr-2af59c55…`: 131 units × lenses → 445 stress agents,
52 adjudicators (`stress/`). Closure workflow `wfr-6e12da73…`: 38 P0/P1
re-executed on f702f0f8 → 16 RESOLVED, 20 OPEN, 2 EXTERNAL; fix loop
(competing implementers + reviewer + adversary, deterministic judge) ran until
the session was ended. A large share of child attempts failed for platform
reasons (VM unavailable, session-creation throttling); those are not product
findings and were never counted as such.
