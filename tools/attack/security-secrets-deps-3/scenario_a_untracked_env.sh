#!/usr/bin/env bash
# Scenario A — plant an AWS-shaped key in an UNTRACKED root `.env` and run
# `scripts/security-scan.sh --tree`.
#
# Expectation under test: either the planted value is detected, or the miss is
# an explicit documented exemption. `.gitleaks.toml` carries a "gitignored
# local env files" path allowlist, so the tree scan is EXPECTED to pass; the
# control file (same value, `.attack-probe.txt`) must FAIL to prove the value is
# detectable at all. A tracked `.env` (git add -f) is ALSO skipped by the same
# path allowlist — that is the documented blind spot this script records.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

[ -e .env ] && inconclusive "a root .env already exists; refusing to overwrite it"

value="$(fake_aws_key)"
track "$REPO_ROOT/.env"
track "$REPO_ROOT/.attack-probe-a.txt"

printf 'AWS_ACCESS_KEY_ID=%s\n' "$value" > .attack-probe-a.txt
rc_control=0
scan a-control --tree || rc_control=$?
rm -f .attack-probe-a.txt
[ "$rc_control" = 1 ] || inconclusive "control file was not flagged (exit $rc_control) — the probe value is not detectable"

printf 'AWS_ACCESS_KEY_ID=%s\n' "$value" > .env
rc_env=0
scan a-untracked-env --tree || rc_env=$?
rm -f .env

allowlisted="$(grep -c 'gitignored local env files' .gitleaks.toml || true)"
assert_clean_tree

if [ "$rc_env" = 0 ] && [ "$allowlisted" -ge 1 ]; then
  echo "note: untracked .env miss is covered by the '.gitleaks.toml' allowlist 'gitignored local env files' (documented exemption); a force-tracked .env is skipped by the same path rule"
  held "untracked .env skipped by an explicit documented path allowlist; control detected (exit $rc_control)"
elif [ "$rc_env" = 1 ]; then
  held "planted value in untracked .env detected (exit 1)"
else
  broken "untracked .env passed (exit $rc_env) with no documented exemption"
fi
