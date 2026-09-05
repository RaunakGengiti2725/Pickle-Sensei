import type { Rng } from "./seededRng";

/**
 * Fault catalogue for the HTTP dependencies of the admin console (the Fastify
 * API behind the vite `/v1` proxy, the vite lab middleware behind `/api/*`,
 * `/datasets/**` and `/docs/COACHING.md`). One mode = one way a dependency
 * can misbehave: throw (network abort), reject (4xx/5xx), timeout/never
 * resolve (hang), malformed (non-JSON / truncated), partial (missing fields),
 * wrong type, slow. Both the browser harness (Playwright `page.route`) and the
 * node harness (mocked `fetch`) materialize the SAME catalogue so a seed means
 * the same fault on every layer.
 */
export const HTTP_FAULT_MODES = [
  "abort",
  "http500-json",
  "http500-html",
  "http502",
  "http503",
  "http504",
  "http401",
  "http403",
  "http404",
  "http429",
  "ok-nonjson",
  "ok-empty-body",
  "ok-null",
  "ok-empty-object",
  "ok-array",
  "ok-string",
  "ok-partial",
  "ok-wrong-type",
  "ok-truncated",
  "slow",
  "hang",
] as const;

export type HttpFaultMode = (typeof HTTP_FAULT_MODES)[number];

/** Modes where the dependency itself reported failure (the UI must show it). */
export const REJECTING_MODES: ReadonlySet<HttpFaultMode> = new Set<HttpFaultMode>([
  "abort",
  "http500-json",
  "http500-html",
  "http502",
  "http503",
  "http504",
  "http401",
  "http403",
  "http404",
  "http429",
]);

/** 2xx with a body that is not what the caller expects. */
export const MALFORMED_OK_MODES: ReadonlySet<HttpFaultMode> = new Set<HttpFaultMode>([
  "ok-nonjson",
  "ok-empty-body",
  "ok-null",
  "ok-empty-object",
  "ok-array",
  "ok-string",
  "ok-partial",
  "ok-wrong-type",
  "ok-truncated",
]);

export interface FaultBodies {
  /** Serialized good response — used by slow / truncated. */
  good: string;
  /** Expected top-level shape but inner fields missing. */
  partial: string;
  /** Expected top-level keys with the wrong JS types. */
  wrongType: string;
}

export type FaultResponse =
  | { kind: "abort" }
  | { kind: "hang" }
  | { kind: "respond"; status: number; contentType: string; body: string; delayMs: number };

const JSON_TYPE = "application/json; charset=utf-8";
const HTML_TYPE = "text/html; charset=utf-8";

export function materializeFault(
  mode: HttpFaultMode,
  rng: Rng,
  bodies: FaultBodies,
  goodStatus = 200,
): FaultResponse {
  const respond = (
    status: number,
    body: string,
    contentType = JSON_TYPE,
    delayMs = 0,
  ): FaultResponse => ({ kind: "respond", status, contentType, body, delayMs });
  switch (mode) {
    case "abort":
      return { kind: "abort" };
    case "hang":
      return { kind: "hang" };
    case "http500-json":
      return respond(
        500,
        JSON.stringify({
          error: { code: "INTERNAL", message: `injected failure #${rng.int(1000, 9999)}` },
        }),
      );
    case "http500-html":
      return respond(
        500,
        "<html><body><h1>500 Internal Server Error</h1></body></html>",
        HTML_TYPE,
      );
    case "http502":
      return respond(502, "Bad Gateway", "text/plain");
    case "http503":
      return respond(
        503,
        JSON.stringify({ error: { code: "UNAVAILABLE", message: "datastore unavailable" } }),
      );
    case "http504":
      return respond(504, "", "text/plain");
    case "http401":
      return respond(
        401,
        JSON.stringify({
          error: { code: "UNAUTHENTICATED", message: "Token verification failed" },
        }),
      );
    case "http403":
      return respond(
        403,
        JSON.stringify({ error: { code: "FORBIDDEN", message: "admin role required" } }),
      );
    case "http404":
      return respond(
        404,
        JSON.stringify({ error: { code: "NOT_FOUND", message: "no such resource" } }),
      );
    case "http429":
      return respond(
        429,
        JSON.stringify({ error: { code: "RATE_LIMITED", message: "slow down" } }),
      );
    case "ok-nonjson":
      return respond(goodStatus, "<!doctype html><html><body>index</body></html>", HTML_TYPE);
    case "ok-empty-body":
      return respond(goodStatus, "");
    case "ok-null":
      return respond(goodStatus, "null");
    case "ok-empty-object":
      return respond(goodStatus, "{}");
    case "ok-array":
      return respond(goodStatus, "[]");
    case "ok-string":
      return respond(goodStatus, JSON.stringify("unexpected string payload"));
    case "ok-partial":
      return respond(goodStatus, bodies.partial);
    case "ok-wrong-type":
      return respond(goodStatus, bodies.wrongType);
    case "ok-truncated": {
      const cut = Math.max(1, Math.floor(bodies.good.length * (0.3 + rng.float() * 0.6)));
      return respond(goodStatus, bodies.good.slice(0, cut));
    }
    case "slow":
      return respond(goodStatus, bodies.good, JSON_TYPE, rng.int(1200, 3500));
  }
}

/** The outcome vocabulary shared by every harness's JSON results table. */
export type Outcome =
  | "HELD"
  | "BROKEN_CRASH"
  | "BROKEN_SILENT"
  | "BROKEN_FAKE_SUCCESS"
  | "BROKEN_INFINITE_PENDING"
  | "BROKEN_NO_RESPONSE"
  | "BROKEN_STATE"
  | "BROKEN_NO_RECOVERY"
  | "BROKEN_WRONG_RESPONSE"
  | "HARNESS_ERROR";

export interface ResultRow {
  seed: number;
  scenario: string;
  outcome: Outcome;
  /** Free-form evidence: what was observed on screen / on the wire / on disk. */
  observed: string;
  /** Degradations that are not counted as BROKEN but that a reviewer should see. */
  notes: string[];
  durationMs: number;
}
