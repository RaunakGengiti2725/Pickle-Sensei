#!/usr/bin/env bash
# Adversarial scenarios against scripts/security-scan.sh (gitleaks gate), run
# inside a throwaway clone so this checkout is never modified:
#
#   S4  broken .gitleaks.toml  → gitleaks itself returns rc>=2 (config error);
#       does the gate surface that distinguishably from "findings" (rc 1)?
#   S5  invoke the gate from a subdirectory (cd apps/mobile && ../../scripts/…)
#       → does it cd to the repo root (path-anchored allowlists) or fail?
#   S9  untracked file with `productKey: sk_<24 alnum>` → the regex allowlist
#       for generic-api-key must NOT silence the custom revenuecat-secret-api-key rule.
#
#   tools/attack/security-secrets-deps/s4_s5_s9_gitleaks_gate.sh [out-dir]
#
# Exit 0 = every scenario HELD; exit 1 = at least one BROKEN (details in out-dir).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="${1:-$REPO_ROOT/artifacts/attack/s4_s5_s9}"
mkdir -p "$OUT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git clone -q "$REPO_ROOT" "$WORK/repo"
cd "$WORK/repo"
broken=0
note() { echo "$*" | tee -a "$OUT/results.txt"; }
: >"$OUT/results.txt"

# ── S4: syntactically broken policy ─────────────────────────────────────────
cp .gitleaks.toml "$OUT/gitleaks.toml.orig"
printf '\n[[rules]\nid = "unterminated\n' >> .gitleaks.toml
rc_direct=0
"$HOME/.cache/pickle-sensei/gitleaks-8.30.1/gitleaks" dir --no-banner --exit-code 1 --config .gitleaks.toml . \
  >"$OUT/s4-gitleaks-direct.log" 2>&1 || rc_direct=$?
rc_gate=0
scripts/security-scan.sh --tree >"$OUT/s4-gate.log" 2>&1 || rc_gate=$?
# gitleaks with a different findings exit code: a FATAL (config parse) still
# exits 1, so a gate that used e.g. --exit-code 3 could tell the two apart.
rc_alt=0
"$HOME/.cache/pickle-sensei/gitleaks-8.30.1/gitleaks" dir --no-banner --exit-code 3 --config .gitleaks.toml . \
  >"$OUT/s4-gitleaks-exitcode3.log" 2>&1 || rc_alt=$?
note "S4 gitleaks-direct(--exit-code 1) rc=$rc_direct  gitleaks-direct(--exit-code 3) rc=$rc_alt  gate rc=$rc_gate"
if grep -q "gitleaks failed with exit" "$OUT/s4-gate.log"; then
  note "S4 gate log labels the run as a scanner failure"
  labelled=failure
elif grep -q "FINDINGS" "$OUT/s4-gate.log"; then
  note "S4 gate log labels the run as FINDINGS although no scan happened (FTL: unable to load gitleaks config)"
  labelled=findings
else
  labelled=none
fi
# The header comment of the script promises: 0 = clean, 1 = findings OR error, 2 = setup failure.
# A policy-file parse error is a setup failure; with --exit-code 1 gitleaks' own
# fatal exit (1) is indistinguishable from findings, so the gate reports FINDINGS.
if [ "$rc_gate" -ge 2 ] && [ "$labelled" = failure ]; then
  note "S4 HELD: gate exits $rc_gate and labels the scanner error"
elif [ "$labelled" = findings ]; then
  note "S4 BROKEN: scanner fatal (no scan performed) reported as 'FINDINGS', exit 1 — same as a real leak; a caller/CI summary cannot tell the difference (fix: --exit-code != 1 so fatals stay at 1, or grep FTL)"
  broken=1
else
  note "S4 BROKEN(exit-code only): scanner error folded into exit 1 == findings; log label=$labelled"
  broken=1
fi
git checkout -q -- .gitleaks.toml
# Control: with the VALID policy and a planted leak, --exit-code 3 yields 3 —
# so findings (3) vs fatal (1) would be separable.
printf 'const k = "sk_Qx7Lm2Vp9Rt4Wk8Zn3Hy6Bd1Fg5Jc0NsUe";\n' > untracked-control.ts
rc_ctl=0
"$HOME/.cache/pickle-sensei/gitleaks-8.30.1/gitleaks" dir --no-banner --exit-code 3 --config .gitleaks.toml . \
  >"$OUT/s4-control-exitcode3.log" 2>&1 || rc_ctl=$?
