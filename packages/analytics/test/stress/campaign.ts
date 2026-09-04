/**
 * Boundary / malformed-input stress campaign for @pickle/analytics.
 *
 * Every iteration is derived from `baseSeed + i` and is replayable on its own
 * with `runIteration(unit, seed)`. The campaign returns one row per iteration
 * (seed → outcome); the vitest wrapper asserts on the invariants and optionally
 * writes the table as JSON (STRESS_OUT=<path>).
 *
 * Outcomes:
 *   HELD   — the invariant held for this input.
 *   BROKEN — the invariant was violated (a finding; the row carries the detail).
 *   INFO   — observation only (no invariant asserted, e.g. a timing sample).
 */
import {
  BufferedAnalytics,
  CATEGORICAL_DRIFT_METRICS,
  DEFAULT_RATE_CARD,
  DRIFT_THRESHOLDS,
  DriftMonitor,
  MAX_ANALYTICS_ARRAY_LENGTH,
  MAX_ANALYTICS_STRING_LENGTH,
  NUMERIC_DRIFT_BINS,
  NUMERIC_DRIFT_METRICS,
  RollingDistribution,
  ZERO_USAGE,
  addUsage,
  computeCost,
  computePsi,
  findPrivacyViolations,
  numericBinLabel,
  scaleUsage,
  type AnalyticsEvent,
  type CostComponent,
  type NumericDriftMetric,
  type PrivacyViolation,
  type RateCard,
  type UsageQuantities,
} from "../../src/index.js";
import {
  CONFUSABLE_VARIANTS,
  PII_FIXTURES,
  PROTO_KEYS,
  TRAVERSAL_IDS,
  countRecord,
  junkObservation,
  junkValue,
  lengthBoundaryString,
  normalizationPair,
  protoPollutionEvent,
  validEvent,
  type Malformed,
} from "./generators.js";
import { ASCII_PRINTABLE, ASCII_WORD, ASTRAL, CONTROL_CHARS, SeededRng } from "./seededRng.js";

export type Outcome = "HELD" | "BROKEN" | "INFO";
export type Unit = "guard" | "drift" | "cost";

export interface Row {
  seed: number;
  unit: Unit;
  category: string;
  invariant: string;
  outcome: Outcome;
  detail: string;
  ms?: number;
}

export interface CampaignOptions {
  baseSeed: number;
  iterations: number;
  /** Longest generated string (code units). Quadratic-regex cost grows with this. */
  maxString: number;
}

const RULES = new Set<PrivacyViolation["rule"]>([
  "uri_scheme",
  "filesystem_path",
  "email_address",
  "base64_blob",
  "oversized_string",
  "oversized_array",
  "forbidden_key",
]);

const ISO_AT = "2026-09-04T12:00:00.000Z";

