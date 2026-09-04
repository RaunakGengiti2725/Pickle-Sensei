#!/usr/bin/env bash
# Execution-audit harness for the packages/evaluation regression CLI.
#
# Exercises usage errors, run-id / out-dir validation, overwrite refusal,
# malformed / mutated summaries, tolerance-config variants, partial runs and
# the pnpm wrapper, recording "<case> exit=<code>" lines in
# $AUDIT_OUT/edge-results.txt plus one log per case under $AUDIT_OUT/edge/.
#
# Requires a completed full run at $AUDIT_OUT/cand/cand.json, e.g.
#   pnpm -s --filter @pickle/evaluation bench:regression --out-dir "$AUDIT_OUT/cand" --run-id cand
#
# Read-only with respect to the repository: it never writes under datasets/
# and leaves `git status --porcelain` empty (asserted as the last line).
set -u
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
AUDIT_OUT=${AUDIT_OUT:-/tmp/pickle-audit-bench}
E=$AUDIT_OUT/edge
O=$AUDIT_OUT/edge-out
mkdir -p "$E" "$O"
cd "$REPO"
TSX=$REPO/packages/evaluation/node_modules/.bin/tsx
CLI=$REPO/packages/evaluation/src/regression/cli.ts
BASE=$REPO/datasets/reports/regression/baseline.json
CAND=$AUDIT_OUT/cand/cand.json
TOL=$REPO/packages/evaluation/regression.tolerances.json
RES=$AUDIT_OUT/edge-results.txt
: > "$RES"
[ -f "$CAND" ] || { echo "missing $CAND — run bench:regression first" >&2; exit 2; }

run_case() { local name=$1; shift; ( "$@" ) > "$E/$name.log" 2>&1; local rc=$?; echo "$name exit=$rc" | tee -a "$RES"; }
direct() { "$TSX" "$CLI" "$@"; }
viapnpm() { pnpm -s --filter @pickle/evaluation "$@"; }
# mutate the real candidate with a python statement operating on dict `d`
mut() {
  python3 - "$CAND" "$O/$1.json" "$2" <<'PYEOF'
import json, sys
src, dst, code = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(src))
exec(code)
json.dump(d, open(dst, "w"), indent=2)
PYEOF
}
# mutate one bench metric and keep the flattened `metrics` view consistent
mutm() { mut "$1" "b=[x for x in d['benches'] if x['id']=='$2'][0]; b['metrics']['$3']=$4; d['metrics']['$2.$3']=$4"; }

# --- usage / argument validation (expected exit 2 unless noted) -------------
run_case u01-noargs                   direct
run_case u02-unknown-cmd              direct frobnicate
run_case u03-compare-one-positional   direct compare "$BASE"
run_case u04-run-outdir-missing-value direct run --out-dir
run_case u05-run-unknown-flag         direct run --out-dir "$O" --run-id u05 --bogus-flag --only coach_gates
run_case u06-compare-unknown-flag     direct compare "$BASE" "$CAND" --bogus
run_case u07-run-extra-positional     direct run extra --out-dir "$O" --run-id u07 --only coach_gates
run_case u08-run-empty-only           direct run --out-dir "$O" --run-id u08 --only ""          # exit 0: runs ALL benches
run_case u09-run-dup-only             direct run --out-dir "$O" --run-id u09 --only coach_gates,coach_gates
run_case u10-run-only-badid           direct run --out-dir "$O" --run-id u10 --only not_a_bench
run_case u11-runid-traversal          direct run --out-dir "$O" --run-id '../escape' --only coach_gates
run_case u12-runid-slash              direct run --out-dir "$O" --run-id 'a/b' --only coach_gates
run_case u13-runid-leading-dot        direct run --out-dir "$O" --run-id '.hidden' --only coach_gates
run_case u14-runid-128chars           direct run --out-dir "$O" --run-id "$(printf 'a%.0s' $(seq 1 128))" --only coach_gates
run_case u15-runid-129chars           direct run --out-dir "$O" --run-id "$(printf 'a%.0s' $(seq 1 129))" --only coach_gates
run_case u16-runid-empty              direct run --out-dir "$O" --run-id '' --only coach_gates   # exit 0: timestamp id
run_case u17-outdir-is-file           direct run --out-dir "$RES" --run-id u17 --only coach_gates
run_case u18-overwrite-first          direct run --out-dir "$O" --run-id ow --only coach_gates
run_case u19-overwrite-refused        direct run --out-dir "$O" --run-id ow --only coach_gates
run_case u20-overwrite-via-pnpm       viapnpm bench:regression --out-dir "$O" --run-id ow --only coach_gates

