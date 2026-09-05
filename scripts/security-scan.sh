#!/usr/bin/env bash
# Secret-scanning gate for Pickle Sensei (gitleaks, pinned, non-interactive).
#
#   scripts/security-scan.sh                 # working tree + full git history of HEAD
#   scripts/security-scan.sh --tree          # working tree only (tracked, untracked, unignored)
#   scripts/security-scan.sh --history       # git history only
#   scripts/security-scan.sh --history --log-opts "origin/main..HEAD"   # only this branch's commits
#   scripts/security-scan.sh --history --log-opts "--full-history --all"  # every fetched ref
#   scripts/security-scan.sh --report-dir out/   # also write JSON reports (redacted)
#
# Policy lives in .gitleaks.toml (default rules + repo-specific allowlists, each
# with a justification). Findings are ALWAYS redacted in output and reports.
#
# Only the pinned gitleaks release may run: whichever binary is selected
# (GITLEAKS_BIN, the cache, PATH, or a fresh download) must match one of the
# pinned per-platform sha256 digests of the official v${GITLEAKS_VERSION}
# executables BEFORE it is executed, and must then report exactly that version.
# Anything else is a setup failure (exit 2) — never a warning.
#
# Exit codes: 0 = no findings, 1 = findings (or gitleaks error), 2 = setup failure.
#
# Environment:
#   GITLEAKS_BIN            use this binary instead of the pinned download
#                           (still digest- and version-verified)
#   SECURITY_SCAN_CACHE     where the pinned binary is cached
#                           (default: ${XDG_CACHE_HOME:-~/.cache}/pickle-sensei)
#   SECURITY_SCAN_OFFLINE=1 never download; fail with exit 2 if no usable binary
set -euo pipefail

GITLEAKS_VERSION="8.30.1"
# sha256 of the official release tarballs for v${GITLEAKS_VERSION}
# (https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1, gitleaks_8.30.1_checksums.txt).
declare -A GITLEAKS_SHA256=(
  [linux_x64]="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
  [linux_arm64]="e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080"
  [darwin_x64]="dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709"
  [darwin_arm64]="b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5"
)
# sha256 of the `gitleaks` executable extracted from each of those tarballs.
# Every binary this script is about to run — GITLEAKS_BIN, the cache, PATH or a
# fresh download — must hash to one of these; the tarball digest alone only
# covers what this script downloaded itself.
declare -A GITLEAKS_BIN_SHA256=(
  [linux_x64]="88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509"
  [linux_arm64]="00e91bbe655bd7c47753e8cfe61cb76ea1a5d7e7702fe161ee40102b46b3823b"
  [darwin_x64]="cee01fea7173f1b779dff188e1c26ecbcb4027d394acc573b23aaf0be260e291"
  [darwin_arm64]="ba52fb1bfabbcde42f032afad3d6e0b19dff8ed105229a16e7caa338bbc0e84f"
)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$REPO_ROOT/.gitleaks.toml"
CACHE_DIR="${SECURITY_SCAN_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/pickle-sensei}"

DOWNLOAD_TMP=""
STAGE_DIR=""
cleanup() {
  [ -z "$DOWNLOAD_TMP" ] || rm -rf "$DOWNLOAD_TMP"
  [ -z "$STAGE_DIR" ] || rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

log() { printf '[security-scan] %s\n' "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 2
}

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

SCAN_TREE=1
SCAN_HISTORY=1
# gitleaks' own default is `--full-history --all`: the verdict would then depend
# on whichever unrelated refs this clone has fetched (CI checks out with
# fetch-depth 0), not on the commit under test. Scan HEAD's full ancestry.
LOG_OPTS="--full-history HEAD"
REPORT_DIR=""
VERBOSE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tree) SCAN_HISTORY=0 ;;
    --history) SCAN_TREE=0 ;;
    --log-opts)
      [ $# -ge 2 ] || die "--log-opts needs a value"
      LOG_OPTS="$2"
      shift
      ;;
    --report-dir)
      [ $# -ge 2 ] || die "--report-dir needs a value"
      REPORT_DIR="$2"
      shift
      ;;
    --verbose | -v) VERBOSE=1 ;;
    --help | -h) usage 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
[ "$SCAN_TREE" = 1 ] || [ "$SCAN_HISTORY" = 1 ] || die "--tree and --history are mutually exclusive"

