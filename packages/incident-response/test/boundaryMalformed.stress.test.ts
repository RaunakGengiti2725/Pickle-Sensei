import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DETECTION_SOURCES,
  FAILURE_CLASSES,
  RESPONSE_STEPS,
  SEVERITIES,
  addEvidence,
  advance,
  attachPostmortem,
  declareIncident,
  escalate,
  isClosed,
  nextRequiredStep,
  remainingSteps,
  type AdvanceInput,
  type DeclareIncidentInput,
  type EvidenceEntry,
  type Incident,
  type Severity,
} from "../src/index.js";
import {
  campaignTimeoutMs,
  campaignVerdict,
  findNonFinite,
  findOwnProtoKeys,
  outputDir,
  runCampaign,
  runGuarded,
  typedShapeGap,
  writeReport,
  type KnownGap,
  type StressCase,
} from "../../../tools/stress/boundary-malformed/harness.js";
import {
  describeValue,
  materialize,
  planMutations,
  type FieldSpec,
} from "../../../tools/stress/boundary-malformed/payloads.js";

/**
 * Boundary / malformed-input stress campaign for @pickle/incident-response.
 *
 * The package is a pure, in-memory state machine; the boundary under test is
 * "what happens when a malformed record (e.g. one deserialized from a
 * hand-edited incident JSON) reaches `declareIncident` / `advance` /
 * `escalate` / `nextRequiredStep`". The invariants asserted:
 *   - inputs are frozen and never mutated by the call (append-only history);
 *   - any thrown error is a typed/domain `Error`, never a native TypeError;
 *   - a returned incident has a valid severity, ordered timeline and no
 *     NaN/Infinity/own-`__proto__` keys.
 *
 * Scale: STRESS_ITER (default 60). Replay one row: STRESS_REPLAY=<seed>.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const DECLARE: DeclareIncidentInput = {
  id: "INC-SYNTHETIC-0001",
  severity: "P1",
  failureClass: "queue_stall",
  title: "synthetic stress incident",
  detectionSource: "monitoring_alert",
  detectedAt: "2026-08-29T00:00:00.000Z",
  affectedSurfaces: ["queue:analysis", "flag:analysis.enabled"],
  declaredBy: "stress",
  note: "declared by stress harness",
};

const DECLARE_FIELDS: FieldSpec[] = [
  { path: ["id"], kind: "string" },
  { path: ["severity"], kind: "enum" },
  { path: ["failureClass"], kind: "enum" },
  { path: ["title"], kind: "string" },
  { path: ["detectionSource"], kind: "enum" },
  { path: ["detectedAt"], kind: "string" },
  { path: ["affectedSurfaces"], kind: "array" },
  { path: ["affectedSurfaces", 0], kind: "string" },
  { path: ["declaredBy"], kind: "string" },
  { path: ["note"], kind: "string" },
];

const SEVERITY_SET: readonly string[] = SEVERITIES;
const STEP_SET: readonly string[] = RESPONSE_STEPS;
const CLASS_SET: readonly string[] = FAILURE_CLASSES;
const SOURCE_SET: readonly string[] = DETECTION_SOURCES;

function validateIncident(incident: Incident, label: string): string[] {
  const problems: string[] = [];
  if (!SEVERITY_SET.includes(incident.severity)) {
    problems.push(`${label}.severity=${describeValue(incident.severity)}`);
  }
  if (!CLASS_SET.includes(incident.failureClass)) {
    problems.push(`${label}.failureClass=${describeValue(incident.failureClass)}`);
  }
  if (!SOURCE_SET.includes(incident.detectionSource)) {
    problems.push(`${label}.detectionSource=${describeValue(incident.detectionSource)}`);
  }
  if (typeof incident.id !== "string" || incident.id.length === 0) {
    problems.push(`${label}.id invalid`);
  }
  if (!Array.isArray(incident.timeline) || incident.timeline.length === 0) {
    problems.push(`${label}.timeline empty`);
  } else {
    for (const [index, entry] of incident.timeline.entries()) {
      if (typeof entry !== "object" || entry === null) {
        problems.push(`${label}.timeline[${index}] not an object`);
        continue;
      }
      if (!STEP_SET.includes(entry.step)) {
        problems.push(`${label}.timeline[${index}].step=${describeValue(entry.step)}`);
      }
      if (typeof entry.actor !== "string" || typeof entry.note !== "string") {
        problems.push(`${label}.timeline[${index}] actor/note not strings`);
      }
    }
  }
  if (!Array.isArray(incident.affectedSurfaces)) {
    problems.push(`${label}.affectedSurfaces not an array`);
  } else if (incident.affectedSurfaces.some((s) => typeof s !== "string")) {
    problems.push(`${label}.affectedSurfaces has non-string`);
  }
  if (incident.postmortemRef !== null && typeof incident.postmortemRef !== "string") {
    problems.push(`${label}.postmortemRef type ${typeof incident.postmortemRef}`);
  }
  problems.push(...findNonFinite(incident, label));
  problems.push(...findOwnProtoKeys(incident, label).map((p) => `own proto key persisted at ${p}`));
  return problems;
}

/** A valid P1 incident advanced to `investigating`, used as the advance/escalate base. */
function seededIncident(): Incident {
  let incident = declareIncident(DECLARE);
  for (const step of ["evidence_preserved", "investigating"] as const) {
    incident = advance(incident, {
      step,
      at: "2026-08-29T00:05:00.000Z",
      actor: "stress",
      note: `seeded ${step}`,
    });
  }
  return incident;
}

