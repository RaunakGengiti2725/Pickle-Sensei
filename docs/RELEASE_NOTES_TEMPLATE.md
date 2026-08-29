# RELEASE NOTES TEMPLATE

Copy this template for every build — TestFlight internal included. Fill every
section; write "none" rather than deleting a heading. Language rules are
inherited from the claim gate (`docs/CLAIM_REVIEW.md`): no accuracy,
coach-equivalence, or latency claims; "Pickle Sensei is still being
validated" is the only approved external framing until that gate passes.

---

## Pickle Sensei <MARKETING_VERSION> (build <BUILD_NUMBER>)

- **Git SHA / tag:** `<sha>` (`v<version>-build.<build>` for store builds)
- **Date:**
- **Channel:** internal TestFlight | external TestFlight | App Store
- **Backend image SHAs:** api `<sha>` / media-worker `<sha>` (or "no backend —
  local-only build, apiBaseUrl null")
- **Environment:** development | staging | production
- **Feature-flag state vs RC record:** matches | drift (list — drift blocks release)

### What changed

<!-- User-visible changes only, honest wording. No superlatives, no accuracy
     claims. "Improved X" requires a linked measurement; otherwise write
     "Changed X". -->

-

### Fixes

-

### Known limitations shipped in this build (do not delete entries; carry forward from RELEASE_PLAN_V1 §5)

- Analysis accuracy is still being validated; coaching-quality surfaces are
  disabled by release gates.
- The app abstains on purpose when it cannot analyze a clip honestly.
- <build-specific additions>

### Rollout & rollback

- Rollout plan: <internal only | canary cohort | phased % schedule>
- Rollback lever if a P0 appears: <per infra/release/release-manifest.json
  rollbackHooks entry ids>

### Monitoring

- Dashboards/alerts confirmed live before user traffic: yes | no (blocking)
- New telemetry in this build: <events/lines, consent gating noted>

### Approvals

- Release owner GO recorded: <D-number in docs/DECISIONS.md | not required
  (internal build)>
- Irreversible actions in this release, each with explicit human
  authorization: <list | none>
