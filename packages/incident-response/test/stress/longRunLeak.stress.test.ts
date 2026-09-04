import { describe, expect, it } from "vitest";
import {
  DETECTION_SOURCES,
  FAILURE_CLASSES,
  IncompleteResponseError,
  InvalidEscalationError,
  InvalidTransitionError,
  REQUIRED_SEQUENCES,
  RESPONSE_STEPS,
  SEVERITIES,
  addEvidence,
  advance,
  attachPostmortem,
  currentStep,
  declareIncident,
  escalate,
  isClosed,
  nextRequiredStep,
  remainingSteps,
  type Incident,
  type ResponseStep,
  type Severity,
} from "../../src/index.js";
import {
  SeededRng,
  type IterationOutcome,
  digestOf,
  nonFinitePaths,
  nondeterministicSeeds,
  runLeakCampaign,
  stressIterations,
  summarizeReport,
  writeReportIfRequested,
} from "../../../../tools/stress/leakHarness.js";

/**
 * LONG-RUN LEAK lens for @pickle/incident-response. Each iteration declares a
 * synthetic incident and walks it to `closed` with seeded detours (invalid
 * steps, empty notes, premature close, escalation, de-escalation attempts),
 * checking every transition against an independent reference of
 * REQUIRED_SEQUENCES and that superseded incident values are never mutated.
 * STRESS_ITER=500 for the full campaign.
 */

const ITER = stressIterations(60);
const BASE_SEED = 0x1c1d_0001;

function isoAt(baseMs: number, offsetMinutes: number): string {
  return new Date(baseMs + offsetMinutes * 60_000).toISOString();
}

/** Reference: the anchor `escalate` must rewind to for a given completed-step set. */
function referenceEscalationAnchor(
  completed: ReadonlySet<ResponseStep>,
  to: Severity,
): ResponseStep {
  let anchor: ResponseStep = "declared";
  for (const step of REQUIRED_SEQUENCES[to]) {
    if (step === "closed" || !completed.has(step)) break;
    anchor = step;
  }
  return anchor;
}

function expectThrow(
  problems: string[],
  label: string,
  fn: () => unknown,
  accept: (error: unknown) => boolean,
): void {
  try {
    fn();
    problems.push(`${label}: did not throw`);
  } catch (error) {
    if (!accept(error)) {
      problems.push(
        `${label}: threw unexpected ${error instanceof Error ? error.name : String(error)}`,
      );
    }
  }
}

