#!/usr/bin/env bash
# Scenario C — a real-format JWT (`eyJ….eyJ….sig`) inside untracked files whose
# EXTENSION is on the `.gitleaks.toml` "binary video, audio, and ML model
# artifacts" allowlist (`.task`, `.pkl`, also upper-case and nested paths).
#
# The allowlist is by extension only, so a plaintext secret in `x.task` is
# skipped. Control: the same JWT in `x.txt` must be flagged. Any allowlisted
# extension that hides the plaintext JWT is recorded as BROKEN (blind spot).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

jwt="$(fake_jwt)"

control="$REPO_ROOT/.attack-probe-c.txt"
track "$control"
printf 'token=%s\n' "$jwt" > "$control"
rc=0
scan c-control --tree || rc=$?
rm -f "$control"
[ "$rc" = 1 ] || inconclusive "control JWT in .txt was not flagged (exit $rc)"

missed=()
for name in x.task x.pkl X.TASK nested/dir/model.pkl x.onnx x.mp4; do
  f="$REPO_ROOT/.attack-probe-c-$name"
  case "$name" in */*) mkdir -p "$(dirname "$f")"; track "$REPO_ROOT/.attack-probe-c-${name%%/*}" ;; *) track "$f" ;; esac
  printf 'token=%s\n' "$jwt" > "$f"
  rc=0
  scan "c-$(printf '%s' "$name" | tr '/' '_')" --tree || rc=$?
  rm -rf "$REPO_ROOT/.attack-probe-c-${name%%/*}"
  if [ "$rc" = 0 ]; then
    missed+=("$name")
  elif [ "$rc" != 1 ]; then
    inconclusive "scan of $name errored (exit $rc)"
  fi
done

assert_clean_tree
if [ "${#missed[@]}" = 0 ]; then
  held "plaintext JWT flagged regardless of extension"
fi
echo "extensions hiding a plaintext JWT: ${missed[*]}"
broken "extension-only allowlist in .gitleaks.toml skips plaintext secrets in ${#missed[@]} probe file(s)"
