#!/usr/bin/env bash
# S7 — apps/mobile/package-lock.json modified while node_modules exists.
#
# In a detached scratch worktree of HEAD: create apps/mobile/node_modules
# (variants below), mutate the lockfile, run
# `scripts/verify-cloud.sh --only deps,mobile` and record whether `npm ci`
# was invoked. `npm`, `npx` and `pnpm` are shims on PATH that log their argv
# and exit 0, so only verify-cloud's own decision logic is exercised (no
# install, no tsc/jest). Then the same with `--fresh-deps`.
#
# Cases:
#   lock_changed        node_modules present + lockfile mutated   -> expect npm ci
#   lock_changed_fresh  same + --fresh-deps                        -> expect npm ci
#   empty_nm            node_modules is an EMPTY dir (interrupted install) -> expect npm ci
#   hidden_lock_stale   node_modules/.package-lock.json disagrees with package-lock.json -> expect npm ci
#   pristine            node_modules present, lockfile untouched   -> skipping is fine
#
# Exit 0 = all HELD, 1 = at least one BROKEN. Results in $OUT/results.jsonl.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="${S7_OUT:-/tmp/attack-s7-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT"
WT="$OUT/worktree"
BROKEN=0
: >"$OUT/results.jsonl"

cd "$REPO_ROOT" || exit 2
git worktree add --detach -q "$WT" HEAD || exit 2
trap 'cd "$REPO_ROOT"; git worktree remove --force "$WT" >/dev/null 2>&1' EXIT

SHIM="$OUT/shim"; mkdir -p "$SHIM"
for tool in npm npx pnpm; do
  cat >"$SHIM/$tool" <<EOF
#!/usr/bin/env bash
echo "$tool \$*" >>"\$S7_LOG"
exit 0
EOF
  chmod +x "$SHIM/$tool"
done

LOCK="$WT/apps/mobile/package-lock.json"
NM="$WT/apps/mobile/node_modules"

reset_tree() {
  (cd "$WT" && git checkout -q -- apps/mobile/package-lock.json)
  rm -rf "$NM"
}

mutate_lock() {
  # bump the lockfile's own "version" field of the root package: a real dependency
  # change would look no different to a presence check on node_modules
  python3 - "$LOCK" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["packages"][""]["dependencies"]["attack-stale-dep"] = "^1.0.0"
d["packages"]["node_modules/attack-stale-dep"] = {"version": "1.0.0", "resolved": "https://registry.npmjs.org/attack-stale-dep/-/attack-stale-dep-1.0.0.tgz", "integrity": "sha512-AAAA"}
json.dump(d, open(p, "w"), indent=2)
PY
}

run_case() { # label expect(npm-ci|any) extra-args...
  local label="$1" expect="$2"; shift 2
  export S7_LOG="$OUT/$label.shim.log"; : >"$S7_LOG"
  local art="$OUT/$label-artifacts" rc ran verdict lock_diff
  (cd "$WT" && PATH="$SHIM:$PATH" VERIFY_ARTIFACTS="$art" scripts/verify-cloud.sh --only deps,mobile "$@") >"$OUT/$label.out" 2>&1
  rc=$?
  grep -q '^npm ci' "$S7_LOG" && ran=yes || ran=no
  lock_diff="$(cd "$WT" && git diff --stat -- apps/mobile/package-lock.json | tail -1 | sed 's/^ *//')"
  verdict=HELD
  case "$expect" in
    npm-ci) [ "$ran" = yes ] || verdict=BROKEN ;;
    any) ;;
  esac
  [ $verdict = BROKEN ] && BROKEN=1
  printf '{"case":"%s","args":"--only deps,mobile %s","npm_ci_ran":"%s","expected":"%s","verify_exit":%d,"lockfile_diff":"%s","deps_note":"%s","verdict":"%s","deps_log":"%s"}\n' \
    "$label" "$*" "$ran" "$expect" "$rc" "${lock_diff:-none}" "$(grep -o 'apps/mobile/node_modules present.*' "$art/deps.log" | head -1)" "$verdict" "$art/deps.log" | tee -a "$OUT/results.jsonl"
}

# lock_changed
reset_tree; mkdir -p "$NM/.bin"; cp "$LOCK" "$NM/.package-lock.json"; mutate_lock
run_case lock_changed npm-ci
# lock_changed_fresh
run_case lock_changed_fresh npm-ci --fresh-deps
# empty_nm
reset_tree; mkdir -p "$NM"
run_case empty_nm npm-ci
# hidden_lock_stale: node_modules was installed from a DIFFERENT lockfile
reset_tree; mkdir -p "$NM/.bin"; cp "$LOCK" "$NM/.package-lock.json"
python3 - "$NM/.package-lock.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["packages"][""]["dependencies"]["previously-installed-dep"] = "^2.0.0"; json.dump(d, open(p, "w"), indent=2)
PY
run_case hidden_lock_stale npm-ci
# pristine control
reset_tree; mkdir -p "$NM/.bin"; cp "$LOCK" "$NM/.package-lock.json"
run_case pristine any

echo "== results: $OUT/results.jsonl"
exit $BROKEN
