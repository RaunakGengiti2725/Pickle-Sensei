import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ANALYTICS_EVENT_NAMES } from "../src/index.js";

/**
 * Gate 15: the committed operational configuration (alert conditions +
 * SQL views) must stay consistent with the typed event taxonomy. A renamed
 * or removed event that a dashboard/alert still references is a silent
 * observability failure — this suite makes it a test failure instead.
 */

const observabilityDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "infra",
  "observability",
);

const eventNames = new Set<string>(ANALYTICS_EVENT_NAMES);

interface AlertCondition {
  kind: "rate" | "count" | "percentile" | "gauge";
  windowMinutes: number;
  threshold: number;
  comparator: ">" | "<" | ">=" | "<=";
  denominatorEvent?: string;
  field?: string;
  percentile?: number;
  minDenominator?: number;
  numeratorFilter?: Record<string, unknown>;
}

interface AlertDefinition {
  id: string;
  name: string;
  severity: "page" | "ticket";
  event: string;
  condition: AlertCondition;
  securitySensitive: boolean;
  runbook: string;
}

const alertsFile = JSON.parse(readFileSync(join(observabilityDir, "alerts.json"), "utf8")) as {
  version: string;
  alerts: AlertDefinition[];
};

describe("infra/observability/alerts.json", () => {
  it("is versioned and has unique alert ids", () => {
    expect(alertsFile.version).toMatch(/^observability-alerts-v\d+$/);
    const ids = alertsFile.alerts.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(10);
  });

  it("every alert references only events that exist in the taxonomy", () => {
    for (const alert of alertsFile.alerts) {
      expect(eventNames, `alert ${alert.id} event`).toContain(alert.event);
      if (alert.condition.denominatorEvent !== undefined) {
        expect(eventNames, `alert ${alert.id} denominatorEvent`).toContain(
          alert.condition.denominatorEvent,
        );
      }
    }
  });

  it("every alert has a well-formed, actionable condition", () => {
    for (const alert of alertsFile.alerts) {
      const c = alert.condition;
      expect(["rate", "count", "percentile", "gauge"]).toContain(c.kind);
      expect(c.windowMinutes).toBeGreaterThan(0);
      expect(Number.isFinite(c.threshold)).toBe(true);
      expect([">", "<", ">=", "<="]).toContain(c.comparator);
      if (c.kind === "rate") {
        expect(c.denominatorEvent, `alert ${alert.id} needs a denominator`).toBeDefined();
        expect(c.minDenominator, `alert ${alert.id} needs a min denominator`).toBeGreaterThan(0);
        expect(c.threshold).toBeGreaterThan(0);
        expect(c.threshold).toBeLessThanOrEqual(1);
      }
      if (c.kind === "percentile" || c.kind === "gauge") {
        expect(c.field, `alert ${alert.id} needs a field`).toBeDefined();
      }
      expect(["page", "ticket"]).toContain(alert.severity);
      expect(typeof alert.securitySensitive).toBe("boolean");
      expect(alert.runbook.length).toBeGreaterThan(20);
    }
  });

  it("covers the mandated alert families", () => {
    const byId = new Map(alertsFile.alerts.map((a) => [a.id, a]));
    for (const required of [
      "crash-spike",
      "analysis-failure-spike",
      "analysis-latency-spike",
      "backend-error-spike",
      "queue-backlog-growth",
    ]) {
      expect(byId.has(required), `missing mandated alert ${required}`).toBe(true);
    }
    expect(alertsFile.alerts.some((a) => a.securitySensitive)).toBe(true);
  });
});

describe("infra/observability/views.sql", () => {
  const sql = readFileSync(join(observabilityDir, "views.sql"), "utf8");

  it("references only event names that exist in the taxonomy", () => {
    // Every single-quoted snake_case literal that collides with the event
    // namespace must be a real event name (view/column names are unquoted).
    const literals = sql.match(/'([a-z][a-z0-9_]*)'/g) ?? [];
    const candidates = literals
      .map((l) => l.slice(1, -1))
      .filter((l) => l.includes("_") && !l.endsWith("Ms"));
    const nonEvents = new Set([
      // jsonb property keys used with ->> / ? — camelCase never collides, but
      // snake_case output aliases are matched too; list the known non-events:
      "reason_category",
      "model_version",
      "device_class",
      "thresholds_version",
      "algorithm_version",
      "app_build",
      "status_code",
      "error_code",
      "job_kind",
      "failure_kind",
      "max_depth",
    ]);
    const referenced = candidates.filter((c) => !nonEvents.has(c));
    expect(referenced.length).toBeGreaterThan(0);
    for (const name of referenced) {
      expect(eventNames, `views.sql references unknown event '${name}'`).toContain(name);
    }
  });

  it("defines a view for every mandated operational question", () => {
    for (const view of [
      "obs_analysis_hourly",
      "obs_abstention_reasons",
      "obs_analysis_latency",
      "obs_envelope_verdicts",
      "obs_target_lock_failures",
      "obs_event_proposal_failures",
      "obs_crash_rate",
      "obs_api_failures",
      "obs_worker_failures",
      "obs_queue_backlog",
    ]) {
      expect(sql).toContain(`CREATE OR REPLACE VIEW ${view}`);
    }
  });

  it("never selects raw media or personal columns", () => {
    for (const forbidden of ["'uri'", "'url'", "'email'", "'objectKey'", "'deviceId'"]) {
      expect(sql).not.toContain(forbidden);
    }
  });
});