[ -f "$CONFIG" ] || die "missing $CONFIG"
cd "$REPO_ROOT"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$REPO_ROOT is not a git work tree"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "need sha256sum or shasum to verify the gitleaks binary"
  fi
}

platform_key() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os" in
    linux | darwin) ;;
    *) return 1 ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch="x64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *) return 1 ;;
  esac
  printf '%s_%s' "$os" "$arch"
}

reports_version() {
  # gitleaks prints just the semver on stdout.
  [ -x "$1" ] && [ "$("$1" version 2>/dev/null | tr -d '[:space:]')" = "$GITLEAKS_VERSION" ]
}

# Digest of $1 matches the pinned executable for the current platform, or —
# when the platform is not one we pin (or the file is a foreign-arch binary run
# under emulation) — any of the pinned executables. Never executes $1.
binary_is_pinned() {
  local file="$1" actual expected
  [ -f "$file" ] && [ -x "$file" ] || return 1
  actual="$(sha256_file "$file")"
  for expected in "${GITLEAKS_BIN_SHA256[@]}"; do
    [ "$actual" = "$expected" ] && return 0
  done
  return 1
}

# Refuse to run anything but the pinned release: the digest check runs first so
# an untrusted file is never executed, then the version string must match too.
verify_gitleaks() {
  local file="$1" source="$2" key expected
  [ -e "$file" ] || die "$source: $file does not exist"
  [ -f "$file" ] && [ -x "$file" ] || die "$source: $file is not an executable file"
  if ! binary_is_pinned "$file"; then
    key="$(platform_key || true)"
    expected="${GITLEAKS_BIN_SHA256[${key:-none}]:-<no pin for $(uname -s)/$(uname -m)>}"
    die "$source: $file is not the pinned gitleaks v${GITLEAKS_VERSION} executable (sha256 $(sha256_file "$file"); expected $expected). Remove or replace it — the gate only runs the pinned scanner."
  fi
  reports_version "$file" || die "$source: $file does not report v${GITLEAKS_VERSION}"
}

download_gitleaks() {
  local key="$1" dest="$2" tmp tarball url expected actual
  expected="${GITLEAKS_SHA256[$key]:-}"
  [ -n "$expected" ] || die "no pinned checksum for platform $key"
  command -v curl >/dev/null 2>&1 || die "curl is required to download gitleaks"
  tmp="$(mktemp -d)"
  DOWNLOAD_TMP="$tmp"
  tarball="gitleaks_${GITLEAKS_VERSION}_${key}.tar.gz"
  url="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${tarball}"
  log "downloading gitleaks v${GITLEAKS_VERSION} (${key})"
  curl -fsSL --retry 3 --max-time 120 -o "$tmp/$tarball" "$url" || die "download failed: $url"
  actual="$(sha256_file "$tmp/$tarball")"
  [ "$actual" = "$expected" ] || die "checksum mismatch for $tarball (expected $expected, got $actual)"
  tar -xzf "$tmp/$tarball" -C "$tmp" gitleaks
  chmod 0755 "$tmp/gitleaks"
  expected="${GITLEAKS_BIN_SHA256[$key]}"
  actual="$(sha256_file "$tmp/gitleaks")"
  [ "$actual" = "$expected" ] || die "checksum mismatch for the gitleaks executable in $tarball (expected $expected, got $actual)"
  mkdir -p "$(dirname "$dest")"
  mv "$tmp/gitleaks" "$dest"
  rm -rf "$tmp"
  DOWNLOAD_TMP=""
}

# Pick the scanner to run. Every candidate is digest+version verified by
# verify_gitleaks before it is returned; a candidate that exists but fails
# verification is a setup failure, not something to silently skip past.
resolve_gitleaks() {
  local key cached on_path
  if [ -n "${GITLEAKS_BIN:-}" ]; then
    verify_gitleaks "$GITLEAKS_BIN" "GITLEAKS_BIN"
    printf '%s' "$GITLEAKS_BIN"
    return
  fi
  key="$(platform_key || true)"
  cached="$CACHE_DIR/gitleaks-${GITLEAKS_VERSION}/gitleaks"
  if [ -e "$cached" ]; then
    verify_gitleaks "$cached" "SECURITY_SCAN_CACHE"
    printf '%s' "$cached"
    return
  fi
  on_path="$(command -v gitleaks 2>/dev/null || true)"
  if [ -n "$on_path" ]; then
    verify_gitleaks "$on_path" "PATH"
    printf '%s' "$on_path"
    return
  fi
  [ -n "$key" ] || die "unsupported platform $(uname -s)/$(uname -m); set GITLEAKS_BIN to a gitleaks v${GITLEAKS_VERSION} binary"
  [ "${SECURITY_SCAN_OFFLINE:-0}" = 1 ] && die "gitleaks v${GITLEAKS_VERSION} not found and SECURITY_SCAN_OFFLINE=1"
  download_gitleaks "$key" "$cached"
  verify_gitleaks "$cached" "download"
  printf '%s' "$cached"
}

