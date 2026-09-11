#!/usr/bin/env bash
# Orchestrator wiring only: recorded fake toolchains in a disposable checkout.
# Swift/XCTest/Vision product evidence must still come from the real Mac gate.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/repo/scripts" "$WORK/repo/tools/macos-ci" "$WORK/tools" "$WORK/bin" "$WORK/root-node" "$WORK/mobile-node" \
  "$WORK/repo/native/vision-core/.build" "$WORK/repo/native/managed-media" \
  "$WORK/repo/native/swing-lab" "$WORK/repo/datasets/pickleball/fresh-candidates" \
  "$WORK/repo/apps/mobile/ios"
cp "$REPO_ROOT/scripts/mac-full-verify.sh" "$WORK/repo/scripts/"
touch "$WORK/repo/native/vision-core/.build/preserved" \
  "$WORK/repo/datasets/pickleball/fresh-candidates/va-O1dLhGGPErc.mp4"
for helper in inspect-environment.sh simulator-launch-check.sh pod-install.sh \
  xcresult-summary.py check-swing-lab-extract.py describe-package.py; do
  printf '#!/usr/bin/env bash\nexit 0\n' >"$WORK/repo/tools/macos-ci/$helper"
done
cat >"$WORK/repo/tools/macos-ci/test-clip-storage.py" <<'PY_CLIP'
import os, sys
with open(os.environ["NATIVE_TRACE"], "a", encoding="utf-8") as trace:
    trace.write("clip-storage|" + sys.argv[1] + "\n")
raise SystemExit(70 if os.environ.get("FAIL_CLIP_STORAGE") == "1" else 0)
PY_CLIP
cat >"$WORK/repo/tools/macos-ci/select-simulator.sh" <<'SH_SIM'
#!/usr/bin/env bash
printf 'simulator|%s|%s\n' "$PICKLE_CI_SIMULATOR_UDID" "$*" >>"$NATIVE_TRACE"
echo "$PICKLE_CI_SIMULATOR_UDID"
SH_SIM
cat >"$WORK/tools/uname" <<'SH_UNAME'
#!/usr/bin/env bash
case "${1:-}" in -s) echo Darwin ;; -m) echo arm64 ;; *) exit 2 ;; esac
SH_UNAME
cat >"$WORK/tools/swift" <<'SH_SWIFT'
#!/usr/bin/env bash
printf 'swift|%s|%s\n' "$(basename "$PWD")" "$*" >>"$NATIVE_TRACE"
if [ "${FAIL_MANAGED_SWIFT:-0}" = 1 ] && [ "$(basename "$PWD")" = managed-media ] && [ "$1" = test ]; then exit 71; fi
case "$*" in *--show-bin-path*) echo "$FAKE_NATIVE_BIN" ;; esac
SH_SWIFT
cat >"$WORK/tools/xcodebuild" <<'SH_XCODE'
#!/usr/bin/env bash
printf 'xcodebuild|%s|%s\n' "$(basename "$PWD")" "$*" >>"$NATIVE_TRACE"
if [ "${1:-}" = build ]; then
  source apps/mobile/ios/.xcode.env.local
  printf 'xcode-node|%s|%s\n' "$NODE_BINARY" "$("$NODE_BINARY" --version)" >>"$NATIVE_TRACE"
