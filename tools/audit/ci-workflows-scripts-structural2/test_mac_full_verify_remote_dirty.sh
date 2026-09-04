#!/usr/bin/env bash
# scripts/mac-full-verify.sh --remote — the "commit first" guard.
#
# --remote pushes HEAD to a ci/mac-* trigger branch so the Mac builds exactly
# that commit. The guard (`git diff --quiet HEAD -- . ':!artifacts'`) must
# therefore refuse when the working tree differs from HEAD. Untracked files
# (a new Swift source, a new test, a new Podfile entry) are the most common way
# a local tree differs from HEAD, and they are invisible to `git diff HEAD`.
#
# Fully hermetic: an unmodified copy of the script runs inside a throwaway git
# repo whose PATH has a `git` wrapper that records and refuses `push`
# (nothing is pushed anywhere) and a stub `gh` (nothing contacts GitHub).
#
# Asserts (desired behaviour):
#   D1  modified tracked file → exit 2 before any push (control)
#   D2  UNTRACKED new file → exit 2 before any push (the Mac would build a
#       commit that does not contain the file; the run's "same SHA" evidence
#       would not describe the tree the developer tested)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SB=$(mktemp -d)
trap 'rm -rf "$SB"' EXIT
mkdir -p "$SB/repo/scripts" "$SB/bin"
cp "$REPO_ROOT/scripts/mac-full-verify.sh" "$SB/repo/scripts/"
REAL_GIT=$(command -v git)
cat >"$SB/bin/git" <<EOF
#!/usr/bin/env bash
if [ "\$1" = push ]; then echo "PUSH ATTEMPTED: \$*" >>"$SB/push.log"; exit 1; fi
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$SB/bin/git"
make_stub "$SB/bin" gh
cd "$SB/repo"
echo base >tracked.txt
git init -q -b main . && git -c user.email=a@b -c user.name=audit add -A && git -c user.email=a@b -c user.name=audit commit -qm base

run_remote() {
  OUT="$(PATH="$SB/bin:/usr/bin:/bin" scripts/mac-full-verify.sh --remote 2>&1)"; RC=$?
}

# D1 control: modified tracked file
echo change >>tracked.txt
run_remote
printf '%s\n' "$OUT" >"$AUDIT_OUT/mac_remote_D1.log"
assert_eq "D1 modified tracked file refused with exit 2" 2 "$RC"
assert_false "D1 no push attempted" test -e "$SB/push.log"
git checkout -q -- tracked.txt

# D2 untracked new file
echo 'struct NewFeature {}' >NewFeature.swift
run_remote
printf '%s\n' "$OUT" >"$AUDIT_OUT/mac_remote_D2.log"
assert_eq "D2 untracked file refused with exit 2 (commit first)" 2 "$RC"
assert_false "D2 no push attempted" test -e "$SB/push.log"
[ -e "$SB/push.log" ] && cp "$SB/push.log" "$AUDIT_OUT/mac_remote_push_attempts.log"

finish
