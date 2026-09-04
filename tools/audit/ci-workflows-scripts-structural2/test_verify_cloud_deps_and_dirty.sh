#!/usr/bin/env bash
# scripts/verify-cloud.sh deps freshness and the summary.json dirty flag.
#
# Asserts (desired behaviour):
#   D1  deps stage runs `npm ci` in apps/mobile when apps/mobile/node_modules
#       was installed from an OLDER package-lock.json (lockfile changed since)
#   D2  dirty flag is true when the tree is dirty with a large `git status`
#       (> pipe buffer) — the flag is computed with `git status | grep -qv`
#       under `set -o pipefail`; grep -q exiting early can SIGPIPE git and
#       flip the result to false
#   D3  dirty flag is true with a single untracked file (control)
#   D4  dirty flag is false on a clean tree (control)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SB=$(mktemp -d)
trap 'rm -rf "$SB"' EXIT
new_verify_cloud_sandbox "$SB"

# D1: node_modules present but installed from an older lockfile
mkdir -p "$SB/apps/mobile/node_modules"
echo '{"name":"mobile","lockfileVersion":3,"packages":{"node_modules/left-pad":{"version":"1.0.0"}}}' \
  >"$SB/apps/mobile/node_modules/.package-lock.json"
echo '{"name":"mobile","lockfileVersion":3,"packages":{"node_modules/left-pad":{"version":"2.0.0"}}}' \
  >"$SB/apps/mobile/package-lock.json"
touch -d '2020-01-01' "$SB/apps/mobile/node_modules" "$SB/apps/mobile/node_modules/.package-lock.json"
: >"$STUB_LOG"
run_verify_cloud --only deps,mobile
assert_eq "D1 deps stage exit" 0 "$RC"
printf '%s\n' "$OUT" >"$AUDIT_OUT/deps_D1_console.log"
cp "$SB"/artifacts/verify-cloud/*/deps.log "$AUDIT_OUT/deps_D1_deps.log"
assert_true "D1 npm ci executed after package-lock.json changed" grep -q '^npm ci' "$STUB_LOG"

dirty_flag() { # dirty_flag → prints the dirty value from a fresh run's summary
  rm -rf "$SB/artifacts"
  run_verify_cloud --only ml >/dev/null
  jq -r '.dirty' "$SB"/artifacts/verify-cloud/*/summary.json
}

# D4 control: clean tree (commit everything, ignore runtime files)
printf 'artifacts/\nstub.log\nchild.pid\n' >"$SB/.gitignore"
git -C "$SB" add -A
git -C "$SB" -c user.email=a@b -c user.name=audit commit -qm fixtures
assert_eq "D4 clean tree → dirty=false" false "$(dirty_flag)"

# D3 control: one untracked file
touch "$SB/one-untracked-file"
assert_eq "D3 one untracked file → dirty=true" true "$(dirty_flag)"
rm "$SB/one-untracked-file"

# D2: many modified tracked files (git status output > 64 KiB pipe buffer)
mkdir -p "$SB/many"
for i in $(seq 1 6000); do echo a >"$SB/many/tracked-file-with-a-reasonably-long-name-$i.txt"; done
git -C "$SB" add -A
git -C "$SB" -c user.email=a@b -c user.name=audit commit -qm many
for i in $(seq 1 6000); do echo b >"$SB/many/tracked-file-with-a-reasonably-long-name-$i.txt"; done
status_bytes=$(git -C "$SB" status --porcelain | wc -c)
log "git status --porcelain is $status_bytes bytes"
res=$(dirty_flag)
echo "status_bytes=$status_bytes dirty=$res" >"$AUDIT_OUT/dirty_D2.txt"
assert_eq "D2 large dirty tree → dirty=true" true "$res"

finish