fi
case "${1:-}" in
  -list) printf 'Schemes:\n  PickleVisionCore\n  PickleManagedMedia\n' ;;
  -version) printf 'Xcode Test\nBuild version Test\n' ;;
  build) if [ "${FAIL_APP_BUILD:-0}" = 1 ]; then exit 73; fi ;;
  test)
    if [ "${FAIL_MANAGED_IOS:-0}" = 1 ] && [ "$(basename "$PWD")" = managed-media ]; then
      case "$*" in *'platform=iOS Simulator'*) exit 72 ;; esac
    fi
    while [ $# -gt 0 ]; do
      if [ "$1" = -resultBundlePath ]; then mkdir -p "$2"; shift; fi
      shift
    done
    echo '** TEST SUCCEEDED **'
    ;;
esac
SH_XCODE
for spec in root:20.20.0 mobile:22.22.0; do
  name=${spec%%:*}; version=${spec#*:}
  printf '#!/usr/bin/env bash\necho v%s\n' "$version" >"$WORK/$name-node/node"
  chmod +x "$WORK/$name-node/node"
done
for tool in npm npx; do
  cat >"$WORK/tools/$tool" <<'SH_NODE_TOOL'
#!/usr/bin/env bash
printf '%s|%s|%s\n' "$(basename "$0")" "$(node --version)" "$*" >>"$NATIVE_TRACE"
SH_NODE_TOOL
done
cat >"$WORK/bin/swing-lab" <<'SH_SWING'
#!/usr/bin/env bash
printf 'swing-lab|%s\n' "$*" >>"$NATIVE_TRACE"
mkdir -p "$4"
echo '{"tooling-test":true}' >"$4/extract-meta.json"
SH_SWING
chmod +x "$WORK/tools/"* "$WORK/bin/swing-lab" "$WORK/repo/tools/macos-ci/"*
export PATH="$WORK/root-node:$WORK/tools:$PATH" DEVELOPER_DIR="$WORK/developer"
export NATIVE_TRACE="$WORK/trace" FAKE_NATIVE_BIN="$WORK/bin"
export MAC_ARTIFACTS="$WORK/artifacts" PICKLE_CI_CACHE="$WORK/cache"
export PICKLE_CI_SIMULATOR_UDID=dedicated-test-device
unset PICKLE_NATIVE_JOBS VERIFY_MOBILE_NODE_BIN
"$BASH" "$WORK/repo/scripts/mac-full-verify.sh" --only swift-native --clean >"$WORK/run.log" 2>&1
python3 - "$NATIVE_TRACE" "$MAC_ARTIFACTS/summary.json" "$PICKLE_CI_CACHE" <<'PY'
import json, sys
trace = open(sys.argv[1], encoding="utf-8").read().splitlines()
summary = json.load(open(sys.argv[2], encoding="utf-8"))
cache = sys.argv[3]
assert summary["ok"] is True and len(summary["stages"]) == 1, summary
assert summary["stages"][0]["status"] == "passed", summary
assert len([line for line in trace if line.startswith("clip-storage|")]) == 1, trace
for package in ("vision-core", "managed-media"):
    for verb in ("build", "test"):
        command = next(line for line in trace if line.startswith(f"swift|{package}|{verb} "))
        assert f"--scratch-path {cache}/{package}-swiftpm" in command, command
        assert "--jobs 2" in command, command
        if verb == "test":
            assert "--parallel --num-workers 2" in command, command
    commands = [line for line in trace if line.startswith(f"xcodebuild|{package}|test ")]
    assert len(commands) == 2, commands
    for command in commands:
        assert "-jobs 2 -parallel-testing-enabled NO" in command, command
        assert f"-derivedDataPath {cache}/{package}-derived" in command, command
    assert any("platform=macOS,arch=arm64" in c for c in commands), commands
    assert any("platform=iOS Simulator,id=dedicated-test-device" in c for c in commands), commands
for command in (line for line in trace if line.startswith("swift|swing-lab|")):
    assert "--jobs 2" in command and f"--scratch-path {cache}/swing-lab-swiftpm" in command, command
assert any(line.startswith("swing-lab|extract ") for line in trace), trace
PY
test -f "$WORK/repo/native/vision-core/.build/preserved"
echo '[test_mac_full_verify_runtime] PASS: both packages run macOS/iOS tests; workers/cache/simulator pinned; checkout cache retained'

for failure in FAIL_CLIP_STORAGE FAIL_MANAGED_SWIFT FAIL_MANAGED_IOS; do
  export "$failure=1"
  if "$BASH" "$WORK/repo/scripts/mac-full-verify.sh" --only swift-native >"$WORK/failure.log" 2>&1; then
    echo "[test_mac_full_verify_runtime] $failure unexpectedly passed" >&2; exit 1
  fi
  python3 - "$MAC_ARTIFACTS/summary.json" <<'PY'
import json, sys
summary = json.load(open(sys.argv[1], encoding="utf-8"))
assert summary["ok"] is False and summary["stages"][0]["status"] == "failed", summary
PY
  unset "$failure"
done
echo '[test_mac_full_verify_runtime] PASS: managed-media Swift and iOS failures fail the canonical gate'

for invalid in 0 00 invalid; do
  export PICKLE_NATIVE_JOBS="$invalid"
  if "$BASH" "$WORK/repo/scripts/mac-full-verify.sh" --only swift-native >"$WORK/invalid.log" 2>&1; then
    echo '[test_mac_full_verify_runtime] invalid worker bound unexpectedly passed' >&2; exit 1
  fi
  grep -F 'PICKLE_NATIVE_JOBS must be a positive integer' "$WORK/invalid.log" >/dev/null
done
echo '[test_mac_full_verify_runtime] PASS: invalid worker bounds fail before execution'

unset PICKLE_NATIVE_JOBS
for existing in present absent; do
  for build_failure in 0 1; do
    rm -f "$WORK/repo/apps/mobile/ios/.xcode.env.local"
    if [ "$existing" = present ]; then
      echo 'export NODE_BINARY=/preserve/local/configuration' >"$WORK/original-node-env"
      cp "$WORK/original-node-env" "$WORK/repo/apps/mobile/ios/.xcode.env.local"
    fi
    export FAIL_APP_BUILD="$build_failure"
    # A successful fake compiler intentionally produces no app bundle. This
    # exercises normal restoration before the subsequent missing-bundle error.
    if "$BASH" "$WORK/repo/scripts/mac-full-verify.sh" --only ios-app --skip-js --skip-launch >"$WORK/app.log" 2>&1; then
      echo '[test_mac_full_verify_runtime] missing fake app unexpectedly passed' >&2; exit 1
    fi
    if [ "$existing" = present ]; then
      cmp "$WORK/original-node-env" "$WORK/repo/apps/mobile/ios/.xcode.env.local"
    else
      test ! -e "$WORK/repo/apps/mobile/ios/.xcode.env.local"
    fi
    if [ "$build_failure" = 0 ]; then
      grep -F 'no app bundle at' "$WORK/app.log" >/dev/null
    else
      grep -F 'exit 73' "$WORK/app.log" >/dev/null
    fi
  done
done
echo '[test_mac_full_verify_runtime] PASS: local Xcode node config restored after successful and failed compiler commands'

export VERIFY_MOBILE_NODE_BIN="$WORK/mobile-node" FAIL_APP_BUILD=1
: >"$NATIVE_TRACE"
if "$BASH" "$WORK/repo/scripts/mac-full-verify.sh" --only ios-app >"$WORK/mobile-runtime.log" 2>&1; then
  echo '[test_mac_full_verify_runtime] fake failed compiler unexpectedly passed' >&2; exit 1
fi
for expected in \
  'npm|v22.22.0|ci --no-audit --no-fund' \
  'npx|v22.22.0|tsc --noEmit' \
  'npx|v22.22.0|jest --ci --silent --maxWorkers=2' \
  "xcode-node|$WORK/mobile-node/node|v22.22.0"; do
  grep -F "$expected" "$NATIVE_TRACE" >/dev/null
done
grep -F "mobile runtime: v22.22.0 at $WORK/mobile-node/node" "$WORK/mobile-runtime.log" >/dev/null
test "$(node --version)" = v20.20.0
python3 - "$NATIVE_TRACE" <<'PY_SIGN'
import sys
commands = [line for line in open(sys.argv[1]) if line.startswith('xcodebuild|') and '|build ' in line]
assert len(commands) == 1, commands
command = commands[0]
assert "-destination generic/platform=iOS Simulator" in command, command
assert "CODE_SIGNING_ALLOWED=YES" in command and "CODE_SIGN_IDENTITY=-" in command, command
assert "CODE_SIGNING_REQUIRED=NO" in command, command
assert "-allowProvisioning" not in command and " archive " not in command, command
PY_SIGN
echo '[test_mac_full_verify_runtime] PASS: selected mobile Node reaches npm/tsc/Jest/Xcode; caller Node20 preserved'

export VERIFY_MOBILE_NODE_BIN="$WORK/missing-node"
: >"$NATIVE_TRACE"
if "$BASH" "$WORK/repo/scripts/mac-full-verify.sh" --only ios-app >"$WORK/missing-runtime.log" 2>&1; then
  echo '[test_mac_full_verify_runtime] missing selected Node unexpectedly passed' >&2; exit 1
fi
grep -F 'VERIFY_MOBILE_NODE_BIN must contain an executable node' "$WORK/missing-runtime.log" >/dev/null
if grep -E '^(npm|npx)\|' "$NATIVE_TRACE" >/dev/null; then
  echo '[test_mac_full_verify_runtime] invalid runtime reached dependency commands' >&2; exit 1
fi
echo '[test_mac_full_verify_runtime] PASS: invalid mobile runtime fails before dependency installation'