GITLEAKS="$(resolve_gitleaks)"
log "gitleaks $("$GITLEAKS" version) (sha256 verified) at $GITLEAKS"

if [ -n "$REPORT_DIR" ]; then
  mkdir -p "$REPORT_DIR"
  REPORT_DIR="$(cd "$REPORT_DIR" && pwd)"
fi

COMMON_ARGS=(--no-banner --exit-code 1 --redact=100 --config "$CONFIG")
[ "$VERBOSE" = 1 ] && COMMON_ARGS+=(--verbose)

run_scan() {
  # $1 = label, $2 = gitleaks subcommand, remaining = extra args
  local label="$1" sub="$2"
  shift 2
  local args=("$sub" "${COMMON_ARGS[@]}")
  if [ -n "$REPORT_DIR" ]; then
    args+=(--report-format json --report-path "$REPORT_DIR/gitleaks-${label}.json")
  fi
  # Scan "." from the repo root (or the staged copy of it) so findings carry
  # repo-relative paths (the allowlists in .gitleaks.toml are anchored on them).
  args+=("$@" .)
  log "scanning ${label}…"
  local start end rc=0
  start=$(date +%s)
  "$GITLEAKS" "${args[@]}" || rc=$?
  end=$(date +%s)
  case "$rc" in
    0) log "${label}: clean ($((end - start))s)" ;;
    1) log "${label}: FINDINGS — see output above$([ -n "$REPORT_DIR" ] && printf ' and %s' "$REPORT_DIR/gitleaks-${label}.json") ($((end - start))s)" ;;
    *) log "${label}: gitleaks failed with exit $rc" ;;
  esac
  return "$rc"
}

# `gitleaks dir` walks every file under the path, including gitignored ones, so
# scanning the checkout directly would judge whatever happens to sit in
# artifacts/, node_modules/, downloaded CI logs, etc. Hard-link the files git
# would actually commit (tracked + untracked-unignored, worktree contents) into
# a staging tree with the same repo-relative paths, so .gitleaks.toml's
# path-anchored allowlists still apply, and scan that.
stage_tree() {
  local f dir
  local -A made=()
  STAGE_DIR="$(mktemp -d "$(git rev-parse --git-dir)/security-scan-stage.XXXXXX")"
  while IFS= read -r -d '' f; do
    [ -f "$f" ] || continue # deleted in the worktree, or a submodule
    dir="${f%/*}"
    [ "$dir" = "$f" ] && dir=.
    if [ -z "${made[$dir]:-}" ]; then
      mkdir -p "$STAGE_DIR/$dir"
      made[$dir]=1
    fi
    ln "$f" "$STAGE_DIR/$f" 2>/dev/null || cp -p "$f" "$STAGE_DIR/$f"
  done < <(git ls-files -z --cached --others --exclude-standard)
}

scan_tree() {
  local rc=0
  stage_tree
  (cd "$STAGE_DIR" && run_scan tree dir) || rc=$?
  rm -rf "$STAGE_DIR"
  STAGE_DIR=""
  return "$rc"
}

overall=0
if [ "$SCAN_TREE" = 1 ]; then
  scan_tree || overall=1
fi
if [ "$SCAN_HISTORY" = 1 ]; then
  run_scan history git --log-opts "$LOG_OPTS" || overall=1
fi

if [ "$overall" = 0 ]; then
  log "PASS: no secrets detected"
else
  log "FAIL: secrets detected (or scanner error). Never commit the value — remove it, rotate it, and only allowlist in .gitleaks.toml with a justification if it is provably non-secret."
fi
exit "$overall"
