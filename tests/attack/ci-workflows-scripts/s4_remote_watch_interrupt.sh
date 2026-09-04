#!/usr/bin/env bash
# S4 — interrupt `scripts/mac-full-verify.sh --remote` during `gh run watch`.
#
# NO real Mac run is triggered: a `git` shim on PATH swallows `push` (every
# other git sub-command is delegated to the real binary) and a `gh` shim plays
# the GitHub CLI. The shim's behaviour per case is driven by S4_MODE:
#
#   sigint        `gh run watch` blocks; the harness sends SIGINT to the whole
#                 process group (Ctrl-C). Expect: local exit != 0, the fake
#                 run's state file is still "in_progress" (the CLI never
#                 cancels the remote run), and `gh run download <id>` still works.
#   netdrop       `gh run watch` dies with a connection error (exit 1).
#                 Expect: local exit != 0.
#   downloadfail  watch succeeds (run green) but `gh run download` fails.
#                 Expect (evidence standard): non-zero exit / no green claim
#                 without artifacts.
#   viewfail      watch + download succeed, the final `gh run view` fails.
#                 Expect: run.json is not left as an empty file.
#   untracked     an UNTRACKED file is present in the worktree when --remote
#                 is invoked. Expect: refused like uncommitted changes (the Mac
#                 builds the pushed commit, which does not contain the file).
#
# Runs in a detached scratch worktree of HEAD so the repo is never touched.
# Exit 0 = all cases HELD, 1 = at least one BROKEN. Results in $OUT/results.jsonl.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="${S4_OUT:-/tmp/attack-s4-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT"
WT="$OUT/worktree"
FAKE_RUN_ID=424242
BROKEN=0
: >"$OUT/results.jsonl"

cd "$REPO_ROOT" || exit 2
git worktree add --detach -q "$WT" HEAD || exit 2
trap 'cd "$REPO_ROOT"; git worktree remove --force "$WT" >/dev/null 2>&1' EXIT

SHIM="$OUT/shim"; mkdir -p "$SHIM"
REAL_GIT="$(command -v git)"
cat >"$SHIM/git" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = push ]; then echo "SHIM git push \$*" >>"\$S4_LOG"; exit 0; fi
exec "$REAL_GIT" "\$@"
EOF
cat >"$SHIM/gh" <<'EOF'
#!/usr/bin/env bash
# fake GitHub CLI — see S4_MODE in the harness header
echo "SHIM gh $*" >>"$S4_LOG"
RUN_ID=424242
case "$1 $2" in
  "run list")
    printf '%s\n' "$RUN_ID" ;;
  "run view")
    if [ "$S4_MODE" = viewfail ] && [[ "$*" == *conclusion* ]]; then
      echo "error connecting to api.github.com" >&2; exit 1
    fi
    if [[ "$*" == *"--jq .url"* ]]; then echo "https://github.com/example/repo/actions/runs/$RUN_ID"
    else printf '{"databaseId":%s,"status":"%s","conclusion":"success","url":"u","headSha":"h"}\n' "$RUN_ID" "$(cat "$S4_STATE")"; fi ;;
  "run watch")
    case "$S4_MODE" in
      sigint) echo watching >"$S4_STATE.watching"; sleep 120; echo "watch finished normally (should not happen)"; exit 0 ;;
      netdrop) echo "error connecting to api.github.com: dial tcp: i/o timeout" >&2; exit 1 ;;
      *) echo "completed" >"$S4_STATE"; exit 0 ;;
    esac ;;
  "run download")
    if [ "$S4_MODE" = downloadfail ]; then echo "failed to download artifacts: connection reset" >&2; exit 1; fi
    dir=""; while [ $# -gt 0 ]; do [ "$1" = --dir ] && dir="$2"; shift; done
    mkdir -p "$dir/mac-full-verify" && echo '{"stages":[]}' >"$dir/mac-full-verify/summary.json" ;;
  *) echo "unexpected gh invocation: $*" >&2; exit 99 ;;
esac
EOF
chmod +x "$SHIM/git" "$SHIM/gh"

record() { # case verdict exit detail
  [ "$2" = BROKEN ] && BROKEN=1
  printf '{"case":"%s","verdict":"%s","local_exit":%s,"detail":"%s","log":"%s"}\n' "$1" "$2" "$3" "$4" "$OUT/$1.out" | tee -a "$OUT/results.jsonl"
}

run_remote() { # mode -> sets RC, uses $OUT/$mode.out
  local mode="$1"
  export S4_MODE="$mode" S4_LOG="$OUT/$mode.shim.log" S4_STATE="$OUT/$mode.state" MAC_ARTIFACTS="$OUT/$mode.artifacts"
  echo in_progress >"$S4_STATE"; : >"$S4_LOG"; rm -f "$S4_STATE.watching"
  (cd "$WT" && PATH="$SHIM:$PATH" timeout 300 scripts/mac-full-verify.sh --remote) >"$OUT/$mode.out" 2>&1
  RC=$?
}

