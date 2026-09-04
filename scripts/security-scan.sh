#!/usr/bin/env bash
# Secret-scanning gate for Pickle Sensei (gitleaks, pinned, non-interactive).
#
#   scripts/security-scan.sh                 # working tree + full git history of HEAD
#   scripts/security-scan.sh --tree          # working tree only (tracked, untracked, unignored)
#   scripts/security-scan.sh --history       # git history only
#   scripts/security-scan.sh --history --log-opts "origin/main..HEAD"   # only this branch's commits
#   scripts/security-scan.sh --report-dir out/   # also write JSON reports (redacted)
#
# Policy lives in .gitleaks.toml (default rules + repo-specific allowlists, each
# with a justification). Findings are ALWAYS redacted in output and reports, and
# every finding is attributed in the output (RuleID, File, Line, Commit,
# Fingerprint) so a red gate names what tripped it without the report file.
#
# The history range is validated BEFORE scanning: `--log-opts` must resolve
# (gitleaks itself swallows git's "bad revision" error and reports a clean scan
# of 0 commits) and must select at least one commit; a scan that ends up
# covering 0 commits is a setup failure, never a pass.
#
# Exit codes: 0 = no findings, 1 = findings (or gitleaks error),
#             2 = setup failure (missing tool, invalid/empty history range).
#
# Environment:
#   GITLEAKS_BIN            use this binary instead of the pinned download
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

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$REPO_ROOT/.gitleaks.toml"
CACHE_DIR="${SECURITY_SCAN_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/pickle-sensei}"

DOWNLOAD_TMP=""
SCAN_STDERR="$(mktemp)"
trap '[ -z "$DOWNLOAD_TMP" ] || rm -rf "$DOWNLOAD_TMP"; rm -f "$SCAN_STDERR"' EXIT

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
LOG_OPTS=""
REPORT_DIR=""
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
    # Per-finding attribution is always on; accepted so older invocations keep working.
    --verbose | -v) ;;
    --help | -h) usage 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
[ "$SCAN_TREE" = 1 ] || [ "$SCAN_HISTORY" = 1 ] || die "--tree and --history are mutually exclusive"

[ -f "$CONFIG" ] || die "missing $CONFIG"
cd "$REPO_ROOT"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$REPO_ROOT is not a git work tree"

strip_ansi() { sed "s/$(printf '\033')\\[[0-9;]*m//g"; }

# gitleaks hands --log-opts to `git log` split on single spaces (no shell
# quoting); mirror that so the range we validate is the range it scans. With no
# --log-opts gitleaks walks every ref (`git log --all`).
HISTORY_RANGE=()
HISTORY_COMMITS=0
HISTORY_RANGE_DESC="--all (every ref)"
if [ "$SCAN_HISTORY" = 1 ]; then
  if [ -n "$LOG_OPTS" ]; then
    IFS=' ' read -r -a HISTORY_RANGE <<<"$LOG_OPTS"
    HISTORY_RANGE_DESC="'$LOG_OPTS'"
  else
    HISTORY_RANGE=(--all)
  fi
  if ! range_commits="$(git log --no-patch --format=%H "${HISTORY_RANGE[@]}" 2>&1)"; then
    die "setup error: invalid history range --log-opts ${HISTORY_RANGE_DESC}: ${range_commits%%$'\n'*}"
  fi
  # (mawk lacks {n} interval regexes; count 40-hex lines by length instead.)
  HISTORY_COMMITS="$(printf '%s\n' "$range_commits" | awk 'length($0) == 40 && /^[0-9a-f]+$/ { n++ } END { print n + 0 }')"
  [ "$HISTORY_COMMITS" -gt 0 ] || die "setup error: empty history range --log-opts ${HISTORY_RANGE_DESC} selects 0 commits — nothing to scan is not a pass"
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "need sha256sum or shasum to verify the gitleaks download"
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
  mkdir -p "$(dirname "$dest")"
  mv "$tmp/gitleaks" "$dest"
  chmod 0755 "$dest"
  rm -rf "$tmp"
  DOWNLOAD_TMP=""
}

