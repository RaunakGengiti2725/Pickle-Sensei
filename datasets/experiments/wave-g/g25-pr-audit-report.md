# Wave G — g25-pr-audit: PR #1 Integration Risk Audit

Branch audited: `devin/1787988068-wave-c-integration` @ `104ea0f`.
Audit branch: `devin/wave-g/g25-pr-audit`. Verdict: **YELLOW** (see
`g25-pr-audit-summary.json` for machine-readable counts and rationale).

## Scope

Static audit + Linux verification runs across 23 subsystem directories
(packages, services, apps/mobile, native, ml, tools): duplicate
implementations, flag defaults, dead/stale paths, canonical-vs-compat
confusion, single-copy test coverage, schema/version drift, state-machine
divergence, unrerun cascades, fixture leakage, default-ON experiments,
migrations, API/client contract drift, mobile/backend mismatches.

Held-out case contents were never read; only the exclusion machinery that
names them was inspected.

## Residual risks, ranked

1. **Duplicated stroke heuristic** (`packages/swing-lab/src/strokeHeuristic.ts`
   vs `packages/vision-geometry/src/strokeHeuristicLite.ts`). Both at
   `stroke-heuristic-6 (uncalibrated)`; 19-test parity suite compares full
   prediction objects, so behavior matches today. Forward risk: an edit to one
   copy plus a fixture adjustment could drift silently. Dedup follow-up is
   documented. Fixed in this audit: the Lite header still claimed the
   stroke-heuristic-4 absence-of-measurement gates were NOT ported (stale —
   they are ported and parity-tested); the stale claim invited a duplicate
   "port" that would have caused real divergence.
2. **Multiple independent held-out exclusion lists** (`HELD_OUT_BUNDLES`,
   `HELD_OUT_CASES`, `OWNERSHIP_CASES` split table, `paddle-bench.json`
   roles). All four currently agree. Added
   `packages/swing-lab/test/heldOutConsistency.test.ts` (4 tests) pinning all
   copies to the canonical export and scanning swing-lab/vision-geometry
   sources for literals that name only a subset. `ownershipBench`'s explicit
   `--include-held-out` override remains by design (off by default).
3. **Mac-gated verification debt** (external): Swift build/tests
   (`native/vision-core`, `native/camera-engine`, `native/swing-lab`),
   canonical strict-cascade remeasure, and device latency cannot run on
   Linux. `TemporalStrokeDetector` (`temporal-stroke-heuristic-2`) is a
   separate live-capture contract, not a third heuristic copy;
   `native/swing-lab/Sources/main.swift` is overlay rendering only.

## Cleared (no risk found)

- Experimental CLI flags: `merge-tracklets`, `crop-recovery`, `two-pass`,
  `tight-window`, `pass1-roi` all default-OFF; paddle worker default-ON is
  intentional and documented; `tight-window` correctly suppressed (with
  warning) under `--full-scan`/`--two-pass`.
- API/client contracts: mobile client calls match registered Fastify routes;
  zod permit-finalize schema enforces `ratingId` only for scored outcomes,
  matching mobile's non-scored calls. Placeholder-syntax differences are
  Fastify-vs-OpenAPI convention, not drift.
- Migrations `0001`–`0017`: contiguous, sorted-order runner with checksums.
- `ANNOTATION_SCHEMA_VERSION=1` validated on load; 70/70 non-held-out
  annotation records at v1.
- No test/fixture imports in any `services/*` or `apps/*` production `src`.
- Corpus invariants clean (`pnpm --filter @pickle/swing-lab invariants:corpus`).

## Gates on this branch

Root: `pnpm typecheck && pnpm test && pnpm lint && pnpm format:check` — all
pass. Mobile (`apps/mobile`): `npm ci && npx tsc --noEmit && npm test` — all
pass. Swift/Mac/iPhone: not run (unavailable); no numbers claimed.
