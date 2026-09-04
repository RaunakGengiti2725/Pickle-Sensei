// Records fixtures/billing_sync_replay.json from the REAL edge handler so the
// mobile jest replay (apps/mobile/__tests__/attack/s2s3EdgeReplay.attack.test.ts)
// parses genuine server bytes. Re-run only when the edge response shape changes;
// billing_sync_attack.test.ts pins the committed file against the live handler.
//
// Run: deno run -A --no-check --config deno.json attack_billing_pass3/record_fixture.ts
//   (inside supabase/functions/api/__wf__/)

import { buildFixture } from "./syncProbes.ts";

const target = new URL("./fixtures/billing_sync_replay.json", import.meta.url);
const fixture = await buildFixture();
await Deno.mkdir(new URL("./fixtures/", import.meta.url), { recursive: true });
await Deno.writeTextFile(target, JSON.stringify(fixture, null, 2) + "\n");
console.warn(`wrote ${target.pathname}`);
