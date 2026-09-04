# native/vision-core adversarial pass 3 (tester #1) — harness notes

Branch `devin/attack-native-vision-core-1`, attacks written against
`4d812e1aa699014cc0521fd92fde66908043aaa8`. New files only; no production code
or existing test was touched.

## Files

- `native/vision-core/Tests/AdversarialMalformedInputTests.swift` — S02–S07
  plus S08–S11 malformed-input probes. **All green** on 4d812e1a (Linux proxy).
- `native/vision-core/Tests/AdversarialDuplicateLandmarkTrapTests.swift` — S01.
  **Traps the test process** on 4d812e1a (`Fatal error: Duplicate values for
key: 'left_wrist'`, `PoseReadinessEvaluator.swift:117`). Because a Swift
  trap kills the whole xctest bundle, this file is kept alone so the other
  suites can still be run; run it with `--filter AdversarialDuplicateLandmarkTrapTests`
  or exclude it with `--exclude-test AdversarialDuplicateLandmarkTrapTests.swift`.
- `native/vision-core/Tests/AdversarialStateIntegrityGapTests.swift` — G1–G6
  red probes for adjacent state-integrity gaps. **Expected red** on 4d812e1a
  (each test's doc comment says what fails and why).
- `run.sh` — Linux Foundation-only replay proxy (see its header for what it
  does and does not prove). Apple truth still comes only from the M4 runner.

## Integration warning

Landing these tests as-is into `native/vision-core/Tests` makes
`scripts/mac-full-verify.sh` red (and the S01 file aborts the whole vision-core
XCTest run) until the underlying code is fixed. That is intentional — they are
attack tests, not regression pins — so integrate them together with the fixes
or keep them on this branch.

## Commands used (Linux proxy, Swift 5.10.1 Ubuntu 22.04)

```bash
export PATH=$HOME/swift/swift-5.10.1-RELEASE-ubuntu22.04/usr/bin:$PATH
# Everything except the S01 trap file → exit 1 (only the G* gap probes fail)
OUT=/tmp/run-safe tools/attack/native-vision-core-linux-proxy/run.sh \
  --exclude-test AdversarialDuplicateLandmarkTrapTests.swift
# S01 alone → process trap, exit 1, backtrace in $OUT/logs/swift-test.log
OUT=/tmp/run-s01 tools/attack/native-vision-core-linux-proxy/run.sh \
  --filter AdversarialDuplicateLandmarkTrapTests
```