resolve_gitleaks() {
  local key cached
  if [ -n "${GITLEAKS_BIN:-}" ]; then
    [ -x "$GITLEAKS_BIN" ] || die "GITLEAKS_BIN=$GITLEAKS_BIN is not executable"
    reports_version "$GITLEAKS_BIN" || log "warning: GITLEAKS_BIN is not v${GITLEAKS_VERSION}; results may differ from the pinned gate"
    printf '%s' "$GITLEAKS_BIN"
    return
  fi
  key="$(platform_key || true)"
  cached="$CACHE_DIR/gitleaks-${GITLEAKS_VERSION}/gitleaks"
  if reports_version "$cached"; then
    printf '%s' "$cached"
    return
  fi
  if command -v gitleaks >/dev/null 2>&1 && reports_version "$(command -v gitleaks)"; then
    command -v gitleaks
    return
  fi
  [ -n "$key" ] || die "unsupported platform $(uname -s)/$(uname -m); set GITLEAKS_BIN to a gitleaks v${GITLEAKS_VERSION} binary"
  [ "${SECURITY_SCAN_OFFLINE:-0}" = 1 ] && die "gitleaks v${GITLEAKS_VERSION} not found and SECURITY_SCAN_OFFLINE=1"
  download_gitleaks "$key" "$cached"
  reports_version "$cached" || die "downloaded binary did not report v${GITLEAKS_VERSION}"
  printf '%s' "$cached"
}

GITLEAKS="$(resolve_gitleaks)"
log "gitleaks $("$GITLEAKS" version) at $GITLEAKS"

if [ -n "$REPORT_DIR" ]; then
  mkdir -p "$REPORT_DIR"
  REPORT_DIR="$(cd "$REPORT_DIR" && pwd)"
fi

# --verbose prints each finding (RuleID, File, Line, Commit, Fingerprint);
# --redact=100 replaces the secret itself with REDACTED in that output and in
# every report, so attribution never costs a plaintext value.
COMMON_ARGS=(--no-banner --exit-code 1 --redact=100 --verbose --config "$CONFIG")

run_scan() {
  # $1 = label, $2 = gitleaks subcommand, remaining = extra args
  local label="$1" sub="$2"
  shift 2
  local args=("$sub" "${COMMON_ARGS[@]}") report=""
  if [ -n "$REPORT_DIR" ]; then
    report="$REPORT_DIR/gitleaks-${label}.json"
    args+=(--report-format json --report-path "$report")
  fi
  # Scan "." from the repo root so findings carry repo-relative paths (the
  # allowlists in .gitleaks.toml are anchored on them).
  args+=("$@" .)
  log "scanning ${label}…"
  local start end rc=0
  start=$(date +%s)
  # Findings stay on stdout; gitleaks' log (stderr) is also copied to
  # SCAN_STDERR so the commit count it reports can be checked below.
  { "$GITLEAKS" "${args[@]}" 2>&1 1>&3 | tee "$SCAN_STDERR" >&2; } 3>&1 || rc=$?
  end=$(date +%s)
  if [ "$label" = history ] && [ "$rc" = 0 ]; then
    local scanned
    scanned="$(strip_ansi <"$SCAN_STDERR" | sed -n 's/.* \([0-9][0-9]*\) commits scanned\..*/\1/p' | tail -n 1)"
    [ "${scanned:-0}" -gt 0 ] || die "history scan covered ${scanned:-an unknown number of} commits although the range ${HISTORY_RANGE_DESC} holds ${HISTORY_COMMITS} — gitleaks got no patches from git (see any [git] lines above; merge/empty commits carry no diff); not a pass"
  fi
  case "$rc" in
    0) log "${label}: clean ($((end - start))s)" ;;
    1) log "${label}: FINDINGS — each is attributed above (RuleID, File, Line, Commit, Fingerprint; secret redacted) ($((end - start))s)" ;;
    *) log "${label}: gitleaks failed with exit $rc" ;;
  esac
  [ -z "$report" ] || log "${label} report: $report"
  return "$rc"
}

overall=0
if [ "$SCAN_TREE" = 1 ]; then
  run_scan tree dir || overall=1
fi
if [ "$SCAN_HISTORY" = 1 ]; then
  log "history: ${HISTORY_COMMITS} commits in range ${HISTORY_RANGE_DESC}"
  if [ -n "$LOG_OPTS" ]; then
    run_scan history git --log-opts "$LOG_OPTS" || overall=1
  else
    run_scan history git || overall=1
  fi
fi

if [ "$overall" = 0 ]; then
  log "PASS: no secrets detected"
else
  log "FAIL: secrets detected (or scanner error). Never commit the value — remove it, rotate it, and only allowlist in .gitleaks.toml with a justification if it is provably non-secret."
fi
exit "$overall"
