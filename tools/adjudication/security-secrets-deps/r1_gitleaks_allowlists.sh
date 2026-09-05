#!/usr/bin/env bash
# R1 — .gitleaks.toml allowlists exempt WHOLE FILES from both scan modes.
# Plants the same canary payload in a control file and in every path that a
# `paths` allowlist (with or without `regexes`) or an extension allowlist
# covers, commits them in a throwaway clone, and runs the repo's own gate.
# HELD  = every planted file is reported by BOTH `--tree` and `--history`.
# BROKEN = at least one planted file is missed by either mode.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
LAB="$(mktemp -d)"; trap 'rm -rf "$LAB"' EXIT
throwaway_clone "$LAB"
cd "$LAB"

PLANTS=(
  "control|probe/control.txt|new"
  "dotenv|.env|new"
  "dotenv-nested|apps/mobile/.env|new"
  "build-dir|apps/mobile/build/config.ts|new"
  "dist-dir|dist/config.ts|new"
  "coverage-dir|coverage/report.json|new"
  "pods-dir|apps/mobile/ios/Pods/Config.rb|new"
  "venv-dir|.venv/settings.py|new"
  "dotbuild-dir|.build/settings.txt|new"
  "turbo-dir|.turbo/settings.txt|new"
  "podfile-lock|apps/mobile/ios/Podfile.lock|append"
  "ext-mp4|docs/notes.mp4|new"
  "ext-pt|ml/weights.pt|new"
  "ext-task|ml/model.task|new"
  "regex-allowlist-runtimeConfig|apps/mobile/src/config/runtimeConfig.ts|append"
  "regex-allowlist-distribution-doc|docs/DISTRIBUTION.md|append"
  "regex-allowlist-mobile-secrets-test|apps/mobile/__tests__/wf/be-mobile-security-secrets.test.ts|append"
)
PAYLOAD="$(canary_payload)"
for p in "${PLANTS[@]}"; do
  IFS='|' read -r _ path mode <<<"$p"
  mkdir -p "$(dirname "$path")"
  if [ "$mode" = append ]; then printf '%s\n' "$PAYLOAD" >>"$path"; else printf '%s\n' "$PAYLOAD" >"$path"; fi
  git add -f "$path"
done
git commit -qm "adjudication: planted canaries"

"$LAB/scripts/security-scan.sh" --tree --report-dir "$OUT/r1-tree" >"$OUT/r1-tree.log" 2>&1 || true
"$LAB/scripts/security-scan.sh" --history --log-opts HEAD~1..HEAD --report-dir "$OUT/r1-history" >"$OUT/r1-history.log" 2>&1 || true

while IFS='|' read -r v c d; do verdict "$v" "$c" "$d"; done < <(python3 - "$OUT" "${PLANTS[@]}" <<'EOF'
import json, os, sys
out, plants = sys.argv[1], [p.split('|') for p in sys.argv[2:]]
seen = {}
for mode in ('tree', 'history'):
    path = f'{out}/r1-{mode}/gitleaks-{mode}.json'
    seen[mode] = {f['File'] for f in (json.load(open(path)) if os.path.exists(path) else [])}
for label, path, _ in plants:
    t, h = path in seen['tree'], path in seen['history']
    print(f"{'HELD' if t and h else 'BROKEN'}|r1:{label}|{path} tree={'hit' if t else 'MISS'} history={'hit' if h else 'MISS'}")
EOF
)
finish