# --- compare: input problems (expected exit 2) ----------------------------------
run_case c01-missing-candidate        direct compare "$BASE" "$O/does-not-exist.json"
run_case c02-missing-baseline         direct compare "$O/does-not-exist.json" "$CAND"
head -c 2000 "$CAND" > "$O/truncated.json"
run_case c03-truncated-json           direct compare "$BASE" "$O/truncated.json"
echo '{}' > "$O/empty-object.json"
run_case c04-empty-object             direct compare "$BASE" "$O/empty-object.json"
: > "$O/zero-bytes.json"
run_case c05-zero-bytes               direct compare "$BASE" "$O/zero-bytes.json"
echo '[]' > "$O/array.json"
run_case c06-array                    direct compare "$BASE" "$O/array.json"
run_case c07-self-compare             direct compare "$BASE" "$BASE"
run_case c08-self-compare-json        direct compare "$BASE" "$BASE" --json
run_case c09-tolerances-missing       direct compare "$BASE" "$CAND" --tolerances "$O/nope.json"
echo '{"configVersion":1}' > "$O/bad-tol.json"
run_case c10-tolerances-invalid       direct compare "$BASE" "$CAND" --tolerances "$O/bad-tol.json"
run_case c11-directory-as-summary     direct compare "$BASE" "$O"

