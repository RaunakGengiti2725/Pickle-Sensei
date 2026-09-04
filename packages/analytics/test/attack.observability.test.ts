/**
 * Adversarial pass (shared-packages-ops #1, pass 3) — infra/observability.
 * Attacks the committed alert conditions + SQL views against the typed event
 * taxonomy at a level the existing Gate-15 suite does not: payload FIELD names
 * (not just event names), filter DSL shape, dangling `$schema`, and view
 * coverage of the newer ops events. `it(...)` = HELD / OBSERVED (pinned
 * current behaviour); `it.fails(...)` = EXPECTED contract that is currently
 * broken.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ANALYTICS_EVENT_NAMES, type AnalyticsEventName } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const observabilityDir = join(here, "..", "..", "..", "infra", "observability");
const alertsPath = join(observabilityDir, "alerts.json");
const viewsPath = join(observabilityDir, "views.sql");
const eventsSource = readFileSync(join(here, "..", "src", "index.ts"), "utf8");

interface AlertCondition {
  kind: string;
  windowMinutes: number;
  threshold: number;
  comparator: string;
  denominatorEvent?: string;
  field?: string;
  percentile?: number;
  minDenominator?: number;
  numeratorFilter?: Record<string, unknown>;
}
interface AlertDefinition {
  id: string;
  event: string;
  severity: string;
  condition: AlertCondition;
  securitySensitive: boolean;
}
const alertsFile = JSON.parse(readFileSync(alertsPath, "utf8")) as {
  $schema?: string;
  version: string;
  alerts: AlertDefinition[];
};
const sql = readFileSync(viewsPath, "utf8");

/**
 * Extract the declared payload keys of one member of the AnalyticsEvent union
 * by text (the union is a type — it has no runtime representation). Base keys
 * (at, sessionId, appBuild, deviceClass, …) are added from `interface Base`.
 */
