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
# Scanner identity: the ONLY thing this wrapper ever executes is a private copy
# of a file whose sha256 equals the pinned digest of the official gitleaks
# v${GITLEAKS_VERSION} binary for this platform. Candidates (GITLEAKS_BIN, the
# cache, PATH, a fresh download) are hashed BEFORE they are run — a file is
# never asked for its version to decide whether to trust it — and a candidate
# that does not match is a setup failure, not a warning and not a fallback.
#
# Exit codes: 0 = no findings, 1 = findings (or gitleaks error), 2 = setup failure.
#
# Environment:
#   GITLEAKS_BIN            use this binary (must hash to the pinned digest)
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
# sha256 of the `gitleaks` BINARY extracted from each of those tarballs. This
# is the identity every candidate must prove before it is executed; the tarball
# digests above only guard the download. Re-derive on a version bump with:
#   tar -xzf gitleaks_<ver>_<key>.tar.gz gitleaks && sha256sum gitleaks
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
RUN_DIR=""
cleanup() {
  [ -z "$DOWNLOAD_TMP" ] || rm -rf "$DOWNLOAD_TMP"
  [ -z "$STAGE_DIR" ] || rm -rf "$STAGE_DIR"
  [ -z "$RUN_DIR" ] || rm -rf "$RUN_DIR"
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

PLATFORM_KEY="$(platform_key || true)"
EXPECTED_BIN_SHA256="${GITLEAKS_BIN_SHA256[${PLATFORM_KEY:-none}]:-}"

# admit_binary <candidate> <source>
# Copies the candidate into this run's private directory, proves the COPY
# hashes to the pinned digest, and only then runs it once to confirm the
# version string. Nothing outside RUN_DIR is ever executed, so a file swapped
# under a cache or PATH entry after the check cannot reach the scan, and an
# executable that merely claims the version (or claims nothing) never runs at
# all. Prints the admitted path.
admit_binary() {
  local candidate="$1" source="$2" admitted actual reported
  [ -n "$EXPECTED_BIN_SHA256" ] || die "no pinned gitleaks v${GITLEAKS_VERSION} binary digest for platform $(uname -s)/$(uname -m); cannot verify the scanner"
  [ -f "$candidate" ] || die "$source: $candidate is not a regular file"
  admitted="$RUN_DIR/gitleaks"
  cp "$candidate" "$admitted"
  chmod 0500 "$admitted"
  actual="$(sha256_file "$admitted")"
  if [ "$actual" != "$EXPECTED_BIN_SHA256" ]; then
    rm -f "$admitted"
    die "$source: $candidate is not the pinned gitleaks v${GITLEAKS_VERSION} binary for ${PLATFORM_KEY} (sha256 $actual, expected $EXPECTED_BIN_SHA256); refusing to run an unverified scanner"
  fi
  reported="$("$admitted" version 2>/dev/null | tr -d '[:space:]')" || reported=""
  [ "$reported" = "$GITLEAKS_VERSION" ] || die "$source: verified binary reported version '${reported}', expected ${GITLEAKS_VERSION}"
  log "gitleaks v${GITLEAKS_VERSION} verified (sha256 ${actual:0:12}…) from ${source}: $candidate"
  printf '%s' "$admitted"
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
  actual="$(sha256_file "$tmp/gitleaks")"
  [ "$actual" = "$EXPECTED_BIN_SHA256" ] || die "extracted gitleaks binary from $tarball does not match the pinned binary digest (expected $EXPECTED_BIN_SHA256, got $actual)"
  mkdir -p "$(dirname "$dest")"
  mv "$tmp/gitleaks" "$dest"
  chmod 0755 "$dest"
  rm -rf "$tmp"
  DOWNLOAD_TMP=""
}

# Pick the candidate binary, in priority order, and admit exactly that one.
# Every source is judged by digest alone; a candidate that fails is fatal
# rather than skipped, so a poisoned cache or a `gitleaks` on PATH that is not
# the pinned build can never be papered over by a later source.
resolve_gitleaks() {
  local cached on_path
  if [ -n "${GITLEAKS_BIN:-}" ]; then
    admit_binary "$GITLEAKS_BIN" "GITLEAKS_BIN"
    return
  fi
  cached="$CACHE_DIR/gitleaks-${GITLEAKS_VERSION}/gitleaks"
  if [ -e "$cached" ]; then
    admit_binary "$cached" "SECURITY_SCAN_CACHE (remove the file to re-download)"
    return
  fi
  if on_path="$(command -v gitleaks 2>/dev/null)"; then
    admit_binary "$on_path" "PATH (set GITLEAKS_BIN to the pinned v${GITLEAKS_VERSION} build, or take this one off PATH)"
    return
  fi
  [ -n "$PLATFORM_KEY" ] || die "unsupported platform $(uname -s)/$(uname -m); no pinned gitleaks v${GITLEAKS_VERSION} build to download"
  [ "${SECURITY_SCAN_OFFLINE:-0}" = 1 ] && die "gitleaks v${GITLEAKS_VERSION} not found and SECURITY_SCAN_OFFLINE=1"
  download_gitleaks "$PLATFORM_KEY" "$cached"
  admit_binary "$cached" "fresh download"
}

# Private, mode-0700 home for the one binary this run may execute (inside the
# git dir like the staging tree, so a noexec $TMPDIR cannot break the gate).
RUN_DIR="$(mktemp -d "$(git rev-parse --absolute-git-dir)/security-scan-bin.XXXXXX")"
chmod 0700 "$RUN_DIR"
GITLEAKS="$(resolve_gitleaks)"

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
