// Static pin: every edge mutant in tools/mutation-auth/mutants.json must still
// apply to supabase/functions/api/index.ts (its `find` snippet occurs exactly
// once). `node tools/mutation-auth/run.mjs` records a non-applying mutant as
// "invalid" and silently drops it from the kill matrix — so a refactor of the
// mutated region shrinks the auth mutation coverage without any test going red.
//
// On a6fb880a ED-03 and ED-18 (authenticate() provider branch: the removed
// `signIn.data.user` / `signIn.error || !signIn.data.user || !signIn.data.session`
// snippets) occur 0 times; on f702f0f8 all 22 edge mutants occur exactly once.
//
//   cd supabase/functions/api/__wf__ && \
//     deno test -A --no-check --config deno.json attack_eacr1_mutants_apply_test.ts
import { assertEquals } from "@std/assert";

const here = new URL(".", import.meta.url);
const repoRoot = new URL("../../../../", here);

interface Mutant {
  id: string;
  plane: "mobile" | "edge";
  file: string;
  symbol: string;
  find: string;
}

const mutants = (
  JSON.parse(await Deno.readTextFile(new URL("tools/mutation-auth/mutants.json", repoRoot))) as {
    mutants: Mutant[];
  }
).mutants.filter((m) => m.plane === "edge");

const sources = new Map<string, string>();
for (const m of mutants) {
  if (!sources.has(m.file)) {
    sources.set(m.file, await Deno.readTextFile(new URL(m.file, repoRoot)));
  }
}

Deno.test(
  "mutation-auth: every edge mutant's find snippet occurs exactly once in its target",
  () => {
    const drifted = mutants
      .map((m) => ({ ...m, occurrences: sources.get(m.file)!.split(m.find).length - 1 }))
      .filter((m) => m.occurrences !== 1)
      .map((m) => `${m.id} (${m.symbol}) occurs ${m.occurrences}× in ${m.file}`);
    assertEquals(
      drifted,
      [],
      "mutants that no longer apply are reported 'invalid' by tools/mutation-auth/run.mjs and " +
        "vanish from the kill matrix — update mutants.json alongside the refactor",
    );
  },
);
