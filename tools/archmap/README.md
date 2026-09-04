# tools/archmap — executable architecture map & dependency graph

Zero-dependency Node (>= 20) harness that extracts the repository's architecture
from disk, evaluates invariants over it, and emits docs-ready JSON, Mermaid and
Markdown. Nothing here is hand-maintained except `critical-paths.json`
(the product critical paths and the external single points of failure, each
with the files that implement it — checked for existence by `CP-01`).

```
node tools/archmap/archmap.mjs [--out DIR] [--check] [--repeat N] [--probe route-probe.json]
node --test tools/archmap/test/*.test.mjs
```

| Flag           | Effect                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `--out DIR`    | Output directory (default `artifacts/archmap/<utc-stamp>/`, git-ignored).                                                                   |
| `--check`      | Exit `1` if any invariant fails.                                                                                                            |
| `--repeat N`   | Re-run extraction N times; record ms / heap / serialized bytes per iteration and assert byte-identical output (exit `3` on nondeterminism). |
| `--probe FILE` | Merge the black-box route-probe JSON (below) and add `ROUTE-03`, which cross-checks it against the static `ROUTE-01` verdict.               |

## Outputs

| File                 | Content                                                                                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `archmap.json`       | Full model: workspaces, import edges, native targets + bridges, edge/legacy/mobile routes, env vars, flags, workflows, scripts, migrations, datasets, artifacts, unverifiable surfaces, ML, critical paths, invariants, stale systems, summary, run `meta` (sha, repeat iterations with heap numbers). |
| `invariants.json`    | Every invariant with `status`, `details` (failures), `info`, and `replay` (exact command + focus id + inputs).                                                                                                                                                                                         |
| `env-matrix.json`    | Env var → consumers (file:line), templates it appears in, secret-likeness, plane (edge / legacy / mobile / CI).                                                                                                                                                                                        |
| `routes-matrix.json` | Edge-fn routes, Fastify routes, mobile client calls (method-aware, `:param`-normalised), and the merged probe if given.                                                                                                                                                                                |
| `stale-systems.json` | Canonical-vs-stale pairs (services/api vs edge fn, mac-smoke-test vs mac-full-verify, two migration trees, flags, env templates).                                                                                                                                                                      |
| `*.mmd`              | Mermaid: package graph, runtime systems, critical paths, workflows → scripts → stages.                                                                                                                                                                                                                 |
| `ARCHITECTURE.md`    | Human-readable report embedding all of the above.                                                                                                                                                                                                                                                      |

## Black-box route probe (Deno)

`edge/mobile_route_probe.ts` drives the production edge handler
(`supabase/functions/api/index.ts`) in-process through the existing test harness
(`__wf__/routesHarness.ts`) — no network, no secrets — and asks, for every
`/v1` path the mobile app calls, whether the router recognises `METHOD path`.
A router-level `404 "Unknown endpoint"` means unrouted; any other status
(including an application-level 404 for a made-up resource id) means routed.
Path parameters are substituted with a fixed UUID and the client IP sequence
is deterministic, so the output is replayable.

```
node tools/archmap/archmap.mjs --out /tmp/archmap
deno run -A --no-check --config supabase/functions/api/__wf__/deno.json \
  tools/archmap/edge/mobile_route_probe.ts /tmp/archmap/routes-matrix.json /tmp/archmap/route-probe.json
node tools/archmap/archmap.mjs --out /tmp/archmap --check --probe /tmp/archmap/route-probe.json
```

(`--no-check` because `index.ts` has documented pre-existing type errors; the
probe file itself type-checks clean.)

## Invariants

| ID           | Checks                                                                                                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEP-01..05   | Runtime dependency cycles (dev-only cycles are info), undeclared / unused workspace deps, `workspace:*` protocol, relative imports crossing package boundaries from runtime code.                    |
| MOB-01..02   | apps/mobile `@pickle/*` aliases agree across tsconfig / metro / jest; every `NativeModules.X` / `requireNativeComponent` name used by TS has an iOS native export.                                   |
| NAT-01..02   | App pod symlinks resolve to `native/` sources and match the podspec; SwiftPM local package dependencies resolve.                                                                                     |
| ROUTE-01..03 | Mobile → edge route coverage (static), rate-limit route families match served routes, black-box probe agreement.                                                                                     |
| ENV-01..04   | Env vars read by `services/*` vs `.env.example`; edge-fn secrets documented; `.env.example` keys with no consumer (info); no non-public secret literals in the mobile runtime config.                |
| WF-01..04    | Workflow-referenced scripts exist; self-hosted workflows have no PR trigger and explicit read-only `permissions:`; verify-cloud stages ↔ ci.yml in sync; Mac workflows do not duplicate each other.  |
| SCR-01       | Shell entry points: references resolve, strict mode on, no gate verdict masked with `\|\| true` (diagnostic probes are classified benign).                                                           |
| MIG-01       | Supabase migration filenames follow `YYYYMMDDHHMMSS_description.sql` and are unique; the legacy tree is flagged.                                                                                     |
| CP-01..02    | Every critical-path hop file and SPOF evidence file exists; critical-path HTTP routes are served by the edge function.                                                                               |
| FLAG-01      | Registry flags == seeded flags, plus reachability from the shipping app.                                                                                                                             |
| DATA-01      | Bench baseline / tolerances exist; dataset references resolve.                                                                                                                                       |
| ART-01       | Release manifest paths exist; artifact roots written by scripts are git-ignored (asked of `git check-ignore`).                                                                                       |
| UNV-01       | Surfaces Linux cannot verify (Swift/Vision/Xcode/iOS runtime) are enumerated; no skipped tests. Precondition-gated suites (`skipIf`, `x ? describe : describe.skip`, Deno `ignore:`) listed as info. |
| UNV-02       | Filesystem-gated suites gate on a path git tracks — a suite gated on a git-ignored path never runs on any CI plane yet reports "skipped".                                                            |
| SPOF-01      | Computed package-graph single points of failure (info).                                                                                                                                              |

Each result carries `replay: { command, focus, inputs }` so a failure can be
reproduced with exactly one command.
