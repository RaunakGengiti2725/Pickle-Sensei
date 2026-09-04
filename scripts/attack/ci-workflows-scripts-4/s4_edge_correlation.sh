#!/usr/bin/env bash
# S4 — tools/diagnostics/edge_error_taxonomy.ts must FAIL (exit 1) when the
# correlation contract drifts. In a scratch worktree the __wf__ routesHarness's
# Deno.serve capture is wrapped so that one route's response
#   (a) loses x-request-id entirely,
#   (b) carries an x-request-id that no access line matches,
#   (c) carries the id of a DIFFERENT request (stale/constant id),
# and the probe must exit 1 each time, naming the probe. Baseline must exit 0.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

OUT="$ATTACK_EVIDENCE/s4"
rm -rf "$OUT" && mkdir -p "$OUT"
command -v deno >/dev/null || { log "deno missing"; exit 2; }

WT="$(scratch_worktree s4)"
trap 'remove_worktree "$WT"' EXIT
cd "$WT" || exit 2
HARNESS=supabase/functions/api/__wf__/routesHarness.ts
DENO=(deno run -A --no-check --config supabase/functions/api/__wf__/deno.json tools/diagnostics/edge_error_taxonomy.ts)

run_probe() { # $1 label → prints exit code, writes $OUT/$1.{txt,json}
  local rc=0
  "${DENO[@]}" >"$OUT/$1.txt" 2>&1 || rc=$?
  "${DENO[@]}" --json >"$OUT/$1.json" 2>/dev/null || true
  echo "$rc"
}

# Wrap the captured handler. $1 = JS body operating on (req, res, h) returning a Response.
patch_harness() {
  git checkout -q -- "$HARNESS"
  python3 - "$HARNESS" "$1" <<'PY'
import sys, pathlib
path, body = sys.argv[1], sys.argv[2]
src = pathlib.Path(path).read_text()
needle = "    state.handler = handler;\n"
assert needle in src, "anchor not found"
wrapped = (
    "    state.handler = async (req: Request): Promise<Response> => {\n"
    "      const res = await handler(req);\n"
    "      const h = new Headers(res.headers);\n"
    f"      {body}\n"
    "      return new Response(res.body, { status: res.status, headers: h });\n"
    "    };\n"
)
pathlib.Path(path).write_text(src.replace(needle, wrapped, 1))
PY
}

ROUTE='/functions/v1/api/v1/me/access'

rc="$(run_probe baseline)"
assert_eq "baseline probe exits 0" 0 "$rc"
assert_grep "baseline reports 15/15 correlated" "15/15 correlated" "$OUT/baseline.txt"

patch_harness "if (new URL(req.url).pathname === \"$ROUTE\") h.delete(\"x-request-id\");"
rc="$(run_probe drop-header)"
assert_eq "dropped x-request-id on $ROUTE → exit 1" 1 "$rc"
assert_grep "dropped header names the failing probe" "FAIL correlation: (missing|malformed) bearer" "$OUT/drop-header.txt"
assert_grep "dropped header: correlated count < 15" "1[0-3]/15 correlated" "$OUT/drop-header.txt"

patch_harness "if (new URL(req.url).pathname === \"$ROUTE\") h.set(\"x-request-id\", \"attack-\" + crypto.randomUUID());"
rc="$(run_probe unmatched-id)"
assert_eq "unmatched x-request-id (no access line) → exit 1" 1 "$rc"

patch_harness "if (h.has(\"x-request-id\")) h.set(\"x-request-id\", \"00000000-0000-4000-8000-000000000000\");"
rc="$(run_probe constant-id)"
assert_eq "constant x-request-id on every response → exit 1" 1 "$rc"

# Taxonomy drift: a wrong status on one route must also fail.
patch_harness "if (new URL(req.url).pathname === \"$ROUTE\" && res.status === 401) return new Response(res.body, { status: 403, headers: h });"
rc="$(run_probe wrong-status)"
assert_eq "status drift 401→403 on $ROUTE → exit 1" 1 "$rc"

git checkout -q -- "$HARNESS"
rc="$(run_probe restored)"
assert_eq "restored harness exits 0 again" 0 "$rc"

finish
