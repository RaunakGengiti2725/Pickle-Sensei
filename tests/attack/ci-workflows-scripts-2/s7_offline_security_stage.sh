#!/usr/bin/env bash
# Scenario 7 — `SECURITY_SCAN_OFFLINE=1 XDG_CACHE_HOME=<empty> scripts/verify-cloud.sh --only security`
#
# Expected: the security stage is `failed` with note `exit 2`, summary.json has
# ok:false, verify-cloud exits 1, and security.log ends with the setup error.
#
# "<empty>" is ambiguous, so both readings are exercised:
#   emptydir   XDG_CACHE_HOME=<fresh empty directory>  → no cached binary, no
#              download allowed → exit 2 (the scenario's expectation)
#   emptystr   XDG_CACHE_HOME=""  → bash `${XDG_CACHE_HOME:-$HOME/.cache}`
#              falls back to ~/.cache; if the pinned binary is cached there the
#              scan RUNS (documented here so nobody mistakes it for offline).
#   standalone SECURITY_SCAN_OFFLINE=1 scripts/security-scan.sh --tree with the
#              empty dir → exit 2 directly (the inner contract)
#   readonly   cache dir exists but is read-only (permission denial) with
#              downloads allowed → must still be exit 2, not a traceback/exit 1
#   corrupt    cache holds a non-gitleaks file at the pinned path, offline →
#              exit 2 ("not found"), never executed as the scanner
# shellcheck source=tests/attack/ci-workflows-scripts-2/lib.sh
source "$(dirname "$0")/lib.sh"
cd "$ATTACK_REPO_ROOT" || exit 2

overall=0
EMPTY="$ATTACK_OUT/s7-empty-xdg"; mkdir -p "$EMPTY"

summarise() {
  # $1 = artifacts dir → prints "ok status note"
  python3 - "$1/summary.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
st = next((s for s in d["stages"] if s["name"] == "security"), {})
print(d.get("ok"), st.get("status", "?"), st.get("note", "?"))
PY
}

# --- emptydir (the scenario) -------------------------------------------------
art="$ATTACK_OUT/s7-emptydir-verify"; log="$ATTACK_OUT/s7-emptydir.log"; rc=0
SECURITY_SCAN_OFFLINE=1 XDG_CACHE_HOME="$EMPTY" VERIFY_ARTIFACTS="$art" PATH="$(echo "$PATH" | tr ':' '\n' | grep -v gitleaks | paste -sd:)" \
  scripts/verify-cloud.sh --only security >"$log" 2>&1 || rc=$?
echo "exit=$rc" >>"$log"
ok=1
assert_eq "emptydir: verify-cloud exit" "$rc" 1 || ok=0
read -r sok sstatus snote < <(summarise "$art")
assert_eq "emptydir: summary.ok" "$sok" False || ok=0
assert_eq "emptydir: stage status" "$sstatus" failed || ok=0
assert_eq "emptydir: stage note" "$snote" "exit 2" || ok=0
assert_grep "emptydir: security.log names the cause" 'ERROR: gitleaks v8\.30\.1 not found and SECURITY_SCAN_OFFLINE=1' "$art/security.log" || ok=0
assert_grep "emptydir: console shows FAIL (exit 2)" '\[security\] FAIL \(exit 2\)' "$log" || ok=0
if [ -z "$(find "$EMPTY" -mindepth 1 2>/dev/null)" ]; then
  alog "  ok   emptydir: nothing downloaded into XDG_CACHE_HOME"
else
  alog "  FAIL emptydir: cache dir was written to while offline"; ok=0
fi
if [ $ok = 1 ]; then
  record_verdict s7-emptydir HELD "verify-cloud exit 1; summary ok:false; security failed 'exit 2'; log names the offline cause; cache untouched" \
    "stage failed exit 2, ok:false" "$log" "$art/summary.json" "$art/security.log"
else
  record_verdict s7-emptydir BROKEN "exit=$rc ok=$sok status=$sstatus note=$snote" "stage failed exit 2, ok:false" "$log" "$art/summary.json"; overall=1
fi

