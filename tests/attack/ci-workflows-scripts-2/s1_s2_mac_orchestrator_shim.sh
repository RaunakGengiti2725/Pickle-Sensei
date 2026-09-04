#!/usr/bin/env bash
# Scenarios 1 + 2 (Linux harness) — error propagation inside the Apple
# orchestrator WITHOUT an Apple machine.
#
# What this proves and what it cannot:
#   * scripts/mac-full-verify.sh and tools/macos-ci/*.{sh,py} are bash/python;
#     their control flow (pipefail, set -e subshells, the *.xcresult glob, the
#     exception swallowing in xcresult-summary.py) executes identically on
#     Linux. That is what we exercise, by putting a shim toolchain first on
#     PATH (uname→Darwin, xcodebuild, swift, xcrun, xcode-select, sw_vers, file)
#     whose behaviour is chosen per variant via SHIM_* variables.
#   * Anything about REAL Xcode/xcresulttool/simctl output remains UNKNOWN from
#     here; the only Apple truth is the existing run 33841813597 on this SHA.
#
# Variants
#   summary-*     tools/macos-ci/xcresult-summary.py fed stale / missing /
#                 unreadable / failing bundles (scenario 1 first half)
#   orch-pass     shim all-green → swift-native passed (control)
#   orch-xcfail   shim `xcodebuild test` exits 65 → stage must FAIL (scenario 1
#                 second half: "xcodebuild test exit still fails the stage")
#   orch-stale    xcodebuild exits 0 but xcresulttool cannot read the bundles →
#                 does the stage pass with zero parsed test evidence?
#   orch-noclip   scratch clone with the committed clip removed → stage must
#                 fail at "committed clip missing" (scenario 2)
#   orch-nopose   swing-lab extract reports 0 frames with pose → stage must fail
#                 via check-swing-lab-extract.py
#   orch-artifact summary.json + per-stage log exist after a FAILED run
#                 (artifact retention for the always() upload step)
#   orch-cancel   SIGTERM mid-`xcodebuild test` (what cancel-in-progress does
#                 to the runner job): which partial artifacts survive for the
#                 always() upload + step summary? (scenario 5, local half)
# shellcheck source=tests/attack/ci-workflows-scripts-2/lib.sh
source "$(dirname "$0")/lib.sh"
cd "$ATTACK_REPO_ROOT" || exit 2

overall=0
SHIM="$ATTACK_OUT/s1-shim-bin"
mkdir -p "$SHIM/swing-lab-bin"
register_cleanup "$SHIM"

# ------------------------------------------------------------------ shims ----
cat >"$SHIM/uname" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in -s) echo Darwin ;; -m) echo arm64 ;; *) echo "Darwin shim 26.0 arm64" ;; esac
SH
cat >"$SHIM/xcode-select" <<'SH'
#!/usr/bin/env bash
echo /Applications/Xcode.app/Contents/Developer
SH
cat >"$SHIM/sw_vers" <<'SH'
#!/usr/bin/env bash
echo 26.0
SH
cat >"$SHIM/file" <<'SH'
#!/usr/bin/env bash
echo "$1: Mach-O 64-bit executable arm64 (shim)"
SH
cat >"$SHIM/swift" <<'SH'
#!/usr/bin/env bash
# swift build | swift test --parallel --xunit-output F | swift build -c release --show-bin-path
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  [ "${args[$i]}" = --xunit-output ] && printf '<testsuites tests="1" failures="0"/>\n' >"${args[$((i+1))]}"
  [ "${args[$i]}" = --show-bin-path ] && { echo "$SHIM_DIR/swing-lab-bin"; exit 0; }
done
echo "swift ${args[0]:-} ok (shim)"
SH
cat >"$SHIM/xcodebuild" <<'SH'
#!/usr/bin/env bash
# -list → scheme names; -version → banner; test … -resultBundlePath B → writes B
case "${1:-}" in
  -list) echo "Information about package"; echo "    Schemes:"; echo "        PickleVisionCore-Package"; exit 0 ;;
  -version) echo "Xcode 26.0 (shim)"; echo "Build version SHIM"; exit 0 ;;
