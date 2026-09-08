#!/usr/bin/env bash
# Runtime/worker wiring only: all subprocesses are recorded fakes in an isolated
# checkout. Semantic product tests still run through the canonical stages.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/repo/scripts" "$WORK/repo/apps/mobile/node_modules" \
  "$WORK/repo/packages/database/node_modules/pg" "$WORK/root-bin" "$WORK/mobile-bin" "$WORK/tools"
cp "$REPO_ROOT/scripts/verify-cloud.sh" "$WORK/repo/scripts/verify-cloud.sh"
for pair in root:20.20.0 mobile:22.13.0; do
  name=${pair%%:*}; version=${pair#*:}
  cat >"$WORK/$name-bin/node" <<SH_NODE
#!/usr/bin/env bash
if [ "\${1:-}" = --version ]; then echo v$version; exit; fi
printf 'node|v$version|%s\\n' "\$*" >>"\$RUNTIME_TRACE"
SH_NODE
  chmod +x "$WORK/$name-bin/node"
done
for command in pnpm npm npx; do
  cat >"$WORK/tools/$command" <<'SH_TOOL'
#!/usr/bin/env bash
printf '%s|%s|%s|threads=%s|forks=%s\n' "$(basename "$0")" "$(node --version)" "$*" "${VITEST_MAX_THREADS:-unset}" "${VITEST_MAX_FORKS:-unset}" >>"$RUNTIME_TRACE"
SH_TOOL
  chmod +x "$WORK/tools/$command"
done
cat >"$WORK/tools/curl" <<'SH_CURL'
#!/usr/bin/env bash
exit 0
SH_CURL
chmod +x "$WORK/tools/curl"
export RUNTIME_TRACE="$WORK/trace"
export PATH="$WORK/root-bin:$WORK/tools:$PATH"
export VERIFY_ARTIFACTS="$WORK/artifacts"
export VERIFY_MOBILE_NODE_BIN="$WORK/mobile-bin"
export VERIFY_MAX_WORKERS=2
"$WORK/repo/scripts/verify-cloud.sh" --only deps,typecheck,test,mobile --fresh-deps >"$WORK/run.log" 2>&1
jq -e '.ok == true and (.stages | length == 4)' "$VERIFY_ARTIFACTS/summary.json" >/dev/null
for expected in \
  'pnpm|v20.20.0|install --frozen-lockfile|' \
  'pnpm|v20.20.0|-r --workspace-concurrency=2 typecheck|' \
  'pnpm|v20.20.0|test|threads=2|forks=2' \
  'npm|v22.13.0|ci --no-audit --no-fund|' \
  'npx|v22.13.0|tsc --noEmit|' \
  'npx|v22.13.0|jest --ci --silent --maxWorkers=2|' \
  'node|v22.13.0|--test scripts/generate-third-party-notices.test.mjs' \
  'node|v22.13.0|scripts/generate-third-party-notices.mjs --check'; do
  if ! grep -F "$expected" "$RUNTIME_TRACE" >/dev/null; then
    echo "[test_verify_cloud_runtime] missing command: $expected" >&2
    cat "$RUNTIME_TRACE" >&2
    exit 1
  fi
done
echo '[test_verify_cloud_runtime] PASS: root runtime preserved; mobile npm/tsc/Jest/notices use selected runtime; workers bounded'

export VERIFY_MOBILE_NODE_BIN="$WORK/missing"
if "$WORK/repo/scripts/verify-cloud.sh" --only mobile >"$WORK/missing.log" 2>&1; then
  echo '[test_verify_cloud_runtime] invalid mobile runtime unexpectedly passed' >&2
  exit 1
fi
jq -e '.ok == false and .stages[0].status == "unavailable"' "$VERIFY_ARTIFACTS/summary.json" >/dev/null
echo '[test_verify_cloud_runtime] PASS: invalid runtime is unavailable, never passed'

unset VERIFY_MOBILE_NODE_BIN
: >"$RUNTIME_TRACE"
"$WORK/repo/scripts/verify-cloud.sh" --only mobile >"$WORK/default.log" 2>&1
grep -F 'npx|v20.20.0|jest --ci --silent --maxWorkers=2|' "$RUNTIME_TRACE" >/dev/null
echo '[test_verify_cloud_runtime] PASS: omitted override preserves caller runtime for split CI jobs'

export VERIFY_MAX_WORKERS=0
if "$WORK/repo/scripts/verify-cloud.sh" --only mobile >"$WORK/workers.log" 2>&1; then
  echo '[test_verify_cloud_runtime] invalid worker bound unexpectedly passed' >&2
  exit 1
fi
grep -F 'VERIFY_MAX_WORKERS must be a positive integer' "$WORK/workers.log" >/dev/null
echo '[test_verify_cloud_runtime] PASS: invalid worker bounds fail before execution'