const INCIDENT_FIELDS: FieldSpec[] = [
  { path: ["id"], kind: "string" },
  { path: ["severity"], kind: "enum" },
  { path: ["failureClass"], kind: "enum" },
  { path: ["title"], kind: "string" },
  { path: ["detectionSource"], kind: "enum" },
  { path: ["detectedAt"], kind: "string" },
  { path: ["affectedSurfaces"], kind: "array" },
  { path: ["timeline"], kind: "array" },
  { path: ["timeline", 0], kind: "object" },
  { path: ["timeline", 0, "step"], kind: "enum" },
  { path: ["timeline", 3], kind: "object" },
  { path: ["timeline", 3, "step"], kind: "enum" },
  { path: ["timeline", 3, "actor"], kind: "string" },
  { path: ["timeline", 3, "note"], kind: "string" },
  { path: ["evidence"], kind: "array" },
  { path: ["postmortemRef"], kind: "string" },
];

const ADVANCE_FIELDS: FieldSpec[] = [
  { path: ["step"], kind: "enum" },
  { path: ["at"], kind: "string" },
  { path: ["actor"], kind: "string" },
  { path: ["note"], kind: "string" },
];

interface IncidentBase {
  declare: DeclareIncidentInput;
  incident: Incident;
  advanceInput: AdvanceInput;
  escalateTo: Severity;
  evidence: EvidenceEntry;
  /** Which argument the mutations apply to. */
  target: "declare" | "incident" | "advance" | "escalate" | "evidence" | "postmortem";
}

function snapshot(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === "bigint" ? `${v.toString()}n` : typeof v === "symbol" ? v.toString() : v,
  );
}

function baseFor(target: IncidentBase["target"]): IncidentBase {
  return {
    declare: DECLARE,
    incident: seededIncident(),
    advanceInput: {
      step: "fix_in_progress",
      at: "2026-08-29T00:10:00.000Z",
      actor: "stress",
      note: "fix under way",
    },
    escalateTo: "P0",
    evidence: {
      capturedAt: "2026-08-29T00:11:00.000Z",
      description: "queue depth snapshot",
      location: null,
    },
    target,
  };
}

const declareCase: StressCase<IncidentBase> = {
  api: "declareIncident",
  surface: "typed",
  weight: 3,
  mutationRoot: (base) => base.declare,
  generate(rng) {
    const plan = planMutations(rng, DECLARE_FIELDS, {
      jsonOnly: false,
      allowText: false,
      objectPaths: [[]],
    });
    return { category: plan.category, base: baseFor("declare"), mutations: plan.mutations };
  },
  execute(base, mutations) {
    const { value } = materialize(base.declare, mutations);
    const before = snapshot(value);
    const result = runGuarded(
      () => declareIncident(value as DeclareIncidentInput),
      (incident) => {
        const problems = validateIncident(incident, "incident");
        if (incident.timeline.length !== 1 || incident.timeline[0]?.step !== "declared") {
          problems.push("declared incident timeline is not exactly [declared]");
        }
        return problems;
      },
    );
    if (snapshot(value) !== before) result.violations.push("input-mutated: declare input changed");
    return result;
  },
};