function incidentIteration(seed: number): IterationOutcome {
  const rng = new SeededRng(seed);
  const baseMs = 1_750_000_000_000 + rng.int(0, 10_000_000);
  const startSeverity = rng.pick(SEVERITIES);
  const problems: string[] = [];
  const superseded: { digest: string; value: Incident }[] = [];

  let incident = declareIncident({
    id: `SYNTHETIC-TEST-FIXTURE.inc-${seed.toString(16)}`,
    severity: startSeverity,
    failureClass: rng.pick(FAILURE_CLASSES),
    title: `synthetic incident ${seed}`,
    detectionSource: rng.pick(DETECTION_SOURCES),
    detectedAt: isoAt(baseMs, 0),
    affectedSurfaces: Array.from({ length: rng.int(0, 4) }, (_, i) => `surface-${i}`),
    declaredBy: "SYNTHETIC-TEST-FIXTURE.oncall",
    note: "declared by stress harness",
  });
  let minute = 0;
  let escalations = 0;
  let rejected = 0;
  let evidenceCount = 0;

  const remember = (value: Incident): void => {
    superseded.push({ digest: digestOf(value), value });
  };

  while (!isClosed(incident)) {
    minute += rng.int(1, 120);
    const expected = nextRequiredStep(incident);
    if (expected === null) {
      problems.push(`open incident with no next step at ${currentStep(incident)}`);
      break;
    }
    const remaining = remainingSteps(incident);
    if (remaining[0] !== expected) {
      problems.push(`remainingSteps[0]=${remaining[0]} but nextRequiredStep=${expected}`);
    }
    const at = isoAt(baseMs, minute);
    const actor = `SYNTHETIC-TEST-FIXTURE.actor-${rng.int(1, 5)}`;

    if (rng.chance(0.3)) {
      remember(incident);
      incident = addEvidence(incident, {
        capturedAt: at,
        description: `evidence ${evidenceCount}`,
        location: rng.chance(0.5) ? null : `s3://synthetic/${seed}/${evidenceCount}`,
      });
      evidenceCount += 1;
    }

    if (rng.chance(0.15)) {
      const wrong = rng.pick(RESPONSE_STEPS.filter((s) => s !== expected));
      expectThrow(
        problems,
        `invalid step ${wrong} (expected ${expected})`,
        () => advance(incident, { step: wrong, at, actor, note: "wrong" }),
        (e) => e instanceof InvalidTransitionError,
      );
      rejected += 1;
    }
    if (rng.chance(0.1)) {
      expectThrow(
        problems,
        "empty note",
        () => advance(incident, { step: expected, at, actor, note: rng.pick(["", "   ", "\n"]) }),
        (e) => e instanceof Error && !(e instanceof InvalidTransitionError),
      );
      rejected += 1;
    }
    if (rng.chance(0.1)) {
      const lower = SEVERITIES.filter(
        (s) => SEVERITIES.indexOf(s) >= SEVERITIES.indexOf(incident.severity),
      );
      expectThrow(
        problems,
        "de-escalation",
        () => escalate(incident, rng.pick(lower), { at, actor, note: "down" }),
        (e) => e instanceof InvalidEscalationError,
      );
      rejected += 1;
    }
    if (rng.chance(0.12) && incident.severity !== "P0") {
      const higher = SEVERITIES.filter(
        (s) => SEVERITIES.indexOf(s) < SEVERITIES.indexOf(incident.severity),
      );
      const to = rng.pick(higher);
      const completed = new Set(incident.timeline.map((e) => e.step));
      completed.delete("closed");
      const anchor = referenceEscalationAnchor(completed, to);
      remember(incident);
      incident = escalate(incident, to, { at, actor, note: "worse than thought" });
      escalations += 1;
      if (incident.severity !== to) problems.push(`escalate landed on ${incident.severity}`);
      if (currentStep(incident) !== anchor) {
        problems.push(`escalation anchor ${currentStep(incident)} != reference ${anchor}`);
      }
      continue;
    }

    if (expected === "closed" && REQUIRED_SEQUENCES[incident.severity].includes("postmortem")) {
      if (incident.postmortemRef === null) {
        expectThrow(
          problems,
          "close without postmortem",
          () => advance(incident, { step: "closed", at, actor, note: "closing" }),
          (e) => e instanceof IncompleteResponseError,
        );
        rejected += 1;
        remember(incident);
        incident = attachPostmortem(incident, `pm://synthetic/${seed}`);
      }
    }
    remember(incident);
    incident = advance(incident, { step: expected, at, actor, note: `step ${expected}` });
    if (currentStep(incident) !== expected)
      problems.push(`advance landed on ${currentStep(incident)}`);
  }

  if (isClosed(incident)) {
    if (remainingSteps(incident).length !== 0) problems.push("closed with remaining steps");
    if (nextRequiredStep(incident) !== null) problems.push("closed with a next step");
    expectThrow(
      problems,
      "advance after close",
      () =>
        advance(incident, { step: "closed", at: isoAt(baseMs, minute + 1), actor: "x", note: "n" }),
      (e) => e instanceof InvalidTransitionError,
    );
    // Every required step of the FINAL severity appears in order in the timeline.
    const steps = incident.timeline.map((e) => e.step);
    let cursor = -1;
    for (const required of REQUIRED_SEQUENCES[incident.severity]) {
      const idx = steps.indexOf(required, cursor + 1);
      if (idx === -1) problems.push(`required step ${required} missing from timeline`);
      else cursor = idx;
    }
  }
  if (incident.evidence.length !== evidenceCount) {
    problems.push(`evidence count ${incident.evidence.length} != ${evidenceCount}`);
  }
  for (const { digest, value } of superseded) {
    if (digestOf(value) !== digest) {
      problems.push("a superseded incident value was mutated");
      break;
    }
  }
  problems.push(...nonFinitePaths(incident, "incident"));
  if (problems.length > 0) throw new Error(problems.join("; "));

  return {
    outcome: `${startSeverity}->${incident.severity}/${incident.timeline.length}steps`,
    digest: digestOf(incident),
    retainables: [incident, ...superseded.map((s) => s.value)],
    detail: { escalations, rejected, evidenceCount, timeline: incident.timeline.length },
  };
}

