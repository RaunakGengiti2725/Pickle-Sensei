/**
 * W06-01 adversarial attack — can the Edge/Deno plane even load the candidate's
 * canonical definition through `computePlayerRank`?
 *
 * The repo's SQL/Edge rank parity check (be-edge-routes-shots-rank.test.ts)
 * imports packages/shared-types/src/playerRank.ts under this directory's
 * deno.json (`deno task test`). On BASE that module has no imports and loads.
 * The candidate adds `import ... from "./scoringDefinition.js"` (NodeNext
 * style) — Deno's strict resolution has no such file and no import-map
 * alias exists for it, so the module fails at load time.
 *
 * Run (CI form):  cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json attack_w06_01_deno_import.test.ts
 */
import { computePlayerRank } from "../../../../packages/shared-types/src/playerRank.ts";

Deno.test(
  "W06-01 attack: playerRank.ts (and thus SCORING_DEFINITION) loads under the __wf__ Deno config",
  () => {
    if (computePlayerRank([]) !== null) throw new Error("no evidence must be null");
  },
);
