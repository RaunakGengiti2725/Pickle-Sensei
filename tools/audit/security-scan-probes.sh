#!/usr/bin/env bash
# Negative controls for the secret-scanning gate (scripts/security-scan.sh +
# .gitleaks.toml). Each probe builds a throwaway git repo that contains ONLY
# the gate (script + policy) plus a synthetic canary, runs the gate, and
# compares the exit code with what the gate's own documentation promises.
#
#   tools/audit/security-scan-probes.sh                  # run every probe
#   tools/audit/security-scan-probes.sh --report out.json
#   tools/audit/security-scan-probes.sh --only tree_canary_build_dir,gitleaks_bin_true
#
# Exit 0 when every probe matches its expectation, 1 when any probe fails,
# 2 on setup failure. Canary values are random per run and never real
# credentials; nothing is written into the real repository.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/security-scan.sh"
POLICY="$REPO_ROOT/.gitleaks.toml"
[ -x "$GATE" ] || { echo "missing $GATE" >&2; exit 2; }
[ -f "$POLICY" ] || { echo "missing $POLICY" >&2; exit 2; }

REPORT=""
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --report) REPORT="$2"; shift ;;
    --only) ONLY="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Identity via env so no git config is ever touched.
export GIT_AUTHOR_NAME=probe GIT_AUTHOR_EMAIL=probe@example.invalid
export GIT_COMMITTER_NAME=probe GIT_COMMITTER_EMAIL=probe@example.invalid
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

canary() {
  # A Supabase-style secret key: matched by the repo's own supabase-secret-api-key
  # rule (and gitleaks' generic-api-key). Random so it can never collide with a
  # real value; never printed by this script.
  printf 'SUPABASE_SECRET_KEY=sb_secret_%s\n' "$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9_-' | head -c 40)"
}

new_repo() {
  # $1 = name → prints path. Contains the gate, the policy and one benign file.
  local dir="$WORK/$1"
  mkdir -p "$dir/scripts"
  cp "$GATE" "$dir/scripts/security-scan.sh"
  cp "$POLICY" "$dir/.gitleaks.toml"
  printf 'hello\n' > "$dir/README.md"
  git -C "$dir" init -q -b main
  git -C "$dir" add -A
  git -C "$dir" commit -q -m "gate + policy"
  printf '%s' "$dir"
}

commit_all() { git -C "$1" add -A -f && git -C "$1" commit -q -m "$2"; }

run_gate() {
  # $1 = repo, rest = args; prints exit code, output to $WORK/last.log
  local dir="$1"; shift
  local rc=0
  (cd "$dir" && scripts/security-scan.sh "$@" >"$WORK/last.log" 2>&1) || rc=$?
  printf '%s' "$rc"
}

RESULTS=()
FAILED=0
record() {
  # $1 name, $2 expected, $3 observed, $4 note
  local status=PASS
  case "$2" in
    nonzero) [ "$3" != 0 ] || status=FAIL ;;
    *) [ "$3" = "$2" ] || status=FAIL ;;
  esac
  [ "$status" = PASS ] || FAILED=1
  printf '%-4s %-40s expected=%-7s observed=%-3s %s\n' "$status" "$1" "$2" "$3" "$4"
  RESULTS+=("{\"probe\":\"$1\",\"expected\":\"$2\",\"observed\":$3,\"status\":\"$status\",\"note\":\"$4\"}")
}

want() { [ -z "$ONLY" ] || [[ ",$ONLY," == *",$1,"* ]]; }

# ── controls ────────────────────────────────────────────────────────────────
if want baseline_clean; then
  r="$(new_repo baseline)"
  record baseline_clean 0 "$(run_gate "$r")" "gate+policy+README only"
fi

if want tree_canary_tracked; then
  r="$(new_repo tree_tracked)"; mkdir -p "$r/src"; canary > "$r/src/config.ts"; commit_all "$r" canary
  record tree_canary_tracked 1 "$(run_gate "$r" --tree)" "control: secret in a normal source path is caught"
fi

if want history_canary_removed; then
  r="$(new_repo hist_removed)"; canary > "$r/notes.txt"; commit_all "$r" leak; rm "$r/notes.txt"; commit_all "$r" remove
  record history_canary_removed 1 "$(run_gate "$r" --history)" "control: secret only in history is caught"
fi

# ── path allowlists (.gitleaks.toml) ────────────────────────────────────────
for d in build dist coverage; do
  if want "tree_canary_${d}_dir"; then
    r="$(new_repo "tree_$d")"; mkdir -p "$r/$d"; canary > "$r/$d/config.js"; commit_all "$r" canary
    record "tree_canary_${d}_dir" 1 "$(run_gate "$r" --tree)" "tracked $d/ file holding a secret (.gitleaks.toml path allowlist)"
  fi
  if want "history_canary_${d}_dir"; then
    r="$(new_repo "hist_$d")"; mkdir -p "$r/$d"; canary > "$r/$d/config.js"; commit_all "$r" canary; rm -r "$r/$d"; commit_all "$r" remove
    record "history_canary_${d}_dir" 1 "$(run_gate "$r" --history)" "secret committed under $d/ then deleted"
  fi
done

