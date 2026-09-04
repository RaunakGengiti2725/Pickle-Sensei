#!/usr/bin/env bash
# Secret-scanning gate for Pickle Sensei (gitleaks, pinned, non-interactive).
#
#   scripts/security-scan.sh                 # working tree + git history reachable from HEAD
#   scripts/security-scan.sh --tree          # working tree only (tracked, untracked, unignored)
#   scripts/security-scan.sh --history       # git history reachable from HEAD (= --log-opts "HEAD --")
#   scripts/security-scan.sh --history --log-opts "origin/main..HEAD"   # only this branch's commits
#   scripts/security-scan.sh --report-dir out/   # also write JSON reports (redacted)
#
# Policy lives in .gitleaks.toml (default rules + repo-specific allowlists, each
# with a justification). Findings are ALWAYS redacted in output and reports.
#
# History scope: without --log-opts the scan covers exactly the ancestry of HEAD
# (DEFAULT_LOG_OPTS, spelled "HEAD --" so a tracked file named HEAD cannot make
# the revision ambiguous), never every fetched ref, so the verdict for the
# commit under test does not depend on unrelated branches. --log-opts is handed
# to gitleaks verbatim: it splits the value on single spaces and appends the
# words to `git log -p -U0`, so the value must be single-space separated (no
# leading/trailing/double spaces). The scan fails closed: the same range is
# resolved with `git log` first and an invalid range or one selecting zero
# commits is a scanner error ("NO COMMITS SCANNED"), as are gitleaks ERR lines,
# a missing commit count, or gitleaks counting 0 commits in a range whose
# `git log -p` output contains textual hunks. gitleaks counts only commits that
# produce text hunks, so a non-empty range made solely of merges, --allow-empty
# commits, renames, mode changes or binary files legitimately scans 0 commits
# and PASSES (git already proved the range is non-empty; there is no text to
# scan). A shallow repository (history coverage incomplete) is a scanner error —
# run `git fetch --unshallow`, or set SECURITY_SCAN_ALLOW_SHALLOW=1 to
# downgrade it to a warning.
#
# Exit codes: 0 = no findings, 1 = findings, 2 = no verdict (setup or scanner
#             error: no binary, invalid/empty/malformed history range, shallow
#             repository, gitleaks error output). Only 0 is a PASS.
#
# Environment:
#   GITLEAKS_BIN            use this binary instead of the pinned download
#   SECURITY_SCAN_CACHE     where the pinned binary is cached
#                           (default: ${XDG_CACHE_HOME:-~/.cache}/pickle-sensei)
#   SECURITY_SCAN_OFFLINE=1 never download; fail with exit 2 if no usable binary
#   SECURITY_SCAN_ALLOW_SHALLOW=1  scan a shallow clone anyway (loud warning, PASS
#                           is qualified as incomplete coverage)
set -euo pipefail

# `git log` range the history scan uses when --log-opts is not given. The `--`
# keeps HEAD a revision even when the repository tracks a file named HEAD.
DEFAULT_LOG_OPTS="HEAD --"

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
trap '[ -z "$DOWNLOAD_TMP" ] || rm -rf "$DOWNLOAD_TMP"' EXIT

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
if [ -n "$LOG_OPTS" ] && [[ "$LOG_OPTS" =~ (^\ |\ $|\ \ |[[:cntrl:]]) ]]; then
  die "--log-opts must be single-space separated words with no leading, trailing or double spaces (gitleaks splits it on single spaces and git rejects the resulting empty argument): '$LOG_OPTS'"
fi

[ -f "$CONFIG" ] || die "missing $CONFIG"
cd "$REPO_ROOT"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$REPO_ROOT is not a git work tree"

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

COMMON_ARGS=(--no-banner --no-color --exit-code 1 --redact=100 --config "$CONFIG")
[ "$VERBOSE" = 1 ] && COMMON_ARGS+=(--verbose)

SCANNER_LOG="$(mktemp)"
trap '[ -z "$DOWNLOAD_TMP" ] || rm -rf "$DOWNLOAD_TMP"; rm -f "$SCANNER_LOG"' EXIT

