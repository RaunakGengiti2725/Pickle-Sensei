import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Agent, createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLabApiMiddleware } from "../labApi";
import { syntheticAgreeingPair } from "../syntheticFixtures";
import { validateCoachRegistry, type CoachQualification } from "../provisioning";
import type { AssignmentsFile, ReviewAmendment } from "../records";
import type { CoachRegistry, CoachReview } from "../types";
import {
  createSeededRng,
  planCampaign,
  sleep,
  summarize,
  withDeadline,
  writeResultsTable,
  type IterationRow,
  type SeededRng,
} from "../../stress/seeded";

/**
 * CONCURRENCY STRESS — Coach Review Lab dev API (the exact middleware
 * vite.config.ts mounts), driven with Promise.all bursts from a seeded scheduler
 * against a fresh THROWAWAY repo root per iteration (never datasets/).
 *
 * Each iteration is one seeded interleaving of:
 *   - duplicate calls          k identical review POSTs (same reviewId)
 *   - two actors, same row     two coaches review the same queue item
 *   - amendment race           k amendments racing for the same next revision
 *   - lost-update probe        k assignments for distinct items + m for the SAME item
 *   - provisioning race        k provisions + duplicate provisions + registry validity
 *   - call-during-call         GETs of every listing while the writes are in flight
 *   - cancel-during-call       clients that abort mid-body / mid-stream
 *   - oversize body            a body over the route limit
 *   - clock skew               payload timestamps randomized ±30 days
 * with seeded start jitter and seeded body chunking so the single async point of
 * every handler (`await readJsonBody`) is hit in different orders.
 *
 * Invariants asserted per iteration: idempotency (exactly one 201 per identity),
 * no duplicate rows/files, no lost update, no torn/partial JSON on disk or on the
 * wire, registry validity, server liveness, bounded wall time (deadline), no
 * unhandled rejections. File-descriptor counts are recorded per campaign, and a
 * separate test pins that a client-aborted Range GET releases its descriptor.
 *
 * Fast by default (STRESS_ITER=12); the recorded campaign ran STRESS_ITER=500.
 */

const REAL_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const DEFAULT_ITERATIONS = 12;
const DEFAULT_BASE_SEED = 20260904;
const ITERATION_DEADLINE_MS = 15_000;
const STREAM_BLOB_BYTES = 4 * 1024 * 1024;

const COACHES = [
  { coachId: "stress-test-coach-a", credentialRef: "stress-test-cred-a" },
  { coachId: "stress-test-coach-b", credentialRef: "stress-test-cred-b" },
  { coachId: "stress-test-coach-c", credentialRef: "stress-test-cred-c" },
] as const;
const PROVISIONED_AT = "2026-08-29T00:00:00.000Z";
const PROVISIONED_BY = "stress-harness-test";

function testQualification(): CoachQualification {
  return {
    policyVersion: "coach-qualification-policy-v1",
    satisfiedCriteria: ["criterion.professional-coaching-history"],
    verdict: "qualified",
    assessedBy: PROVISIONED_BY,
    assessedAtIso: PROVISIONED_AT,
    certifications: [],
    professionalCoachingHistory: {
      statement: "TEST-ONLY fixture claim (throwaway root, not a real coach)",
      verification: {
        method: "document_reviewed",
        verifiedBy: PROVISIONED_BY,
        verifiedAtIso: PROVISIONED_AT,
        evidenceRef: "test-evidence-nonexistent",
      },
    },
    competitiveBackground: null,
    affiliation: null,
    yearsCoaching: null,
    specialties: [],
  };
}

interface Env {
  root: string;
  server: Server;
  port: number;
  queueItemIds: string[];
}

