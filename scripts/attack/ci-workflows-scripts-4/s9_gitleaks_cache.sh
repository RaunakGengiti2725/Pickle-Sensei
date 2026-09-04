#!/usr/bin/env bash
# S9 — corrupt cached gitleaks must be replaced by a checksum-verified
# re-download, never surface as "gitleaks failed with exit N":
#   1. truncated binary (0 bytes)              → re-download, sha256 == pinned, scan runs
#   2. truncated to half its size (ELF header ok, body missing)
#   3. mode 000 (unreadable / not executable)
#   4. same corruption with SECURITY_SCAN_OFFLINE=1 → exit 2, no download
#   5. cached binary is a wrapper that lies about its version → recorded (cache trust boundary)
# Uses a private SECURITY_SCAN_CACHE so the real ~/.cache is untouched; the
# well-known path from the scenario text is the default when ATTACK_GITLEAKS_CACHE_LIVE=1.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

OUT="$ATTACK_EVIDENCE/s9"
rm -rf "$OUT" && mkdir -p "$OUT"
PINNED_TARBALL_SHA="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb" # linux_x64, from scripts/security-scan.sh
if [ "${ATTACK_GITLEAKS_CACHE_LIVE:-0}" = 1 ]; then
  CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/pickle-sensei"
else
  CACHE="$OUT/cache"
fi
BIN="$CACHE/gitleaks-8.30.1/gitleaks"
export SECURITY_SCAN_CACHE="$CACHE"
unset GITLEAKS_BIN
cd "$REPO_ROOT" || exit 2
[ "$(uname -s)/$(uname -m)" = "Linux/x86_64" ] || { log "pinned sha check is linux_x64 only; skipping"; exit 0; }

scan() { local label="$1" rc=0; shift; env "$@" scripts/security-scan.sh --tree >"$OUT/$label.log" 2>&1 || rc=$?; echo "$rc"; }
good_sha() { sha256sum "$BIN" | awk '{print $1}'; }

# Prime the cache (this is itself a checksum-verified download).
rc="$(scan prime)"
assert_eq "prime: fresh cache downloads and scans (exit 0)" 0 "$rc"
assert_grep "prime: download announced" "downloading gitleaks v8.30.1 \(linux_x64\)" "$OUT/prime.log"
GOOD_SHA="$(good_sha)"; GOOD_SIZE="$(stat -c %s "$BIN")"
log "good binary sha256=$GOOD_SHA size=$GOOD_SIZE"
# Independently verify the pinned tarball checksum the script relies on.
T="$(mktemp -d)"; curl -fsSL --retry 3 --max-time 120 -o "$T/g.tgz" \
  https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz
assert_eq "pinned linux_x64 tarball sha256 matches the upstream release asset" "$PINNED_TARBALL_SHA" "$(sha256sum "$T/g.tgz" | awk '{print $1}')"
rm -rf "$T"

corrupt_and_scan() { # $1 label, $2 corruption command
  local label="$1"
  eval "$2"
  cp -p "$BIN" "$OUT/$label.corrupt.bin" 2>/dev/null || true
  local rc; rc="$(scan "$label")"
  assert_eq "$label: scan exits 0 after self-heal" 0 "$rc"
  assert_grep "$label: re-download announced" "downloading gitleaks v8.30.1" "$OUT/$label.log"
  assert_not_grep "$label: no 'gitleaks failed with exit'" "gitleaks failed with exit" "$OUT/$label.log"
  assert_eq "$label: restored binary is byte-identical to the good one" "$GOOD_SHA" "$(good_sha)"
}
corrupt_and_scan truncate-zero ": >'$BIN'"
corrupt_and_scan truncate-half "truncate -s $((GOOD_SIZE / 2)) '$BIN'"
corrupt_and_scan mode-000 "chmod 000 '$BIN'"
corrupt_and_scan garbage "head -c 4096 /dev/urandom >'$BIN'"

# Offline: corrupt cache must be a loud setup failure, not a download.
: >"$BIN"
rc="$(scan offline-truncated SECURITY_SCAN_OFFLINE=1 PATH=/usr/bin:/bin)"
assert_eq "offline + truncated cache → exit 2" 2 "$rc"
assert_grep "offline + truncated cache → names SECURITY_SCAN_OFFLINE" "SECURITY_SCAN_OFFLINE=1" "$OUT/offline-truncated.log"
assert_not_grep "offline: no download attempted" "downloading gitleaks" "$OUT/offline-truncated.log"
rc="$(scan heal-after-offline)"; assert_eq "cache heals again once online" 0 "$rc"

# Cache trust boundary: a wrapper that reports the pinned version is accepted
# without a hash check. Recorded as information (cache dir is user-owned).
cat >"$BIN" <<'SH'
#!/usr/bin/env bash
[ "${1:-}" = version ] && { echo 8.30.1; exit 0; }
echo "IMPOSTOR: would have scanned $*" >&2
exit 0
SH
chmod 755 "$BIN"
rc="$(scan impostor)"
log "impostor cached binary → rc=$rc; $(grep -m1 IMPOSTOR "$OUT/impostor.log" || echo 'impostor not executed')"
if grep -q IMPOSTOR "$OUT/impostor.log" && [ "$rc" = 0 ]; then
  verdict INFO "cached binary is trusted on version string alone (no sha256 of the cached file)" "rc=0 PASS via impostor; cache is user-owned so not a CI-facing break"
fi
rm -f "$BIN"; scan restore >/dev/null

finish
