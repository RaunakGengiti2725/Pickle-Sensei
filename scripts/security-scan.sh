#!/usr/bin/env bash
# Secret-scanning gate for Pickle Sensei (gitleaks, pinned, non-interactive).
#
#   scripts/security-scan.sh                 # working tree + full git history of HEAD
#   scripts/security-scan.sh --tree          # working tree only (tracked, untracked, unignored)
#   scripts/security-scan.sh --history       # git history only (HEAD's ancestry)
#   scripts/security-scan.sh --history --all-refs   # audit: every ref in the clone, not just HEAD
#   scripts/security-scan.sh --history --log-opts "origin/main..HEAD"   # only this branch's commits
#   scripts/security-scan.sh --report-dir out/   # also write JSON reports (redacted)
#
# Policy lives in .gitleaks.toml (default rules + repo-specific allowlists, each
# with a justification). Findings are ALWAYS redacted in output and reports.
#
# Scope: the verdict is a function of the commit under test. The default
# history scan covers exactly HEAD's ancestry — gitleaks is pointed at an
# ephemeral bare repository that shares this clone's object store (alternates)
# but holds a single ref = HEAD, so no other branch, tag or remote-tracking ref
# exists for it to walk. Unrelated branches in the clone (CI fetches every
# remote branch) can therefore neither fail nor pass a run; use --all-refs for
# a repository-wide audit. The log states the scanned range and commit count.
#
# Exit codes: 0 = no findings, 1 = findings (or gitleaks error), 2 = setup failure.
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
HISTORY_VIEW=""
trap '[ -z "$DOWNLOAD_TMP" ] || rm -rf "$DOWNLOAD_TMP"; [ -z "$HISTORY_VIEW" ] || rm -rf "$HISTORY_VIEW"' EXIT

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
ALL_REFS=0
LOG_OPTS=""
REPORT_DIR=""
VERBOSE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tree) SCAN_HISTORY=0 ;;
    --history) SCAN_TREE=0 ;;
    --all-refs) ALL_REFS=1 ;;
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
[ "$ALL_REFS" = 0 ] || [ -z "$LOG_OPTS" ] || die "--all-refs and --log-opts are mutually exclusive (put --all in --log-opts instead)"
[ "$ALL_REFS" = 0 ] || [ "$SCAN_HISTORY" = 1 ] || die "--all-refs only applies to the history scan"

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

COMMON_ARGS=(--no-banner --exit-code 1 --redact=100 --config "$CONFIG")
[ "$VERBOSE" = 1 ] && COMMON_ARGS+=(--verbose)

run_scan() {
  # $1 = label, $2 = gitleaks subcommand, $3 = source path, remaining = extra args
  local label="$1" sub="$2" source="$3"
  shift 3
  local args=("$sub" "${COMMON_ARGS[@]}")
  if [ -n "$REPORT_DIR" ]; then
    args+=(--report-format json --report-path "$REPORT_DIR/gitleaks-${label}.json")
  fi
  # The tree scan runs on "." from the repo root and git scans report the
  # paths in the diff headers, so findings always carry repo-relative paths
  # (the allowlists in .gitleaks.toml are anchored on them).
  args+=("$@" "$source")
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

make_head_ancestry_view() {
  # Sets HISTORY_VIEW to a bare repository whose ONLY ref is $1 (HEAD of this
  # clone). It borrows this clone's objects through objects/info/alternates
  # (nothing is copied) and inherits its shallow boundary, so `git log --all`
  # inside it is exactly `git log HEAD` here — the scope is enforced by
  # construction rather than by the scanner's revision-selection flags.
  local rev="$1" common alt
  common="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
  HISTORY_VIEW="$(mktemp -d)"
  git init -q --bare "$HISTORY_VIEW" || die "could not create the HEAD-ancestry view"
  {
    printf '%s\n' "$common/objects"
    if [ -f "$common/objects/info/alternates" ]; then
      while IFS= read -r alt; do
        case "$alt" in
          "" | /*) printf '%s\n' "$alt" ;;
          *) printf '%s/objects/%s\n' "$common" "$alt" ;;
        esac
      done <"$common/objects/info/alternates"
    fi
  } >"$HISTORY_VIEW/objects/info/alternates"
  [ ! -f "$common/shallow" ] || cp "$common/shallow" "$HISTORY_VIEW/shallow"
  git -C "$HISTORY_VIEW" update-ref refs/heads/head-ancestry "$rev" || die "could not pin $rev in the HEAD-ancestry view"
  [ "$(git -C "$HISTORY_VIEW" rev-list --count --all)" = "$(git rev-list --count "$rev")" ] \
    || die "HEAD-ancestry view does not match this clone's HEAD history"
}

scan_history() {
  local rev count
  if [ -n "$LOG_OPTS" ]; then
    log "history: custom revision selection (git log $LOG_OPTS) over the whole clone"
    run_scan history git . --log-opts "$LOG_OPTS"
  elif [ "$ALL_REFS" = 1 ]; then
    count="$(git rev-list --count --all)"
    log "history: all refs in this clone, $count commits — AUDIT MODE: this verdict depends on refs other than HEAD"
    run_scan history git .
  else
    rev="$(git rev-parse --verify -q 'HEAD^{commit}')" || die "HEAD does not point at a commit"
    count="$(git rev-list --count "$rev")"
    log "history: HEAD ancestry (${rev:0:12}), $count commits — refs other than HEAD are not visible to this scan"
    make_head_ancestry_view "$rev"
    run_scan history git "$HISTORY_VIEW"
  fi
}

overall=0
if [ "$SCAN_TREE" = 1 ]; then
  run_scan tree dir . || overall=1
fi
if [ "$SCAN_HISTORY" = 1 ]; then
  scan_history || overall=1
fi

if [ "$overall" = 0 ]; then
  log "PASS: no secrets detected"
else
  log "FAIL: secrets detected (or scanner error). Never commit the value — remove it, rotate it, and only allowlist in .gitleaks.toml with a justification if it is provably non-secret."
fi
exit "$overall"
