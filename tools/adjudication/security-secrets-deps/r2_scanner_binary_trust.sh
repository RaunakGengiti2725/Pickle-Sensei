#!/usr/bin/env bash
# R2 — scripts/security-scan.sh trusts any executable that prints the pinned
# version string (GITLEAKS_BIN, a poisoned cache entry, or a PATH impostor) and
# collapses a fatal gitleaks error (exit 2) into the "findings" exit 1.
# Runs against a throwaway clone with a planted canary that the REAL scanner
# reports (control). HELD = impostors are rejected (exit 2 / setup failure)
# and a malformed config surfaces as exit 2; BROKEN = the gate passes (exit 0)
# with an impostor, or a config error is indistinguishable from findings.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
LAB="$(mktemp -d)"; trap 'rm -rf "$LAB"' EXIT
throwaway_clone "$LAB"
cd "$LAB"
mkdir -p probe && canary_payload >probe/control.txt && git add -f probe/control.txt && git commit -qm "adjudication: canary"

run_gate() { # run_gate <label> [env assignments...] -- [args...]
  local label="$1"; shift
  local rc=0
  env "$@" "$LAB/scripts/security-scan.sh" --tree --report-dir "$OUT/r2-$label" >"$OUT/r2-$label.log" 2>&1 || rc=$?
  echo "$rc"
}

rc="$(run_gate control)"
[ "$rc" = 1 ] || die "control scan did not report the canary (exit $rc); cannot adjudicate"
verdict HELD r2:control "real gitleaks reports the planted canary (exit 1)"

IMP="$LAB/.impostor"; mkdir -p "$IMP"
printf '#!/bin/sh\n[ "$1" = version ] && echo 8.30.1\nexit 0\n' >"$IMP/gitleaks"; chmod +x "$IMP/gitleaks"

rc="$(run_gate bin-true GITLEAKS_BIN=/bin/true)"
[ "$rc" = 0 ] && verdict BROKEN r2:GITLEAKS_BIN "GITLEAKS_BIN=/bin/true passes the gate (exit 0) with a planted canary" \
  || verdict HELD r2:GITLEAKS_BIN "GITLEAKS_BIN=/bin/true rejected (exit $rc)"

CACHE="$LAB/.cache"; mkdir -p "$CACHE/gitleaks-8.30.1"; cp "$IMP/gitleaks" "$CACHE/gitleaks-8.30.1/gitleaks"
rc="$(run_gate poisoned-cache SECURITY_SCAN_CACHE="$CACHE")"
[ "$rc" = 0 ] && verdict BROKEN r2:cache "same-version impostor in SECURITY_SCAN_CACHE passes the gate (exit 0)" \
  || verdict HELD r2:cache "cache impostor rejected (exit $rc)"

rc="$(run_gate path-impostor SECURITY_SCAN_CACHE="$LAB/.empty-cache" PATH="$IMP:$PATH")"
[ "$rc" = 0 ] && verdict BROKEN r2:PATH "same-version impostor on PATH passes the gate (exit 0)" \
  || verdict HELD r2:PATH "PATH impostor rejected (exit $rc)"

printf '\n[[rules]]\nid = "broken"\nregex = "(unclosed"\n' >>"$LAB/.gitleaks.toml"
rc="$(run_gate broken-config)"
[ "$rc" = 1 ] && verdict BROKEN r2:fatal-exit "malformed .gitleaks.toml (gitleaks exit 2) is reported as exit 1 = 'findings'" \
  || verdict HELD r2:fatal-exit "malformed config surfaces as exit $rc"
finish
