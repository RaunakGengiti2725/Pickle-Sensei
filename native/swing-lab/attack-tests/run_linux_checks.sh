#!/usr/bin/env bash
# Linux plane of the swing-lab adversarial pass: everything that does NOT need
# AVFoundation/Vision. Exit code is the truth — nothing is skipped silently.
#
#   1. byte-compile + unit-test the harness (test_check_extract.py: the checker
#      catches every scenario's failure mode; fixtures self-verify)
#   2. generate the adversarial fixtures with ffmpeg
#   3. run check_extract.py against the same-SHA Mac artifact (Apple truth from
#      `gh run download <run> -n mac-full-verify-3`) and write the report
#
#   native/swing-lab/attack-tests/run_linux_checks.sh --out <dir> [--mac-extract <dir>] [--run-id 33841813597]
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
OUT="" MAC="" RUN_ID="33841813597"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --mac-extract) MAC="$2"; shift 2 ;;
    --run-id) RUN_ID="$2"; shift 2 ;;
    *) echo "unknown arg $1"; exit 2 ;;
  esac
done
[ -n "$OUT" ] || { echo "usage: $0 --out <dir> [--mac-extract <swing-lab-extract dir>] [--run-id <gh run id>]"; exit 2; }
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
STATUS=0
step() { echo; echo "== $*"; }

step "1a. byte-compile"
python3 -m py_compile "$HERE/check_extract.py" "$HERE/test_check_extract.py" "$HERE/fixtures/mp4_edit.py" || STATUS=1
bash -n "$HERE/run_mac_attacks.sh" "$HERE/fixtures/make_fixtures.sh" "$HERE/run_linux_checks.sh" || STATUS=1
if command -v shellcheck >/dev/null; then
  shellcheck -S warning "$HERE/run_mac_attacks.sh" "$HERE/fixtures/make_fixtures.sh" "$HERE/run_linux_checks.sh" || STATUS=1
else
  echo "shellcheck not installed (bash -n only)"
fi

if [ -z "$MAC" ]; then
  for candidate in "$HOME/mac-artifacts/run-$RUN_ID/mac-full-verify-3/swing-lab-extract" "$OUT/mac-full-verify-3/swing-lab-extract"; do
    [ -d "$candidate" ] && MAC="$candidate" && break
  done
fi
if [ -z "$MAC" ] && command -v gh >/dev/null; then
  step "download Mac artifact for run $RUN_ID"
  (cd "$OUT" && gh run download "$RUN_ID" -n mac-full-verify-3 -D "$OUT/mac-full-verify-3" -R RaunakGengiti2725/Pickle-Sensei) && MAC="$OUT/mac-full-verify-3/swing-lab-extract"
fi

step "1b. harness unit tests"
if [ -n "$MAC" ] && [ -d "$MAC" ]; then export SWING_LAB_MAC_EXTRACT_DIR="$MAC"; fi
(cd "$REPO" && python3 -m unittest native/swing-lab/attack-tests/test_check_extract.py -v) 2>&1 | tee "$OUT/test_check_extract.log"
[ "${PIPESTATUS[0]}" -eq 0 ] || STATUS=1

step "2. fixtures"
bash "$HERE/fixtures/make_fixtures.sh" "$OUT/fixtures" > "$OUT/make_fixtures.log" 2>&1
FX=$?
tail -3 "$OUT/make_fixtures.log"
[ $FX -eq 0 ] || { echo "fixture generation FAILED (see $OUT/make_fixtures.log)"; STATUS=1; }

step "3. checker vs same-SHA Mac artifact"
if [ -n "$MAC" ] && [ -d "$MAC" ]; then
  python3 "$HERE/check_extract.py" "$MAC" \
    --expect-video-path datasets/pickleball/fresh-candidates/va-O1dLhGGPErc.mp4 \
    --min-pose-frames 1 \
    --report "$OUT/baseline-$RUN_ID-check.json" | tee "$OUT/baseline-$RUN_ID-check.log"
  BASE=${PIPESTATUS[0]}
  echo "checker exit=$BASE (a non-zero exit here is a reproduced FINDING on the Apple artifact, not a harness error)"
  echo "$BASE" > "$OUT/baseline-$RUN_ID-check.exit"
else
  echo "Mac artifact for run $RUN_ID unavailable — Apple-plane evidence NOT reproduced (this is a failure, not a pass)"
  STATUS=1
fi

echo
echo "run_linux_checks.sh exit=$STATUS (harness health); baseline checker exit recorded separately in $OUT/baseline-$RUN_ID-check.exit"
exit $STATUS