esac
bundle=""
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do [ "${args[$i]}" = -resultBundlePath ] && bundle="${args[$((i+1))]}"; done
if [ -n "$bundle" ]; then
  mkdir -p "$bundle"
  echo "$SHIM_BUNDLE_KIND" >"$bundle/shim-kind"
  echo '<?xml version="1.0"?><plist version="1.0"><dict><key>version</key><dict><key>major</key><integer>3</integer></dict></dict></plist>' >"$bundle/Info.plist"
fi
echo "Test Suite 'All tests' started (shim)"
sleep "${SHIM_XCODEBUILD_SLEEP:-0}"
if [ "${SHIM_XCODEBUILD_TEST_RC:-0}" != 0 ]; then
  echo "error: shim test failure"; echo "** TEST FAILED **"; exit "$SHIM_XCODEBUILD_TEST_RC"
fi
echo "Executed 56 tests, with 0 failures (shim)"; echo "** TEST SUCCEEDED **"
SH
cat >"$SHIM/xcrun" <<'SH'
#!/usr/bin/env bash
# xcrun simctl … | xcrun xcresulttool get test-results summary --path B
if [ "${1:-}" = simctl ]; then
  echo "simctl $2 ${3:-}" >>"${SHIM_SIMCTL_LOG:-/dev/null}"
  case "${2:-} ${3:-}" in
    'list devices')
      cat <<'JSON'
{"devices": {"com.apple.CoreSimulator.SimRuntime.iOS-26-0": [{"udid": "SHIM-UDID-0000", "name": "iPhone 17 Pro", "state": "Booted", "isAvailable": true}]}}
JSON
      ;;
    'list runtimes')
      echo '{"runtimes": [{"identifier": "com.apple.CoreSimulator.SimRuntime.iOS-26-0", "version": "26.0", "platform": "iOS", "isAvailable": true}]}' ;;
    'list devicetypes')
      echo '{"devicetypes": [{"name": "iPhone 11 Pro", "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-11-Pro"}, {"name": "iPhone 17 Pro", "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"}, {"name": "iPhone 17 Pro Max", "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max"}]}' ;;
    'create '*) echo "SHIM-CREATED-$(date +%s%N)" ;;
    bootstatus*|boot*|terminate*|uninstall*|install*|launch*) ;;
    *) echo "simctl shim: unsupported $2" >&2; exit 1 ;;
  esac
  exit 0
fi
if [ "${1:-}" = xcresulttool ]; then
  bundle=""
  args=("$@")
  for ((i=0; i<${#args[@]}; i++)); do [ "${args[$i]}" = --path ] && bundle="${args[$((i+1))]}"; done
  kind="$(cat "$bundle/shim-kind" 2>/dev/null || echo stale)"
  case "$kind" in
    pass)   printf '{"result":"Passed","totalTestCount":56,"passedTests":56,"failedTests":0,"skippedTests":0,"testFailures":[]}\n' ;;
    fail)   printf '{"result":"Failed","totalTestCount":56,"passedTests":54,"failedTests":2,"skippedTests":0,"testFailures":[{"testName":"shimTest()","failureText":"XCTAssertEqual failed"}]}\n' ;;
    badjson) printf 'not json at all\n' ;;
    *)      echo "Error: The requested test results summary is not available in this result bundle (older format)" >&2; exit 1 ;;
  esac
  exit 0