# --- compare: mutated candidates -----------------------------------------------
mut m01-contract2 'd["contractVersion"]=2'
run_case m01-contract-version-2       direct compare "$BASE" "$O/m01-contract2.json"      # 3
mut m02-schema2 'd["schemaVersion"]=2'
run_case m02-schema-version-2         direct compare "$BASE" "$O/m02-schema2.json"        # 2 (validator), docs say 3
mut m03-evclass 'd["provenance"]["evidenceClass"]="mac_device"'
run_case m03-evidence-class-mac       direct compare "$BASE" "$O/m03-evclass.json"        # 2 (validator), docs say 3
mut m04-contract-name 'd["contract"]="other-contract"'
run_case m04-contract-name            direct compare "$BASE" "$O/m04-contract-name.json"  # 2 (validator), docs say 3
mutm m05-regressed contact_replay estimated 6
run_case m05-regressed-metric         direct compare "$BASE" "$O/m05-regressed.json"      # 1
mutm m06-improved event_recall proposed_ok 14
run_case m06-improved-metric          direct compare "$BASE" "$O/m06-improved.json"       # 0
mutm m07-lost contact_replay estimated None
run_case m07-measurement-lost         direct compare "$BASE" "$O/m07-lost.json"           # 1
mut m08-flat-mismatch 'd["metrics"]["contact_replay.estimated"]=6'
run_case m08-flat-mismatch            direct compare "$BASE" "$O/m08-flat-mismatch.json"  # 2
mutm m09-unlisted coach_gates brand_new_metric 1
run_case m09-unlisted-new-metric      direct compare "$BASE" "$O/m09-unlisted.json"       # 0 (!) missing_in_baseline wins over policy fail
mut m10-drop-info 'b=[x for x in d["benches"] if x["id"]=="coach_gates"][0]; del b["metrics"]["active_coaches"]; del d["metrics"]["coach_gates.active_coaches"]'
run_case m10-missing-informational    direct compare "$BASE" "$O/m10-drop-info.json"      # 0
mut m11-failed-bench 'b=[x for x in d["benches"] if x["id"]=="coach_gates"][0]; b["status"]="failed"; b["error"]="synthetic failure"; [d["metrics"].pop("coach_gates."+k) for k in list(b["metrics"])]; b["metrics"]={}'
run_case m11-candidate-bench-failed   direct compare "$BASE" "$O/m11-failed-bench.json"   # 1
run_case m12-baseline-bench-failed    direct compare "$O/m11-failed-bench.json" "$CAND"   # 0
mut m13-drop-bench 'd["benches"]=[x for x in d["benches"] if x["id"]!="coach_gates"]; [d["metrics"].pop(k) for k in list(d["metrics"]) if k.startswith("coach_gates.")]'
run_case m13-bench-missing-in-candidate direct compare "$BASE" "$O/m13-drop-bench.json"   # 1
run_case m14-bench-new-in-candidate   direct compare "$O/m13-drop-bench.json" "$CAND"     # 0
mut m15-dirty 'd["provenance"]["gitDirty"]=True'
run_case m15-gitdirty-candidate       direct compare "$BASE" "$O/m15-dirty.json"          # 0 + CONFOUND warning
mut m16-tree 'd["provenance"]["datasetsTreeSha"]="0"*40'
run_case m16-dataset-tree-confound    direct compare "$BASE" "$O/m16-tree.json"           # 0 + CONFOUND warning
mut m17-inf 'd["benches"][0]["metrics"][sorted(d["benches"][0]["metrics"])[0]]=float("inf")'
run_case m17-infinity-metric          direct compare "$BASE" "$O/m17-inf.json"            # 2
mut m18-string-metric 'k=sorted(d["benches"][0]["metrics"])[0]; d["benches"][0]["metrics"][k]="7"; d["metrics"][d["benches"][0]["id"]+"."+k]="7"'
run_case m18-string-metric            direct compare "$BASE" "$O/m18-string-metric.json"  # 2
mut m19-exitcode-null 'b=[x for x in d["benches"] if x["kind"]=="subprocess"][0]; b["exitCode"]=None'
run_case m19-subprocess-exitcode-null direct compare "$BASE" "$O/m19-exitcode-null.json"  # 2
mut m20-extra-key 'd["extra"]=1'
run_case m20-extra-toplevel-key       direct compare "$BASE" "$O/m20-extra-key.json"      # 2
mut m21-bad-sha 'd["provenance"]["gitSha"]="notasha"'
run_case m21-bad-git-sha              direct compare "$BASE" "$O/m21-bad-sha.json"        # 2
mut m22-dup-bench 'd["benches"].append(dict(d["benches"][0]))'
run_case m22-duplicate-bench          direct compare "$BASE" "$O/m22-dup-bench.json"      # 2
mut m23-model-version 'd["provenance"]["modelVersions"][sorted(d["provenance"]["modelVersions"])[0]]="changed"'
run_case m23-model-version-expected   direct compare "$BASE" "$O/m23-model-version.json"  # 0 (expected difference)
mut m24-drop-guarded 'b=[x for x in d["benches"] if x["id"]=="coach_gates"][0]; del b["metrics"]["gates_pass"]; del d["metrics"]["coach_gates.gates_pass"]'
run_case m24-missing-guarded-metric   direct compare "$BASE" "$O/m24-drop-guarded.json"   # 1
mut m25-unlisted-both 'b=[x for x in d["benches"] if x["id"]=="coach_gates"][0]; b["metrics"]["brand_new_metric"]=1; d["metrics"]["coach_gates.brand_new_metric"]=1'
run_case m25-unlisted-in-both         direct compare "$O/m25-unlisted-both.json" "$O/m25-unlisted-both.json"  # 1
mut m26-same-node 'd["runner"]["node"]="v22.23.2"'
run_case m26-runner-node-matched      direct compare "$BASE" "$O/m26-same-node.json"      # 0, no CONFOUND