# --- emptystr (literal empty string) ----------------------------------------
art="$ATTACK_OUT/s7-emptystr-verify"; log="$ATTACK_OUT/s7-emptystr.log"; rc=0
SECURITY_SCAN_OFFLINE=1 XDG_CACHE_HOME="" VERIFY_ARTIFACTS="$art" scripts/verify-cloud.sh --only security >"$log" 2>&1 || rc=$?
echo "exit=$rc" >>"$log"
read -r sok sstatus snote < <(summarise "$art")
cached="$HOME/.cache/pickle-sensei/gitleaks-8.30.1/gitleaks"
if [ -x "$cached" ]; then
  # A cached pinned binary exists → the scan is expected to run (offline is satisfied).
  # The stage may still fail on HISTORY findings from other refs (see
  # s8_history_scan_ref_dependence.sh); here we only judge whether the scan ran.
  if grep -q "gitleaks 8.30.1 at $cached" "$art/security.log" && grep -q 'scanning tree' "$art/security.log"; then
    record_verdict s7-emptystr INFO "XDG_CACHE_HOME=\"\" is NOT 'no cache': falls back to ~/.cache and RAN the cached pinned binary (stage=$sstatus note=$snote)" \
      "documented: only an empty DIRECTORY reproduces the offline failure" "$log" "$art/summary.json" "$art/security.log"
  else
    record_verdict s7-emptystr BROKEN "cached pinned binary present at ~/.cache but the scan did not run: stage=$sstatus note=$snote" "scan runs from the cache" "$log" "$art/summary.json"; overall=1
  fi
else
  if [ "$sstatus" = failed ] && [ "$snote" = "exit 2" ]; then
    record_verdict s7-emptystr HELD "no ~/.cache binary → exit 2 as with the empty dir" "stage failed exit 2" "$log" "$art/summary.json"
  else
    record_verdict s7-emptystr BROKEN "status=$sstatus note=$snote" "stage failed exit 2" "$log" "$art/summary.json"; overall=1
  fi
fi

# --- standalone inner contract -----------------------------------------------
log="$ATTACK_OUT/s7-standalone.log"; rc=0
SECURITY_SCAN_OFFLINE=1 XDG_CACHE_HOME="$EMPTY" PATH="$(echo "$PATH" | tr ':' '\n' | grep -v gitleaks | paste -sd:)" \
  scripts/security-scan.sh --tree >"$log" 2>&1 || rc=$?
echo "exit=$rc" >>"$log"
if assert_eq "standalone: exit" "$rc" 2 && assert_grep "standalone: message" 'SECURITY_SCAN_OFFLINE=1' "$log"; then
  record_verdict s7-standalone HELD "security-scan.sh exit 2 offline with empty cache" "exit 2" "$log"
else
  record_verdict s7-standalone BROKEN "exit $rc" "exit 2" "$log"; overall=1
fi

# --- read-only cache dir, downloads allowed (permission denial) ---------------
RO="$ATTACK_OUT/s7-ro-xdg"; mkdir -p "$RO/pickle-sensei"; chmod 0555 "$RO/pickle-sensei" "$RO"
register_cleanup "$RO"
log="$ATTACK_OUT/s7-readonly.log"; rc=0
XDG_CACHE_HOME="$RO" timeout 300 scripts/security-scan.sh --tree >"$log" 2>&1 || rc=$?
echo "exit=$rc" >>"$log"
chmod -R u+w "$RO" 2>/dev/null || true
if [ "$rc" = 2 ]; then
  record_verdict s7-readonly HELD "read-only cache → exit 2 (setup failure), last line: $(tail -n 2 "$log" | head -n 1 | cut -c1-160)" "exit 2, no scan run" "$log"
elif [ "$rc" = 0 ]; then
  record_verdict s7-readonly BROKEN "read-only cache dir yet exit 0 — scan ran from elsewhere or wrote past the permission" "exit 2" "$log"; overall=1
else
  record_verdict s7-readonly BROKEN "read-only cache → exit $rc (not the documented setup code 2); last: $(tail -n 2 "$log" | head -n 1 | cut -c1-160)" "exit 2" "$log"; overall=1
fi

# --- corrupt cached binary, offline -------------------------------------------
CORRUPT="$ATTACK_OUT/s7-corrupt-xdg"; mkdir -p "$CORRUPT/pickle-sensei/gitleaks-8.30.1"
printf '#!/bin/sh\necho CORRUPT-BINARY-EXECUTED >&2; exit 0\n' >"$CORRUPT/pickle-sensei/gitleaks-8.30.1/gitleaks"
chmod +x "$CORRUPT/pickle-sensei/gitleaks-8.30.1/gitleaks"
log="$ATTACK_OUT/s7-corrupt.log"; rc=0
SECURITY_SCAN_OFFLINE=1 XDG_CACHE_HOME="$CORRUPT" PATH="$(echo "$PATH" | tr ':' '\n' | grep -v gitleaks | paste -sd:)" \
  scripts/security-scan.sh --tree >"$log" 2>&1 || rc=$?
echo "exit=$rc" >>"$log"
if [ "$rc" = 2 ] && ! grep -q 'PASS' "$log"; then
  record_verdict s7-corrupt HELD "cached file at the pinned path that does not report 8.30.1 is rejected → exit 2 (executed once for 'version' only)" "exit 2, never used as scanner" "$log"
else
  record_verdict s7-corrupt BROKEN "exit $rc; PASS present: $(grep -c PASS "$log")" "exit 2" "$log"; overall=1
fi

exit $overall
