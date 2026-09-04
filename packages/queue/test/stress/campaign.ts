import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { InMemoryJobQueue, SqsJobQueue } from "../../src/index.js";
import { fakeBroker, SqsLikeError, SQS_MAX_BODY_BYTES } from "./fakeBroker.js";
import {
  describeValue,
  genBoundaryNumber,
  genJsValue,
  genKind,
  genRawBody,
  type GeneratedRawBody,
} from "./generators.js";
import { hashSeed, SeededRng } from "./rng.js";

/**
 * Boundary/malformed stress campaigns for @pickle/queue.
 *
 * Every iteration is derived from `hashSeed(campaign, seedBase + iter)` and
 * produces one `StressRow`; the row's `seed` alone replays it
 * (`replayDecode(seed)` etc.). Outcomes:
 *  - HELD   — every hard invariant held (soft observations go to `notes`)
 *  - BROKEN — at least one hard invariant failed (`violations`)
 *
 * Hard invariants (the lens contract):
 *  - a store method never throws / rejects because of message CONTENT;
 *    producer-side rejections must be `Error` instances and must happen
 *    BEFORE any write reaches the broker;
 *  - one hostile message never loses its batch neighbours;
 *  - envelope fields never carry NaN/Infinity that the queue itself minted;
 *  - decoding never mutates `Object.prototype` / `Array.prototype`;
 *  - the in-memory queue conserves jobs (queued + received == enqueued) and
 *    hands back the identical payload reference.
 */

export type Outcome = "HELD" | "BROKEN";

export interface StressRow {
  campaign: string;
  iter: number;
  seed: number;
  category: string;
  input: string;
  outcome: Outcome;
  violations: string[];
  notes: string[];
  error?: string;
  gapId?: string;
}

export interface KnownGap {
  id: string;
  title: string;
  /** Row matches this gap: it is a reproduced, pinned failure rather than a new one. */
  matches: (row: StressRow) => boolean;
}

/**
 * Reproduced gaps pinned by boundaryMalformed.knownGaps.test.ts. Remove an
 * entry only together with the fix that makes its pinning test fail.
 */
export const KNOWN_GAPS: readonly KnownGap[] = [
  {
    id: "GAP-QUEUE-1-null-body-throws",
    title: "SqsJobQueue.receive throws TypeError when a message body is the JSON document `null`",
    matches: (row) =>
      row.category.endsWith("json-nonobject-null") && row.violations.includes("receive_threw"),
  },
  {
    id: "GAP-QUEUE-2-attempt-not-integer",
    title:
      "SqsJobQueue.receive forwards ApproximateReceiveCount verbatim through Number(): NaN / Infinity / 1.5 / -1 attempts",
    matches: (row) =>
      row.category.startsWith("attr-garbage") && row.violations.includes("attempt_not_finite"),
  },
];

export function classifyGap(row: StressRow): StressRow {
  if (row.outcome !== "BROKEN") return row;
  const gap = KNOWN_GAPS.find((candidate) => candidate.matches(row));
  return gap ? { ...row, gapId: gap.id } : row;
}

const PROTOTYPE_BASELINE = [
  Object.getOwnPropertyNames(Object.prototype).sort().join(","),
  Object.getOwnPropertyNames(Array.prototype).sort().join(","),
].join("|");

export function prototypePollution(): string | null {
  const now = [
    Object.getOwnPropertyNames(Object.prototype).sort().join(","),
    Object.getOwnPropertyNames(Array.prototype).sort().join(","),
  ].join("|");
  if (now !== PROTOTYPE_BASELINE) return "prototype_mutated";
  const probe: Record<string, unknown> = {};
  if (probe["polluted"] !== undefined) return "object_prototype_polluted";
  if (([] as unknown as Record<string, unknown>)["polluted"] !== undefined)
    return "array_prototype_polluted";
  return null;
}

/**
 * Structural equality for JSON-shaped values WITHOUT recursion: generated
 * bodies nest 100k levels deep and `util.isDeepStrictEqual` overflows the
 * stack at ~4k, which would be a harness failure masquerading as a finding.
 */
export function jsonDeepEqual(left: unknown, right: unknown): boolean {
  const stack: Array<[unknown, unknown]> = [[left, right]];
  while (stack.length > 0) {
    const pair = stack.pop();
    if (!pair) break;
    const [a, b] = pair;
    if (Object.is(a, b)) continue;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let index = 0; index < a.length; index += 1) stack.push([a[index], b[index]]);
      continue;
    }
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let index = 0; index < aKeys.length; index += 1) {
      const key = aKeys[index];
      if (key === undefined || key !== bKeys[index]) return false;
      stack.push([(a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]]);
    }
  }
  return true;
}

