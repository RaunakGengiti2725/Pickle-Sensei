#!/usr/bin/env bash
# STRUCTURAL AUDIT #2 — process-level probes that need real pnpm / real CLI runs.
# Usage: packages/evaluation/test/audit/structural2-harness.sh <out-dir>
# Never modifies tracked files; removes every untracked file it causes under datasets/.
set -u
OUT="${1:?out dir}"
mkdir -p "$OUT"
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$ROOT"
PNPM10="npx --yes pnpm@10.15.1"
TSX="$ROOT/packages/evaluation/node_modules/.bin/tsx"
CLI="packages/evaluation/src/regression/cli.ts"
BASE="datasets/reports/regression/baseline.json"
log() { printf '%s\n' "$*" | tee -a "$OUT/harness.log"; }

log "== 0. toolchain"
log "node $(node --version) | pnpm-on-PATH $(pnpm --version) | packageManager $(node -p "require('./package.json').packageManager")"

log "== 1. two concurrent full runs (event_recall + completion_bench write into tracked dataset dirs)"
before_untracked="$(git ls-files --others --exclude-standard -- datasets | sort)"
rm -rf "$OUT/par"; mkdir -p "$OUT/par"
$TSX $CLI run --out-dir "$OUT/par" --run-id par-a > "$OUT/par/a.log" 2>&1 & pa=$!
$TSX $CLI run --out-dir "$OUT/par" --run-id par-b > "$OUT/par/b.log" 2>&1 & pb=$!
wait $pa; ea=$?; wait $pb; eb=$?
log "par-a exit=$ea  par-b exit=$eb"
grep -E "^  (ok|FAILED)" "$OUT/par/a.log" | sed 's/^/  a: /' | tee -a "$OUT/harness.log"
grep -E "^  (ok|FAILED)" "$OUT/par/b.log" | sed 's/^/  b: /' | tee -a "$OUT/harness.log"
after_untracked="$(git ls-files --others --exclude-standard -- datasets | sort)"
strays="$(comm -13 <(printf '%s\n' "$before_untracked") <(printf '%s\n' "$after_untracked") | grep -v '^$' || true)"
log "strays left under datasets/ by the two runs:"; printf '%s\n' "$strays" | sed 's/^/  /' | tee -a "$OUT/harness.log"
log "== 1b. a third, serial run while the strays exist"
$TSX $CLI run --out-dir "$OUT/par" --run-id after-strays > "$OUT/par/after.log" 2>&1; log "after-strays exit=$?"
head -1 "$OUT/par/after.log" | tee -a "$OUT/harness.log"
node -e "const s=require('$OUT/par/after-strays.json');console.log('  gitDirty='+s.provenance.gitDirty, 'caveats='+JSON.stringify(s.caveats.slice(3)))" | tee -a "$OUT/harness.log"
if [ -n "$strays" ]; then printf '%s\n' "$strays" | while read -r f; do [ -n "$f" ] && rm -f "$ROOT/$f"; done; fi
log "cleanup done; untracked under datasets now: $(git ls-files --others --exclude-standard -- datasets | wc -l)"

log "== 2. exit-code propagation: pnpm 9 (PATH) vs pnpm 10 (packageManager) for compare exit 3 / 2 / 1"
PNPM9_VER="$(pnpm --version)"
node -e "const s=require('$ROOT/$BASE');s.contractVersion=2;require('fs').writeFileSync('$OUT/cv2.json',JSON.stringify(s))"
node -e "const s=require('$ROOT/$BASE');s.metrics['contact_replay.estimated']=1;s.benches.find(b=>b.id==='contact_replay').metrics.estimated=1;require('fs').writeFileSync('$OUT/regress.json',JSON.stringify(s))"
run_exit() { "$@" > /dev/null 2>&1; echo $?; }
log "direct tsx      compare(contractVersion 2) exit=$(run_exit $TSX $CLI compare "$BASE" "$OUT/cv2.json") (expect 3)"
log "pnpm $PNPM9_VER -s  compare(contractVersion 2) exit=$(run_exit pnpm -s --filter @pickle/evaluation bench:compare "$BASE" "$OUT/cv2.json") (expect 3)"
log "pnpm $PNPM9_VER     compare(contractVersion 2) exit=$(run_exit pnpm --filter @pickle/evaluation bench:compare "$BASE" "$OUT/cv2.json") (expect 3)"
log "pnpm 10.15.1 -s compare(contractVersion 2) exit=$(run_exit $PNPM10 -s --filter @pickle/evaluation bench:compare "$BASE" "$OUT/cv2.json") (expect 3)"
log "pnpm $PNPM9_VER -s  compare(missing file)      exit=$(run_exit pnpm -s --filter @pickle/evaluation bench:compare "$BASE" /nonexistent.json) (expect 2)"
log "pnpm 10.15.1 -s compare(missing file)      exit=$(run_exit $PNPM10 -s --filter @pickle/evaluation bench:compare "$BASE" /nonexistent.json) (expect 2)"
log "pnpm $PNPM9_VER -s  compare(regressed)         exit=$(run_exit pnpm -s --filter @pickle/evaluation bench:compare "$BASE" "$OUT/regress.json") (expect 1)"
log "pnpm 10.15.1 -s compare(regressed)         exit=$(run_exit $PNPM10 -s --filter @pickle/evaluation bench:compare "$BASE" "$OUT/regress.json") (expect 1)"
log "pnpm $PNPM9_VER -s  compare(clean)             exit=$(run_exit pnpm -s --filter @pickle/evaluation bench:compare "$BASE" "$BASE") (expect 0)"
log "engines.pnpm in root package.json: $(node -p "JSON.stringify(require('./package.json').engines.pnpm ?? null)") (nothing enforces packageManager)"