describe(
  "incident-response long-run leak (seeded, one process)",
  { timeout: 30_000 + ITER * 400 },
  () => {
    it(`walks ${ITER} seeded incidents to closed without retaining superseded values`, async () => {
      const report = await runLeakCampaign({
        name: "incident-response.lifecycle",
        baseSeed: BASE_SEED,
        iterations: ITER,
        run: incidentIteration,
      });
      const path = writeReportIfRequested(report);
      console.log(summarizeReport(report), path ?? "");

      expect(report.gcForced).toBe(true);
      expect(report.iterations).toBe(ITER);
      expect(report.failures).toEqual([]);
      expect(report.retained.maxAtAnyCheckpoint).toBe(0);
      expect(report.handles.grown).toEqual({});
      if (ITER >= 200) {
        expect(report.heap.monotoneIncreasing && report.heap.slopePctPer100 > 5).toBe(false);
      }
    });

    it(`one long-lived incident accumulates ${ITER} evidence entries immutably`, async () => {
      let incident = declareIncident({
        id: "SYNTHETIC-TEST-FIXTURE.inc-long-lived",
        severity: "P1",
        failureClass: "queue_stall",
        title: "long-lived synthetic incident",
        detectionSource: "monitoring_alert",
        detectedAt: "2026-09-01T00:00:00.000Z",
        affectedSurfaces: ["analysis"],
        declaredBy: "SYNTHETIC-TEST-FIXTURE.oncall",
        note: "declared",
      });
      const report = await runLeakCampaign({
        name: "incident-response.long-lived-evidence",
        baseSeed: BASE_SEED + 100_000,
        iterations: ITER,
        run: (seed, iteration) => {
          const rng = new SeededRng(seed);
          const before = incident;
          const beforeLength = before.evidence.length;
          incident = addEvidence(incident, {
            capturedAt: isoAt(1_756_684_800_000, iteration),
            description: `evidence ${iteration}`,
            location: rng.chance(0.5) ? null : `s3://synthetic/${seed}`,
          });
          const problems: string[] = [];
          if (before.evidence.length !== beforeLength)
            problems.push("addEvidence mutated its input");
          if (incident.evidence.length !== beforeLength + 1)
            problems.push("evidence did not grow by 1");
          if (before.evidence === incident.evidence) problems.push("evidence array shared");
          if (nextRequiredStep(incident) !== "evidence_preserved") problems.push("step drifted");
          if (problems.length > 0) throw new Error(problems.join("; "));
          return {
            outcome: `evidence=${incident.evidence.length}`,
            digest: digestOf(incident.evidence.at(-1)),
            retainables: [before],
          };
        },
      });
      const path = writeReportIfRequested(report);
      console.log(summarizeReport(report), path ?? "");

      expect(report.gcForced).toBe(true);
      expect(report.failures).toEqual([]);
      expect(report.retained.maxAtAnyCheckpoint).toBe(0);
      expect(report.handles.grown).toEqual({});
      expect(incident.evidence.length).toBe(ITER + 1);
    });

    it("same seed → identical closed-incident digest", () => {
      const seeds = Array.from({ length: Math.min(ITER, 25) }, (_, i) => BASE_SEED + i);
      expect(nondeterministicSeeds(seeds, incidentIteration)).toEqual([]);
    });
  },
);
