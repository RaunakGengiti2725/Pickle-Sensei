// Adversarial pass 3 (db-rls-grants-isolation #1), scenario S1 — the route
// half of "can a Google user forge profiles.provider = 'apple'?".
//
// attack_rls_isolation_1.sql proves the UPDATE succeeds at the DB layer
// (provider is in the authenticated column grant). This static pin proves
// that nothing in the edge function TRUSTS the forged column: every
// provider-dependent decision and the deletion-survey stamp read
// `authed.provider` (derived from Supabase Auth app_metadata by
// providerOfUser), and the only reader of `profile.provider` is the bootstrap
// repair that overwrites it FROM the authenticated value.
//
//   deno test --no-config --allow-read supabase/tests/attack_rls_isolation_1_provider_stamp.test.ts

function ok(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const INDEX_TS = new URL("../functions/api/index.ts", import.meta.url);
const source = await Deno.readTextFile(INDEX_TS);

function bodyOf(fnName: string): string {
  const start = source.indexOf(`async function ${fnName}(`);
  ok(start >= 0, `${fnName} not found in index.ts`);
  const next = source.indexOf("\nasync function ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

Deno.test("S1: providerOfUser derives the provider from Auth app_metadata, never from profiles", () => {
  const start = source.indexOf("function providerOfUser(");
  ok(start >= 0, "providerOfUser missing");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  ok(body.includes("app_metadata"), "providerOfUser must read app_metadata");
  ok(!body.includes("profiles"), "providerOfUser must not consult public.profiles");
});

Deno.test("S1: the deletion survey stamps authed.provider, not the profile column", () => {
  const body = bodyOf("recordDeletionSurvey");
  ok(body.includes("provider: authed.provider"), "survey row must stamp authed.provider");
  ok(!/profile\.provider|profiles?\b.*\.provider/.test(body), "survey must not read profiles.provider");
});

Deno.test("S1: profile.provider is only ever READ to be repaired from authed.provider", () => {
  const reads = [...source.matchAll(/profile\.provider/g)].map((m) => m.index ?? -1);
  ok(reads.length >= 1, "expected the bootstrap repair to read profile.provider");
  for (const at of reads) {
    const line = source.slice(source.lastIndexOf("\n", at) + 1, source.indexOf("\n", at));
    ok(
      /if \(profile\.provider !== authed\.provider\)/.test(line),
      `unexpected trust of profile.provider: ${line.trim()}`,
    );
  }
  ok(
    source.includes('.update({ provider: authed.provider }).eq("id", authed.id)'),
    "bootstrap must overwrite the profile provider from the authenticated identity",
  );
});

Deno.test("S1: every provider-gated decision keys on authed.provider", () => {
  const gates = [...source.matchAll(/(\w+)\.provider === "apple"/g)].map((m) => m[1]);
  ok(gates.length >= 1, "expected at least one apple-specific gate");
  for (const receiver of gates) {
    ok(receiver === "authed", `provider gate reads ${receiver}.provider instead of authed.provider`);
  }
  ok(!/provider: profile\.provider/.test(source), "no response/row may echo profiles.provider");
});
