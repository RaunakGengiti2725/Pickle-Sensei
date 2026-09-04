// STRUCTURAL AUDIT #1 (edge-auth-cache-ratelimit) — do the "mirror" tests in
// this directory still describe index.ts? auth_session_cache_test.ts and
// cache.test.ts re-implement the auth-failure counter as a cache GET → +1 →
// SET on `authfail:<ip>` and cite index.ts line numbers for it. index.ts now
// counts through enforceRateLimit("authfail", …) (atomic INCR on an aligned
// window). A passing mirror of code that no longer exists is misleading
// evidence, so this probe checks the mirrors against the real source.
//
// Run: (cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json audit_s1_test_fidelity_test.ts)

import { assert, assertEquals } from "@std/assert";

const here = new URL(".", import.meta.url);
const index = await Deno.readTextFile(new URL("../index.ts", here));
const indexLines = index.split("\n");
const authSessionMirror = await Deno.readTextFile(
  new URL("./auth_session_cache_test.ts", here),
);
const cacheMirror = await Deno.readTextFile(new URL("./cache.test.ts", here));

Deno.test("index.ts counts auth failures through enforceRateLimit('authfail'), not a cache GET→SET counter", () => {
  assert(
    /enforceRateLimit\("authfail"/.test(index),
    "atomic INCR path present",
  );
  assert(/peekRateLimit\(\s*"authfail"/.test(index), "pre-auth peek present");
  assertEquals(
    /cacheSet\(\s*`authfail:/.test(index),
    false,
    "no cache-based authfail SET remains",
  );
  assertEquals(
    /cacheGet\(\s*`authfail:/.test(index),
    false,
    "no cache-based authfail GET remains",
  );
});

Deno.test("[defect] auth_session_cache_test.ts mirrors an `authfail:<ip>` GET→SET counter that index.ts no longer contains", () => {
  const mirrorsCounter = /cacheSet\(failKey, String\(failedRecently \+ 1\)/
    .test(authSessionMirror);
  assert(
    mirrorsCounter,
    "the mirror is present in the test file (precondition)",
  );
  // The mirror claims to be "verbatim" with cited lines. The cited lines must
  // contain the mirrored code for the test to be evidence about index.ts.
  const cited = [2090, 2152, 2153, 2154, 2171, 2173, 2174, 2175].map((n) =>
    indexLines[n - 1] ?? ""
  );
  const anyCitedLineMentionsAuthfail = cited.some((line) =>
    /authfail|AUTH_FAILURE_LIMIT/.test(line)
  );
  const indexHasMirroredCounter = /cacheSet\(\s*failKey/.test(index) ||
    /`authfail:\$\{ip\}`/.test(index);
  assert(
    anyCitedLineMentionsAuthfail && indexHasMirroredCounter,
    `auth_session_cache_test.ts cites index.ts:2090/2152-2161/2171-2177 for an authfail:<ip> cacheSet counter; ` +
      `cited lines mention authfail: ${anyCitedLineMentionsAuthfail}; index.ts contains the mirrored counter: ${indexHasMirroredCounter}`,
  );
});

Deno.test("[defect] cache.test.ts `[defect]` authfail tests describe a non-atomic GET→SET counter 'exactly as index.ts maintains it' — index.ts does not", () => {
  assert(
    /non-atomic GET → \+1 → SET/.test(cacheMirror),
    "precondition: the claim is in the file",
  );
  const indexHasMirroredCounter = /`authfail:\$\{ip\}`/.test(index);
  assert(
    indexHasMirroredCounter,
    "cache.test.ts:12-22 claims to mirror index.ts lines ~2152-2175, but index.ts has no `authfail:${ip}` cache counter (it uses enforceRateLimit at index.ts:2912-2913)",
  );
});