function asEvent(value: unknown): AnalyticsEvent {
  return value as AnalyticsEvent;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.constructor.name}: ${error.message.slice(0, 80)}`;
  return `non-Error throw: ${String(error).slice(0, 80)}`;
}

function protoPolluted(marker: string): boolean {
  const probe: Record<string, unknown> = {};
  return probe[marker] !== undefined || probe["polluted"] !== undefined;
}

/** Guard run that must not throw; returns the violations or the thrown error. */
function guard(value: unknown): { violations?: PrivacyViolation[]; error?: string; ms: number } {
  const t0 = performance.now();
  try {
    const violations = findPrivacyViolations(asEvent(value));
    return { violations, ms: performance.now() - t0 };
  } catch (error) {
    return { error: describeError(error), ms: performance.now() - t0 };
  }
}

function wellTyped(violations: PrivacyViolation[]): boolean {
  return violations.every(
    (v) => typeof v.path === "string" && RULES.has(v.rule) && Object.keys(v).length === 2,
  );
}

function stringField(event: AnalyticsEvent, rng: SeededRng): string | null {
  const keys = Object.entries(event)
    .filter(([key, value]) => key !== "name" && key !== "at" && typeof value === "string")
    .map(([key]) => key);
  return keys.length === 0 ? null : rng.pick(keys);
}

/** Feed an event through BufferedAnalytics and report where it ended up. */
function trackOutcome(value: unknown): {
  error?: string;
  sent: number;
  dropped: number;
  reported: number;
} {
  const sent: AnalyticsEvent[] = [];
  let reported = 0;
  const sink = new BufferedAnalytics(
    async (batch) => {
      sent.push(...batch);
    },
    1,
    () => {
      reported++;
    },
  );
  try {
    sink.track(asEvent(value));
  } catch (error) {
    return {
      error: describeError(error),
      sent: sent.length,
      dropped: sink.droppedViolationCount(),
      reported,
    };
  }
  return {
    sent: sent.length + sink.pendingCount(),
    dropped: sink.droppedViolationCount(),
    reported,
  };
}

// ---------------------------------------------------------------------------
// Guard iterations
// ---------------------------------------------------------------------------

const GUARD_CATEGORIES = [
  "valid_event",
  "pii_injected",
  "wrong_types",
  "truncated_json",
  "proto_pollution",
  "numeric_edges",
  "control_chars",
  "oversized_string",
  "oversized_array",
  "length_boundary",
  "normalization_pair",
  "confusable_variant",
  "path_traversal_id",
  "future_schema",
  "empty_containers",
  "nested_numeric",
  "non_object_event",
  "unknown_name",
  "cyclic_or_hostile",
] as const;

export function runGuardIteration(seed: number, maxString: number): Row[] {
  const rng = new SeededRng(seed);
  const category = GUARD_CATEGORIES[seed % GUARD_CATEGORIES.length] ?? "valid_event";
  const rows: Row[] = [];
  const push = (invariant: string, outcome: Outcome, detail: string, ms?: number) =>
    rows.push({
      seed,
      unit: "guard",
      category,
      invariant,
      outcome,
      detail,
      ...(ms === undefined ? {} : { ms }),
    });

  switch (category) {
    case "valid_event": {
      const event = validEvent(rng);
      const r = guard(event);
      if (r.error) push("no_throw", "BROKEN", r.error);
      else {
        const clean = r.violations!.length === 0;
        push(
          "clean_event_passes",
          clean ? "HELD" : "BROKEN",
          clean ? event.name : JSON.stringify(r.violations),
        );
        const t = trackOutcome(event);
        push(
          "clean_event_buffered",
          t.sent === 1 && t.dropped === 0 ? "HELD" : "BROKEN",
          JSON.stringify(t),
        );
      }
      break;
    }
    case "pii_injected": {
      const event = validEvent(rng);
      const field = stringField(event, rng);
      if (!field) {
        push("pii_flagged", "INFO", `no string field on ${event.name}`);
        break;
      }
      const fixture = rng.pick(PII_FIXTURES);
      const prefix = rng.bool() ? "" : `${rng.string(rng.int(1, 20), ASCII_WORD)} `;
      const suffix = rng.bool() ? "" : ` ${rng.string(rng.int(1, 20), ASCII_WORD)}`;
      const injected: Malformed = { ...event, [field]: `${prefix}${fixture.payload}${suffix}` };
      const r = guard(injected);
      if (r.error) push("no_throw", "BROKEN", r.error);
      else {
        const rules = r.violations!.map((v) => v.rule);
        const flagged = rules.includes(fixture.rule as PrivacyViolation["rule"]);
        push(
          "pii_flagged",
          flagged ? "HELD" : "BROKEN",
          `${fixture.rule} via ${field}: [${rules.join(",")}] payload=${JSON.stringify(fixture.payload.slice(0, 60))}`,
        );
        if (r.violations!.length > 0) {
          const t = trackOutcome(injected);
          push(
            "violation_never_written",
            t.sent === 0 && t.dropped === 1 && t.reported === 1 ? "HELD" : "BROKEN",
            JSON.stringify(t),
          );
        }
      }
      break;
    }
    case "wrong_types": {
      const event: Malformed = { ...validEvent(rng) };
      const keys = Object.keys(event);
      const count = rng.int(1, keys.length);
      for (let i = 0; i < count; i++) event[rng.pick(keys)] = junkValue(rng);
      const r = guard(event);
      push(
        "no_throw",
        r.error ? "BROKEN" : "HELD",
        r.error ?? `${r.violations!.length} violations`,
      );
      if (r.violations)
        push(
          "typed_result",
          wellTyped(r.violations) ? "HELD" : "BROKEN",
          JSON.stringify(r.violations),
        );
      const t = trackOutcome(event);
      push("track_no_throw", t.error ? "BROKEN" : "HELD", t.error ?? JSON.stringify(t));
      break;
    }
    case "truncated_json": {
      const text = JSON.stringify(validEvent(rng));
      const cut = rng.int(0, text.length - 1);
      const truncated =
        text.slice(0, cut) + (rng.bool(0.2) ? rng.string(rng.int(1, 5), ASCII_PRINTABLE) : "");
      let parsed: unknown;
      try {
        parsed = JSON.parse(truncated);
      } catch (error) {
        push(
          "malformed_json_rejected_by_parser",
          "HELD",
          `${describeError(error).slice(0, 40)} @${cut}/${text.length}`,
        );
        break;
      }
      const r = guard(parsed);
      push(
        "no_throw",
        r.error ? "BROKEN" : "HELD",
        r.error ?? `parsed ${typeof parsed}; ${r.violations!.length} violations`,
      );
      break;
    }
    case "proto_pollution": {
      const { parsed, marker } = protoPollutionEvent(rng) as { parsed: unknown; marker: string };
      const r = guard(parsed);
      push(
        "no_throw",
        r.error ? "BROKEN" : "HELD",
        r.error ?? `${r.violations!.length} violations`,
      );
      const t = trackOutcome(parsed);
      push("no_prototype_pollution", protoPolluted(marker) ? "BROKEN" : "HELD", JSON.stringify(t));
      // Also as a category label inside the drift monitor.
      const monitor = new DriftMonitor(10);
      monitor.record({ deviceModel: rng.pick(PROTO_KEYS) });
      const snap = monitor.snapshot("device_model");
      push(
        "drift_label_no_pollution",
        protoPolluted(marker) || Object.getPrototypeOf(snap.counts) !== Object.prototype
          ? "BROKEN"
          : "HELD",
        JSON.stringify(Object.keys(snap.counts)),
      );
      break;
    }
    case "numeric_edges": {
      const event: Malformed = { ...validEvent(rng) };
      const numericKeys = Object.entries(event)
        .filter(([, v]) => typeof v === "number")
        .map(([k]) => k);
      const key = numericKeys.length ? rng.pick(numericKeys) : "latencyMs";
      const value = rng.pick([
        NaN,
        Infinity,
        -Infinity,
        -0,
        Number.MAX_VALUE,
        -Number.MAX_VALUE,
        2 ** 53 + 1,
        1e-320,
        -1,
      ]);
      event[key] = value;
      const r = guard(event);
      push(
        "no_throw",
        r.error ? "BROKEN" : "HELD",
        r.error ?? `${key}=${String(value)} → ${r.violations!.length} violations`,
      );
      const t = trackOutcome(event);
      push(
        "non_finite_number_observed",
        "INFO",
        `${key}=${String(value)} sent=${t.sent} dropped=${t.dropped}`,
      );
      break;
    }
    case "control_chars": {
      const event: Malformed = { ...validEvent(rng) };
      const field = stringField(asEvent(event), rng) ?? "failureKind";
      const text = rng.string(rng.int(1, 64), CONTROL_CHARS + ASCII_WORD);
      event[field] = rng.bool() ? `\u0000${text}` : text;
      const r = guard(event);
      push("no_throw", r.error ? "BROKEN" : "HELD", r.error ?? JSON.stringify(text.slice(0, 20)));
      if (r.violations)
        push(
          "typed_result",
          wellTyped(r.violations) ? "HELD" : "BROKEN",
          JSON.stringify(r.violations),
        );
      break;
    }
    case "oversized_string": {
      const event: Malformed = { ...validEvent(rng) };
      const field = stringField(asEvent(event), rng) ?? "failureKind";
      const length = rng.logInt(
        MAX_ANALYTICS_STRING_LENGTH + 1,
        Math.max(MAX_ANALYTICS_STRING_LENGTH + 1, maxString),
      );
      const alphabet = rng.pick([ASCII_WORD, ASCII_PRINTABLE, ASTRAL, "a", "a.", "a@"]);
      const text = rng.string(length, alphabet);
      event[field] = text;
      const r = guard(event);
      if (r.error) push("no_throw", "BROKEN", r.error, r.ms);
      else {
        const flagged = r.violations!.some(
          (v) => v.rule === "oversized_string" && v.path === field,
        );
        push(
          "oversized_flagged",
          flagged ? "HELD" : "BROKEN",
          `len=${text.length} alphabet=${JSON.stringify(alphabet.slice(0, 4))}`,
          r.ms,
        );
        const t = trackOutcome(event);
        push(
          "violation_never_written",
          t.sent === 0 && t.dropped === 1 ? "HELD" : "BROKEN",
          JSON.stringify(t),
        );
        push(
          "guard_time_ms",
          "INFO",
          `len=${text.length} alphabet=${JSON.stringify(alphabet.slice(0, 4))}`,
          r.ms,
        );
      }
      break;
    }
    case "oversized_array": {
      const length = rng.pick([
        MAX_ANALYTICS_ARRAY_LENGTH,
        MAX_ANALYTICS_ARRAY_LENGTH + 1,
        rng.int(33, 5000),
      ]);
      const event: Malformed = {
        name: "capture_envelope_verdict",
        at: ISO_AT,
        overall: "UNSUPPORTED",
        failedDimensions: Array.from({ length }, (_, i) => `d${i}`),
        notMeasuredCount: 0,
        thresholdsVersion: "v0.1",
      };
      const r = guard(event);
      if (r.error) push("no_throw", "BROKEN", r.error);
      else {
        const flagged = r.violations!.some((v) => v.rule === "oversized_array");
        const expected = length > MAX_ANALYTICS_ARRAY_LENGTH;
        push(
          "oversized_array_cap",
          flagged === expected ? "HELD" : "BROKEN",
          `len=${length} flagged=${flagged}`,
          r.ms,
        );
      }
      break;
    }
    case "length_boundary": {
      const b = lengthBoundaryString(rng);
      const event: Malformed = { name: "analysis_failed", at: ISO_AT, failureKind: b.text };
      const r = guard(event);
      if (r.error) push("no_throw", "BROKEN", r.error);
      else {
        const flagged = r.violations!.some((v) => v.rule === "oversized_string");
        const expected = b.codeUnits > MAX_ANALYTICS_STRING_LENGTH;
        push(
          "cap_is_utf16_code_units",
          flagged === expected ? "HELD" : "BROKEN",
          `codeUnits=${b.codeUnits} codepoints=${b.codepoints} graphemes=${b.graphemes} flagged=${flagged}`,
        );
      }
      break;
    }
    case "normalization_pair": {
      const pair = normalizationPair(rng);
      const a = guard({ name: "analysis_failed", at: ISO_AT, failureKind: pair.nfc });
      const b = guard({ name: "analysis_failed", at: ISO_AT, failureKind: pair.nfd });
      if (a.error || b.error) push("no_throw", "BROKEN", a.error ?? b.error ?? "");
      else {
        const ra = a
          .violations!.map((v) => v.rule)
          .sort()
          .join(",");
        const rb = b
          .violations!.map((v) => v.rule)
          .sort()
          .join(",");
        push(
          "nfc_nfd_same_verdict",
          ra === rb && ra.length > 0 ? "HELD" : "BROKEN",
          `nfc=[${ra}] nfd=[${rb}]`,
        );
      }
      break;
    }
    case "confusable_variant": {
      const variant = rng.pick(CONFUSABLE_VARIANTS);
      const r = guard({ name: "analysis_failed", at: ISO_AT, failureKind: variant.payload });
      if (r.error) push("no_throw", "BROKEN", r.error);
      else {
        const flagged = r.violations!.length > 0;
        push(
          "confusable_pii_flagged",
          flagged ? "HELD" : "BROKEN",
          `${variant.describes}: ${JSON.stringify(variant.payload)}`,
        );
      }
      break;
    }
    case "path_traversal_id": {
      const id = rng.pick(TRAVERSAL_IDS);
      const event: Malformed = rng.bool()
        ? { name: "drill_opened", at: ISO_AT, drillSlug: id }
        : { name: "shot_type_selected", at: ISO_AT, shotType: id };
      const r = guard(event);
      push(
        "no_throw",
        r.error ? "BROKEN" : "HELD",
        r.error ??
          `${JSON.stringify(id)} → ${r.violations!.map((v) => v.rule).join(",") || "none"}`,
      );
      const t = trackOutcome(event);
      push("track_no_throw", t.error ? "BROKEN" : "HELD", t.error ?? JSON.stringify(t));
      break;
    }
    case "future_schema": {
      const event: Malformed = {
        ...validEvent(rng),
        schemaVersion: rng.int(2, 99),
        [rng.string(rng.int(1, 12), ASCII_WORD)]: junkValue(rng),
      };
      const r = guard(event);
      push(
        "no_throw",
        r.error ? "BROKEN" : "HELD",
        r.error ?? `${r.violations!.length} violations`,
      );
      const t = trackOutcome(event);
      push("track_no_throw", t.error ? "BROKEN" : "HELD", t.error ?? JSON.stringify(t));
      break;
    }
    case "empty_containers": {
      const event: Malformed = {
        ...validEvent(rng),
        [rng.pick(["emptyArr", "emptyObj", "failedDimensions", "extra"])]: rng.pick([
          [],
          {},
          [[]],
          [{}],
          { a: [] },
        ]),
      };
      const r = guard(event);
      push(
        "no_throw",
        r.error ? "BROKEN" : "HELD",
        r.error ?? `${r.violations!.length} violations`,
      );
      if (r.violations)
        push(
          "typed_result",
          wellTyped(r.violations) ? "HELD" : "BROKEN",
          JSON.stringify(r.violations),
        );
      break;
    }
    case "nested_numeric": {
      // Pose-shaped numeric payload: up to 32×32×32 numbers under an unlisted key.
      const depth = rng.int(1, 3);
      const width = rng.int(2, MAX_ANALYTICS_ARRAY_LENGTH);
      const build = (d: number): unknown =>
        d === 0 ? rng.next() : Array.from({ length: width }, () => build(d - 1));
      const payload = build(depth);
      const event: Malformed = {
        name: "analysis_completed",
        at: ISO_AT,
        shotType: "forehand_drive",
        confidenceBand: "normal",
        [rng.pick(["keypoints", "joints", "landmarks", "frames", "skeleton"])]: payload,
      };
      const r = guard(event);
      if (r.error) push("no_throw", "BROKEN", r.error);
      else {
        const numbers = width ** depth;
        push(
          "raw_signal_smuggling_blocked",
          r.violations!.length > 0 ? "HELD" : "BROKEN",
          `${numbers} numbers (${width}^${depth}) under unlisted key, ${JSON.stringify(event).length} bytes`,
          r.ms,
        );
      }
      break;
    }
    case "non_object_event": {
      const value = rng.pick<unknown>([
        null,
        undefined,
        0,
        1,
        true,
        false,
        "",
        "app_opened",
        [],
        [1, 2],
        42n,
        Symbol("e"),
      ]);
      const t = trackOutcome(value);
      push("track_no_throw", t.error ? "BROKEN" : "HELD", t.error ?? JSON.stringify(t));
      if (!t.error)
        push(
          "shape_validated",
          t.sent === 0 ? "HELD" : "BROKEN",
          `${typeof value} event sent=${t.sent}`,
        );
      break;
    }
    case "unknown_name": {
      const event: Malformed = {
        ...validEvent(rng),
        name: rng.pick([
          "",
          "NOPE",
          "app_opened ",
          "App_Opened",
          rng.string(8, ASCII_WORD),
          42,
          null,
        ]),
      };
      const t = trackOutcome(event);
      push("track_no_throw", t.error ? "BROKEN" : "HELD", t.error ?? JSON.stringify(t));
      if (!t.error)
        push(
          "shape_validated",
          t.sent === 0 ? "HELD" : "BROKEN",
          `name=${JSON.stringify(event["name"])} sent=${t.sent}`,
        );
      break;
    }
    case "cyclic_or_hostile": {
      const kind = rng.pick(["cycle", "deep", "getter", "proxy", "array_cycle"]);
      let value: unknown;
      if (kind === "cycle") {
        const e: Malformed = { ...validEvent(rng) };
        e["self"] = e;
        value = e;
      } else if (kind === "array_cycle") {
        const e: Malformed = { ...validEvent(rng) };
        const arr: unknown[] = [];
        arr.push(arr);
        e["dims"] = arr;
        value = e;
      } else if (kind === "deep") {
        const depth = rng.logInt(1000, 200_000);
        const root: Malformed = { ...validEvent(rng) };
        let cursor = root;
        for (let i = 0; i < depth; i++) {
          const next: Malformed = {};
          cursor["n"] = next;
          cursor = next;
        }
        value = root;
      } else if (kind === "getter") {
        const e: Malformed = { ...validEvent(rng) };
        Object.defineProperty(e, "boom", {
          enumerable: true,
          get() {
            throw new Error("hostile getter");
          },
        });
        value = e;
      } else {
        value = new Proxy(
          { ...validEvent(rng) },
          {
            ownKeys() {
              throw new Error("hostile proxy");
            },
          },
        );
      }
      const t = trackOutcome(value);
      push(
        "track_no_throw",
        t.error ? "BROKEN" : "HELD",
        `${kind}: ${t.error ?? JSON.stringify(t)}`,
      );
      break;
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Drift iterations
// ---------------------------------------------------------------------------

const DRIFT_CATEGORIES = [
  "junk_observations",
  "psi_random_counts",
  "psi_proto_labels",
  "bin_labels",
  "window_bounds",
  "null_observation",
  "long_labels",
] as const;

const ALL_METRICS = [...CATEGORICAL_DRIFT_METRICS, ...NUMERIC_DRIFT_METRICS];

function validBinLabels(metric: NumericDriftMetric): Set<string> {
  const edges = NUMERIC_DRIFT_BINS[metric];
  const labels = new Set<string>([`<${edges[0]}`, `>=${edges[edges.length - 1]}`]);
  for (let i = 1; i < edges.length; i++) labels.add(`[${edges[i - 1]},${edges[i]})`);
  return labels;
}

function finiteNumbers(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(finiteNumbers);
  if (value && typeof value === "object") return Object.values(value).every(finiteNumbers);
  return true;
}

export function runDriftIteration(seed: number, maxString: number): Row[] {
  const rng = new SeededRng(seed);
  const category = DRIFT_CATEGORIES[seed % DRIFT_CATEGORIES.length] ?? "junk_observations";
  const rows: Row[] = [];
  const push = (invariant: string, outcome: Outcome, detail: string) =>
    rows.push({ seed, unit: "drift", category, invariant, outcome, detail });

  switch (category) {
    case "junk_observations": {
      const max = rng.int(1, 300);
      const monitor = new DriftMonitor(max);
      const n = rng.int(1, 600);
      try {
        for (let i = 0; i < n; i++) monitor.record(junkObservation(rng) as never);
        if (rng.bool()) monitor.freezeReference();
        for (let i = 0; i < rng.int(0, 300); i++) monitor.record(junkObservation(rng) as never);
      } catch (error) {
        push("record_no_throw", "BROKEN", describeError(error));
        break;
      }
      push("record_no_throw", "HELD", `${n} junk observations`);
      let bounded = true;
      let consistent = true;
      for (const metric of ALL_METRICS) {
        const snap = monitor.snapshot(metric);
        const sum = Object.values(snap.counts).reduce((a, b) => a + b, 0);
        if (snap.totalSamples > max) bounded = false;
        if (
          sum !== snap.totalSamples ||
          Object.values(snap.counts).some((c) => !Number.isInteger(c) || c <= 0)
        )
          consistent = false;
      }
      push("window_bounded", bounded ? "HELD" : "BROKEN", `max=${max}`);
      push(
        "counts_consistent",
        consistent ? "HELD" : "BROKEN",
        "sum(counts)==totalSamples, counts positive ints",
      );
      const alerts = monitor.alerts(ISO_AT);
      const results = ALL_METRICS.map((m) => monitor.test(m));
      push(
        "no_nan_in_outputs",
        finiteNumbers(alerts) && finiteNumbers(results) ? "HELD" : "BROKEN",
        `${alerts.length} alerts`,
      );
      break;
    }
    case "psi_random_counts": {
      const bins = Array.from({ length: rng.int(1, 12) }, (_, i) => `b${i}`);
      const reference = countRecord(rng, bins);
      const current = countRecord(rng, bins);
      const psi = computePsi(reference, current);
      const ok = Number.isFinite(psi) && psi >= -1e-12;
      push("psi_finite_nonnegative", ok ? "HELD" : "BROKEN", `psi=${psi}`);
      const again = computePsi(reference, current);
      push("psi_deterministic", Object.is(psi, again) ? "HELD" : "BROKEN", `${psi} vs ${again}`);
      break;
    }
    case "psi_proto_labels": {
      const label = rng.pick(PROTO_KEYS);
      const side = rng.pick(["reference", "current", "both"]);
      const reference: Record<string, number> = { a: rng.int(1, 500) };
      const current: Record<string, number> = { a: rng.int(1, 500) };
      if (side !== "current") reference[label] = rng.int(1, 500);
      if (side !== "reference") current[label] = rng.int(1, 500);
      const psi = computePsi(reference, current);
      push(
        "psi_finite_nonnegative",
        Number.isFinite(psi) ? "HELD" : "BROKEN",
        `label=${label} side=${side} psi=${psi}`,
      );
      // Same label through the monitor: reference window has it, current does not (or vice versa).
      const monitor = new DriftMonitor(DRIFT_THRESHOLDS.minSamples);
      for (let i = 0; i < DRIFT_THRESHOLDS.minSamples; i++)
        monitor.record({ deviceModel: side === "current" ? "synthetic-a" : label });
      monitor.freezeReference();
      for (let i = 0; i < DRIFT_THRESHOLDS.minSamples; i++)
        monitor.record({ deviceModel: side === "reference" ? "synthetic-a" : label });
      const result = monitor.test("device_model");
      const alerts = monitor.alerts(ISO_AT).filter((a) => a.metric === "device_model");
      const expectDrift = side !== "both";
      const fine = finiteNumbers(result) && (!expectDrift || alerts.length === 1);
      push(
        "monitor_no_nan_and_alerts",
        fine ? "HELD" : "BROKEN",
        `label=${label} side=${side} result=${JSON.stringify(result)} alerts=${alerts.length}`,
      );
      break;
    }
    case "bin_labels": {
      const metric = rng.pick(NUMERIC_DRIFT_METRICS);
      const value = rng.pick([
        rng.next() * 10_000 - 100,
        -0,
        0,
        Number.MIN_VALUE,
        Number.MAX_VALUE,
        -Number.MAX_VALUE,
        Infinity,
        -Infinity,
        NaN,
        ...NUMERIC_DRIFT_BINS[metric],
        ...NUMERIC_DRIFT_BINS[metric].map((e) => e - Number.EPSILON * 10),
      ]);
      let label: string;
      try {
        label = numericBinLabel(metric, value);
      } catch (error) {
        push("bin_label_no_throw", "BROKEN", describeError(error));
        break;
      }
      const valid = validBinLabels(metric).has(label);
      if (Number.isNaN(value))
        push("nan_not_binned", "BROKEN", `${metric} NaN → ${JSON.stringify(label)}`);
      else
        push(
          "bin_label_in_frozen_set",
          valid ? "HELD" : "BROKEN",
          `${metric} ${String(value)} → ${label}`,
        );
      // Every finite value must land in exactly the bin that contains it.
      if (Number.isFinite(value)) {
        const edges = NUMERIC_DRIFT_BINS[metric];
        let idx = 0;
        for (const e of edges) if (value >= e) idx++;
        const expected =
          idx === 0
            ? `<${edges[0]}`
            : idx === edges.length
              ? `>=${edges[edges.length - 1]}`
              : `[${edges[idx - 1]},${edges[idx]})`;
        push(
          "bin_label_correct",
          label === expected ? "HELD" : "BROKEN",
          `${metric} ${String(value)} → ${label} (expected ${expected})`,
        );
      }
      break;
    }
    case "window_bounds": {
      const max = rng.pick([0, 1, 2, rng.int(3, 50), NaN, -1, Infinity, 0.5]);
      const dist = new RollingDistribution("device_model", max);
      const n = rng.int(1, 500);
      try {
        for (let i = 0; i < n; i++) dist.addCategory(rng.pick(["a", "b", "c", "d"]));
      } catch (error) {
        push("add_no_throw", "BROKEN", describeError(error));
        break;
      }
      const snap = dist.snapshot();
      const sum = Object.values(snap.counts).reduce((a, b) => a + b, 0);
      const boundedBy = Number.isFinite(max) && max >= 0 ? Math.floor(max) : n;
      push(
        "window_bounded",
        snap.totalSamples <= Math.max(boundedBy, 0) && sum === snap.totalSamples
          ? "HELD"
          : "BROKEN",
        `max=${String(max)} n=${n} total=${snap.totalSamples} sum=${sum}`,
      );
      if (!Number.isFinite(max) || max < 0 || !Number.isInteger(max))
        push(
          "non_integer_max_samples",
          "INFO",
          `max=${String(max)} → retained ${snap.totalSamples} of ${n}`,
        );
      break;
    }
    case "null_observation": {
      const monitor = new DriftMonitor();
      const value = rng.pick<unknown>([null, undefined, 42, "fps=30", [], true]);
      try {
        monitor.record(value as never);
        push("record_non_object_no_throw", "HELD", `${String(value)} ignored`);
      } catch (error) {
        push(
          "record_non_object_no_throw",
          "BROKEN",
          `record(${String(value)}) → ${describeError(error)}`,
        );
      }
      break;
    }
    case "long_labels": {
      const length = rng.logInt(1, Math.max(1, maxString));
      const label = rng.string(length, rng.pick([ASCII_WORD, ASTRAL, "a@b.c "]));
      const monitor = new DriftMonitor(50);
      monitor.record({ deviceModel: label, osVersion: `player@example.com/${length}` });
      const snap = monitor.snapshot("device_model");
      const stored = Object.keys(snap.counts)[0] ?? "";
      push(
        "label_stored_verbatim",
        "INFO",
        `len=${label.length} storedLen=${stored.length} exposedInSnapshot=${stored === label}`,
      );
      break;
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Cost iterations
// ---------------------------------------------------------------------------

const COST_CATEGORIES = [
  "invalid_quantity",
  "finite_quantity",
  "rate_card_junk",
  "scale_add",
  "partial_usage",
] as const;

const COMPONENTS = Object.keys(ZERO_USAGE) as CostComponent[];

export function runCostIteration(seed: number): Row[] {
  const rng = new SeededRng(seed);
  const category = COST_CATEGORIES[seed % COST_CATEGORIES.length] ?? "invalid_quantity";
  const rows: Row[] = [];
  const push = (invariant: string, outcome: Outcome, detail: string) =>
    rows.push({ seed, unit: "cost", category, invariant, outcome, detail });

  switch (category) {
    case "invalid_quantity": {
      const usage: Record<string, unknown> = { ...ZERO_USAGE };
      const component = rng.pick(COMPONENTS);
      const bad = rng.pick<unknown>([
        NaN,
        Infinity,
        -Infinity,
        -1,
        -Number.MIN_VALUE,
        "12",
        null,
        undefined,
        true,
        10n,
        {},
        [],
      ]);
      usage[component] = bad;
      try {
        computeCost(usage as UsageQuantities, DEFAULT_RATE_CARD);
        push("invalid_quantity_rejected", "BROKEN", `${component}=${String(bad)} accepted`);
      } catch (error) {
        const typed =
          error instanceof Error && error.message.startsWith("cost_model.invalid_quantity");
        push(
          "invalid_quantity_rejected",
          typed ? "HELD" : "BROKEN",
          `${component}=${String(bad)} → ${describeError(error)}`,
        );
      }
      break;
    }
    case "finite_quantity": {
      const usage: Record<CostComponent, number> = { ...ZERO_USAGE };
      const overflow = rng.bool(0.3);
      for (const c of COMPONENTS) {
        usage[c] = overflow
          ? rng.pick([0, 1e300, Number.MAX_VALUE, 2 ** 1000])
          : rng.pick([
              0,
              -0,
              rng.next() * 1e6,
              rng.int(0, 1e9),
              Number.MIN_VALUE,
              Number.MAX_SAFE_INTEGER,
            ]);
      }
      let breakdown;
      try {
        breakdown = computeCost(usage, DEFAULT_RATE_CARD);
      } catch (error) {
        push(
          overflow ? "overflow_rejected_or_finite" : "finite_no_throw",
          overflow ? "HELD" : "BROKEN",
          describeError(error),
        );
        break;
      }
      const finite = finiteNumbers(breakdown);
      const integers =
        breakdown.components.every((c) => Number.isInteger(c.microUsd)) &&
        Number.isInteger(breakdown.totalMicroUsd);
      const formatted = /^\$\d+\.\d{6}$/.test(breakdown.totalUsdFormatted);
      push(
        overflow ? "overflow_rejected_or_finite" : "outputs_finite_integers",
        finite && integers && formatted ? "HELD" : "BROKEN",
        `total=${breakdown.totalMicroUsd} formatted=${breakdown.totalUsdFormatted} max=${Math.max(...Object.values(usage))}`,
      );
      const again = computeCost(usage, DEFAULT_RATE_CARD);
      push(
        "deterministic",
        JSON.stringify(again) === JSON.stringify(breakdown) ? "HELD" : "BROKEN",
        "same inputs, same output",
      );
      break;
    }
    case "rate_card_junk": {
      const component = rng.pick(COMPONENTS);
      const rate = rng.pick([NaN, Infinity, -1, -0, 1e308]);
      const card: RateCard = {
        ...DEFAULT_RATE_CARD,
        [component]: { usdPerUnit: rate, provenance: "assumption", source: "stress" },
      };
      try {
        const b = computeCost({ ...ZERO_USAGE, [component]: 1 }, card);
        push(
          "rate_card_validated",
          finiteNumbers(b) && b.totalMicroUsd >= 0 ? "HELD" : "BROKEN",
          `${component} rate=${String(rate)} → total=${b.totalMicroUsd} ${b.totalUsdFormatted}`,
        );
      } catch (error) {
        push("rate_card_validated", "HELD", `rejected: ${describeError(error)}`);
      }
      break;
    }
    case "scale_add": {
      const factor = rng.pick([0, 1, 2.5, 1e300, NaN, Infinity, -1, -0]);
      const usage: UsageQuantities = {
        ...ZERO_USAGE,
        server_cpu: rng.int(1, 1e6),
        storage: Number.MAX_VALUE,
      };
      try {
        const scaled = scaleUsage(usage, factor);
        const summed = addUsage(scaled, scaled);
        push(
          "scale_add_finite",
          finiteNumbers(summed) ? "HELD" : "BROKEN",
          `factor=${String(factor)} → ${JSON.stringify(summed)}`,
        );
      } catch (error) {
        const typed =
          error instanceof Error && error.message.startsWith("cost_model.invalid_scale_factor");
        push(
          "scale_add_finite",
          typed ? "HELD" : "BROKEN",
          `factor=${String(factor)} → ${describeError(error)}`,
        );
      }
      break;
    }
    case "partial_usage": {
      const usage: Record<string, number> = {};
      for (const c of COMPONENTS) if (rng.bool(0.5)) usage[c] = rng.int(0, 100);
      if (rng.bool(0.3)) usage["unknown_component"] = 5;
      const missing = COMPONENTS.filter((c) => !(c in usage));
      try {
        const b = computeCost(usage as UsageQuantities, DEFAULT_RATE_CARD);
        push(
          "missing_component_rejected",
          missing.length === 0 ? "HELD" : "BROKEN",
          `missing=${missing.join(",")} → total=${b.totalMicroUsd}`,
        );
      } catch (error) {
        const typed =
          error instanceof Error && error.message.startsWith("cost_model.invalid_quantity");
        push(
          "missing_component_rejected",
          typed && missing.length > 0 ? "HELD" : "BROKEN",
          `missing=${missing.join(",")} → ${describeError(error)}`,
        );
      }
      break;
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

export function runIteration(unit: Unit, seed: number, maxString: number): Row[] {
  if (unit === "guard") return runGuardIteration(seed, maxString);
  if (unit === "drift") return runDriftIteration(seed, maxString);
  return runCostIteration(seed);
}

export interface CampaignResult {
  options: CampaignOptions;
  iterations: number;
  rows: Row[];
  byOutcome: Record<Outcome, number>;
  brokenByInvariant: Record<string, number>;
}

/**
 * Split `iterations` across the three units (60% guard, 25% drift, 15% cost)
 * and run each iteration from its own seed.
 */
export function runCampaign(options: CampaignOptions): CampaignResult {
  const rows: Row[] = [];
  const guardCount = Math.floor(options.iterations * 0.6);
  const driftCount = Math.floor(options.iterations * 0.25);
  const costCount = options.iterations - guardCount - driftCount;
  let iterations = 0;
  const run = (unit: Unit, count: number, offset: number) => {
    for (let i = 0; i < count; i++) {
      rows.push(...runIteration(unit, options.baseSeed + offset + i, options.maxString));
      iterations++;
    }
  };
  run("guard", guardCount, 0);
  run("drift", driftCount, 1_000_000);
  run("cost", costCount, 2_000_000);
  const byOutcome: Record<Outcome, number> = { HELD: 0, BROKEN: 0, INFO: 0 };
  const brokenByInvariant: Record<string, number> = {};
  for (const row of rows) {
    byOutcome[row.outcome]++;
    if (row.outcome === "BROKEN")
      brokenByInvariant[row.invariant] = (brokenByInvariant[row.invariant] ?? 0) + 1;
  }
  return { options, iterations, rows, byOutcome, brokenByInvariant };
}

/** Rows with timing removed, for determinism comparison. */
export function stableRows(rows: Row[]): Omit<Row, "ms">[] {
  return rows.map(({ ms: _ms, ...rest }) => rest);
}
