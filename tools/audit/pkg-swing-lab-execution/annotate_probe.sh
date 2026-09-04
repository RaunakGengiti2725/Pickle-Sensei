#!/usr/bin/env bash
# Audit harness: drive packages/swing-lab/src/annotate.ts through startup and
# route states (missing root, empty root, non-bundle directory, valid save +
# revision bump, malformed body). Prints one TSV line per probe:
#   probe<TAB>http_status_or_exit<TAB>body_excerpt
# Usage: annotate_probe.sh <repo-root> <out-dir>
set -u
REPO=${1:?repo root}
OUT=${2:?out dir}
PKG="$REPO/packages/swing-lab"
mkdir -p "$OUT"
PORT=4799

start() { # start <rootdir> ; sets PID, waits for listen or exit
  setsid bash -c "cd '$PKG' && exec npx tsx src/annotate.ts '$1' $PORT" > "$OUT/server-$2.log" 2>&1 &
  PID=$!
  for _ in $(seq 1 40); do
    if grep -q "annotation bench" "$OUT/server-$2.log" 2>/dev/null; then sleep 0.3; return 0; fi
    if ! kill -0 $PID 2>/dev/null; then return 1; fi
    sleep 0.25
  done
  return 1
}
stop() {
  kill -TERM -- -$PID 2>/dev/null; wait $PID 2>/dev/null; SERVER_EXIT=$?
  for _ in $(seq 1 20); do ss -ltn 2>/dev/null | grep -q ":$PORT " || break; sleep 0.25; done
}
req() { # req <name> <curl args...>
  local name=$1; shift
  local code
  code=$(curl -s -o "$OUT/$name.body" -w "%{http_code}" "$@")
  printf "%s\t%s\t%s\n" "$name" "$code" "$(head -c 160 "$OUT/$name.body" | tr '\n' ' ')" | tee -a "$OUT/results.tsv"
}
: > "$OUT/results.tsv"

# 1. root directory does not exist
start /nonexistent-annotate-root nonexistent; started=$?
sleep 1.5
if kill -0 $PID 2>/dev/null; then alive=alive; else alive=dead; fi
stop
printf "startup:nonexistent-root\tstarted=%s alive_after_1.5s=%s exit=%s\t%s\n" "$started" "$alive" "$SERVER_EXIT" "$(grep -m1 -o 'Error: [^,]*' "$OUT/server-nonexistent.log" | head -c 160)" | tee -a "$OUT/results.tsv"

# 2. empty root directory
EMPTY=$(mktemp -d)
start "$EMPTY" empty; started=$?
printf "startup:empty-root\tstarted=%s\t%s\n" "$started" "$(grep -m1 'bundles found' "$OUT/server-empty.log")" | tee -a "$OUT/results.tsv"
req empty:bundles "http://127.0.0.1:$PORT/api/bundles"
req empty:clip-missing "http://127.0.0.1:$PORT/api/clip?bundle=nope"
stop

# 3. root with one real bundle + one non-bundle directory + a plain file
ROOT=$(mktemp -d)
mkdir -p "$ROOT/real-bundle" "$ROOT/not-a-bundle"
cp "$REPO/datasets/paddle-bench/bundles/wm-volley-02/clip.mp4" "$ROOT/real-bundle/clip.mp4"
echo hi > "$ROOT/plainfile.txt"
start "$ROOT" mixed; started=$?
printf "startup:mixed-root\tstarted=%s\t%s\n" "$started" "$(grep -m1 'bundles found' "$OUT/server-mixed.log")" | tee -a "$OUT/results.tsv"
req mixed:bundles "http://127.0.0.1:$PORT/api/bundles"
req mixed:get-nonbundle-dir "http://127.0.0.1:$PORT/api/annotation?bundle=not-a-bundle&annotator=x"
req mixed:get-plainfile "http://127.0.0.1:$PORT/api/annotation?bundle=plainfile.txt&annotator=x"
req mixed:get-traversal "http://127.0.0.1:$PORT/api/annotation?bundle=..%2Freal-bundle&annotator=x"
req mixed:clip-nonbundle "http://127.0.0.1:$PORT/api/clip?bundle=not-a-bundle"
req mixed:clip-plainfile "http://127.0.0.1:$PORT/api/clip?bundle=plainfile.txt"
VALID='{"schemaVersion":1,"captureBundle":"%s","annotatorId":"auditor","stroke":"unsure","analyzable":false,"annotatorConfidence":0.5,"faults":[],"checkpointScores":{},"paddleFrames":[],"ballFrames":[],"otherPaddleFrames":[],"events":[]}'
req mixed:post-valid-1 -X POST --data "$(printf "$VALID" real-bundle)" "http://127.0.0.1:$PORT/api/annotation"
req mixed:post-valid-2 -X POST --data "$(printf "$VALID" real-bundle)" "http://127.0.0.1:$PORT/api/annotation"
req mixed:get-after-post "http://127.0.0.1:$PORT/api/annotation?bundle=real-bundle&annotator=auditor"
req mixed:post-nonbundle-dir -X POST --data "$(printf "$VALID" not-a-bundle)" "http://127.0.0.1:$PORT/api/annotation"
req mixed:post-plainfile -X POST --data "$(printf "$VALID" plainfile.txt)" "http://127.0.0.1:$PORT/api/annotation"
req mixed:post-unknown-bundle -X POST --data "$(printf "$VALID" ghost)" "http://127.0.0.1:$PORT/api/annotation"
req mixed:post-empty-body -X POST --data "" "http://127.0.0.1:$PORT/api/annotation"
req mixed:post-not-json -X POST --data "not json" "http://127.0.0.1:$PORT/api/annotation"
req mixed:post-json-null -X POST --data "null" "http://127.0.0.1:$PORT/api/annotation"
req mixed:post-bad-annotator -X POST --data "$(printf "$VALID" real-bundle | sed 's/"auditor"/"..\/x"/')" "http://127.0.0.1:$PORT/api/annotation"
# corrupt annotation file on disk -> silently dropped?
echo '{not json' > "$ROOT/real-bundle/annotation/broken.json"
req mixed:bundles-with-corrupt-annotation "http://127.0.0.1:$PORT/api/bundles"
req mixed:unknown-route "http://127.0.0.1:$PORT/api/nope"
stop
printf "server:mixed-exit-on-SIGTERM\t%s\t%s\n" "$SERVER_EXIT" "$(tail -c 160 "$OUT/server-mixed.log" | tr '\n' ' ')" | tee -a "$OUT/results.tsv"
echo "written-to-non-bundle-dir: $(ls "$ROOT/not-a-bundle/annotation" 2>/dev/null | tr '\n' ' ')" | tee -a "$OUT/results.tsv"
echo "real-bundle annotations: $(ls "$ROOT/real-bundle/annotation" | tr '\n' ' ')" | tee -a "$OUT/results.tsv"
rm -rf "$EMPTY" "$ROOT"
