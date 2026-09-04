// Fault-injection layer over routesHarness.ts for the adversarial webhook /
// billing tests (`*_attack.test.ts`).
//
// routesHarness installs a fake `globalThis.fetch` whose PostgREST branch can
// only answer happy paths (GET → stubbed rows, POST/PATCH → 201) and whose
// RevenueCat branch is either "200 + subscriber" or "500". The attack tests
// need to inject the other shapes — a failed entitlement upsert, a failed
// webhook_events lookup, a 200 from RevenueCat without a subscriber object,
// a stateful webhook_events table — WITHOUT editing the shared harness.
//
// `loadAttackHarness()` calls `loadHarness()` and then wraps the installed
// fake fetch once with a dispatcher that consults an optional override first.
// Every call (overridden or not) is still recorded in `harness.calls`, so the
// existing `callsTo()` assertions keep working. Because supabase-js captures
// `globalThis.fetch` when a client is created, the wrapper must be installed
// before the FIRST request of the test module — which is exactly what happens
// when every test starts with `await loadAttackHarness()` and no other test
// module runs in this isolate (deno test gives each module its own).

import { loadHarness, type Harness, type RecordedCall } from "./routesHarness.ts";

export type FetchOverride = (
  request: Request,
  recorded: RecordedCall,
) => Response | null | Promise<Response | null>;

export interface AttackHarness extends Harness {
  /** Install (or clear with `null`) the override consulted before the fake fetch. */
  override(fn: FetchOverride | null): void;
}

let attackHarness: AttackHarness | null = null;
let currentOverride: FetchOverride | null = null;

export async function loadAttackHarness(): Promise<AttackHarness> {
  const base = await loadHarness();
  currentOverride = null;
  if (attackHarness) return attackHarness;

  const harnessFake = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!currentOverride) return harnessFake(input, init);
    const request = new Request(input, init);
    const probe = request.clone();
    const headers: Record<string, string> = {};
    probe.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    const text = await probe.text().catch(() => "");
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const recorded: RecordedCall = { url: request.url, method: request.method, headers, body };
    const hit = await currentOverride(request.clone(), recorded);
    if (hit) {
      base.calls.push(recorded);
      return hit;
    }
    return harnessFake(request);
  }) as typeof fetch;

  attackHarness = Object.assign(base, {
    override(fn: FetchOverride | null) {
      currentOverride = fn;
    },
  });
  return attackHarness;
}

export function pgError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ code, message, details: null, hint: null }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Run `fn` with an environment variable temporarily unset, restoring it after. */
export async function withEnvUnset(names: string[], fn: () => Promise<void>): Promise<void> {
  const saved = names.map((name) => [name, Deno.env.get(name)] as const);
  for (const name of names) Deno.env.delete(name);
  try {
    await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}