async function startEnv(): Promise<Env> {
  const root = mkdtempSync(join(tmpdir(), "stress-labapi-"));
  const dir = join(root, "datasets/coach-review");
  mkdirSync(dir, { recursive: true });
  for (const name of ["queue.json", "schema.json"]) {
    cpSync(join(REAL_REPO_ROOT, "datasets/coach-review", name), join(dir, name));
  }
  for (const sub of ["taxonomy", "drills"]) {
    cpSync(join(REAL_REPO_ROOT, "datasets/coach-review", sub), join(dir, sub), {
      recursive: true,
    });
  }
  writeFileSync(join(dir, "stress-blob.bin"), Buffer.alloc(STREAM_BLOB_BYTES, 0x2e));
  writeFileSync(
    join(dir, "coaches.json"),
    JSON.stringify({
      schemaVersion: 2,
      note: "TEST-ONLY throwaway registry for the concurrency stress harness.",
      qualificationPolicy: {
        version: "coach-qualification-policy-v1",
        document: "docs/COACH_QUALIFICATION_POLICY.md",
      },
      coaches: COACHES.map((coach) => ({
        ...coach,
        status: "active",
        provisionedAtIso: PROVISIONED_AT,
        provisionedBy: PROVISIONED_BY,
        qualification: testQualification(),
      })),
    }),
  );
  const queue = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8")) as {
    queue: { queueItemId: string }[];
  };
  const middleware = createLabApiMiddleware(root);
  const server = createServer((req, res) => {
    middleware(req, res, () => {
      res.writeHead(404);
      res.end("fell through");
    });
  });
  await new Promise<void>((resolvePromise) =>
    server.listen(0, "127.0.0.1", () => resolvePromise()),
  );
  return {
    root,
    server,
    port: (server.address() as AddressInfo).port,
    queueItemIds: queue.queue.map((item) => item.queueItemId),
  };
}

async function stopEnv(env: Env): Promise<void> {
  env.server.closeAllConnections();
  await new Promise<void>((resolvePromise) => env.server.close(() => resolvePromise()));
  rmSync(env.root, { recursive: true, force: true });
}

const agent = new Agent({ keepAlive: false });

interface SendOptions {
  method: "GET" | "POST";
  path: string;
  body?: string;
  headers?: Record<string, string>;
  /** Seeded scheduler knobs. */
  startDelayMs?: number;
  chunks?: number;
  chunkGapMs?: number;
  /** cancel-during-call: destroy the socket after this many body bytes. */
  abortAfterBytes?: number;
  /** cancel-during-stream: destroy the socket after the first response chunk. */
  abortAfterFirstChunk?: boolean;
}

interface SendResult {
  status: number | null;
  body: string;
  error: string | null;
  bytesReceived: number;
}

function send(env: Env, options: SendOptions): Promise<SendResult> {
  return new Promise((resolvePromise) => {
    void (async () => {
      if (options.startDelayMs) await sleep(options.startDelayMs);
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: env.port,
          method: options.method,
          path: options.path,
          agent,
          headers: {
            ...(options.body !== undefined
              ? {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(options.body),
                }
              : {}),
            ...(options.headers ?? {}),
          },
        },
        (res) => {
          let body = "";
          let bytes = 0;
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            body += chunk.toString("utf8");
            if (options.abortAfterFirstChunk) {
              res.destroy();
              resolvePromise({
                status: res.statusCode ?? null,
                body: "",
                error: "aborted-by-client-mid-stream",
                bytesReceived: bytes,
              });
            }
          });
          res.on("end", () =>
            resolvePromise({
              status: res.statusCode ?? null,
              body,
              error: null,
              bytesReceived: bytes,
            }),
          );
          res.on("error", (error) =>
            resolvePromise({ status: null, body, error: String(error), bytesReceived: bytes }),
          );
        },
      );
      req.on("error", (error: NodeJS.ErrnoException) =>
        resolvePromise({
          status: null,
          body: "",
          error: error.code ?? String(error),
          bytesReceived: 0,
        }),
      );
      if (options.body === undefined) {
        req.end();
        return;
      }
      const body = Buffer.from(options.body);
      if (options.abortAfterBytes !== undefined) {
        req.write(body.subarray(0, options.abortAfterBytes));
        await sleep(options.chunkGapMs ?? 0);
        req.destroy();
        resolvePromise({
          status: null,
          body: "",
          error: "aborted-by-client-mid-body",
          bytesReceived: 0,
        });
        return;
      }
      const chunks = Math.max(1, options.chunks ?? 1);
      const size = Math.ceil(body.length / chunks);
      for (let index = 0; index < chunks; index += 1) {
        req.write(body.subarray(index * size, (index + 1) * size));
        if (index < chunks - 1) await sleep(options.chunkGapMs ?? 0);
      }
      req.end();
    })();
  });
}