# --- tolerance-config variants -------------------------------------------------
python3 - "$TOL" "$O" <<'PYEOF'
import json, sys
t = json.load(open(sys.argv[1])); o = sys.argv[2] + "/"
def cp(): return json.loads(json.dumps(t))
v = cp(); v["unlistedMetricPolicy"] = "informational"; json.dump(v, open(o + "tol-unlisted-info.json", "w"))
v = cp(); v["lostMeasurementIsRegression"] = False; json.dump(v, open(o + "tol-lost-ok.json", "w"))
v = cp(); v["metrics"]["contact_replay.estimated"]["absoluteTolerance"] = 1; json.dump(v, open(o + "tol-abs1.json", "w"))
v = cp(); v["metrics"]["contact_replay.estimated"]["absoluteTolerance"] = 0.5; json.dump(v, open(o + "tol-abs05.json", "w"))
v = cp(); v["contractVersion"] = 2; json.dump(v, open(o + "tol-contract2.json", "w"))
v = cp(); v["metrics"]["contact_replay.estimated"]["absoluteTolerance"] = -1; json.dump(v, open(o + "tol-neg.json", "w"))
v = cp(); v["metrics"]["contact_replay.estimated"]["direction"] = "sideways"; json.dump(v, open(o + "tol-baddir.json", "w"))
v = cp(); v["metrics"]["zzz.stale_metric"] = {"direction": "higher_is_better", "absoluteTolerance": 0, "rationale": "stale"}; json.dump(v, open(o + "tol-stale-entry.json", "w"))
PYEOF
run_case t01-unlisted-informational   direct compare "$O/m25-unlisted-both.json" "$O/m25-unlisted-both.json" --tolerances "$O/tol-unlisted-info.json"  # 0
run_case t02-lost-not-regression      direct compare "$BASE" "$O/m07-lost.json" --tolerances "$O/tol-lost-ok.json"        # 0
run_case t03-abs-tolerance-1          direct compare "$BASE" "$O/m05-regressed.json" --tolerances "$O/tol-abs1.json"       # 0 (|Δ|=1 <= 1)
run_case t03b-abs-tolerance-0.5       direct compare "$BASE" "$O/m05-regressed.json" --tolerances "$O/tol-abs05.json"      # 1
run_case t04-tol-contract2            direct compare "$BASE" "$CAND" --tolerances "$O/tol-contract2.json"                  # 3
run_case t05-tol-negative             direct compare "$BASE" "$CAND" --tolerances "$O/tol-neg.json"                        # 2
run_case t06-tol-bad-direction        direct compare "$BASE" "$CAND" --tolerances "$O/tol-baddir.json"                     # 2
run_case t07-tol-stale-entry          direct compare "$BASE" "$CAND" --tolerances "$O/tol-stale-entry.json"                # 0, silent

# --- partial run vs the full baseline ----------------------------------------
run_case p01-run-only-contact         direct run --out-dir "$O" --run-id only-cr --only contact_replay
run_case p02-compare-partial          direct compare "$BASE" "$O/only-cr.json"            # 1 (8 benches missing_in_candidate)
run_case p03-compare-partial-reverse  direct compare "$O/only-cr.json" "$BASE"            # 0 (new_in_candidate never fails)

# --- pnpm wrapper ------------------------------------------------------------
run_case w01-pnpm-json-nosilent       pnpm --filter @pickle/evaluation bench:compare "$BASE" "$CAND" --json
python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$E/w01-pnpm-json-nosilent.log" > "$E/w01-parse.log" 2>&1; echo "w01-json-parse exit=$?" | tee -a "$RES"   # 1 without -s (banner)
run_case w02-pnpm-json-silent         viapnpm bench:compare "$BASE" "$CAND" --json
python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$E/w02-pnpm-json-silent.log" > "$E/w02-parse.log" 2>&1; echo "w02-json-parse exit=$?" | tee -a "$RES"
run_case w03-pnpm-exit3               viapnpm bench:compare "$BASE" "$O/m01-contract2.json"   # 3 on pnpm 10, 1 on pnpm 9
run_case w04-pnpm-exit2               viapnpm bench:compare "$BASE" "$O/m03-evclass.json"     # 2 on pnpm 10, 1 on pnpm 9
run_case w05-pnpm-exit1               viapnpm bench:compare "$BASE" "$O/m05-regressed.json"
run_case w06-pnpm-relpath             viapnpm bench:compare datasets/reports/regression/baseline.json "$CAND"
echo "pnpm-version $(pnpm --version)" | tee -a "$RES"

git status --porcelain > "$E/git-status-after.txt"
echo "git-status-lines $(wc -l < "$E/git-status-after.txt")" | tee -a "$RES"
