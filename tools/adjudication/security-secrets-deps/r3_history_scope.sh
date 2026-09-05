#!/usr/bin/env bash
# R3 — the default `--history` scan has no defined scope: without --log-opts
# gitleaks walks EVERY ref (a canary committed on an unrelated local branch
# fails HEAD's gate) while a `--depth 1` clone scans one commit and passes
# even when the canary is one commit behind HEAD.
# HELD = HEAD's history gate is unaffected by unrelated refs AND a shallow
# clone is refused (or unshallowed) rather than silently passing.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
LAB="$(mktemp -d)"; trap 'rm -rf "$LAB"' EXIT
throwaway_clone "$LAB"
cd "$LAB"
BASE="$(git rev-parse HEAD)"

# unrelated sibling branch carries the canary; HEAD does not
git checkout -q -b adjudication/sibling
mkdir -p probe && canary_payload >probe/sibling.txt && git add -f probe/sibling.txt && git commit -qm "sibling canary"
git checkout -q "$BASE"
rc=0; "$LAB/scripts/security-scan.sh" --history --report-dir "$OUT/r3-allrefs" >"$OUT/r3-allrefs.log" 2>&1 || rc=$?
[ "$rc" = 0 ] && verdict HELD r3:all-refs "default history scan of a clean HEAD ignores the sibling branch" \
  || verdict BROKEN r3:all-refs "default history scan of a clean HEAD exits $rc because of a canary on an unrelated branch"

# canary committed then removed in HEAD's own history; shallow clone hides it
git checkout -q -b adjudication/removed
canary_payload >probe/removed.txt && git add -f probe/removed.txt && git commit -qm "add canary"
git rm -q probe/removed.txt && git commit -qm "remove canary"
SHALLOW="$(mktemp -d)"; trap 'rm -rf "$LAB" "$SHALLOW"' EXIT
git clone -q --depth 1 --branch adjudication/removed "file://$LAB" "$SHALLOW"
rc=0; "$SHALLOW/scripts/security-scan.sh" --history --log-opts HEAD --report-dir "$OUT/r3-shallow" >"$OUT/r3-shallow.log" 2>&1 || rc=$?
[ "$rc" = 0 ] && verdict BROKEN r3:shallow "--depth 1 clone: history scan passes (exit 0) although the canary is in HEAD~1" \
  || verdict HELD r3:shallow "shallow clone does not pass silently (exit $rc)"
finish
