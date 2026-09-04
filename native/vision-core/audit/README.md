# native/vision-core — structural audit harness (Linux)

Audit-only tooling; nothing here is compiled into the app or the package's
own targets (`Package.swift` pins `Sources/` and `Tests/`).

- `linux-harness/` — a SwiftPM package that symlinks the Foundation-only
  sources and every test in `../Tests` and runs them on Linux. The only
  Apple-only dependency (`import CoreVideo` for `CVPixelBuffer` in two
  protocol signatures) is shimmed in a GENERATED copy of
  `VisionCoreContracts.swift`; `generate-contracts.sh` diff-checks that copy
  against the canonical file. `ApplePoseProvider.swift` (Vision) is out of
  reach here — Apple behaviour is Mac-runner evidence only.
  Run: `audit/linux-harness/run.sh [--filter Audit]`.
- `probes/` — minimal scripts for defects that cannot be expressed as an
  XCTest (a runtime trap aborts the test process).
  Run: `audit/probes/run_readiness_duplicate_landmark_trap.sh`.

The `Tests/Audit*ProbeTests.swift` files are audit probes: each test states
an invariant; on 4d812e1a several FAIL by design (they are the reproductions
behind the audit findings) and become regression tests once fixed.
