// Structural audit #2 (edge-domain-routes) — thin layer over routesHarness.ts.
// Adds a per-test fetch interceptor (so one PostgREST/provider call can be
// delayed, failed or answered with a specific row) plus the fixtures the
// probes share. Every request still goes through the REAL ../index.ts handler.

import {
  fakeAppleIdToken,
  fakeGoogleIdToken,
  type Harness,
  loadHarness,
  SUPABASE_URL,
} from "./routesHarness.ts";

export { fakeAppleIdToken, fakeGoogleIdToken, SUPABASE_URL };

export type Interceptor = (
  request: Request,
  body: unknown,
) => Promise<Response | null | undefined> | Response | null | undefined;

let interceptor: Interceptor | null = null;
let installed = false;

/** Loads the shared harness and installs the interceptor hook exactly once
 * (on top of the harness' own fetch stub). */
export async function loadStructuralHarness(): Promise<Harness> {
  const h = await loadHarness();
  if (!installed) {
    const stubbed = globalThis.fetch;
    globalThis.fetch =
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (interceptor) {
          const probe = new Request(input, init);
          const text = await probe.clone().text().catch(() => "");
          let body: unknown = null;
          if (text) {
            try {
              body = JSON.parse(text);
            } catch {
              body = text;
            }
          }
          const override = await interceptor(probe.clone(), body);
          if (override) return override;
          return stubbed(probe);
        }
        return stubbed(input, init);
      }) as typeof fetch;
    installed = true;
  }
  interceptor = null;
  return h;
}

export function intercept(fn: Interceptor | null): void {
  interceptor = fn;
}

export const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const restPath = (request: Request): string =>
  new URL(request.url).pathname.replace(/^\/rest\/v1\//, "");

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A Google ID token whose payload carries an extra claim so two bearers for
 * the SAME subject hash to different auth-cache keys (multi-device). */
export function distinctGoogleIdToken(sub: string, device: string): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      sub,
      jti: device,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  return `${header}.${payload}.sig`;
}

/** Deterministic per-test user ids keep the per-user rate budgets
 * (delete-confirm 5/h, shots 30/min, …) isolated between probes. */
export function userId(n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `aaaaaaaa-0000-4000-8000-${hex}`;
}

export const VERSION_VECTOR = {
  appVersion: "1.0.0",
  modelBundleVersion: "bundle-1",
  poseModelVersion: "pose-1",
  paddleModelVersion: "paddle-1",
  strokeDetectorVersion: "stroke-1",
  phaseModelVersion: "phase-1",
  scoringModelVersion: "scoring-1",
  shotConfigVersion: "config-1",
};

/** One canonical shots:sync entry (apps/mobile/src/data/sync.ts toSyncPayload). */
export function syncShot(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    analysisPermitId: crypto.randomUUID(),
    sessionId: null,
    source: "real",
    shotType: "dink",
    cameraView: "side",
    capturedAt: new Date().toISOString(),
    timestamps: { startMs: 0, contactMs: 400, endMs: 900 },
    resultKind: "scored",
    overallScore: 7.2,
    confidence: 0.9,
    phases: [{
      key: "prep",
      startMs: 0,
      representativeMs: 100,
      endMs: 300,
      confidence: 0.8,
    }],
    checkpoints: [
      {
        key: "contact_position",
        score: 71,
        confidence: 0.8,
        band: "green",
        direction: "ok",
        severity: 0.1,
        applicable: true,
      },
    ],
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
}

export async function readJson(
  response: Response,
): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** Resolves once `predicate` sees a recorded call, polling the harness. */
export async function waitForCall(
  h: Harness,
  predicate: (call: Harness["calls"][number]) => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (h.calls.some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("expected call was never made");
}

export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
} {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