function containsNonFinite(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some((entry) => containsNonFinite(entry, depth + 1));
  if (value !== null && typeof value === "object")
    return Object.values(value).some((entry) => containsNonFinite(entry, depth + 1));
  return false;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 200);
  return `non-Error rejection: ${describeValue(error)}`;
}

export interface RowDraft {
  violations: string[];
  notes: string[];
  error?: string;
}

export function finish(
  campaign: string,
  iter: number,
  seed: number,
  category: string,
  input: string,
  draft: RowDraft,
): StressRow {
  const row: StressRow = {
    campaign,
    iter,
    seed,
    category,
    input,
    outcome: draft.violations.length === 0 ? "HELD" : "BROKEN",
    violations: draft.violations,
    notes: draft.notes,
    ...(draft.error === undefined ? {} : { error: draft.error }),
  };
  return classifyGap(row);
}

// ---------------------------------------------------------------------------
// Campaign A — InMemoryJobQueue with hostile kind/payload/max
// ---------------------------------------------------------------------------

export async function inMemoryIteration(iter: number, seed: number): Promise<StressRow> {
  const rng = new SeededRng(seed);
  const kind = genKind(rng);
  const payload = genJsValue(rng);
  const max = genBoundaryNumber(rng);
  const category = `${kind.category}|${payload.category}|max-${max.category}`;
  const input = `kind=${describeValue(kind.value, 60)} payload=${describeValue(payload.value, 80)} max=${String(max.value)}`;
  const draft: RowDraft = { violations: [], notes: [] };
  const queue = new InMemoryJobQueue();
  try {
    // The type says `kind: string`; the harness deliberately crosses the boundary.
    const id = await queue.enqueue(kind.value as string, payload.value);
    if (typeof id !== "string" || id.length === 0) draft.violations.push("enqueue_id_not_string");
    if ((await queue.size()) !== 1) draft.violations.push("size_after_enqueue_not_1");
    const age = await queue.oldestJobAgeMs();
    if (age === null || !Number.isFinite(age) || age < 0) draft.violations.push("age_not_finite");

    const received = await queue.receive(max.value);
    const remaining = await queue.size();
    if (received.length + remaining !== 1) draft.violations.push("job_not_conserved");
    if (Number.isFinite(max.value) && max.value >= 1 && received.length > Math.floor(max.value))
      draft.violations.push("received_more_than_max");
    if (received.length === 0) {
      draft.notes.push(`max_${max.category}_received_0`);
      queue.expireInFlight();
      const retry = await queue.receive(1);
      if (retry.length !== 1) draft.violations.push("job_lost_after_zero_receive");
      received.push(...retry);
    }
    const first = received[0];
    if (!first) {
      draft.violations.push("job_unreachable");
    } else {
      if (!Object.is(first.job.kind, kind.value)) draft.violations.push("kind_identity_lost");
      if (!Object.is(first.job.payload, payload.value))
        draft.violations.push("payload_identity_lost");
      if (!Number.isInteger(first.job.attempt) || first.job.attempt < 1)
        draft.violations.push("attempt_not_finite");
      if (typeof first.job.id !== "string") draft.violations.push("id_not_string");
      if (typeof first.job.kind !== "string")
        draft.notes.push(`kind_not_string:${typeof first.job.kind}`);
      const inFlightAge = await queue.oldestJobAgeMs();
      if (inFlightAge === null) draft.violations.push("age_hidden_while_in_flight");
      await first.ack();
      if ((await queue.size()) !== 0) draft.violations.push("size_after_ack_not_0");
      if ((await queue.oldestJobAgeMs()) !== null) draft.violations.push("age_after_ack_not_null");
      queue.expireInFlight();
      if ((await queue.size()) !== 0) draft.violations.push("acked_job_resurrected");
    }
  } catch (error) {
    draft.violations.push("store_threw");
    draft.error = errorText(error);
  }
  const pollution = prototypePollution();
  if (pollution) draft.violations.push(pollution);
  return finish("inmemory", iter, seed, category, input, draft);
}

// ---------------------------------------------------------------------------
// Campaign B — SqsJobQueue.receive decoding hostile wire bodies (fake broker)
// ---------------------------------------------------------------------------