function jitter(rng: SeededRng): Pick<SendOptions, "startDelayMs" | "chunks" | "chunkGapMs"> {
  return {
    startDelayMs: rng.bool(0.5) ? rng.range(0, 6) : 0,
    chunks: rng.range(1, 4),
    chunkGapMs: rng.bool(0.5) ? rng.range(0, 3) : 0,
  };
}

/** Clock skew: client timestamps are randomized ±30d; nothing server-side may depend on them. */
function skewedIso(rng: SeededRng): string {
  const skewMs = (rng.next() * 2 - 1) * 30 * 24 * 3600 * 1000;
  return new Date(Date.parse(PROVISIONED_AT) + skewMs).toISOString();
}

function reviewFor(coachIndex: 0 | 1 | 2, queueItemId: string, rng: SeededRng): CoachReview {
  const [fixture] = syntheticAgreeingPair();
  const coach = COACHES[coachIndex];
  const caseId = queueItemId.replace(/-E\d+$/, "");
  const eventIndex = Number(/-E(\d+)$/.exec(queueItemId)![1]) - 1;
  return {
    ...fixture!,
    coachId: coach.coachId,
    coachCredentialRef: coach.credentialRef,
    queueItemId,
    eventRef: { caseId, eventIndex },
    reviewId: `${queueItemId}.${coach.coachId}`,
    confidence: 0.5 + rng.int(40) / 100,
    provenance: {
      ...fixture!.provenance,
      coachQualificationSnapshot: {
        ...fixture!.provenance.coachQualificationSnapshot,
        coachId: coach.coachId,
        credentialRef: coach.credentialRef,
        provisionedAtIso: PROVISIONED_AT,
        provisionedBy: PROVISIONED_BY,
      },
    },
  };
}

function provisionAction(coachId: string, rng: SeededRng) {
  return {
    schemaVersion: 1,
    actionId: `${coachId}.a1`,
    action: "provision",
    coachId,
    performedBy: "stress-harness-admin",
    performedAtIso: skewedIso(rng),
    reason: "TEST-ONLY provisioning inside throwaway root (stress harness)",
    registryEntry: {
      coachId,
      credentialRef: `${coachId}-cred`,
      status: "active",
      provisionedAtIso: PROVISIONED_AT,
      provisionedBy: "stress-harness-admin",
      qualification: testQualification(),
    },
  };
}

function listJson(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : [];
}

function parseOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function fdCount(): number | null {
  try {
    return readdirSync("/proc/self/fd").length;
  } catch {
    return null;
  }
}

let unhandledRejections = 0;
const onUnhandled = (): void => {
  unhandledRejections += 1;
};