const advanceCase: StressCase<IncidentBase> = {
  api: "advance",
  surface: "typed",
  weight: 4,
  mutationRoot: (base) => (base.target === "incident" ? base.incident : base.advanceInput),
  generate(rng) {
    const onIncident = rng.chance(0.5);
    const plan = onIncident
      ? planMutations(rng, INCIDENT_FIELDS, {
          jsonOnly: false,
          allowText: false,
          objectPaths: [[], ["timeline", 3]],
        })
      : planMutations(rng, ADVANCE_FIELDS, {
          jsonOnly: false,
          allowText: false,
          objectPaths: [[]],
        });
    return {
      category: plan.category,
      base: baseFor(onIncident ? "incident" : "advance"),
      mutations: plan.mutations,
    };
  },
  execute(base, mutations) {
    const incident =
      base.target === "incident"
        ? (materialize(base.incident, mutations).value as Incident)
        : base.incident;
    const input =
      base.target === "advance"
        ? (materialize(base.advanceInput, mutations).value as AdvanceInput)
        : base.advanceInput;
    const incidentBefore = snapshot(incident);
    const inputBefore = snapshot(input);
    const result = runGuarded(
      () => advance(incident, input),
      (next) => {
        const problems = validateIncident(next, "next");
        if (next.timeline.length !== incident.timeline.length + 1) {
          problems.push("advance did not append exactly one timeline entry");
        }
        const last = next.timeline[next.timeline.length - 1];
        if (last === undefined || !STEP_SET.includes(last.step)) {
          problems.push(`advanced to invalid step ${describeValue(last?.step)}`);
        }
        return problems;
      },
    );
    if (snapshot(incident) !== incidentBefore) result.violations.push("input-mutated: incident");
    if (snapshot(input) !== inputBefore) result.violations.push("input-mutated: advance input");
    return result;
  },
};

const ESCALATE_ARGS = {
  to: "P0",
  at: "2026-08-29T00:12:00.000Z",
  actor: "stress",
  note: "worse",
} as const;

const escalateCase: StressCase<IncidentBase> = {
  api: "escalate",
  surface: "typed",
  weight: 2,
  mutationRoot: () => ESCALATE_ARGS,
  generate(rng) {
    const plan = planMutations(
      rng,
      [
        { path: ["to"], kind: "enum" },
        { path: ["at"], kind: "string" },
        { path: ["actor"], kind: "string" },
        { path: ["note"], kind: "string" },
      ],
      { jsonOnly: false, allowText: false, objectPaths: [[]] },
    );
    return { category: plan.category, base: baseFor("escalate"), mutations: plan.mutations };
  },
  execute(base, mutations) {
    const { value } = materialize({ ...ESCALATE_ARGS, to: base.escalateTo }, mutations);
    const args = value as { to: Severity; at: string; actor: string; note: string };
    const before = snapshot(base.incident);
    const result = runGuarded(
      () => escalate(base.incident, args.to, args),
      (next) => {
        const problems = validateIncident(next, "next");
        if (!SEVERITY_SET.includes(next.severity)) {
          problems.push(`escalated to invalid severity ${describeValue(next.severity)}`);
        }
        return problems;
      },
    );
    if (snapshot(base.incident) !== before) result.violations.push("input-mutated: incident");
    return result;
  },
};

const deriveCase: StressCase<IncidentBase> = {
  api: "nextRequiredStep/remainingSteps/isClosed",
  surface: "typed",
  weight: 3,
  mutationRoot: (base) => base.incident,
  generate(rng) {
    const plan = planMutations(rng, INCIDENT_FIELDS, {
      jsonOnly: false,
      allowText: false,
      objectPaths: [[], ["timeline", 3]],
    });
    return { category: plan.category, base: baseFor("incident"), mutations: plan.mutations };
  },
  execute(base, mutations) {
    const incident = materialize(base.incident, mutations).value as Incident;
    const before = snapshot(incident);
    const result = runGuarded(
      () => ({
        next: nextRequiredStep(incident),
        remaining: remainingSteps(incident),
        closed: isClosed(incident),
      }),
      (derived) => {
        const problems: string[] = [];
        if (derived.next !== null && !STEP_SET.includes(derived.next)) {
          problems.push(`nextRequiredStep=${describeValue(derived.next)}`);
        }
        if (!Array.isArray(derived.remaining)) problems.push("remainingSteps not an array");
        if (typeof derived.closed !== "boolean") problems.push("isClosed not boolean");
        if (derived.next === null && derived.remaining.length !== 0 && !derived.closed) {
          problems.push("next=null but remaining steps non-empty and not closed");
        }
        return problems;
      },
    );
    if (snapshot(incident) !== before) result.violations.push("input-mutated: incident");
    return result;
  },
};