for f in .env .env.local .env.production.local; do
  name="tree_canary_forceadded_${f//./_}"
  if want "$name"; then
    r="$(new_repo "tree_$f")"; canary > "$r/$f"; commit_all "$r" canary
    record "$name" 1 "$(run_gate "$r" --tree)" "$f force-added with a secret (tracked)"
  fi
done

for ext in pkl task npy; do
  if want "tree_canary_text_$ext"; then
    r="$(new_repo "tree_$ext")"; mkdir -p "$r/models"; canary > "$r/models/weights.$ext"; commit_all "$r" canary
    record "tree_canary_text_$ext" 1 "$(run_gate "$r" --tree)" "plain-text secret in a file with binary extension .$ext"
  fi
done

# ── scanner integrity (scripts/security-scan.sh) ────────────────────────────
if want gitleaks_bin_true; then
  r="$(new_repo bin_true)"; mkdir -p "$r/src"; canary > "$r/src/config.ts"; commit_all "$r" canary
  rc=0; (cd "$r" && GITLEAKS_BIN=/bin/true scripts/security-scan.sh >"$WORK/last.log" 2>&1) || rc=$?
  record gitleaks_bin_true nonzero "$rc" "GITLEAKS_BIN=/bin/true with a tracked secret must not PASS"
fi

if want gitleaks_bin_fake_version; then
  r="$(new_repo bin_fake)"; mkdir -p "$r/src"; canary > "$r/src/config.ts"; commit_all "$r" canary
  fake="$WORK/fake-gitleaks"; printf '#!/bin/sh\n[ "$1" = version ] && { echo 8.30.1; exit 0; }\nexit 0\n' > "$fake"; chmod +x "$fake"
  rc=0; (cd "$r" && GITLEAKS_BIN="$fake" scripts/security-scan.sh >"$WORK/last.log" 2>&1) || rc=$?
  record gitleaks_bin_fake_version nonzero "$rc" "GITLEAKS_BIN that only echoes the pinned version is accepted without checksum"
fi

if want cache_binary_not_checksummed; then
  r="$(new_repo cache_poison)"; mkdir -p "$r/src"; canary > "$r/src/config.ts"; commit_all "$r" canary
  cache="$WORK/cache"; mkdir -p "$cache/gitleaks-8.30.1"
  printf '#!/bin/sh\n[ "$1" = version ] && { echo 8.30.1; exit 0; }\nexit 0\n' > "$cache/gitleaks-8.30.1/gitleaks"; chmod +x "$cache/gitleaks-8.30.1/gitleaks"
  rc=0; (cd "$r" && SECURITY_SCAN_CACHE="$cache" scripts/security-scan.sh >"$WORK/last.log" 2>&1) || rc=$?
  record cache_binary_not_checksummed nonzero "$rc" "cached binary reused on version string alone (no sha256 re-check)"
fi

if want scanner_crash_fails_closed; then
  r="$(new_repo crash)"
  crash="$WORK/crash-gitleaks"; printf '#!/bin/sh\n[ "$1" = version ] && { echo 8.30.1; exit 0; }\necho "config parse error" >&2; exit 126\n' > "$crash"; chmod +x "$crash"
  rc=0; (cd "$r" && GITLEAKS_BIN="$crash" scripts/security-scan.sh --tree >"$WORK/last.log" 2>&1) || rc=$?
  record scanner_crash_fails_closed nonzero "$rc" "gitleaks rc>=2 must not become PASS"
fi

# ── tree scope ──────────────────────────────────────────────────────────────
if want tree_scan_skips_gitignored; then
  # Header of security-scan.sh: "--tree  working tree only (tracked, untracked, unignored)".
  r="$(new_repo tree_gitignore)"
  printf 'scratch/\n' > "$r/.gitignore"; commit_all "$r" gitignore
  mkdir -p "$r/scratch"; canary > "$r/scratch/notes.txt"
  [ -z "$(git -C "$r" status --porcelain)" ] || { echo "setup: canary should be ignored" >&2; exit 2; }
  record tree_scan_skips_gitignored 0 "$(run_gate "$r" --tree)" "secret only in a gitignored, untracked file; header says unignored files only"
fi

# ── history scope ───────────────────────────────────────────────────────────
if want history_scope_is_head_only; then
  # Header of security-scan.sh: "working tree + full git history of HEAD".
  r="$(new_repo hist_scope)"
  git -C "$r" checkout -q -b unrelated; canary > "$r/leak.txt"; commit_all "$r" leak-on-side-branch
  git -C "$r" checkout -q main
  record history_scope_is_head_only 0 "$(run_gate "$r" --history)" "secret only on a branch NOT reachable from HEAD; header promises HEAD history"
fi

if want history_scope_head_ancestry; then
  r="$(new_repo hist_scope2)"
  git -C "$r" checkout -q -b unrelated; canary > "$r/leak.txt"; commit_all "$r" leak-on-side-branch
  git -C "$r" checkout -q main
  record history_scope_head_ancestry 0 "$(run_gate "$r" --history --log-opts HEAD)" "same repo, --log-opts HEAD: only HEAD ancestry is scanned"
fi

if [ -n "$REPORT" ]; then
  { printf '['; (IFS=,; printf '%s' "${RESULTS[*]}"); printf ']\n'; } > "$REPORT"
  echo "report: $REPORT"
fi
exit "$FAILED"