async function runIteration(seed: number): Promise<IterationRow> {
  const rng = createSeededRng(seed);
  const startedAt = Date.now();
  const failures: string[] = [];
  const notes: Record<string, unknown> = {};
  const fail = (message: string): void => {
    failures.push(message);
  };
  const env = await startEnv();
  const items = rng.shuffle(env.queueItemIds);
  const plan = {
    duplicateReviewCalls: rng.range(2, 6),
    amendmentRacers: rng.range(2, 5),
    assignmentItems: rng.range(2, Math.min(5, items.length - 5)),
    sameItemAssignmentRacers: rng.range(2, 5),
    provisionCoaches: rng.range(2, 4),
    duplicateProvisionCalls: rng.range(2, 3),
    midBodyAborts: rng.range(1, 3),
    midStreamAborts: rng.range(1, 3),
    listReadsDuringWrites: rng.range(2, 5),
    oversizeBody: rng.bool(0.3),
  };
  const dir = join(env.root, "datasets/coach-review");
  const [dupItem, twoActorItem, amendItem, cancelItem, ...assignPool] = items as [
    string,
    string,
    string,
    string,
    ...string[],
  ];
  const assignmentItems = assignPool.slice(0, plan.assignmentItems);
  const sameItem = assignPool[plan.assignmentItems]!;

  try {
    // --- pre-step (sequential): base review that the amendment racers version ---
    const base = reviewFor(2, amendItem, rng);
    const baseResult = await send(env, {
      method: "POST",
      path: "/api/coach-reviews",
      body: JSON.stringify(base),
    });
    if (baseResult.status !== 201)
      fail(`pre-step base review expected 201, got ${baseResult.status}`);

    // --- the burst: every task starts inside one Promise.all ---
    const dupReview = reviewFor(0, dupItem, rng);
    const dupBody = JSON.stringify(dupReview);
    const actorA = reviewFor(0, twoActorItem, rng);
    const actorB = reviewFor(1, twoActorItem, rng);
    const amendments: ReviewAmendment[] = Array.from({ length: plan.amendmentRacers }, (_, i) => ({
      schemaVersion: 1,
      amendmentId: `${base.reviewId}.r2`,
      reviewId: base.reviewId,
      revision: 2,
      reason: `stress racer ${i} rewatched the clip — confidence revised`,
      review: { ...base, confidence: 0.1 + i * 0.05 },
      createdAtIso: skewedIso(rng),
    }));
    const assignments = assignmentItems.map((queueItemId, i) => ({
      queueItemId,
      coachIds: [COACHES[i % 3]!.coachId],
      assignedAtIso: skewedIso(rng),
      assignedBy: "stress-harness-admin",
    }));
    const sameItemAssignments = Array.from({ length: plan.sameItemAssignmentRacers }, (_, i) => ({
      queueItemId: sameItem,
      coachIds: rng.shuffle(COACHES.map((coach) => coach.coachId)).slice(0, 1 + (i % 3)),
      assignedAtIso: skewedIso(rng),
      assignedBy: `stress-actor-${i}`,
    }));
    const newCoachIds = Array.from(
      { length: plan.provisionCoaches },
      (_, i) => `stress-coach-${seed % 1000}-${i}`,
    );
    const provisions = newCoachIds.map((coachId) => provisionAction(coachId, rng));
    const duplicatedProvision = provisions[0]!;
    const cancelReview = reviewFor(0, cancelItem, rng);
    const cancelBody = JSON.stringify(cancelReview);
    const oversizeBody = JSON.stringify({
      ...reviewFor(1, cancelItem, rng),
      rationale: "x".repeat(1_000_001),
    });

    type Task = () => Promise<void>;
    const tasks: Task[] = [];
    const results = {
      dup: [] as SendResult[],
      actors: [] as SendResult[],
      amend: new Array<SendResult>(amendments.length),
      assign: [] as SendResult[],
      sameItem: [] as SendResult[],
      provision: [] as SendResult[],
      dupProvision: [] as SendResult[],
      aborts: [] as SendResult[],
      streamAborts: [] as SendResult[],
      lists: [] as { path: string; result: SendResult }[],
      oversize: null as SendResult | null,
    };
    for (let i = 0; i < plan.duplicateReviewCalls; i += 1) {
      tasks.push(async () => {
        results.dup.push(
          await send(env, {
            method: "POST",
            path: "/api/coach-reviews",
            body: dupBody,
            ...jitter(rng),
          }),
        );
      });
    }
    for (const review of [actorA, actorB]) {
      tasks.push(async () => {
        results.actors.push(
          await send(env, {
            method: "POST",
            path: "/api/coach-reviews",
            body: JSON.stringify(review),
            ...jitter(rng),
          }),
        );
      });
    }
    amendments.forEach((amendment, index) => {
      tasks.push(async () => {
        results.amend[index] = await send(env, {
          method: "POST",
          path: "/api/coach-review-amendments",
          body: JSON.stringify(amendment),
          ...jitter(rng),
        });
      });
    });
    for (const entry of assignments) {
      tasks.push(async () => {
        results.assign.push(
          await send(env, {
            method: "POST",
            path: "/api/coach-assignments",
            body: JSON.stringify(entry),
            ...jitter(rng),
          }),
        );
      });
    }
    for (const entry of sameItemAssignments) {
      tasks.push(async () => {
        results.sameItem.push(
          await send(env, {
            method: "POST",
            path: "/api/coach-assignments",
            body: JSON.stringify(entry),
            ...jitter(rng),
          }),
        );
      });
    }
    for (const action of provisions) {
      tasks.push(async () => {
        results.provision.push(
          await send(env, {
            method: "POST",
            path: "/api/coach-provisioning",
            body: JSON.stringify(action),
            ...jitter(rng),
          }),
        );
      });
    }
    for (let i = 0; i < plan.duplicateProvisionCalls; i += 1) {
      tasks.push(async () => {
        results.dupProvision.push(
          await send(env, {
            method: "POST",
            path: "/api/coach-provisioning",
            body: JSON.stringify(duplicatedProvision),
            ...jitter(rng),
          }),
        );
      });
    }
    for (let i = 0; i < plan.midBodyAborts; i += 1) {
      const cut = Math.max(1, Math.floor(cancelBody.length * (0.1 + rng.next() * 0.8)));
      tasks.push(async () => {
        results.aborts.push(
          await send(env, {
            method: "POST",
            path: "/api/coach-reviews",
            body: cancelBody,
            abortAfterBytes: cut,
            chunkGapMs: rng.range(0, 3),
            startDelayMs: rng.range(0, 4),
          }),
        );
      });
    }
    for (let i = 0; i < plan.midStreamAborts; i += 1) {
      const start = rng.int(STREAM_BLOB_BYTES / 2);
      tasks.push(async () => {
        results.streamAborts.push(
          await send(env, {
            method: "GET",
            path: "/datasets/coach-review/stress-blob.bin",
            headers: { range: `bytes=${start}-` },
            abortAfterFirstChunk: true,
            startDelayMs: rng.range(0, 4),
          }),
        );
      });
    }
    const listPaths = [
      "/api/coach-reviews",
      "/api/coach-review-amendments",
      "/api/coach-assignments",
      "/api/coach-provisioning",
      "/api/coach-adjudications",
      "/api/drill-mapping-proposals",
    ];
    for (let i = 0; i < plan.listReadsDuringWrites; i += 1) {
      const path = rng.pick(listPaths);
      tasks.push(async () => {
        results.lists.push({
          path,
          result: await send(env, { method: "GET", path, startDelayMs: rng.range(0, 8) }),
        });
      });
    }
    if (plan.oversizeBody) {
      tasks.push(async () => {
        results.oversize = await send(env, {
          method: "POST",
          path: "/api/coach-reviews",
          body: oversizeBody,
          chunks: 4,
          startDelayMs: rng.range(0, 4),
        });
      });
    }
    notes["burstSize"] = tasks.length;
    await Promise.all(rng.shuffle(tasks).map((task) => task()));

    // --- invariants ---
    const statuses = (list: SendResult[]) => list.map((result) => result.status ?? result.error);

    // duplicate calls: exactly one 201, the rest 409, one file, content == payload
    const dup201 = results.dup.filter((result) => result.status === 201).length;
    const dup409 = results.dup.filter((result) => result.status === 409).length;
    if (dup201 !== 1 || dup409 !== results.dup.length - 1) {
      fail(
        `duplicate review POST x${plan.duplicateReviewCalls}: statuses ${JSON.stringify(statuses(results.dup))} (expected one 201, rest 409)`,
      );
    }
    const dupFiles = listJson(join(dir, "reviews")).filter(
      (name) => name === `${dupReview.reviewId}.json`,
    );
    if (dupFiles.length !== 1)
      fail(`duplicate review: ${dupFiles.length} files for ${dupReview.reviewId}`);
    const dupOnDisk = parseOrNull(
      readFileSync(join(dir, "reviews", `${dupReview.reviewId}.json`), "utf8"),
    );
    if (JSON.stringify(dupOnDisk) !== JSON.stringify(dupReview))
      fail("duplicate review: on-disk record differs from payload (torn write?)");

    // two actors on the same row: both persisted, distinct files
    if (results.actors.some((result) => result.status !== 201)) {
      fail(
        `two actors same item: statuses ${JSON.stringify(statuses(results.actors))} (expected 201,201)`,
      );
    }
    for (const review of [actorA, actorB]) {
      if (!existsSync(join(dir, "reviews", `${review.reviewId}.json`)))
        fail(`two actors: missing ${review.reviewId}.json`);
    }

    // amendment race: exactly one revision-2 winner, one file, file == winner payload
    const amend201 = results.amend
      .map((result, i) => (result.status === 201 ? i : -1))
      .filter((i) => i >= 0);
    if (amend201.length !== 1) {
      fail(
        `amendment race x${plan.amendmentRacers}: statuses ${JSON.stringify(statuses(results.amend))} (expected exactly one 201)`,
      );
    }
    if (results.amend.some((result) => result.status !== 201 && result.status !== 409)) {
      fail(`amendment race: non-409 loser statuses ${JSON.stringify(statuses(results.amend))}`);
    }
    const amendFiles = listJson(join(dir, "amendments"));
    if (amendFiles.length !== 1)
      fail(`amendment race: ${amendFiles.length} amendment files (expected 1)`);
    const winner = amend201.length === 1 ? amendments[amend201[0]!] : undefined;
    if (winner && amendFiles.length === 1) {
      const onDisk = parseOrNull(
        readFileSync(join(dir, "amendments", amendFiles[0]!), "utf8"),
      ) as ReviewAmendment | null;
      if (!onDisk || onDisk.review.confidence !== winner.review.confidence) {
        fail(
          "amendment race: persisted amendment is not the racer that received 201 (lost update)",
        );
      }
    }
    const rev3 = await send(env, {
      method: "POST",
      path: "/api/coach-review-amendments",
      body: JSON.stringify({ ...amendments[0]!, amendmentId: `${base.reviewId}.r3`, revision: 3 }),
    });
    if (rev3.status !== 201)
      fail(
        `amendment chain: revision 3 after the race expected 201, got ${rev3.status} ${rev3.body.slice(0, 120)}`,
      );

    // assignments: no lost update across distinct items; exactly one row for the contested item
    if (results.assign.some((result) => result.status !== 201)) {
      fail(`assignments distinct items: statuses ${JSON.stringify(statuses(results.assign))}`);
    }
    if (results.sameItem.some((result) => result.status !== 201)) {
      fail(`assignments same item: statuses ${JSON.stringify(statuses(results.sameItem))}`);
    }
    const assignmentsFile = parseOrNull(
      readFileSync(join(dir, "assignments.json"), "utf8"),
    ) as AssignmentsFile | null;
    if (!assignmentsFile) fail("assignments.json is not valid JSON (torn write)");
    else {
      for (const entry of assignments) {
        const rows = assignmentsFile.assignments.filter(
          (row) => row.queueItemId === entry.queueItemId,
        );
        if (rows.length !== 1)
          fail(
            `assignments: ${rows.length} rows for ${entry.queueItemId} (expected 1 — lost update or duplicate)`,
          );
        else if (JSON.stringify(rows[0]!.coachIds) !== JSON.stringify(entry.coachIds))
          fail(
            `assignments: row for ${entry.queueItemId} has coachIds ${JSON.stringify(rows[0]!.coachIds)}, expected ${JSON.stringify(entry.coachIds)}`,
          );
      }
      const contested = assignmentsFile.assignments.filter((row) => row.queueItemId === sameItem);
      if (contested.length !== 1)
        fail(
          `assignments same item: ${contested.length} rows for ${sameItem} (expected exactly 1)`,
        );
      else if (
        !sameItemAssignments.some((entry) => JSON.stringify(entry) === JSON.stringify(contested[0]))
      )
        fail(
          "assignments same item: persisted row matches none of the submitted payloads (torn merge)",
        );
      if (assignmentsFile.assignments.length !== assignments.length + 1)
        fail(
          `assignments: ${assignmentsFile.assignments.length} rows total, expected ${assignments.length + 1}`,
        );
    }
    const assignGet = await send(env, { method: "GET", path: "/api/coach-assignments" });
    if (assignGet.status !== 200 || parseOrNull(assignGet.body) === null)
      fail(`assignments GET after burst: ${assignGet.status}`);

    // provisioning: every distinct coach provisioned once; duplicate provision exactly one 201
    const prov201 = results.provision.filter((result) => result.status === 201).length;
    const dupProv201 = results.dupProvision.filter((result) => result.status === 201).length;
    if (prov201 + dupProv201 !== provisions.length) {
      fail(
        `provisioning: ${prov201 + dupProv201} 201s for ${provisions.length} distinct coaches (dup-call statuses ${JSON.stringify(statuses(results.dupProvision))}, distinct ${JSON.stringify(statuses(results.provision))})`,
      );
    }
    if (
      [...results.provision, ...results.dupProvision].some(
        (result) => result.status !== 201 && result.status !== 422 && result.status !== 409,
      )
    ) {
      fail(
        `provisioning: unexpected statuses ${JSON.stringify(statuses([...results.provision, ...results.dupProvision]))}`,
      );
    }
    const registry = parseOrNull(
      readFileSync(join(dir, "coaches.json"), "utf8"),
    ) as CoachRegistry | null;
    if (!registry) fail("coaches.json is not valid JSON (torn write)");
    else {
      for (const coachId of newCoachIds) {
        const rows = registry.coaches.filter((coach) => coach.coachId === coachId);
        if (rows.length !== 1)
          fail(`provisioning: ${rows.length} registry rows for ${coachId} (expected 1)`);
      }
      const registryProblems = validateCoachRegistry(registry);
      if (registryProblems.length > 0)
        fail(`provisioning: registry invalid after burst: ${registryProblems.join("; ")}`);
    }
    const logFiles = listJson(join(dir, "provisioning-log"));
    if (logFiles.length !== provisions.length)
      fail(`provisioning: ${logFiles.length} audit files, expected ${provisions.length}`);
    const suspend = await send(env, {
      method: "POST",
      path: "/api/coach-provisioning",
      body: JSON.stringify({
        schemaVersion: 1,
        actionId: `${newCoachIds[0]}.a2`,
        action: "suspend",
        coachId: newCoachIds[0],
        performedBy: "stress-harness-admin",
        performedAtIso: skewedIso(rng),
        reason: "TEST-ONLY suspension inside throwaway root (stress harness)",
        registryEntry: null,
      }),
    });
    if (suspend.status !== 201)
      fail(
        `provisioning chain: a2 suspend after the race expected 201, got ${suspend.status} ${suspend.body.slice(0, 160)}`,
      );

    // call-during-call: every listing read during writes was a complete, valid JSON document
    for (const { path, result } of results.lists) {
      if (result.status !== 200 || parseOrNull(result.body) === null)
        fail(
          `GET ${path} during writes: status ${result.status ?? result.error}, valid JSON=${parseOrNull(result.body) !== null}`,
        );
    }

    // cancel-during-call: aborted uploads persisted nothing
    if (existsSync(join(dir, "reviews", `${cancelReview.reviewId}.json`)))
      fail("cancel-during-call: a mid-body-aborted review was persisted");
    notes["midBodyAborts"] = statuses(results.aborts);
    notes["midStreamAborts"] = results.streamAborts.map(
      (result) => `${result.status}/${result.bytesReceived}B`,
    );
    if (results.oversize) {
      notes["oversize"] = results.oversize.status ?? results.oversize.error;
      if (results.oversize.status === 201) fail("oversize body was accepted with 201");
    }

    // liveness after the burst
    const alive = await send(env, { method: "GET", path: "/api/coach-reviews" });
    const reviewsListed = parseOrNull(alive.body) as unknown[] | null;
    if (alive.status !== 200 || !Array.isArray(reviewsListed))
      fail(`server not healthy after burst: ${alive.status ?? alive.error}`);
    else if (reviewsListed.length !== 4)
      fail(
        `reviews listed after burst: ${reviewsListed.length}, expected 4 (base, dup, actorA, actorB)`,
      );
    if (unhandledRejections > 0) fail(`unhandled rejections observed: ${unhandledRejections}`);
  } finally {
    await stopEnv(env);
  }
  return {
    seed,
    outcome: failures.length === 0 ? "HELD" : "BROKEN",
    ms: Date.now() - startedAt,
    plan,
    failures,
    notes,
  };
}