const POSTMORTEM_ARGS = { ref: "docs/postmortems/synthetic.md" };

const evidenceCase: StressCase<IncidentBase> = {
  api: "addEvidence/attachPostmortem",
  surface: "typed",
  weight: 2,
  mutationRoot: (base) => (base.target === "postmortem" ? POSTMORTEM_ARGS : base.evidence),
  generate(rng) {
    const postmortem = rng.chance(0.4);
    const plan = postmortem
      ? planMutations(rng, [{ path: ["ref"], kind: "string" }], {
          jsonOnly: false,
          allowText: false,
          objectPaths: [[]],
        })
      : planMutations(
          rng,
          [
            { path: ["capturedAt"], kind: "string" },
            { path: ["description"], kind: "string" },
            { path: ["location"], kind: "string" },
          ],
          { jsonOnly: false, allowText: false, objectPaths: [[]] },
        );
    return {
      category: plan.category,
      base: baseFor(postmortem ? "postmortem" : "evidence"),
      mutations: plan.mutations,
    };
  },
  execute(base, mutations) {
    const before = snapshot(base.incident);
    let result;
    if (base.target === "postmortem") {
      const { value } = materialize(POSTMORTEM_ARGS, mutations);
      const ref = (value as { ref: string }).ref;
      result = runGuarded(
        () => attachPostmortem(base.incident, ref),
        (next) => validateIncident(next, "next"),
      );
    } else {
      const { value } = materialize(base.evidence, mutations);
      result = runGuarded(
        () => addEvidence(base.incident, value as EvidenceEntry),
        (next) => {
          const problems = validateIncident(next, "next");
          if (next.evidence.length !== base.incident.evidence.length + 1) {
            problems.push("addEvidence did not append exactly one entry");
          }
          return problems;
        },
      );
    }
    if (snapshot(base.incident) !== before) result.violations.push("input-mutated: incident");
    return result;
  },
};

/* ------------------------------------------------------------------------ */
/* Known gaps (reproduced, documented behaviour — see the campaign report)   */
/* ------------------------------------------------------------------------ */

const KNOWN_GAPS: KnownGap[] = [
  {
    id: "IR-ERR-ECHO-UNBOUNDED",
    finding:
      "InvalidTransitionError and the stateMachine 'step not in sequence' Error interpolate the " +
      "caller-supplied step verbatim; a 64 KiB step string yields a 64 KiB+ message.",
    matches: (row) =>
      (row.outcome === "rejected-typed" || row.outcome === "rejected-error") &&
      row.violations.length > 0 &&
      row.violations.every((v) => v.startsWith("oversized-error-message")),
  },
  typedShapeGap(
    "IR-TYPED-NO-GUARDS",
    "incident.ts / stateMachine.ts apply no runtime guard to their typed arguments; a " +
      "non-object incident, non-array affectedSurfaces or non-string note ends in a native " +
      "TypeError (`is not iterable`, `.trim is not a function`, `reading 'length'`).",
  ),
  {
    id: "IR-ENUM-UNVALIDATED",
    finding:
      "declareIncident/advance/escalate/addEvidence copy severity, failureClass, " +
      "detectionSource, step, actor, note and evidence fields verbatim with no enum or type " +
      "check (own __proto__/constructor keys included). An unknown severity string is a " +
      "shape-correct input that makes nextRequiredStep/remainingSteps/isClosed and advance " +
      "crash with a native TypeError (REQUIRED_SEQUENCES[severity] is undefined → " +
      "`reading 'indexOf'`).",
    matches: (row) =>
      row.surface === "typed" &&
      (row.outcome === "returned-invalid" ||
        (row.outcome === "crash-native" && row.errorName === "TypeError")) &&
      row.violations.length === 0,
  },
];

describe("incident-response boundary/malformed stress", () => {
  it(
    "never mutates inputs and only throws typed errors on malformed records",
    () => {
      const report = runCampaign<IncidentBase>({
        pkg: "incident-response",
        cases: [declareCase, advanceCase, escalateCase, deriveCase, evidenceCase],
        knownGaps: KNOWN_GAPS,
      });
      const path = writeReport(report, outputDir(REPO_ROOT));
      expect(campaignVerdict(report, path)).toBeNull();
    },
    campaignTimeoutMs(),
  );
});
