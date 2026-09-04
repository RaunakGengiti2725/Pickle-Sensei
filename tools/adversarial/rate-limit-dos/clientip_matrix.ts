// Adversarial matrix for the rate-limit IDENTITY: which part of a request
// decides the key that every pre-auth budget is charged against.
//
//   deno run -A tools/adversarial/rate-limit-dos/clientip_matrix.ts
//
// clientIp() (supabase/functions/api/http.ts:57-65) is the ONLY source of the
// `id` in `rl:<scope>:<bucket>:<id>` for the per-IP, auth-failure, refresh,
// public-page and webhook budgets. This harness enumerates header shapes an
// attacker can send and records, for each, the identity the limiter would use
// and whether that identity is attacker-chosen.

import { clientIp } from "../../../supabase/functions/api/http.ts";
import { outPath, println, writeReport } from "./report.ts";

const OUT = outPath("artifacts/xc-rate-limit-dos/clientip_matrix.json");

interface Case {
  name: string;
  headers: Record<string, string>;
  /** What the value the attacker typed into the request was. */
  attackerValue: string | null;
  /** Identity the attacker WANTS to be charged (null = wants no identity). */
  note: string;
}

const CLIENT = "198.51.100.9"; // the attacker's real peer address
const VICTIM = "203.0.113.7"; // a co-tenant / spoof target

const cases: Case[] = [
  {
    name: "no ip headers at all",
    headers: {},
    attackerValue: null,
    note: "fallback identity",
  },
  {
    name: "single xff hop (gateway-appended peer only)",
    headers: { "x-forwarded-for": CLIENT },
    attackerValue: null,
    note: "honest shape when the client sent no xff",
  },
  {
    name: "client-supplied leading xff hop, gateway appends peer",
    headers: { "x-forwarded-for": `${VICTIM}, ${CLIENT}` },
    attackerValue: VICTIM,
    note: "the 2026-09-01 fix: leftmost hop must NOT win",
  },
  {
    name: "client-supplied trailing xff hop (gateway does NOT append)",
    headers: { "x-forwarded-for": `${CLIENT}, ${VICTIM}` },
    attackerValue: VICTIM,
    note: "last hop wins, so a pass-through gateway hands the attacker the id",
  },
  {
    name: "xff with trailing comma / empty last hop",
    headers: { "x-forwarded-for": `${VICTIM}, ` },
    attackerValue: VICTIM,
    note: "empty hops are filtered, so the victim value survives",
  },
  {
    name: "xff of only separators",
    headers: { "x-forwarded-for": " , ,, " },
    attackerValue: null,
    note: "degenerates to the fallback identity",
  },
  {
    name: "cf-connecting-ip beats a 3-hop xff chain",
    headers: {
      "cf-connecting-ip": VICTIM,
      "x-forwarded-for": `${CLIENT}, 10.0.0.1, 10.0.0.2`,
    },
    attackerValue: VICTIM,
    note: "cf-connecting-ip is taken unconditionally, no allowlist of peers",
  },
  {
    name: "cf-connecting-ip that is not an IP at all",
    headers: { "cf-connecting-ip": "not-an-ip!#$%&'*+^_`|~" },
    attackerValue: "not-an-ip!#$%&'*+^_`|~",
    note: "no syntax validation: any header-legal token becomes a bucket",
  },
  {
    name: "cf-connecting-ip with an IPv6 zone + port shapes",
    headers: { "cf-connecting-ip": "[2001:db8::1%25eth0]:443" },
    attackerValue: "[2001:db8::1%25eth0]:443",
    note: "one host can present many spellings of one address = many buckets",
  },
  {
    name: "cf-connecting-ip 1 KiB long",
    headers: { "cf-connecting-ip": "9".repeat(1_024) },
    attackerValue: "9".repeat(1_024),
    note: "no length cap: key size is attacker-controlled (heap amplification)",
  },
  {
    name: "cf-connecting-ip 8 KiB long",
    headers: { "cf-connecting-ip": "9".repeat(8_192) },
    attackerValue: "9".repeat(8_192),
    note: "no length cap: key size is attacker-controlled (heap amplification)",
  },
  {
    name: "cf-connecting-ip padded with whitespace",
    headers: { "cf-connecting-ip": `  ${VICTIM}  ` },
    attackerValue: VICTIM,
    note: "trimmed, so padding is not a distinct bucket",
  },
  {
    name: "cf-connecting-ip carrying an rl: key prefix (key-confusion probe)",
    headers: {
      "cf-connecting-ip": "rl:user:0:11111111-1111-4111-8111-111111111111",
    },
    attackerValue: "rl:user:0:11111111-1111-4111-8111-111111111111",
    note: "can a colon-bearing id collide with another scope's key?",
  },
  {
    name: "cf-connecting-ip carrying an auth: cache prefix (key-confusion probe)",
    headers: { "cf-connecting-ip": "auth:deadbeef" },
    attackerValue: "auth:deadbeef",
    note: "can an id escape the rl: namespace into the session cache?",
  },
  {
    name: "cf-connecting-ip empty, xff present",
    headers: { "cf-connecting-ip": "", "x-forwarded-for": CLIENT },
    attackerValue: null,
    note: "empty edge header must fall through to xff",
  },
  {
    name: "cf-connecting-ip whitespace only, xff present",
    headers: { "cf-connecting-ip": "   ", "x-forwarded-for": CLIENT },
    attackerValue: null,
    note: "whitespace-only edge header must fall through to xff",
  },
];