# --- sigint: Ctrl-C the foreground process group while `gh run watch` blocks
export S4_MODE=sigint S4_LOG="$OUT/sigint.shim.log" S4_STATE="$OUT/sigint.state" MAC_ARTIFACTS="$OUT/sigint.artifacts"
echo in_progress >"$S4_STATE"; : >"$S4_LOG"; rm -f "$S4_STATE.watching"
# the script runs in its own process group (like a terminal foreground job);
# the wrapper bash stays outside it so it can report the exit status.
( cd "$WT" && PATH="$SHIM:$PATH" bash -c 'setsid --wait bash scripts/mac-full-verify.sh --remote; echo "LOCAL_EXIT=$?" >&3' 3>"$OUT/sigint.exit" ) >"$OUT/sigint.out" 2>&1 &
BG=$!
for _ in $(seq 1 60); do [ -f "$S4_STATE.watching" ] && break; sleep 1; done
if [ -f "$S4_STATE.watching" ]; then
  PGID="$(ps -o pgid= -p "$(pgrep -f '^bash scripts/mac-full-verify.sh --remote$' | head -1)" | tr -d ' ')"
  MYPGID="$(ps -o pgid= -p $$ | tr -d ' ')"
  if [ -z "$PGID" ] || [ "$PGID" = "$MYPGID" ]; then echo "refusing to signal own process group ($PGID)" >&2; exit 2; fi
  kill -INT -- "-$PGID"
  wait "$BG" 2>/dev/null
  sleep 1
  LOCAL_EXIT="$(sed -n 's/^LOCAL_EXIT=//p' "$OUT/sigint.exit" 2>/dev/null)"
  STATE="$(cat "$S4_STATE")"
  # recovery: the run id is known from the log; download must still work
  (cd "$WT" && PATH="$SHIM:$PATH" gh run download "$FAKE_RUN_ID" --dir "$OUT/sigint.recovered") >>"$OUT/sigint.out" 2>&1; DL=$?
  if [ -n "$LOCAL_EXIT" ] && [ "$LOCAL_EXIT" -ne 0 ] && [ "$STATE" = in_progress ] && [ $DL -eq 0 ] && [ -f "$OUT/sigint.recovered/mac-full-verify/summary.json" ]; then
    record sigint HELD "$LOCAL_EXIT" "exit=$LOCAL_EXIT remote_state=$STATE recovery_download_exit=$DL"
  else
    record sigint BROKEN "${LOCAL_EXIT:-null}" "exit=${LOCAL_EXIT:-unknown} remote_state=$STATE recovery_download_exit=$DL"
  fi
else
  record sigint BROKEN null "gh run watch never started (see log)"
fi

# --- netdrop
run_remote netdrop
if [ $RC -ne 0 ]; then record netdrop HELD $RC "watch died with connection error; local exit $RC"; else record netdrop BROKEN $RC "exit 0 despite watch failure"; fi

# --- downloadfail: green run, artifact download fails
run_remote downloadfail
N=$(find "$MAC_ARTIFACTS" -type f 2>/dev/null | wc -l)
if [ $RC -ne 0 ]; then record downloadfail HELD $RC "exit $RC, files=$N"; else record downloadfail BROKEN $RC "exit 0 with $N artifact files downloaded (only run.json)"; fi

# --- viewfail: final metadata fetch fails
run_remote viewfail
SZ=$(stat -c %s "$MAC_ARTIFACTS/run.json" 2>/dev/null || echo missing)
if [ "$SZ" = missing ] || [ "$SZ" -gt 0 ]; then record viewfail HELD $RC "run.json=$SZ bytes exit=$RC"; else record viewfail BROKEN $RC "run.json is an EMPTY file (0 bytes), exit=$RC"; fi

# --- untracked: new file not in the commit under test
run_remote_untracked() {
  echo "// not committed" >"$WT/native/UntrackedAttack.swift"
  run_remote untracked
  rm -f "$WT/native/UntrackedAttack.swift"
}
mkdir -p "$WT/native"; run_remote_untracked
if grep -q 'SHIM git push' "$OUT/untracked.shim.log"; then
  record untracked BROKEN $RC "push proceeded with an untracked file in the worktree (exit $RC)"
else
  record untracked HELD $RC "push refused (exit $RC)"
fi

echo "== results: $OUT/results.jsonl"; cat "$OUT/results.jsonl"
exit $BROKEN