const campaign = planCampaign(process.env, {
  iterations: DEFAULT_ITERATIONS,
  baseSeed: DEFAULT_BASE_SEED,
});

describe("labApi concurrency stress (seeded Promise.all bursts, throwaway roots)", () => {
  const fdBefore = fdCount();
  beforeAll(() => process.on("unhandledRejection", onUnhandled));
  afterAll(() => process.off("unhandledRejection", onUnhandled));

  it(
    `holds idempotency / no-duplicate / no-lost-update / liveness over ${campaign.seeds.length} seeded interleavings`,
    async () => {
      const startedAtIso = new Date().toISOString();
      const rows: IterationRow[] = [];
      let maxFd = fdBefore ?? 0;
      for (const seed of campaign.seeds) {
        const startedAt = Date.now();
        try {
          rows.push(await withDeadline(runIteration(seed), ITERATION_DEADLINE_MS, `seed ${seed}`));
        } catch (error) {
          rows.push({
            seed,
            outcome: String(error).includes("TIMEOUT") ? "TIMEOUT" : "BROKEN",
            ms: Date.now() - startedAt,
            plan: {},
            failures: [String(error)],
            notes: {},
          });
        }
        const fd = fdCount();
        if (fd !== null) maxFd = Math.max(maxFd, fd);
      }
      const fdAfter = fdCount();
      const table = summarize("labApi.concurrency.stress", campaign.baseSeed, startedAtIso, rows);
      const fdGrowth = fdBefore !== null && fdAfter !== null ? fdAfter - fdBefore : null;
      const withFd = { ...table, fdBefore, fdAfter, fdMax: maxFd, fdGrowth };
      if (campaign.outPath) writeResultsTable(campaign.outPath, withFd);
      console.log(
        `[stress] labApi concurrency: ${table.held} HELD / ${table.broken} BROKEN / ${table.timeouts} TIMEOUT over ${table.iterations} seeds (base ${campaign.baseSeed}); fd ${fdBefore}→${fdAfter} (max ${maxFd})` +
          (table.failedSeeds.length > 0 ? `; failing seeds: ${table.failedSeeds.join(",")}` : ""),
      );
      const brokenRows = rows.filter((row) => row.outcome !== "HELD");
      expect(
        brokenRows.map((row) => `seed ${row.seed} (${row.outcome}): ${row.failures.join(" | ")}`),
        "replay a failing seed with STRESS_ONLY_SEED=<seed>",
      ).toEqual([]);
    },
    campaign.seeds.length * ITERATION_DEADLINE_MS + 30_000,
  );

  // cancel-during-stream (Linux only: needs /proc/self/fd). The browser's <video>
  // element aborts Range requests on every seek, so each aborted GET /datasets/**
  // must release the file descriptor the server opened for it.
  it.skipIf(process.platform !== "linux")(
    "releases the server-side file descriptor when a client aborts a Range GET mid-stream",
    async () => {
      const env = await startEnv();
      const blobFds = (): number =>
        readdirSync("/proc/self/fd").filter((name) => {
          try {
            return readlinkSync(`/proc/self/fd/${name}`).endsWith("stress-blob.bin");
          } catch {
            return false;
          }
        }).length;
      const rng = createSeededRng(campaign.baseSeed);
      const aborted = 64;
      try {
        expect(blobFds(), "precondition: no blob fds open").toBe(0);
        await Promise.all(
          Array.from({ length: aborted }, () =>
            send(env, {
              method: "GET",
              path: "/datasets/coach-review/stress-blob.bin",
              headers: { range: `bytes=${rng.int(STREAM_BLOB_BYTES / 2)}-` },
              abortAfterFirstChunk: true,
              startDelayMs: rng.range(0, 4),
            }),
          ),
        );
        await sleep(250);
        const control = await send(env, {
          method: "GET",
          path: "/datasets/coach-review/stress-blob.bin",
        });
        expect(control.status, "control: a complete GET still succeeds").toBe(200);
        await sleep(250);
        const leaked = blobFds();
        console.log(
          `[stress] cancel-during-stream: ${aborted} aborted Range GETs → ${leaked} blob fds still open`,
        );
        expect(
          leaked,
          `fds still open on stress-blob.bin after ${aborted} client-aborted Range GETs`,
        ).toBeLessThan(4);
      } finally {
        await stopEnv(env);
      }
    },
  );
});