const FAKE_QUEUE_URL = "fake://sqs/000000000000/stress";
const GARBAGE_ATTRIBUTE_VALUES = ["", "abc", "NaN", "-1", "1.5", "1e999", "0x10", " 2 "] as const;

function fakeQueue(): SqsJobQueue {
  return new SqsJobQueue({ queueUrl: FAKE_QUEUE_URL, region: "fake" });
}

export interface DecodeExpectation {
  generated: GeneratedRawBody;
  messageId: string;
}

export function checkDecodedJob(
  job: { id: string; kind: string; payload: unknown; attempt: number },
  expectation: DecodeExpectation,
  draft: RowDraft,
): void {
  const { generated } = expectation;
  if (job.id !== expectation.messageId) draft.violations.push("id_mismatch");
  if (!Number.isInteger(job.attempt) || job.attempt < 1)
    draft.violations.push("attempt_not_finite");
  if (generated.body === undefined) {
    if (job.kind !== undefined || job.payload !== undefined)
      draft.violations.push("absent_body_not_empty_envelope");
    draft.notes.push("absent_body_empty_envelope");
  } else if (!generated.parses) {
    if (job.kind !== "__malformed__") draft.violations.push("malformed_not_flagged");
    if (job.payload !== generated.body) draft.violations.push("malformed_payload_not_raw_body");
  } else {
    const parsed: unknown = JSON.parse(generated.body);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const envelope = parsed as { kind?: unknown; payload?: unknown };
      if (!jsonDeepEqual(job.kind, envelope.kind)) draft.violations.push("kind_decode_mismatch");
      if (!jsonDeepEqual(job.payload, envelope.payload))
        draft.violations.push("payload_decode_mismatch");
      if (generated.expectedKind !== undefined && job.kind !== generated.expectedKind)
        draft.violations.push("expected_kind_mismatch");
    } else {
      if (job.kind !== undefined) draft.violations.push("nonobject_envelope_kind_defined");
      draft.notes.push("nonobject_envelope_kind_undefined");
    }
    if (containsNonFinite(job.payload)) draft.notes.push("payload_nonfinite_from_wire");
  }
  if (typeof job.kind !== "string") draft.notes.push(`kind_not_string:${typeof job.kind}`);
  else if (job.kind === "__malformed__" && generated.parses)
    draft.notes.push("kind_collides_with_sentinel");
}

export async function decodeIteration(iter: number, seed: number): Promise<StressRow> {
  const rng = new SeededRng(seed);
  const generated = genRawBody(rng);
  const attributeRoll = rng.next();
  let attributes: Record<string, string> | undefined | null;
  let category = generated.category;
  if (attributeRoll < 0.05) {
    attributes = null;
    category = `attr-absent|${category}`;
  } else if (attributeRoll < 0.1) {
    attributes = { ApproximateReceiveCount: rng.pick(GARBAGE_ATTRIBUTE_VALUES) };
    category = `attr-garbage|${category}`;
  }
  const neighbours = rng.chance(0.3) ? 1 + rng.int(2) : 0;
  const input = `body=${generated.body === undefined ? "<absent>" : describeValue(generated.body, 120)}${
    attributes === undefined ? "" : ` attrs=${describeValue(attributes, 40)}`
  }${neighbours ? ` neighbours=${neighbours}` : ""}`;
  const draft: RowDraft = { violations: [], notes: [] };

  fakeBroker.reset();
  const before =
    neighbours >= 1
      ? fakeBroker.inject(
          FAKE_QUEUE_URL,
          JSON.stringify({ kind: "media.process", payload: { n: 0 } }),
        )
      : null;
  const target = fakeBroker.inject(FAKE_QUEUE_URL, generated.body, attributes);
  const after =
    neighbours >= 2
      ? fakeBroker.inject(
          FAKE_QUEUE_URL,
          JSON.stringify({ kind: "media.purge", payload: { n: 2 } }),
        )
      : null;
  const expectedCount = 1 + (before ? 1 : 0) + (after ? 1 : 0);

  const queue = fakeQueue();
  try {
    const received = await queue.receive(10);
    if (received.length !== expectedCount) draft.violations.push("batch_loss");
    const targetEntry = received.find((entry) => entry.job.id === target.MessageId);
    if (!targetEntry) draft.violations.push("target_missing");
    else checkDecodedJob(targetEntry.job, { generated, messageId: target.MessageId }, draft);
    for (const neighbour of [before, after]) {
      if (!neighbour) continue;
      const entry = received.find((candidate) => candidate.job.id === neighbour.MessageId);
      if (!entry) draft.violations.push("neighbour_missing");
      else if (typeof entry.job.kind !== "string" || !entry.job.kind.startsWith("media."))
        draft.violations.push("neighbour_corrupted");
    }
    for (const entry of received) await entry.ack();
    if (fakeBroker.deletes.length !== received.length) draft.violations.push("ack_not_delivered");
  } catch (error) {
    draft.violations.push("receive_threw");
    draft.error = errorText(error);
  }
  const pollution = prototypePollution();
  if (pollution) draft.violations.push(pollution);
  return finish("decode", iter, seed, category, input, draft);
}