fi
echo "xcrun shim: unsupported $*" >&2; exit 1
SH
cat >"$SHIM/swing-lab-bin/swing-lab" <<'SH'
#!/usr/bin/env bash
# swing-lab extract CLIP --out DIR
out=""
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do [ "${args[$i]}" = --out ] && out="${args[$((i+1))]}"; done
[ -f "${args[1]:-}" ] || { echo "clip not readable: ${args[1]:-}" >&2; exit 1; }
mkdir -p "$out"
fwp="${SHIM_FRAMES_WITH_POSE:-1286}"
printf '{"framesSeen":1461,"framesWithPose":%s,"trajectoryCount":3,"poseModelVersion":"shim","wallTimeMs":1}\n' "$fwp" >"$out/extract-meta.json"
if [ "$fwp" = 0 ]; then
  printf '{"format":"pickle.pose-sequence.v1","frames":[]}\n' >"$out/pose.json"
else
  printf '{"format":"pickle.pose-sequence.v1","frames":[{"t":0}]}\n' >"$out/pose.json"
fi
echo "extract done (shim)"
SH
chmod +x "$SHIM"/* "$SHIM/swing-lab-bin/swing-lab"

# ------------------------------------------ scenario 1a: xcresult-summary.py ----
SUM=tools/macos-ci/xcresult-summary.py
mk_bundle() { mkdir -p "$1"; echo "$2" >"$1/shim-kind"; }
B="$ATTACK_OUT/s1-bundles"; rm -rf "$B"
mk_bundle "$B/stale.xcresult" stale
mk_bundle "$B/pass.xcresult" pass
mk_bundle "$B/fail.xcresult" fail
mk_bundle "$B/badjson.xcresult" badjson

summary_case() { # $1 label, $2 expected exit, $3 expected regex, rest = args
  local label="$1" want_rc="$2" want_re="$3"; shift 3
  local log="$ATTACK_OUT/s1-summary-$label.log" rc=0
  PATH="$SHIM:$PATH" SHIM_DIR="$SHIM" python3 "$SUM" "$@" >"$log" 2>&1 || rc=$?
  echo "exit=$rc" >>"$log"
  if [ "$rc" = "$want_rc" ] && grep -Eq -- "$want_re" "$log"; then
    return 0
  fi
  return 1
}

# stale bundle → prints "(no test summary: CalledProcessError)" and exits 0 (scenario's premise)
if summary_case stale 0 'stale\.xcresult`: \(no test summary: CalledProcessError\)' "$B/stale.xcresult"; then
  record_verdict s1-summary-stale BROKEN \
    "xcresult-summary.py on an unreadable/older-format bundle prints '(no test summary: CalledProcessError)' and exits 0 — zero parsed tests counts as success" \
    "a bundle that cannot be summarised should not exit 0 (or the stage should require ≥1 parsed passing bundle); today only failedTests>0 fails it" \
    "$ATTACK_OUT/s1-summary-stale.log" "tools/macos-ci/xcresult-summary.py"
  overall=1
else
  record_verdict s1-summary-stale HELD "unreadable bundle did not yield exit 0 with '(no test summary…)'" "n/a" "$ATTACK_OUT/s1-summary-stale.log"
fi
# missing path (what the unexpanded glob "$ARTIFACTS/*.xcresult" turns into when no bundle exists) → exit 0
if summary_case missing 0 '\*\.xcresult`: \(missing\)' "$B/nothing-here/*.xcresult"; then
  record_verdict s1-summary-missing BROKEN "a non-existent bundle path (the literal unexpanded glob) prints '(missing)' and exits 0" \
    "no bundles ⇒ no test evidence ⇒ non-zero" "$ATTACK_OUT/s1-summary-missing.log"; overall=1
else
  record_verdict s1-summary-missing HELD "missing bundle path is non-zero" "n/a" "$ATTACK_OUT/s1-summary-missing.log"
fi
# malformed JSON from xcresulttool → JSONDecodeError swallowed → exit 0
if summary_case badjson 0 'badjson\.xcresult`: \(no test summary: JSONDecodeError\)' "$B/badjson.xcresult"; then
  record_verdict s1-summary-badjson BROKEN "malformed xcresulttool JSON → '(no test summary: JSONDecodeError)', exit 0" "non-zero" "$ATTACK_OUT/s1-summary-badjson.log"; overall=1
else
  record_verdict s1-summary-badjson HELD "malformed JSON is non-zero" "n/a" "$ATTACK_OUT/s1-summary-badjson.log"
fi
# xcrun absent from PATH entirely → FileNotFoundError swallowed → exit 0
log="$ATTACK_OUT/s1-summary-noxcrun.log"; rc=0
PATH="/usr/bin:/bin" python3 "$SUM" "$B/pass.xcresult" >"$log" 2>&1 || rc=$?
echo "exit=$rc" >>"$log"
if [ "$rc" = 0 ] && grep -q 'no test summary: FileNotFoundError' "$log"; then
  record_verdict s1-summary-noxcrun BROKEN "with no xcrun on PATH every bundle is '(no test summary: FileNotFoundError)' and the tool exits 0" "non-zero (tooling absent ≠ tests passed)" "$log"; overall=1
else
  record_verdict s1-summary-noxcrun HELD "exit $rc" "non-zero" "$log"
fi
# genuine failing bundle → exit 1 (the intended gate works when the bundle is readable)
if summary_case fail 1 'fail\.xcresult`: \*\*Failed\*\* — total 56, passed 54, failed 2' "$B/fail.xcresult"; then
  record_verdict s1-summary-fail HELD "readable bundle with failedTests=2 → exit 1 with the failure listed" "exit 1" "$ATTACK_OUT/s1-summary-fail.log"
else
  record_verdict s1-summary-fail BROKEN "failing bundle did not exit 1" "exit 1" "$ATTACK_OUT/s1-summary-fail.log"; overall=1
fi
# mixed: one stale + one passing → exit 0, stale silently ignored
if summary_case mixed 0 'stale\.xcresult`: \(no test summary' "$B/stale.xcresult" "$B/pass.xcresult"; then
  record_verdict s1-summary-mixed BROKEN "stale + passing bundle → exit 0; the stale bundle (e.g. the iOS-simulator run) contributes nothing and nobody is told" \
    "exit non-zero or at least emit ::error:: when a bundle cannot be read" "$ATTACK_OUT/s1-summary-mixed.log"; overall=1
else
  record_verdict s1-summary-mixed HELD "mixed stale/pass is non-zero" "n/a" "$ATTACK_OUT/s1-summary-mixed.log"
fi

# ------------------------- scenario 3 (static+shim): select-simulator.sh pick ----
# A booted, available iPhone 17 Pro exists (shim). The documented contract is to
# pick it ("preferring an already-booted device"), never to create a new one.
log="$ATTACK_OUT/s3-select-simulator.log"; simlog="$ATTACK_OUT/s3-select-simulator-simctl.txt"; : >"$simlog"; rc=0
PATH="$SHIM:$PATH" SHIM_DIR="$SHIM" SHIM_SIMCTL_LOG="$simlog" tools/macos-ci/select-simulator.sh >"$log" 2>&1 || rc=$?
echo "exit=$rc" >>"$log"
MACLOG="${MAC_RUN_ARTIFACTS:-/home/ubuntu/attack-artifacts/mac-run-33841813597/mac-full-verify-3}"
mac_note=""
if [ -f "$MACLOG/swift-native.log" ] && grep -q 'SyntaxError: f-string' "$MACLOG/swift-native.log"; then
  mac_note="; CONFIRMED on the real M4 run 33841813597: swift-native.log:$(grep -n 'SyntaxError' "$MACLOG/swift-native.log" | cut -d: -f1 | head -1) and ios-app.log:$(grep -n 'SyntaxError' "$MACLOG/ios-app.log" | cut -d: -f1 | head -1) show the same SyntaxError followed by 'creating simulator PickleSensei-CI (…iPhone-11-Pro…)' — two new devices per run ($(grep -h 'booting simulator' "$MACLOG"/swift-native.log "$MACLOG"/ios-app.log | awk '{print $3}' | sort -u | wc -l | tr -d ' ') distinct UDIDs booted) while an iPhone 17 Pro Max was already Booted (environment.txt)"
fi
if grep -q 'SyntaxError: f-string' "$log" && grep -q 'creating simulator PickleSensei-CI' "$log" && grep -q 'simctl create' "$simlog"; then
  record_verdict s3-select-simulator BROKEN \
    "pick() always dies: the bash single-quoted python program contains '.'.join → the quotes end the bash string, python sees {..join(...)} → SyntaxError; select-simulator.sh then falls into the create-a-new-device path on every run (chose iPhone-11-Pro type, not the booted iPhone 17 Pro)$mac_note" \
    "select the existing booted iPhone (newest runtime, Pro, booted first); create only when none exists" \
    "$log" "$simlog" "tools/macos-ci/select-simulator.sh:47"
  overall=1
else
  record_verdict s3-select-simulator HELD "select-simulator.sh exit $rc without the SyntaxError/create path" "selects the booted device" "$log"
fi

# ---------------------------------------- orchestrator under the shim PATH ----
run_orch() { # $1 label, $2 checkout dir, remaining = env assignments
  local label="$1" dir="$2"; shift 2
  local art="$ATTACK_OUT/s1-orch-$label-artifacts" log="$ATTACK_OUT/s1-orch-$label.log" rc=0
  rm -rf "$art"
  (
    cd "$dir" || exit 2
    # shellcheck disable=SC2030  # intentionally scoped to this subshell
    export PATH="$SHIM:$PATH" SHIM_DIR="$SHIM" HOME="$ATTACK_OUT/s1-home-$label"
    export MAC_ARTIFACTS="$art" PICKLE_CI_CACHE="$ATTACK_OUT/s1-cache-$label"
    export SHIM_BUNDLE_KIND=pass SHIM_XCODEBUILD_TEST_RC=0 SHIM_FRAMES_WITH_POSE=1286
    for kv in "$@"; do export "${kv?}"; done
    timeout 300 scripts/mac-full-verify.sh --only swift-native
  ) >"$log" 2>&1 || rc=$?
  echo "exit=$rc" >>"$log"
  ORCH_RC=$rc ORCH_ART=$art ORCH_LOG=$log
}
orch_status() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); s=next(x for x in d["stages"] if x["name"]=="swift-native"); print(d["ok"], s["status"], s["note"])' "$1/summary.json" 2>/dev/null || echo "no-summary"; }

# control
run_orch pass "$ATTACK_REPO_ROOT"
st="$(orch_status "$ORCH_ART")"
if [ "$ORCH_RC" = 0 ] && [ "$st" = "True passed " ] && grep -q 'Passed\*\* — total 56, passed 56' "$ORCH_ART/swift-native-xcresult-summary.txt"; then
  record_verdict s1-orch-pass HELD "control: all-green shim → exit 0, summary ok:true, swift-native passed, xcresult summary lists 2 passing bundles" "pass" "$ORCH_LOG" "$ORCH_ART/summary.json"
else
  record_verdict s1-orch-pass BROKEN "control run did not pass: exit $ORCH_RC, $st (shim/harness problem — later verdicts unreliable)" "pass" "$ORCH_LOG" "$ORCH_ART/summary.json"; overall=1
fi

# xcodebuild test exit 65 → stage must fail
run_orch xcfail "$ATTACK_REPO_ROOT" SHIM_XCODEBUILD_TEST_RC=65
st="$(orch_status "$ORCH_ART")"
if [ "$ORCH_RC" = 1 ] && [ "$st" = "False failed exit 65" ]; then
  record_verdict s1-orch-xcfail HELD "xcodebuild test exit 65 propagates through 'xcodebuild | tee | grep||true | tail' (set -o pipefail + set -e subshell): swift-native failed 'exit 65', run exit 1" \
    "stage fails on xcodebuild test failure" "$ORCH_LOG" "$ORCH_ART/summary.json" "$ORCH_ART/swift-native.log"
else
  record_verdict s1-orch-xcfail BROKEN "xcodebuild exit 65 did not fail the stage: exit $ORCH_RC, $st" "stage failed exit 65" "$ORCH_LOG" "$ORCH_ART/summary.json"; overall=1
fi

# xcodebuild ok, bundles unreadable → stage outcome?
run_orch stale "$ATTACK_REPO_ROOT" SHIM_BUNDLE_KIND=stale
st="$(orch_status "$ORCH_ART")"
if [ "$ORCH_RC" = 0 ] && [ "$st" = "True passed " ] && grep -q '(no test summary: CalledProcessError)' "$ORCH_ART/swift-native-xcresult-summary.txt"; then
  record_verdict s1-orch-stale BROKEN "xcodebuild exit 0 + both .xcresult bundles unreadable by xcresulttool → swift-native PASSED, summary ok:true; swift-native-xcresult-summary.txt (what the step summary shows) only says '(no test summary: CalledProcessError)' for both bundles" \
    "the stage's test-evidence gate should require at least one parsed bundle; a run with zero parsed XCTest results must not be 'passed'" \
    "$ORCH_LOG" "$ORCH_ART/summary.json" "$ORCH_ART/swift-native-xcresult-summary.txt"
  overall=1
else
  record_verdict s1-orch-stale HELD "unreadable bundles: exit $ORCH_RC, $st" "n/a" "$ORCH_LOG" "$ORCH_ART/summary.json"
fi

# scenario 2: committed clip removed in a scratch clone
SCRATCH="$ATTACK_OUT/s2-scratch"; register_cleanup "$SCRATCH"
scratch_clone "$SCRATCH"
git -C "$SCRATCH" rm -q datasets/pickleball/fresh-candidates/va-O1dLhGGPErc.mp4
git -C "$SCRATCH" -c user.name=attack -c user.email=attack@example.invalid commit -q -m "drop committed clip"
[ ! -f "$SCRATCH/datasets/pickleball/fresh-candidates/va-O1dLhGGPErc.mp4" ] || { alog "clip still present in scratch"; exit 2; }
run_orch noclip "$SCRATCH"
st="$(orch_status "$ORCH_ART")"
if [ "$ORCH_RC" = 1 ] && [ "$st" = "False failed exit 1" ] && grep -q 'committed clip missing: datasets/pickleball/fresh-candidates/va-O1dLhGGPErc.mp4' "$ORCH_ART/swift-native.log" && [ ! -d "$ORCH_ART/swing-lab-extract" ]; then
  record_verdict s2-orch-noclip HELD "clip removed → swift-native failed 'exit 1' with 'committed clip missing: …va-O1dLhGGPErc.mp4' in swift-native.log; no swing-lab-extract/ written; xcresult summary step never reached" \
    "fail at 'committed clip missing', never pass without pose evidence" "$ORCH_LOG" "$ORCH_ART/summary.json" "$ORCH_ART/swift-native.log"
else
  record_verdict s2-orch-noclip BROKEN "clip removed: exit $ORCH_RC, $st" "stage failed exit 1 with 'committed clip missing'" "$ORCH_LOG" "$ORCH_ART/summary.json"; overall=1
fi

# extract with zero pose frames → check-swing-lab-extract.py must fail the stage
run_orch nopose "$ATTACK_REPO_ROOT" SHIM_FRAMES_WITH_POSE=0
st="$(orch_status "$ORCH_ART")"
if [ "$ORCH_RC" = 1 ] && [ "$st" = "False failed exit 1" ] && grep -q '::error::Apple Vision produced zero frames with a detected pose' "$ORCH_ART/swift-native.log"; then
  record_verdict s1-orch-nopose HELD "extract meta framesWithPose=0 → check-swing-lab-extract.py '::error::Apple Vision produced zero frames…' fails the stage (exit 1)" "fail" "$ORCH_LOG" "$ORCH_ART/swift-native.log"
else
  record_verdict s1-orch-nopose BROKEN "zero-pose extract: exit $ORCH_RC, $st" "stage failed exit 1" "$ORCH_LOG" "$ORCH_ART/summary.json"; overall=1
fi

# artifact retention after a failed run (feeds the always() upload + step summary)
art="$ATTACK_OUT/s1-orch-xcfail-artifacts"
if [ -f "$art/summary.json" ] && [ -s "$art/swift-native.log" ] && [ -f "$art/vision-core-xcodebuild-macos.log" ]; then
  record_verdict s1-orch-artifact HELD "after the failed run: summary.json, swift-native.log and vision-core-xcodebuild-macos.log all present under MAC_ARTIFACTS" "artifacts survive failure" "$art/summary.json"
else
  record_verdict s1-orch-artifact BROKEN "artifacts missing after failed run: $(find "$art" -maxdepth 1 -mindepth 1 2>/dev/null | tr '\n' ' ')" "summary.json + logs present" "$ATTACK_OUT/s1-orch-xcfail.log"; overall=1
fi

# cancellation mid-flight: SIGTERM the orchestrator while xcodebuild test is running
art="$ATTACK_OUT/s1-orch-cancel-artifacts"; log="$ATTACK_OUT/s1-orch-cancel.log"; rm -rf "$art"
(
  cd "$ATTACK_REPO_ROOT" || exit 2
  # shellcheck disable=SC2031  # PATH is read, not relied on outside the subshell
  exec env PATH="$SHIM:$PATH" SHIM_DIR="$SHIM" HOME="$ATTACK_OUT/s1-home-cancel" \
    MAC_ARTIFACTS="$art" PICKLE_CI_CACHE="$ATTACK_OUT/s1-cache-cancel" \
    SHIM_BUNDLE_KIND=pass SHIM_XCODEBUILD_TEST_RC=0 SHIM_FRAMES_WITH_POSE=1286 SHIM_XCODEBUILD_SLEEP=60 \
    setsid scripts/mac-full-verify.sh --only swift-native
) >"$log" 2>&1 &
ORCH_PID=$!
for _ in $(seq 1 60); do [ -f "$art/vision-core-xcodebuild-macos.log" ] && break; sleep 0.5; done
sleep 1
kill -TERM -- "-$ORCH_PID" 2>/dev/null || kill -TERM "$ORCH_PID" 2>/dev/null
rc=0; wait "$ORCH_PID" || rc=$?
echo "exit=$rc" >>"$log"
survivors="$(find "$art" -maxdepth 1 -type f -printf '%f ' 2>/dev/null)"
if [ ! -f "$art/summary.json" ] && [ -f "$art/swift-native.log" ] && [ -f "$art/vision-core-xcodebuild-macos.log" ] && [ "$rc" -ne 0 ]; then
  record_verdict s5-orch-cancel HELD "SIGTERM during xcodebuild test → orchestrator exit $rc; partial artifacts survive for the always() upload: $survivors— summary.json is NOT written (only at the end), so the step summary shows sw_vers/xcodebuild -version + nothing else; swift-native.log holds the partial tee'd output" \
    "partial artifacts retained; no summary.json ok:true left behind" "$log" "$art/swift-native.log"
elif [ -f "$art/summary.json" ]; then
  record_verdict s5-orch-cancel BROKEN "a summary.json exists after cancellation: $(tr -d '\n' <"$art/summary.json" | cut -c1-200)" "no summary.json from a cancelled run" "$log" "$art/summary.json"; overall=1
else
  record_verdict s5-orch-cancel BROKEN "cancel: exit $rc, files: $survivors" "partial logs present" "$log"; overall=1
fi
exit $overall