function payloadKeys(event: string): Set<string> {
  const baseMatch = eventsSource.match(/interface Base \{([\s\S]*?)\n\}/);
  const keys = new Set<string>();
  for (const m of (baseMatch?.[1] ?? "").matchAll(/^\s*([a-zA-Z]+)\??:/gm)) keys.add(m[1]!);
  const idx = eventsSource.indexOf(`name: "${event}"`);
  expect(idx, `event ${event} not found in src/index.ts`).toBeGreaterThan(-1);
  const open = eventsSource.lastIndexOf("{", idx);
  let depth = 0;
  let end = open;
  for (let i = open; i < eventsSource.length; i++) {
    if (eventsSource[i] === "{") depth++;
    if (eventsSource[i] === "}") depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }
  const body = eventsSource.slice(open + 1, end);
  for (const m of body.matchAll(/(?:^|[;{\n])\s*([a-zA-Z]+)\??:/g)) keys.add(m[1]!);
  return keys;
}

describe("infra/observability/alerts.json — payload-level coherence", () => {
  it("HELD: every alert `field` and every numeratorFilter key exists on the referenced event's typed payload", () => {
    for (const alert of alertsFile.alerts) {
      const keys = payloadKeys(alert.event);
      if (alert.condition.field !== undefined) {
        expect(keys, `alert ${alert.id} field ${alert.condition.field}`).toContain(
          alert.condition.field,
        );
      }
      for (const key of Object.keys(alert.condition.numeratorFilter ?? {})) {
        expect(keys, `alert ${alert.id} numeratorFilter.${key}`).toContain(key);
      }
    }
  });

  it("OBSERVED: `$schema` points at ./alerts.schema.json, which does not exist — the file is validated only by the vitest gate, not by a JSON schema", () => {
    expect(alertsFile.$schema).toBe("./alerts.schema.json");
    expect(existsSync(join(observabilityDir, alertsFile.$schema!))).toBe(false);
  });

  it.fails("EXPECTED: a declared $schema resolves to a real file", () => {
    expect(existsSync(join(observabilityDir, alertsFile.$schema!))).toBe(true);
  });

  it("OBSERVED: numeratorFilter values use an ad-hoc string DSL ('>=500', 'in(401,403)') alongside raw booleans — no grammar is declared or validated anywhere in the repo", () => {
    const filterValues = alertsFile.alerts.flatMap((a) =>
      Object.values(a.condition.numeratorFilter ?? {}),
    );
    const strings = filterValues.filter((v): v is string => typeof v === "string");
    expect(strings.sort()).toEqual([">=500", "in(401,403)"]);
    expect(filterValues.filter((v) => typeof v === "boolean")).toHaveLength(2);
    // nothing outside this test file parses the DSL
    expect(sql).not.toMatch(/in\(401,403\)/);
  });

  it("HELD: percentile alerts declare a percentile in (0,100]; gauge/count thresholds are positive integers; windows are ≤ 24h", () => {
    for (const a of alertsFile.alerts) {
      const c = a.condition;
      if (c.kind === "percentile") {
        expect(c.percentile).toBeGreaterThan(0);
        expect(c.percentile).toBeLessThanOrEqual(100);
      }
      if (c.kind === "count" || c.kind === "gauge") {
        expect(Number.isInteger(c.threshold) && c.threshold > 0, a.id).toBe(true);
      }
      expect(c.windowMinutes).toBeLessThanOrEqual(1440);
    }
  });

  it("HELD: every `page`-severity alert is a rate or count with a denominator floor or absolute count (no percentile pages without a floor)", () => {
    for (const a of alertsFile.alerts.filter((x) => x.severity === "page")) {
      const c = a.condition;
      expect(["rate", "count"], a.id).toContain(c.kind);
      if (c.kind === "rate") expect(c.minDenominator, a.id).toBeGreaterThan(0);
    }
  });

  it("OBSERVED: the typed ops events queue_stalled / worker_crash / deletion_backlog / media_storage_failure have NO alert and NO view — a stalled deletion pipeline (privacy SLA) is invisible to this config", () => {
    const alerted = new Set(
      alertsFile.alerts.flatMap((a) => [a.event, a.condition.denominatorEvent].filter(Boolean)),
    );
    const viewed = new Set((sql.match(/'([a-z][a-z0-9_]*)'/g) ?? []).map((l) => l.slice(1, -1)));
    const uncovered: AnalyticsEventName[] = [];
    for (const name of [
      "queue_stalled",
      "worker_crash",
      "deletion_backlog",
      "media_storage_failure",
    ] as const) {
      expect(ANALYTICS_EVENT_NAMES).toContain(name);
      if (!alerted.has(name) && !viewed.has(name)) uncovered.push(name);
    }
    expect(uncovered).toEqual([
      "queue_stalled",
      "worker_crash",
      "deletion_backlog",
      "media_storage_failure",
    ]);
  });

  it.fails(
    "EXPECTED: deletion_backlog (typed for exactly this purpose — `exhausted` rows need a human) has an alert",
    () => {
      expect(alertsFile.alerts.some((a) => a.event === "deletion_backlog")).toBe(true);
    },
  );
});

describe("infra/observability/views.sql — payload-level coherence", () => {
  const viewBlocks = sql.split(/CREATE OR REPLACE VIEW /).slice(1);

  it("HELD: every `props ->> 'key'` in a single-event view names a key on that event's typed payload", () => {
    let checked = 0;
    for (const block of viewBlocks) {
      const single = block.match(/WHERE name = '([a-z_]+)'/);
      if (!single) continue;
      const keys = payloadKeys(single[1]!);
      for (const m of block.matchAll(/props ->> '([A-Za-z]+)'/g)) {
        expect(keys, `view ${block.split(" ")[0]} key ${m[1]}`).toContain(m[1]!);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(10);
  });

  it("OBSERVED: obs_crash_rate groups by props->>'appBuild' but appBuild is an OPTIONAL Base field — every crash from a build that omitted it lands in a NULL group; no view uses COALESCE", () => {
    expect(sql).toMatch(/props ->> 'appBuild' AS app_build/);
    expect(payloadKeys("app_crash")).toContain("appBuild");
    expect(eventsSource).toMatch(/appBuild\?:/);
    expect(sql).not.toMatch(/COALESCE/i);
  });

  it("OBSERVED: numeric casts are unguarded — `(props ->> 'statusCode')::int`, `(props ->> 'depth')::int`, `(props ->> 'fatal')::boolean` will abort the whole view on ONE malformed row (no NULLIF / regex guard)", () => {
    for (const cast of [
      "(props ->> 'statusCode')::int",
      "(props ->> 'depth')::int",
      "(props ->> 'fatal')::boolean",
    ]) {
      expect(sql).toContain(cast);
    }
    expect(sql).not.toMatch(/NULLIF|~ '\^/);
  });

  it("HELD: alert thresholds and view semantics agree on fatal-only crash rate and 5xx-only backend errors", () => {
    const crash = alertsFile.alerts.find((a) => a.id === "crash-spike")!;
    expect(crash.condition.numeratorFilter).toEqual({ fatal: true });
    expect(sql).toMatch(/name = 'app_crash' AND \(props ->> 'fatal'\)::boolean/);
    const backend = alertsFile.alerts.find((a) => a.id === "backend-error-spike")!;
    expect(backend.condition.numeratorFilter).toEqual({ statusCode: ">=500" });
  });

  it("HELD: the analysis-latency alert (p95 > 60000ms) and the SLO package default (analysis_latency_p95_ms max 15000 in rollout criteria) are at least ordered — alert fires only well past the rollout gate", () => {
    const latency = alertsFile.alerts.find((a) => a.id === "analysis-latency-spike")!;
    expect(latency.condition.percentile).toBe(95);
    expect(latency.condition.threshold).toBeGreaterThan(15000);
  });
});