rm -f untracked-control.ts
note "S4 control: valid policy + planted leak, --exit-code 3 → rc=$rc_ctl (fatal config error stayed rc=$rc_alt)"

# ── S5: run from a subdirectory ─────────────────────────────────────────────
# Plant a Podfile.lock-shaped checksum line OUTSIDE the allowlisted path so the
# only thing that keeps the gate clean is the correctly-anchored allowlists;
# then run from apps/mobile. If the gate scanned apps/mobile as "." the
# repo-relative anchors would drift.
rc_sub=0
(cd apps/mobile && ../../scripts/security-scan.sh --tree) >"$OUT/s5-subdir.log" 2>&1 || rc_sub=$?
scanned_root=$(grep -c "scanned ~" "$OUT/s5-subdir.log" || echo 0)
note "S5 subdir invocation rc=$rc_sub (scan lines: $scanned_root)"
# Prove where it scanned: byte count of a root scan vs an apps/mobile-only scan differ by >10x.
root_bytes=$(sed -n 's/.*scanned ~\([0-9]*\) bytes.*/\1/p' "$OUT/s5-subdir.log" | head -1)
rc_root=0
scripts/security-scan.sh --tree >"$OUT/s5-root.log" 2>&1 || rc_root=$?
root_ref=$(sed -n 's/.*scanned ~\([0-9]*\) bytes.*/\1/p' "$OUT/s5-root.log" | head -1)
note "S5 bytes scanned from subdir=$root_bytes from root=$root_ref"
if [ "$rc_sub" = "$rc_root" ] && [ "$root_bytes" = "$root_ref" ]; then
  note "S5 HELD: subdirectory invocation scans the whole repo from its root"
else
  note "S5 BROKEN: subdirectory invocation differs from root invocation"
  broken=1
fi

# ── S9: productKey line carrying an sk_ secret shape ────────────────────────
printf 'const cfg = { productKey: "sk_Qx7Lm2Vp9Rt4Wk8Zn3Hy6Bd1Fg5Jc0NsUe" };\n' > untracked-productkey.ts
rc_s9=0
scripts/security-scan.sh --tree --report-dir "$OUT/s9-report" >"$OUT/s9.log" 2>&1 || rc_s9=$?
rules=$(python3 -c 'import json,sys; print(",".join(sorted({f["RuleID"] for f in json.load(open(sys.argv[1]))})))' "$OUT/s9-report/gitleaks-tree.json" 2>/dev/null || echo none)
note "S9 rc=$rc_s9 rules_fired=$rules"
if [ "$rc_s9" = 1 ] && [[ "$rules" == *revenuecat-secret-api-key* ]]; then
  note "S9 HELD: custom sk_ rule fires despite the productKey generic-api-key allowlist"
else
  note "S9 BROKEN: sk_ secret on a productKey line passed the gate"
  broken=1
fi
rm -f untracked-productkey.ts

# ── S9b: same, but the value sits on a `sessionKey` line in a services/api test path
# (allowlist L70-73 is path+regex scoped; make sure the path scope does not widen).
mkdir -p services/api/test
printf 'const t = { sessionKey: "sk_Qx7Lm2Vp9Rt4Wk8Zn3Hy6Bd1Fg5Jc0NsUe" }; // planted\n' > services/api/test/attack-planted.test.ts
rc_s9b=0
scripts/security-scan.sh --tree --report-dir "$OUT/s9b-report" >"$OUT/s9b.log" 2>&1 || rc_s9b=$?
rules_b=$(python3 -c 'import json,sys; print(",".join(sorted({f["RuleID"] for f in json.load(open(sys.argv[1]))})))' "$OUT/s9b-report/gitleaks-tree.json" 2>/dev/null || echo none)
note "S9b rc=$rc_s9b rules_fired=$rules_b"
if [ "$rc_s9b" = 1 ] && [[ "$rules_b" == *revenuecat-secret-api-key* ]]; then
  note "S9b HELD"
else
  note "S9b BROKEN: sk_ secret in services/api/test on a sessionKey line passed"
  broken=1
fi
rm -f services/api/test/attack-planted.test.ts

exit "$broken"
