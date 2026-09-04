# vision-core Linux review harness

Adversarial, replayable stress harness for the Foundation-only parts of
`native/vision-core` (and the `StrokeCompletionMonitor` from PickleNative),
compiled on Linux by symlinking the production sources into a SwiftPM package.
`Sources/CoreVideo` is a stand-in so `PoseProviding` compiles; nothing that
touches Apple Vision / AVFoundation / CoreVideo runs here. Linux results are a
proxy for the pure Swift logic only — never Apple runtime truth.

Production code is never modified: every file under
`Sources/PickleVisionCoreLinux` is a symlink into the real source tree.

```bash
swift build -c release -Xswiftc -enable-testing
swift test                                    # XCTests (also run on the Mac package)

H=.build/release/ReviewHarness
$H fuzz   --seeds 128 --frames 50000 --out artifacts/review     # realistic|hostile|clock modes
$H fuzz   --seeds 32  --frames 20000 --allow-duplicate-names --out artifacts/dup
$H scale  --frames 4000000 --mode realistic --out artifacts/scale  # RSS + retained-state checkpoints
$H traps  --out artifacts/review                                   # process-isolated trap probes
$H threads --probe monitor|single-queue|closure-var-race --out artifacts/threads

# every failing fuzz row carries a `replay` command, e.g.
$H child fuzz --seed 6 --mode clock --frames 50000
$H child replay-frame --seed 6 --mode clock --index 41542   # dump the exact input frame
$H child trap PoseReadinessEvaluator duplicate_landmark_name

# ThreadSanitizer (reports go to stderr; TSan's default exit code on a race is 66)
swift build --sanitize=thread --build-path .build-tsan --product ReviewHarness
.build-tsan/debug/ReviewHarness threads --probe closure-var-race --iterations 20000 --out artifacts/tsan
```

Input modes: `realistic` (scripted athlete: quiet, ~300 ms wrist arc, quiet),
`hostile` (NaN/±inf/negative/out-of-range values, missing joints, random
timestamps), `clock` (finite values with repeated, regressed and gapped
timestamps). Generators are seeded (`SplitMix64`), so a seed + mode + index
reproduces any frame byte-for-byte.