/** The key rateLimit.ts builds (rateLimit.ts:47-50) for a given identity. */
function windowKey(scope: string, id: string, windowSeconds: number, nowMs: number): string {
  return `rl:${scope}:${Math.floor(nowMs / (windowSeconds * 1_000))}:${id}`;
}

const NOW = 1_780_000_000_000; // fixed clock so keys are reproducible
const identities = new Map<string, string>();
const rows = cases.map((c) => {
  const id = clientIp(new Request("https://example.test/v1/me", { headers: c.headers }));
  identities.set(c.name, id);
  const attackerControlled = c.attackerValue !== null && id === c.attackerValue.trim();
  return {
    case: c.name,
    headers: Object.fromEntries(
      Object.entries(c.headers).map(([k, v]) => [
        k,
        v.length > 48 ? `${v.slice(0, 32)}…(${v.length}B)` : v,
      ]),
    ),
    identity: id.length > 48 ? `${id.slice(0, 32)}…(${id.length}B)` : id,
    identityBytes: new TextEncoder().encode(id).length,
    ipBudgetKey: (() => {
      const k = windowKey("ip", id, 60, NOW);
      return k.length > 80 ? `${k.slice(0, 64)}…(${k.length}B)` : k;
    })(),
    attackerChosenIdentity: attackerControlled,
    note: c.note,
  };
});

// Key-confusion check: does any attacker-chosen identity produce a key that
// another scope (or the session cache) could also produce?
const scopes = ["ip", "authfail", "auth_refresh", "user", "healthz", "legal", "webhook"];
const collisions: Array<{ identity: string; key: string; alsoProducedBy: string }> = [];
for (const row of rows) {
  if (!row.attackerChosenIdentity) continue;
  const raw = identities.get(row.case) ?? "";
  for (const scope of scopes) {
    const key = windowKey(scope, raw, 60, NOW);
    for (const other of scopes) {
      if (other === scope) continue;
      const prefix = `rl:${other}:${Math.floor(NOW / 60_000)}:`;
      if (key.startsWith(prefix)) {
        collisions.push({
          identity: raw.slice(0, 48),
          key: key.slice(0, 96),
          alsoProducedBy: other,
        });
      }
    }
    if (key.startsWith("auth:")) {
      collisions.push({
        identity: raw.slice(0, 48),
        key: key.slice(0, 96),
        alsoProducedBy: "auth session cache",
      });
    }
  }
}

const report = {
  harness: "tools/adversarial/rate-limit-dos/clientip_matrix.ts",
  target: "supabase/functions/api/http.ts clientIp() + rateLimit.ts windowKey()",
  deno: Deno.version.deno,
  fixedClockMs: NOW,
  measuredAt: new Date().toISOString(),
  cases: rows,
  attackerChosenIdentities: rows.filter((r) => r.attackerChosenIdentity).length,
  totalCases: rows.length,
  keyConfusionCollisions: collisions,
};

for (const row of rows) {
  println(
    `${row.attackerChosenIdentity ? "ATTACKER-CHOSEN" : "gateway-derived "}  ` +
      `${row.case} → id=${row.identity} (${row.identityBytes}B)`,
  );
}
println(
  `attacker-chosen identities: ${report.attackerChosenIdentities}/${report.totalCases}; ` +
    `key-confusion collisions: ${collisions.length}`,
);
await writeReport(OUT, report);
