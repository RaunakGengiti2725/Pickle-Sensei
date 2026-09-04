#!/usr/bin/env bash
# S1 — tamper with the cached gitleaks binary that scripts/security-scan.sh trusts.
#
# Attack: scripts/security-scan.sh pins a SHA-256 for the *download tarball* but,
# on every later run, only asks the cached executable `gitleaks version` and
# trusts it when the string matches (reports_version). Anything that answers
# "8.30.1" is therefore used as the secret-scanning gate.
#
# Checks (each is HELD only if the tampered binary is NOT used as the gate):
#   s1.a  control     — pristine cache + planted secret          → scan must exit 1
#   s1.b  append-byte — `printf '\0' >> gitleaks`, rerun          → expect checksum failure/redownload
#   s1.c  impostor    — replace cache with a script that prints 8.30.1 and exits 0
#   s1.d  path-hijack — empty cache + impostor `gitleaks` on PATH (offline mode)
#
# Usage: tools/attack-security-secrets-deps/s1_gitleaks_cache_tamper.sh
# Env:   SECURITY_SCAN_CACHE (defaults to the real cache, exactly as the gate uses it)
#        ATTACK_SEED (default 20260904) — drives the planted fake credential
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

GITLEAKS_VERSION="$(sed -n 's/^GITLEAKS_VERSION="\(.*\)"$/\1/p' "$REPO_ROOT/scripts/security-scan.sh")"
[ -n "$GITLEAKS_VERSION" ] || { log "could not read GITLEAKS_VERSION from scripts/security-scan.sh"; exit 2; }
CACHE_DIR="${SECURITY_SCAN_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/pickle-sensei}"
CACHED="$CACHE_DIR/gitleaks-${GITLEAKS_VERSION}/gitleaks"
SEED="${ATTACK_SEED:-20260904}"
echo "$SEED" >"$OUT/seed.txt"

# A synthetic AWS access key id (default gitleaks rule aws-access-token). Never a
# real credential: generated from the recorded seed.
PLANT_FILE="$REPO_ROOT/.attack-s1-planted-$(seeded_token "$SEED" abcdefghijklmnopqrstuvwxyz 8).txt"
PLANT_VALUE="AKIA$(seeded_token "$((SEED + 1))" ABCDEFGHIJKLMNOPQRSTUVWXYZ234567 16)"
BACKUP="$(mktemp -d)"
IMPOSTOR_PATH_DIR="$(mktemp -d)"
ISOLATED_CACHE="$(mktemp -d)"

cleanup() {
  rm -f "$PLANT_FILE"
  if [ -f "$BACKUP/gitleaks" ]; then
    mkdir -p "$(dirname "$CACHED")"
    cp -p "$BACKUP/gitleaks" "$CACHED"
    chmod 0755 "$CACHED"
  fi
  rm -rf "$BACKUP" "$IMPOSTOR_PATH_DIR" "$ISOLATED_CACHE"
}
trap cleanup EXIT

plant() {
  printf 'aws_access_key_id = %s\n' "$PLANT_VALUE" >"$PLANT_FILE"
}

scan() { # <logfile> [env assignments...] — runs the tree scan from the repo root
  local logfile="$1"
  shift
  (cd "$REPO_ROOT" && env "$@" scripts/security-scan.sh --tree >"$logfile" 2>&1) && rc=0 || rc=$?
  printf 'exit=%s\n' "$rc" >>"$logfile"
  printf '%s' "$rc"
}

make_impostor() { # <path> — an executable that claims to be the pinned version and finds nothing
  cat >"$1" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = version ]; then echo "$GITLEAKS_VERSION"; exit 0; fi
echo "impostor gitleaks: pretending the tree is clean" >&2
exit 0
EOF
  chmod 0755 "$1"
}

# ── s1.a control: make sure the pristine gate exists and catches the plant ──────
rc="$(scan "$OUT/s1a-pristine-clean.log")" # populates the cache on first use
[ -x "$CACHED" ] || { log "no cached binary at $CACHED after a scan (exit=$rc); cannot continue"; exit 2; }
cp -p "$CACHED" "$BACKUP/gitleaks"
PRISTINE_SHA="$(sha256sum "$CACHED" | awk '{print $1}')"
echo "$PRISTINE_SHA" >"$OUT/pristine.sha256"
plant
rc="$(scan "$OUT/s1a-pristine-planted.log")"
rm -f "$PLANT_FILE"
if [ "$rc" = 1 ]; then
  record HELD s1.a-control "$rc" "$OUT/s1a-pristine-planted.log" "pristine binary catches the planted key"
else
  log "control failed: pristine gitleaks did not flag the planted key (exit=$rc); aborting"
  exit 2
fi

# ── s1.b append one byte to the cached binary ──────────────────────────────────
printf '\0' >>"$CACHED"
TAMPERED_SHA="$(sha256sum "$CACHED" | awk '{print $1}')"
echo "$TAMPERED_SHA" >"$OUT/s1b-tampered.sha256"
plant
rc="$(scan "$OUT/s1b-append-byte-planted.log")"
rm -f "$PLANT_FILE"
AFTER_SHA="$(sha256sum "$CACHED" | awk '{print $1}')"
echo "$AFTER_SHA" >"$OUT/s1b-after-run.sha256"
if [ "$AFTER_SHA" = "$PRISTINE_SHA" ]; then
  record HELD s1.b-append-byte "$rc" "$OUT/s1b-append-byte-planted.log" "tampered cache was replaced (sha restored to pristine)"
else
  record BROKEN s1.b-append-byte "$rc" "$OUT/s1b-append-byte-planted.log" "tampered binary (sha $TAMPERED_SHA) accepted; no checksum check, no redownload (scan exit=$rc)"
fi
cp -p "$BACKUP/gitleaks" "$CACHED"

# ── s1.c replace the cached binary with an impostor that answers the version ───
make_impostor "$CACHED"
plant
rc="$(scan "$OUT/s1c-impostor-planted.log")"
rm -f "$PLANT_FILE"
if [ "$rc" = 1 ] && grep -q 'FINDINGS' "$OUT/s1c-impostor-planted.log"; then
  record HELD s1.c-impostor "$rc" "$OUT/s1c-impostor-planted.log" "impostor rejected, real scanner found the plant"
elif [ "$rc" = 0 ]; then
  record BROKEN s1.c-impostor "$rc" "$OUT/s1c-impostor-planted.log" "impostor at $CACHED reported PASS with a planted key in the tree"
else
  record BROKEN s1.c-impostor "$rc" "$OUT/s1c-impostor-planted.log" "unexpected exit; see log"
fi
cp -p "$BACKUP/gitleaks" "$CACHED"

# ── s1.d empty cache + impostor `gitleaks` on PATH, offline (no download) ──────
make_impostor "$IMPOSTOR_PATH_DIR/gitleaks"
plant
rc="$(scan "$OUT/s1d-path-hijack-planted.log" "SECURITY_SCAN_CACHE=$ISOLATED_CACHE" "SECURITY_SCAN_OFFLINE=1" "PATH=$IMPOSTOR_PATH_DIR:$PATH")"
rm -f "$PLANT_FILE"
if [ "$rc" = 0 ]; then
  record BROKEN s1.d-path-hijack "$rc" "$OUT/s1d-path-hijack-planted.log" "PATH gitleaks answering the version string was trusted; PASS with planted key"
else
  record HELD s1.d-path-hijack "$rc" "$OUT/s1d-path-hijack-planted.log" "PATH impostor not used as the gate"
fi

verdict
