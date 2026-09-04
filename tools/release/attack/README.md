# release-config adversarial probes

Sandbox attacks against the two Linux release gates — `pnpm release:check`
(`tools/release/check-release-manifest.mjs`) and `apps/mobile npm run check:distribution`
(`apps/mobile/scripts/check-ios-distribution.mjs`). Nothing here modifies the repo: each
scenario copies the files the checkers read into a temp directory, mutates the copy, and
runs both checkers there.

```bash
node --test tools/release/attack/release-config-attacks.test.mjs   # invariants (one test per attack)
node --test tools/release/attack/release-gates-static.test.mjs     # CI wiring / doc coherence at HEAD
node tools/release/attack/run-attacks.mjs [--out DIR] [--only id,id] # HELD/BROKEN report + per-scenario logs
ATTACK_SEED=7 node tools/release/attack/run-attacks.mjs             # seeded fixture values
```

`expect` in `scenarios.mjs` encodes the invariant the docs promise
(`docs/RELEASE_OPERATIONS.md`, `docs/APP_STORE_SUBMISSION.md`,
`.agents/skills/release-verification`), not today's behaviour — a failing test is a gap in
the gates. Evidence from the run at `4d812e1a` lives in `evidence/`.
