# PickleNativeStress — seeded stress harness for the native bridge core

SwiftPM package that compiles the CANONICAL Foundation-only production sources
(`native/vision-core` + `LocalPods/PickleNative/Sources/StrokeCompletionMonitor.swift`,
linked by `scripts/prepare-sources.sh`, never copied) and drives them with
deterministic, seed-replayable scenarios: empty/one-frame/huge/corrupt inputs,
cancellation mid-extraction, two people, rapid start/stop, memory-pressure loops,
concurrent monitor access. It runs on Linux and Darwin. Vision/AVFoundation/UIKit
files are NOT compiled on Linux — anything about them is UNVERIFIED-on-Linux.

```sh
cd apps/mobile/ios/StressTests
scripts/prepare-sources.sh          # populate Sources/PickleNativeStressCore/Generated
swift build --build-tests
swift test                          # XCTest suite; STRESS_ITER scales the campaigns (default 25)
STRESS_ITER=200 swift test          # slow campaign
python3 scripts/campaign.py --iter 200 --out results/campaign-200   # per-scenario processes, seeds.json + summary.json
.build/debug/stress-runner replay --scenario hugeAndCorruptInputs --seed 14
.build/debug/stress-runner repro --name list
```

`stress-runner` exit codes: 0 every iteration held, 3 an invariant was violated,
signal (SIGILL/SIGTRAP) a Swift runtime trap inside production code — the
campaign driver records the trapping seed as `crashed` and resumes with the
next one. Every seed row in `seeds.json` carries its exact replay command.

`MinimalReproTests` execute hand-minimized repros in child `stress-runner`
processes (two of them trap the runtime). Their assertions state the DESIRED
invariants, so they stay red until the production hardening lands.
Xcode-hosted runs must point `STRESS_RUNNER` at a built `stress-runner`.