log "== 3. --json through pnpm without -s"
pnpm --filter @pickle/evaluation bench:compare "$BASE" "$BASE" --json > "$OUT/json-pnpm9.out" 2>/dev/null
node -e "try{JSON.parse(require('fs').readFileSync('$OUT/json-pnpm9.out','utf8'));console.log('  pnpm 9 --json (no -s): valid JSON')}catch(e){console.log('  pnpm 9 --json (no -s): INVALID JSON — first line: '+require('fs').readFileSync('$OUT/json-pnpm9.out','utf8').split('\n')[0])}" | tee -a "$OUT/harness.log"
$PNPM10 --filter @pickle/evaluation bench:compare "$BASE" "$BASE" --json > "$OUT/json-pnpm10.out" 2>/dev/null
node -e "try{JSON.parse(require('fs').readFileSync('$OUT/json-pnpm10.out','utf8'));console.log('  pnpm 10 --json (no -s): valid JSON')}catch(e){console.log('  pnpm 10 --json (no -s): INVALID JSON — first line: '+require('fs').readFileSync('$OUT/json-pnpm10.out','utf8').split('\n')[0])}" | tee -a "$OUT/harness.log"

log "== 4. cwd independence: direct tsx from repo root vs pnpm --filter (cwd packages/evaluation)"
rm -rf "$OUT/cwd"; mkdir -p "$OUT/cwd"
$TSX $CLI run --out-dir "$OUT/cwd" --run-id from-root > "$OUT/cwd/root.log" 2>&1; log "from-root exit=$?"
(cd packages/evaluation && ./node_modules/.bin/tsx src/regression/cli.ts run --out-dir "$OUT/cwd" --run-id from-pkg > "$OUT/cwd/pkg.log" 2>&1); log "from-pkg exit=$?"
$TSX $CLI compare "$OUT/cwd/from-root.json" "$OUT/cwd/from-pkg.json" --json > "$OUT/cwd/compare.json" 2>&1; log "compare(from-root, from-pkg) exit=$?"
node -e "const c=require('$OUT/cwd/compare.json');console.log('  counts='+JSON.stringify(c.counts),'identityDiffs='+JSON.stringify(c.identityDifferences.map(d=>d.field)))" | tee -a "$OUT/harness.log"
$TSX $CLI compare "$BASE" "$OUT/cwd/from-root.json" --json > "$OUT/cwd/compare-baseline.json" 2>&1; log "compare(baseline, from-root) exit=$?"
node -e "const c=require('$OUT/cwd/compare-baseline.json');console.log('  counts='+JSON.stringify(c.counts),'warnings='+JSON.stringify(c.warnings))" | tee -a "$OUT/harness.log"

log "== 5. relative --out-dir without INIT_CWD lands relative to process.cwd(), not the repo root"
rm -rf "$OUT/rel" packages/evaluation/rel-audit-out; mkdir -p "$OUT/rel"
(cd packages/evaluation && ./node_modules/.bin/tsx src/regression/cli.ts run --only coach_gates --out-dir rel-audit-out --run-id rel > "$OUT/rel/run.log" 2>&1); log "relative out-dir run exit=$?"
grep -o "wrote .*" "$OUT/rel/run.log" | tee -a "$OUT/harness.log"
rm -rf packages/evaluation/rel-audit-out

log "== done; tracked changes: $(git status --porcelain --untracked-files=no | wc -l)"