// ---------------------------------------------------------------------------
// Campaign C — SqsJobQueue.enqueue with hostile producer values (fake broker)
// ---------------------------------------------------------------------------

function lossyNotes(value: unknown, depth: number, notes: Set<string>): void {
  if (depth > 32) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) notes.add("lossy_nonfinite_to_null");
    else if (Object.is(value, -0)) notes.add("lossy_negzero_to_zero");
  } else if (typeof value === "bigint") notes.add("bigint_present");
  else if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol")
    notes.add(`lossy_${typeof value}_dropped`);
  else if (value instanceof Date) notes.add("lossy_date_to_string");
  else if (value instanceof Map || value instanceof Set)
    notes.add("lossy_collection_to_empty_object");
  else if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
    notes.add("lossy_binary_to_object");
  else if (Array.isArray(value)) {
    if (value.length !== Object.keys(value).length) notes.add("lossy_sparse_array_to_null");
    for (const entry of value) lossyNotes(entry, depth + 1, notes);
  } else if (value !== null && typeof value === "object") {
    let entries: unknown[] = [];
    try {
      entries = Object.values(value);
    } catch {
      return;
    }
    for (const entry of entries) lossyNotes(entry, depth + 1, notes);
  }
}

export async function encodeIteration(iter: number, seed: number): Promise<StressRow> {
  const rng = new SeededRng(seed);
  const kind = genKind(rng);
  const payload = genJsValue(rng);
  const category = `${kind.category}|${payload.category}`;
  const input = `kind=${describeValue(kind.value, 60)} payload=${describeValue(payload.value, 100)}`;
  const draft: RowDraft = { violations: [], notes: [] };
  fakeBroker.reset();
  const queue = fakeQueue();
  let enqueued = false;
  try {
    const id = await queue.enqueue(kind.value as string, payload.value);
    enqueued = true;
    if (typeof id !== "string" || id.length === 0) draft.violations.push("enqueue_id_not_string");
    const send = fakeBroker.sends[0];
    if (fakeBroker.sends.length !== 1 || !send) draft.violations.push("send_count_not_1");
    else {
      if (typeof send.MessageBody !== "string") draft.violations.push("wire_body_not_string");
      else {
        try {
          JSON.parse(send.MessageBody);
        } catch {
          draft.violations.push("wire_body_not_json");
        }
      }
      if (send.bytes > 65536) draft.notes.push("wire_over_64k");
    }
    if (payload.unserializable) draft.notes.push("unexpected_serializable");
    const received = await queue.receive(10);
    if (received.length !== 1) draft.violations.push("roundtrip_count_not_1");
    const job = received[0]?.job;
    if (job) {
      if (!Number.isInteger(job.attempt) || job.attempt < 1)
        draft.violations.push("attempt_not_finite");
      if (containsNonFinite(job.payload) || containsNonFinite(job.kind))
        draft.violations.push("nonfinite_minted_on_wire");
      if (typeof kind.value === "string" && job.kind !== kind.value)
        draft.violations.push("kind_roundtrip_mismatch");
      if (typeof job.kind !== "string")
        draft.notes.push(`kind_not_string_on_wire:${typeof job.kind}`);
      const lossy = new Set<string>();
      lossyNotes(payload.value, 0, lossy);
      draft.notes.push(...lossy);
      if (lossy.size === 0) {
        const expected: unknown = (
          JSON.parse(JSON.stringify({ p: payload.value })) as { p: unknown }
        ).p;
        if (!jsonDeepEqual(job.payload, expected))
          draft.violations.push("payload_roundtrip_mismatch");
      }
      await received[0]?.ack();
    }
  } catch (error) {
    draft.error = errorText(error);
    if (enqueued) {
      draft.violations.push("receive_or_ack_threw");
    } else if (!(error instanceof Error)) {
      draft.violations.push("reject_not_error");
    } else if (error instanceof SqsLikeError) {
      draft.notes.push(`broker_rejected:${error.name}`);
      const send = fakeBroker.sends[0];
      if (send && send.bytes > SQS_MAX_BODY_BYTES) draft.notes.push("oversize_sqs_would_reject");
    } else {
      draft.notes.push("rejected_before_send");
      if (fakeBroker.sends.length !== 0) draft.violations.push("write_before_reject");
      if (!payload.unserializable && !(typeof kind.value === "bigint"))
        draft.notes.push("unexpected_reject");
    }
  }
  const pollution = prototypePollution();
  if (pollution) draft.violations.push(pollution);
  return finish("encode", iter, seed, category, input, draft);
}

