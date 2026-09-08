# INT-ui-flows-a11y — adversarial evidence

Attacked SHA: `30a4065036a917514fb4984fde73f87867f38619`
(`devin/1788854799-production-program-integration`). Every log in this
directory was produced on Linux with `cd apps/mobile && npx jest --ci <file>`
against that exact checkout; the first two lines of each log carry the command
and the SHA, the last line the exit code. Failing tests reproduce breaks and
are intentionally left failing (no production code or existing tests were
modified).

| Test file                                  | Result               | Verdict                                                                               |
| ------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------- |
| `notificationEarlyPress.test.tsx`          | 2 failed / 2 passed  | BREAK: pre-ready notification presses (warm + cold start) are dropped                 |
| `formReviewSeekCorruptEvidence.test.tsx`   | 2 failed / 3 passed  | BREAK: corrupt clip duration → `now > max`, VoiceOver increment moves backwards       |
| `manageAccountDeletionCopy.test.tsx`       | 2 failed / 2 passed  | BREAK: "Google Play" in deletion notice; same-tick double confirm → 2 API calls       |
| `userFacingCopyScan.test.ts`               | 1 failed / 0 passed  | BREAK: 3 prohibited `Google Play` strings in `ManageAccountScreen.tsx`                |
| `analyzePermissionDeniedRecovery.test.tsx` | 1 failed / 2 passed  | BREAK: permission denial offers no Settings route (fail-closed + retry-once pass)     |
| `resultDetailsRouting.test.tsx`            | 2 failed / 3 passed  | BREAK: double Go back pops twice; route without params throws (stale/slow pass)       |
| `screenHeaderDynamicType.test.tsx`         | 12 failed / 3 passed | BREAK: every non-wrap header title is `numberOfLines={1}` at AX5 (INFERRED clip)      |
| `consentAccountSwitchDoubleAction.test.ts` | 5 passed             | PASS: double tap, network loss, owner switch mid-request, offline hydrate, signed out |

Lint/format/typecheck of the new tests (same checkout):

- `cd apps/mobile && npx prettier --check __tests__/adv/` → exit 0
- `pnpm exec eslint apps/mobile/__tests__/adv` (repo root) → exit 0
- `cd apps/mobile && npm ci && npx tsc --noEmit` → exit 0

Not verifiable on Linux (NOT_YET_VERIFIABLE): real VoiceOver spoken values,
real Dynamic Type layout clipping, iOS Settings deep link, and simulator
notification taps require `scripts/mac-full-verify.sh` on the M4 runner
(`xcodebuild test -workspace apps/mobile/ios/PickleSensei.xcworkspace -scheme
PickleSensei -destination 'platform=iOS Simulator,name=iPhone 16'`), which the
coordinator owns.