run_scan() {
  # $1 = label, $2 = gitleaks subcommand, remaining = extra args
  local label="$1" sub="$2"
  shift 2
  local args=("$sub" "${COMMON_ARGS[@]}")
  if [ -n "$REPORT_DIR" ]; then
    args+=(--report-format json --report-path "$REPORT_DIR/gitleaks-${label}.json")
  fi
  # Scan "." from the repo root so findings carry repo-relative paths (the
  # allowlists in .gitleaks.toml are anchored on them).
  args+=("$@" .)
  log "scanning ${label}…"
  local start end rc=0 scanned
  start=$(date +%s)
  # gitleaks logs to stderr; keep streaming it while also capturing it so a
  # scanner-side error can never be mistaken for a clean result.
  : >"$SCANNER_LOG"
  { "$GITLEAKS" "${args[@]}" 2>&1 1>&3 | tee "$SCANNER_LOG" >&2; } 3>&1 || rc=$?
  end=$(date +%s)
  if [ "$rc" = 0 ] && grep -Eq '(^|[[:space:]])ERR[[:space:]]' "$SCANNER_LOG"; then
    log "${label}: gitleaks reported an error (see ERR lines above) — a scan that could not run is not a PASS"
    rc=2
  fi
  if [ "$rc" = 0 ] && [ "$sub" = git ]; then
    scanned="$(sed -n 's/.* INF \([0-9][0-9]*\) commits scanned\..*/\1/p' "$SCANNER_LOG" | tail -n 1)"
    if [ -z "$scanned" ]; then
      log "${label}: gitleaks did not report a commit count — cannot confirm the scan ran"
      rc=2
    elif [ "$scanned" = 0 ]; then
      # gitleaks counts only commits whose `git log -p -U0` output has text
      # hunks. git already proved the range selects HISTORY_COMMITS commits;
      # 0 scanned is only wrong if git can show hunks gitleaks did not see.
      local hunks
      if ! hunks="$(history_range_hunks "${HISTORY_WORDS[@]}")"; then
        log "${label}: gitleaks scanned 0 commits and git could not re-read the range — no verdict"
        rc=2
      elif [ "$hunks" != 0 ]; then
        log "${label}: gitleaks scanned 0 commits but the range has ${hunks} textual hunk(s) over ${HISTORY_COMMITS} commit(s) — the scanner evaluated nothing it should have"
        rc=2
      else
        log "${label}: ${HISTORY_COMMITS} commit(s) in range, none with a textual diff (merge/empty/rename/mode/binary-only) — nothing for gitleaks to scan; range verified non-empty by git"
      fi
    fi
  fi
  case "$rc" in
    0) log "${label}: clean ($((end - start))s)" ;;
    1) log "${label}: FINDINGS — see output above$([ -n "$REPORT_DIR" ] && printf ' and %s' "$REPORT_DIR/gitleaks-${label}.json") ($((end - start))s)" ;;
    *) log "${label}: gitleaks failed with exit $rc" ;;
  esac
  return "$rc"
}

# history_range_commits <log-opts words...>: resolve the range exactly as
# gitleaks will (`git log <words>`); die on an invalid range or on zero commits.
history_range_commits() {
  local err count
  err="$(mktemp)"
  count="$(git log --no-color --format=%H "$@" 2>"$err" | awk '/^[0-9a-f]+$/ && length($0) >= 40 { n++ } END { print n + 0 }')" || count=0
  if [ -s "$err" ]; then
    log "ERROR: git rejected the history range '$*':"
    sed 's/^/[security-scan]   /' "$err" >&2
    rm -f "$err"
    exit 2
  fi
  rm -f "$err"
  if [ "$count" = 0 ]; then
    die "NO COMMITS SCANNED: history range '$*' selects no commits — a vacuous scan is not a PASS (check the range; the default is '$DEFAULT_LOG_OPTS')"
  fi
  printf '%s' "$count"
}

# history_range_hunks <log-opts words...>: number of textual diff hunks in the
# exact `git log -p -U0` stream gitleaks consumes for this range (headers
# suppressed; hunk lines start with '@@', content lines never do).
history_range_hunks() {
  git log --no-color -p -U0 --format= "$@" | awk '/^@@/ { n++ } END { print n + 0 }'
}

SHALLOW_WARNING=""
check_history_coverage() {
  [ "$(git rev-parse --is-shallow-repository)" = true ] || return 0
  local msg="shallow repository — history coverage incomplete (only $(git rev-list --count HEAD) commit(s) present; run 'git fetch --unshallow' for the full history)"
  if [ "${SECURITY_SCAN_ALLOW_SHALLOW:-0}" = 1 ]; then
    log "WARNING: $msg — continuing because SECURITY_SCAN_ALLOW_SHALLOW=1"
    SHALLOW_WARNING="$msg"
  else
    die "$msg; set SECURITY_SCAN_ALLOW_SHALLOW=1 to scan anyway"
  fi
}

# exit 1 = findings in any scan; exit 2 = no findings but a scan could not run.
overall=0
record() {
  local rc=$1
  case "$rc" in
    0) ;;
    1) overall=1 ;;
    *) [ "$overall" = 1 ] || overall=2 ;;
  esac
}
if [ "$SCAN_TREE" = 1 ]; then
  run_scan tree dir || record $?
fi
if [ "$SCAN_HISTORY" = 1 ]; then
  check_history_coverage
  history_opts="${LOG_OPTS:-$DEFAULT_LOG_OPTS}"
  # gitleaks splits --log-opts on single spaces before handing them to git log.
  IFS=' ' read -r -a HISTORY_WORDS <<<"$history_opts"
  HISTORY_COMMITS="$(history_range_commits "${HISTORY_WORDS[@]}")" || exit $?
  log "history: $HISTORY_COMMITS commits in range (git log $history_opts; gitleaks --log-opts \"$history_opts\" — it counts only commits with a textual diff, so merges are not in its total)"
  run_scan history git --log-opts "$history_opts" || record $?
fi

if [ "$overall" = 0 ]; then
  if [ -n "$SHALLOW_WARNING" ]; then
    log "PASS (history coverage incomplete): no secrets detected in the scanned range, but $SHALLOW_WARNING"
  else
    log "PASS: no secrets detected"
  fi
elif [ "$overall" = 1 ]; then
  log "FAIL: secrets detected. Never commit the value — remove it, rotate it, and only allowlist in .gitleaks.toml with a justification if it is provably non-secret."
else
  log "FAIL: scanner error — the scan could not evaluate the requested scope (see above); no verdict on secrets"
fi
exit "$overall"