// ---------------------------------------------------------------------------
// Runner + report
// ---------------------------------------------------------------------------

export type Iteration = (iter: number, seed: number) => Promise<StressRow>;

export const CAMPAIGNS: Record<string, Iteration> = {
  inmemory: inMemoryIteration,
  decode: decodeIteration,
  encode: encodeIteration,
};

export function seedFor(campaign: string, seedBase: number, iter: number): number {
  return hashSeed(campaign, seedBase + iter);
}

export async function runCampaign(
  campaign: keyof typeof CAMPAIGNS,
  seedBase: number,
  iterations: number,
): Promise<StressRow[]> {
  const iteration = CAMPAIGNS[campaign];
  if (!iteration) throw new Error(`unknown campaign ${campaign}`);
  const rows: StressRow[] = [];
  for (let iter = 0; iter < iterations; iter += 1)
    rows.push(await iteration(iter, seedFor(campaign, seedBase, iter)));
  return rows;
}

/** Replay a single row from its campaign + seed (what a finding cites). */
export async function replay(campaign: keyof typeof CAMPAIGNS, seed: number): Promise<StressRow> {
  const iteration = CAMPAIGNS[campaign];
  if (!iteration) throw new Error(`unknown campaign ${campaign}`);
  return iteration(-1, seed);
}

export interface CampaignSummary {
  campaign: string;
  seedBase: number;
  iterations: number;
  held: number;
  broken: number;
  brokenKnownGap: number;
  brokenNew: number;
  gapCounts: Record<string, number>;
  violationCounts: Record<string, number>;
  noteCounts: Record<string, number>;
  categoryCount: number;
  digest: string;
}

export function summarize(campaign: string, seedBase: number, rows: StressRow[]): CampaignSummary {
  const gapCounts: Record<string, number> = {};
  const violationCounts: Record<string, number> = {};
  const noteCounts: Record<string, number> = {};
  const categories = new Set<string>();
  let held = 0;
  let brokenKnownGap = 0;
  let brokenNew = 0;
  for (const row of rows) {
    categories.add(row.category);
    if (row.outcome === "HELD") held += 1;
    else if (row.gapId) {
      brokenKnownGap += 1;
      gapCounts[row.gapId] = (gapCounts[row.gapId] ?? 0) + 1;
    } else brokenNew += 1;
    for (const violation of row.violations)
      violationCounts[violation] = (violationCounts[violation] ?? 0) + 1;
    for (const note of row.notes) noteCounts[note] = (noteCounts[note] ?? 0) + 1;
  }
  return {
    campaign,
    seedBase,
    iterations: rows.length,
    held,
    broken: brokenKnownGap + brokenNew,
    brokenKnownGap,
    brokenNew,
    gapCounts,
    violationCounts,
    noteCounts,
    categoryCount: categories.size,
    digest: digest(rows),
  };
}

/** Stable digest over (seed, category, outcome, violations, notes) — used for the determinism check. */
export function digest(rows: StressRow[]): string {
  let h = 2166136261;
  const text = rows
    .map(
      (row) =>
        `${row.seed}:${row.category}:${row.outcome}:${row.violations.join("+")}:${row.notes.join("+")}`,
    )
    .join("\n");
  for (let index = 0; index < text.length; index += 1) {
    h ^= text.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export const DEFAULT_OUT_DIR = resolve(
  __dirname,
  "../../../../artifacts/stress/pkg-queue-boundary-malformed",
);

export function writeReport(
  outDir: string,
  name: string,
  rows: StressRow[],
  summary: CampaignSummary,
): { rowsPath: string; summaryPath: string } {
  mkdirSync(outDir, { recursive: true });
  const rowsPath = resolve(outDir, `${name}.rows.json`);
  const summaryPath = resolve(outDir, `${name}.summary.json`);
  writeFileSync(rowsPath, JSON.stringify(rows, null, 2));
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  return { rowsPath, summaryPath };
}
