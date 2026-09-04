import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { ApiSloRecorder } from "@pickle/slo";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";
import { FakeObjectStore } from "./support/fakeObjectStore.js";
import { publishTestScoringRelease } from "./support/scoringRelease.js";
import {
  AWS_PERMANENT_CODES,
  AWS_TRANSIENT_CODES,
  Chaos,
  ChaosAnalytics,
  ChaosError,
  ChaosObjectStore,
  ChaosQueue,
  ChaosSecuritySink,
  checkEnvelope,
  faultId,
  FETCH_MALFORMED_VARIANTS,
  FETCH_PARTIAL_VARIANTS,
  FETCH_STATUS_FAULTS,
  findLeaks,
  installChaosFetch,
  isTransientFault,
  iterationSeed,
  PG_MALFORMED_VARIANTS,
  PG_MESSAGE_FAULTS,
  PG_OUTAGE_CODES,
  PG_PARTIAL_VARIANTS,
  PG_PERMANENT_CODES,
  PG_TRANSIENT_CODES,
  Rng,
  SLOW_MS,
  STORE_MALFORMED_VARIANTS,
  STORE_PARTIAL_VARIANTS,
  wrapPool,
  type Dep,
  type Fault,
  type Mode,
} from "./stress/failureInjection.js";

/**
 * Seeded failure-injection campaign against the legacy Fastify API.
 *
 * Runs against the REAL test database (DATABASE_URL_TEST) so that "no
 * corrupted persisted state" is checked on real rows. Skipped visibly without
 * the URL, exactly like integration.test.ts.
 *
 *   STRESS_ITER=<n>        iterations (default 40; CI-friendly)
 *   STRESS_SEED=<n>        campaign seed (default 20260904)
 *   STRESS_REPLAY=<a,b,c>  replay only these iteration seeds
 *   STRESS_SLOW=1          include faults that wait on the API's own 8s/5s
 *                          upstream deadlines ("never" on fetch)
 *   STRESS_DEADLINE_MS     per-request wall clock before "HUNG" (default 3000)
 *   STRESS_OUT=<file>      write the JSON results table here
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const DEV_SECRET = "stress-secret-0123456789abcdef";
const RC_KEY = "stress-dummy-revenuecat-key-not-a-secret";
const RC_WEBHOOK_AUTH = "stress-dummy-webhook-auth-not-a-secret";
const SECRETS = [DEV_SECRET, RC_KEY, RC_WEBHOOK_AUTH, "pickle_test_password"];

const STRESS_ITER = Number(process.env["STRESS_ITER"] ?? 40);
const CAMPAIGN_SEED = Number(process.env["STRESS_SEED"] ?? 20260904);
const REPLAY = (process.env["STRESS_REPLAY"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);
const SLOW = process.env["STRESS_SLOW"] === "1";
const DEADLINE_MS = Number(process.env["STRESS_DEADLINE_MS"] ?? 3000);
const OUT = process.env["STRESS_OUT"];

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

// ---------------------------------------------------------------------------
// Fault catalogue: which modes/details each dependency supports
// ---------------------------------------------------------------------------

const MODES_BY_DEP: Record<Dep, readonly Mode[]> = {
  "pg.query": ["throw", "reject", "timeout", "malformed", "partial", "slow", "never"],
  "pg.tx": ["throw", "reject", "timeout", "malformed", "partial", "slow", "never"],
  // Opaque return values (job id, presigned URL, depth) have no contract the
  // API could validate, so malformed/partial are only modelled where the API
  // reads structured fields (pg rows, HEAD metadata, provider JSON).
  "queue.enqueue": ["throw", "reject", "timeout", "slow", "never"],
  "queue.size": ["reject", "timeout", "slow", "never"],
  "queue.oldest": ["reject", "timeout", "slow", "never"],
  "store.presignUpload": ["throw", "reject", "timeout", "slow", "never"],
  "store.headObject": ["throw", "reject", "timeout", "malformed", "partial", "slow", "never"],
  "store.presignDownload": ["throw", "reject", "timeout", "slow", "never"],
  "fetch.revenuecat": ["throw", "reject", "timeout", "malformed", "partial", "slow", "never"],
  "fetch.jwks": ["throw", "reject", "timeout", "malformed", "partial", "slow", "never"],
  "sink.analytics": ["throw", "reject", "never"],
  "sink.security": ["throw"],
  "sink.slo": ["throw"],
};

const PG_ERROR_DETAILS = [
  ...PG_OUTAGE_CODES,
  ...PG_TRANSIENT_CODES,
  ...PG_PERMANENT_CODES,
  ...PG_MESSAGE_FAULTS,
];

function pickDetail(rng: Rng, dep: Dep, mode: Mode): string {
  if (mode === "slow") return rng.pick(SLOW_MS);
  if (mode === "timeout" || mode === "never") return "-";
  if (dep === "pg.query" || dep === "pg.tx") {
    if (mode === "malformed") return rng.pick(PG_MALFORMED_VARIANTS);
    if (mode === "partial") return rng.pick(PG_PARTIAL_VARIANTS);
    return rng.pick(PG_ERROR_DETAILS);
  }
  if (dep === "fetch.revenuecat" || dep === "fetch.jwks") {
    if (mode === "throw") return rng.pick(FETCH_STATUS_FAULTS);
    if (mode === "reject") return rng.pick(["ECONNRESET", "ENOTFOUND", "ECONNREFUSED"]);
    if (mode === "malformed") return rng.pick(FETCH_MALFORMED_VARIANTS);
    if (mode === "partial") return rng.pick(FETCH_PARTIAL_VARIANTS);
  }
  if (dep.startsWith("store.")) {
    if (mode === "malformed") return rng.pick(STORE_MALFORMED_VARIANTS);
    if (mode === "partial") return rng.pick(STORE_PARTIAL_VARIANTS);
    return rng.pick([...AWS_TRANSIENT_CODES, ...AWS_PERMANENT_CODES]);
  }
  if (dep.startsWith("queue.")) {
    if (mode === "malformed" || mode === "partial") return "shape";
    return rng.pick([...AWS_TRANSIENT_CODES, ...AWS_PERMANENT_CODES]);
  }
  return "-";
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface Prepared {
  request: InjectOptions;
  /** Returns persisted-state problems after the response (empty = consistent). */
  verify: (status: number | null, body: unknown) => Promise<string[]>;
}

interface Scenario {
  name: string;
  deps: readonly Dep[];
  /** A hard fault (throw/reject/timeout/never/malformed) here must not yield 2xx. */
  critical: readonly Dep[];
  happyStatus: number;
  prepare: () => Promise<Prepared>;
}

interface IterationResult {
  index: number;
  seed: number;
  scenario: string;
  fault: Fault;
  faultId: string;
  fired: boolean;
  status: number | null;
  code: string | null;
  kind: string | null;
  retryable: boolean | null;
  durationMs: number;
  hung: boolean;
  checks: Record<string, "pass" | "fail" | "n/a">;
  problems: string[];
  verdict: "HELD" | "BROKEN" | "NOFIRE" | "SKIPPED_SLOW";
}

/**
 * Documented behavioural gaps reproduced by this campaign (each is a finding
 * in the stress report). A BROKEN iteration must match one of these or the
 * campaign fails — new gaps cannot hide behind old ones.
 */
interface KnownGap {
  id: string;
  file: string;
  matches: (r: IterationResult) => boolean;
}

const failedOnly = (r: IterationResult, check: string): boolean =>
  r.checks[check] === "fail" &&
  Object.entries(r.checks).every(([k, v]) => k === check || v !== "fail");

const KNOWN_GAPS: readonly KnownGap[] = [
  {
    // No pool statement/connection timeout and no Fastify requestTimeout: a
    // dependency call that never settles pins the request open forever.
    id: "hang_no_deadline",
    file: "services/api/src/app.ts:164",
    matches: (r) =>
      r.fault.mode === "never" &&
      r.hung &&
      Object.entries(r.checks).every(([k, v]) => k === "bounded_completion" || v !== "fail"),
  },
  {
    // Retryable Postgres conditions (40001 serialization_failure, 40P01
    // deadlock_detected, 57014 query_canceled) are not in the datastore
    // outage classifier, so they surface as permanent 500 api.internal_error.
    id: "pg_transient_code_permanent_500",
    file: "services/api/src/app.ts:67-87",
    matches: (r) =>
      (r.fault.dep === "pg.query" || r.fault.dep === "pg.tx") &&
      (r.fault.mode === "throw" || r.fault.mode === "reject") &&
      (PG_TRANSIENT_CODES as readonly string[]).includes(r.fault.detail) &&
      r.status === 500 &&
      failedOnly(r, "transient_is_retryable"),
  },
  {
    // AWS-SDK style transient errors (TimeoutError, NetworkingError, SlowDown,
    // Throttling, InternalError) from the object store, and from the queue
    // on the health probe, are not classified: 500 api.internal_error,
    // retryable=false. (media enqueue is the exception — it maps to 503
    // media.dispatch_failed retryable, and the campaign confirms that.)
    id: "aws_transient_permanent_500",
    file: "services/api/src/app.ts:67-87,328",
    matches: (r) =>
      (r.fault.dep.startsWith("store.") || r.fault.dep.startsWith("queue.")) &&
      isTransientFault(r.fault) &&
      r.status === 500 &&
      failedOnly(r, "transient_is_retryable"),
  },
  {
    // RevenueCat answering 200 with a non-JSON / truncated body throws inside
    // response.json() before the schema check, bypassing the retryable
    // billing.revenuecat_invalid_response path.
    id: "revenuecat_unparseable_body_permanent_500",
    file: "services/api/src/modules/billing/revenueCat.ts:108",
    matches: (r) =>
      r.fault.dep === "fetch.revenuecat" &&
      r.fault.mode === "malformed" &&
      r.status === 500 &&
      failedOnly(r, "malformed_upstream_retryable"),
  },
];

class RecordingQueue extends InMemoryJobQueue {
  readonly enqueued: Array<{ kind: string; payload: unknown }> = [];
  override async enqueue(kind: string, payload: unknown): Promise<string> {
    this.enqueued.push({ kind, payload });
    return super.enqueue(kind, payload);
  }
}

class ChaosSlo extends ApiSloRecorder {
  constructor(private readonly chaos: Chaos) {
    super();
  }
  override recordRequest(sample: Parameters<ApiSloRecorder["recordRequest"]>[0]): void {
    this.chaos.interceptSync(
      "sink.slo",
      () => super.recordRequest(sample),
      () => new ChaosError("slo recorder exploded"),
    );
  }
}

function futureIso(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function revenueCatHappyCustomer(): unknown {
  return {
    request_date: new Date().toISOString(),
    subscriber: {
      entitlements: {
        premium: {
          expires_date: futureIso(30),
          grace_period_expires_date: null,
          product_identifier: "com.picklesensei.premium_monthly_499",
          purchase_date: new Date().toISOString(),
        },
      },
      subscriptions: {
        "com.picklesensei.premium_monthly_499": {
          store: "APP_STORE",
          expires_date: futureIso(30),
          purchase_date: new Date().toISOString(),
          original_purchase_date: new Date().toISOString(),
          original_transaction_id: "stress-tx-1",
          is_sandbox: true,
          period_type: "normal",
        },
      },
    },
  };
}

function textResponse(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": contentType },
  }) as unknown as Response;
}

describe.skipIf(!testUrl)("stress: failure injection (svc-api-legacy)", () => {
  let app: FastifyInstance;
  let db: pg.Pool; // un-wrapped pool for state verification
  let chaos: Chaos;
  let queue: RecordingQueue;
  let store: FakeObjectStore;
  let security: ChaosSecuritySink;
  let analytics: ChaosAnalytics;
  let minter: DevTokenVerifier;
  let restoreFetch: () => void;
  let userToken: string;
  let userId: string;
  let billingToken: string;
  let billingUserId: string;
  let adminToken: string;
  const results: IterationResult[] = [];
  const profile: Record<string, Partial<Record<Dep, number>>> = {};
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  const savedEnv: Record<string, string | undefined> = {};

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const bootstrapBody = {
    locale: "en-US",
    timezone: "America/Los_Angeles",
    device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
  };

  async function cleanInject(options: InjectOptions) {
    // Helper for scenario preparation: runs with chaos disarmed and re-arms.
    const saved = chaos.active;
    chaos.active = null;
    try {
      return await app.inject(options);
    } finally {
      chaos.active = saved;
    }
  }

  async function bootstrapUser(subject: string, role: "user" | "admin" = "user") {
    const token = await minter.mint(subject, role);
    const res = await cleanInject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: auth(token),
      payload: bootstrapBody,
    });
    expect(res.statusCode, res.body).toBe(200);
    const id = (res.json() as { user: { id: string } }).user.id;
    return { token, id };
  }

  async function createUpload(): Promise<{ assetId: string; objectKey: string }> {
    const sha = randomUUID().replace(/-/g, "").padEnd(64, "0");
    const res = await cleanInject({
      method: "POST",
      url: "/v1/media/uploads",
      headers: auth(userToken),
      payload: {
        kind: "raw_video",
        filename: "clip.mp4",
        bytes: 4096,
        contentType: "video/mp4",
        sha256: sha,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const assetId = (res.json() as { mediaAssetId: string }).mediaAssetId;
    const row = await db.query<{ object_key: string }>(
      "SELECT object_key FROM media_asset WHERE id = $1",
      [assetId],
    );
    const objectKey = row.rows[0]!.object_key;
    store.objects.set(objectKey, 4096);
    return { assetId, objectKey };
  }

  async function createReadyAsset(): Promise<string> {
    const { assetId } = await createUpload();
    const res = await cleanInject({
      method: "POST",
      url: `/v1/media/${assetId}/complete`,
      headers: auth(userToken),
    });
    expect(res.statusCode, res.body).toBe(200);
    return assetId;
  }

  async function reservePermit(): Promise<string> {
    const res = await cleanInject({
      method: "POST",
      url: "/v1/analysis-permits",
      headers: auth(userToken),
      payload: { idempotencyKey: randomUUID() },
    });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { permit: { id: string } }).permit.id;
  }

  const scenarios: Scenario[] = [
    {
      name: "GET /v1/health/slo",
      deps: ["pg.query", "queue.size", "queue.oldest", "sink.slo"],
      critical: ["queue.size", "queue.oldest"],
      happyStatus: 200,
      prepare: async () => ({
        request: { method: "GET", url: "/v1/health/slo" },
        verify: async () => [],
      }),
    },
    {
      name: "GET /v1/me",
      deps: ["pg.query", "sink.slo"],
      critical: ["pg.query"],
      happyStatus: 200,
      prepare: async () => ({
        request: { method: "GET", url: "/v1/me", headers: auth(userToken) },
        verify: async () => [],
      }),
    },
    {
      // Telemetry sinks only see traffic on failures: a rejected token drives
      // analytics.track/flush + security.record. Their faults must be absorbed.
      name: "GET /v1/me (garbage bearer -> 401)",
      deps: ["sink.analytics", "sink.security", "sink.slo"],
      critical: [],
      happyStatus: 401,
      prepare: async () => ({
        request: { method: "GET", url: "/v1/me", headers: auth("not.a.jwt") },
        verify: async () => [],
      }),
    },
    {
      name: "GET /v1/flags",
      deps: ["pg.query"],
      critical: ["pg.query"],
      happyStatus: 200,
      prepare: async () => ({
        request: { method: "GET", url: "/v1/flags", headers: auth(userToken) },
        verify: async () => [],
      }),
    },
    {
      name: "GET /v1/catalog/shot-types",
      deps: ["pg.query"],
      critical: ["pg.query"],
      happyStatus: 200,
      prepare: async () => ({
        request: { method: "GET", url: "/v1/catalog/shot-types" },
        verify: async () => [],
      }),
    },
    {
      name: "GET /v1/me/access",
      deps: ["pg.query"],
      critical: ["pg.query"],
      happyStatus: 200,
      prepare: async () => ({
        request: { method: "GET", url: "/v1/me/access", headers: auth(userToken) },
        verify: async () => [],
      }),
    },
    {
      name: "POST /v1/account/bootstrap (fresh subject)",
      deps: ["pg.query", "pg.tx"],
      critical: ["pg.query", "pg.tx"],
      happyStatus: 200,
      prepare: async () => {
        const subject = `auth0|stress-${randomUUID()}`;
        const token = await minter.mint(subject);
        return {
          request: {
            method: "POST",
            url: "/v1/account/bootstrap",
            headers: auth(token),
            payload: bootstrapBody,
          },
          verify: async (status) => {
            const problems: string[] = [];
            const users = await db.query<{ id: string }>(
              "SELECT id FROM app_user WHERE auth_subject = $1",
              [subject],
            );
            if (users.rowCount! > 1) problems.push("duplicate_app_user");
            if (status === 200 && users.rowCount === 0) problems.push("success_without_row");
            for (const { id } of users.rows) {
              const [profile, setting, device] = await Promise.all([
                db.query("SELECT 1 FROM user_profile WHERE user_id = $1", [id]),
                db.query("SELECT 1 FROM user_setting WHERE user_id = $1", [id]),
                db.query("SELECT 1 FROM user_device WHERE user_id = $1", [id]),
              ]);
              if (profile.rowCount === 0) problems.push("app_user_without_profile");
              if (setting.rowCount === 0) problems.push("app_user_without_setting");
              if (device.rowCount === 0) problems.push("app_user_without_device");
            }
            return problems;
          },
        };
      },
    },
    {
      name: "POST /v1/analysis-permits (reserve)",
      deps: ["pg.query", "pg.tx"],
      critical: ["pg.query", "pg.tx"],
      happyStatus: 200,
      prepare: async () => {
        const key = randomUUID();
        return {
          request: {
            method: "POST",
            url: "/v1/analysis-permits",
            headers: auth(userToken),
            payload: { idempotencyKey: key },
          },
          verify: async (status, body) => {
            const problems: string[] = [];
            const rows = await db.query<{ id: string; status: string }>(
              "SELECT id, status FROM analysis_permit WHERE user_id = $1 AND idempotency_key = $2",
              [userId, key],
            );
            if (rows.rowCount! > 1) problems.push("duplicate_permit_for_idempotency_key");
            if (status === 200) {
              const id = (body as { permit?: { id?: string } }).permit?.id;
              if (rows.rowCount !== 1 || rows.rows[0]!.id !== id)
                problems.push("success_permit_not_persisted");
            } else if (status !== null && status >= 500 && rows.rowCount !== 0) {
              problems.push("permit_persisted_despite_5xx");
            }
            return problems;
          },
        };
      },
    },
    {
      name: "POST /v1/analysis-permits/:id/finalize (cancelled)",
      deps: ["pg.query", "pg.tx"],
      critical: ["pg.query", "pg.tx"],
      happyStatus: 200,
      prepare: async () => {
        const permitId = await reservePermit();
        return {
          request: {
            method: "POST",
            url: `/v1/analysis-permits/${permitId}/finalize`,
            headers: auth(userToken),
            payload: { outcome: "cancelled", ratingId: null },
          },
          verify: async (status) => {
            const problems: string[] = [];
            const row = await db.query<{ status: string; outcome: string | null }>(
              "SELECT status, outcome FROM analysis_permit WHERE id = $1",
              [permitId],
            );
            const permit = row.rows[0];
            if (!permit) return ["permit_vanished"];
            if (!["reserved", "released"].includes(permit.status))
              problems.push(`permit_invalid_status:${permit.status}`);
            if (permit.status === "released" && permit.outcome !== "cancelled")
              problems.push("released_with_wrong_outcome");
            if (status === 200 && permit.status !== "released")
              problems.push("success_without_release");
            return problems;
          },
        };
      },
    },
    {
      name: "POST /v1/media/uploads",
      deps: ["pg.query", "store.presignUpload"],
      critical: ["pg.query", "store.presignUpload"],
      happyStatus: 200,
      prepare: async () => {
        const sha = randomUUID().replace(/-/g, "").padEnd(64, "0");
        return {
          request: {
            method: "POST",
            url: "/v1/media/uploads",
            headers: auth(userToken),
            payload: {
              kind: "raw_video",
              filename: "clip.mp4",
              bytes: 4096,
              contentType: "video/mp4",
              sha256: sha,
            },
          },
          verify: async (status, body) => {
            const problems: string[] = [];
            const rows = await db.query<{ id: string; status: string }>(
              "SELECT id, status FROM media_asset WHERE owner_user_id = $1 AND sha256 = $2",
              [userId, sha],
            );
            if (rows.rowCount! > 1) problems.push("duplicate_media_asset");
            if (status === 200) {
              const b = body as { mediaAssetId?: string; uploadUrl?: unknown };
              if (rows.rowCount !== 1 || rows.rows[0]!.id !== b.mediaAssetId)
                problems.push("success_asset_not_persisted");
              if (typeof b.uploadUrl !== "string" || b.uploadUrl.length === 0)
                problems.push("success_without_upload_url");
            }
            return problems;
          },
        };
      },
    },
    {
      name: "POST /v1/media/:id/complete",
      deps: ["pg.query", "store.headObject", "queue.enqueue"],
      critical: ["pg.query", "store.headObject", "queue.enqueue"],
      happyStatus: 200,
      prepare: async () => {
        const { assetId } = await createUpload();
        const before = queue.enqueued.length;
        return {
          request: {
            method: "POST",
            url: `/v1/media/${assetId}/complete`,
            headers: auth(userToken),
          },
          verify: async (status) => {
            const problems: string[] = [];
            const row = await db.query<{ status: string }>(
              "SELECT status FROM media_asset WHERE id = $1",
              [assetId],
            );
            const st = row.rows[0]?.status;
            if (!st) return ["asset_vanished"];
            const processJob = queue.enqueued
              .slice(before)
              .some(
                (j) =>
                  j.kind === "media.process" &&
                  (j.payload as { mediaAssetId: string }).mediaAssetId === assetId,
              );
            if (!["uploading", "ready", "deleted"].includes(st))
              problems.push(`invalid_status:${st}`);
            if (status === 200 && (st !== "ready" || !processJob))
              problems.push("success_without_ready_and_job");
            if (st === "ready" && !processJob) problems.push("ready_without_process_job");
            return problems;
          },
        };
      },
    },
    {
      name: "GET /v1/media/:id (signed playback URL)",
      deps: ["pg.query", "store.presignDownload"],
      critical: ["pg.query", "store.presignDownload"],
      happyStatus: 200,
      prepare: async () => {
        const assetId = await createReadyAsset();
        return {
          request: { method: "GET", url: `/v1/media/${assetId}`, headers: auth(userToken) },
          verify: async (status, body) => {
            if (status !== 200) return [];
            const url = (body as { signedUrl?: unknown }).signedUrl;
            return typeof url === "string" && url.length > 0 ? [] : ["success_without_signed_url"];
          },
        };
      },
    },
    {
      name: "DELETE /v1/media/:id",
      deps: ["pg.query", "queue.enqueue"],
      critical: ["pg.query"],
      happyStatus: 204,
      prepare: async () => {
        const assetId = await createReadyAsset();
        return {
          request: { method: "DELETE", url: `/v1/media/${assetId}`, headers: auth(userToken) },
          verify: async (status) => {
            const row = await db.query<{ status: string; deleted_at: Date | null }>(
              "SELECT status, deleted_at FROM media_asset WHERE id = $1",
              [assetId],
            );
            const a = row.rows[0];
            if (!a) return ["asset_vanished"];
            const problems: string[] = [];
            if (status === 204 && (a.status !== "deleted" || !a.deleted_at))
              problems.push("success_without_deletion");
            if ((a.status === "deleted") !== Boolean(a.deleted_at))
              problems.push("deleted_flag_inconsistent");
            return problems;
          },
        };
      },
    },
    {
      name: "POST /v1/billing/sync",
      deps: ["pg.query", "pg.tx", "fetch.revenuecat"],
      critical: ["pg.query", "pg.tx", "fetch.revenuecat"],
      happyStatus: 200,
      prepare: async () => ({
        request: { method: "POST", url: "/v1/billing/sync", headers: auth(billingToken) },
        verify: async (status, body) => {
          const problems: string[] = [];
          const ent = await db.query<{ source: string; valid_to: Date | null }>(
            "SELECT source, valid_to FROM entitlement WHERE user_id = $1 AND feature_key = 'premium'",
            [billingUserId],
          );
          const subs = await db.query<{ status: string }>(
            "SELECT status FROM billing_subscription WHERE user_id = $1 AND provider = 'revenuecat'",
            [billingUserId],
          );
          if (subs.rowCount! > 1) problems.push("duplicate_subscription_rows");
          if (status === 200) {
            const premium = (body as { billing?: { premium?: boolean } }).billing?.premium;
            if (premium !== true) problems.push("success_without_premium");
            if (ent.rowCount !== 1 || ent.rows[0]!.source !== "revenuecat")
              problems.push("success_without_entitlement");
          }
          // Entitlement without a live subscription row is a half-write.
          if (ent.rowCount === 1 && subs.rowCount === 0)
            problems.push("entitlement_without_subscription");
          return problems;
        },
      }),
    },
    {
      name: "POST /v1/webhooks/revenuecat",
      deps: ["pg.query", "pg.tx", "fetch.revenuecat"],
      critical: ["pg.query", "pg.tx", "fetch.revenuecat"],
      happyStatus: 200,
      prepare: async () => {
        const eventId = `stress-evt-${randomUUID()}`;
        return {
          request: {
            method: "POST",
            url: "/v1/webhooks/revenuecat",
            headers: { authorization: RC_WEBHOOK_AUTH },
            payload: {
              api_version: "1.0",
              event: { id: eventId, type: "RENEWAL", app_user_id: billingUserId },
            },
          },
          verify: async (status) => {
            const row = await db.query<{ status: string; failure_code: string | null }>(
              "SELECT status, failure_code FROM billing_provider_event WHERE provider = 'revenuecat' AND event_id = $1",
              [eventId],
            );
            const evt = row.rows[0];
            const problems: string[] = [];
            if (status === 200 && (!evt || evt.status !== "processed"))
              problems.push("success_without_processed_event");
            if (evt && status !== 200 && evt.status === "processed" && evt.failure_code === null)
              problems.push("processed_event_despite_failure");
            return problems;
          },
        };
      },
    },
    {
      name: "GET /v1/admin/users/:id",
      deps: ["pg.query"],
      critical: ["pg.query"],
      happyStatus: 200,
      prepare: async () => ({
        request: { method: "GET", url: `/v1/admin/users/${userId}`, headers: auth(adminToken) },
        verify: async () => [],
      }),
    },
    {
      name: "PUT /v1/admin/flags/:key",
      deps: ["pg.query"],
      critical: ["pg.query"],
      happyStatus: 200,
      prepare: async () => {
        const key = `stress_flag_${randomUUID().slice(0, 8)}`;
        return {
          request: {
            method: "PUT",
            url: `/v1/admin/flags/${key}`,
            headers: auth(adminToken),
            payload: { enabled: true, description: "stress harness flag" },
          },
          verify: async (status) => {
            const row = await db.query<{ enabled: boolean }>(
              "SELECT enabled FROM feature_flag WHERE key = $1",
              [key],
            );
            if (status === 200 && (row.rowCount !== 1 || row.rows[0]!.enabled !== true))
              return ["success_without_flag_row"];
            return [];
          },
        };
      },
    },
  ];

  function chooseFault(seed: number): { scenario: Scenario; fault: Fault } {
    const rng = new Rng(seed);
    const scenario = rng.pick(scenarios);
    const dep = rng.pick(scenario.deps);
    const mode = rng.pick(MODES_BY_DEP[dep]);
    const detail = pickDetail(rng, dep, mode);
    const calls = profile[scenario.name]?.[dep] ?? 0;
    const hit = calls > 0 ? rng.int(calls) : 0;
    return { scenario, fault: { dep, mode, hit, detail } };
  }

  async function runIteration(index: number, seed: number): Promise<IterationResult> {
    const { scenario, fault } = chooseFault(seed);
    const id = faultId(fault);
    const base: IterationResult = {
      index,
      seed,
      scenario: scenario.name,
      fault,
      faultId: id,
      fired: false,
      status: null,
      code: null,
      kind: null,
      retryable: null,
      durationMs: 0,
      hung: false,
      checks: {},
      problems: [],
      verdict: "HELD",
    };
    const waitsOnUpstreamDeadline = fault.mode === "never" && fault.dep.startsWith("fetch.");
    if (waitsOnUpstreamDeadline && !SLOW) return { ...base, verdict: "SKIPPED_SLOW" };

    const prepared = await scenario.prepare();
    const unhandledBefore = unhandled.length;
    chaos.arm(fault);
    const started = Date.now();
    const deadline = waitsOnUpstreamDeadline ? 12_000 : DEADLINE_MS;
    let timer: NodeJS.Timeout | undefined;
    const hungSentinel = new Promise<"HUNG">((resolveHung) => {
      timer = setTimeout(() => resolveHung("HUNG"), deadline);
    });
    const injected = app.inject(prepared.request);
    const outcome = await Promise.race([injected, hungSentinel]);
    if (timer) clearTimeout(timer);
    const durationMs = Date.now() - started;
    chaos.disarm();
    const fired = chaos.fired !== null;
    if (!fired) {
      // Let a still-running clean request finish so it does not bleed into the next iteration.
      if (outcome === "HUNG") await injected;
      return { ...base, fired: false, durationMs, verdict: "NOFIRE" };
    }

    const checks: IterationResult["checks"] = {};
    const problems: string[] = [];
    let status: number | null = null;
    let code: string | null = null;
    let kind: string | null = null;
    let retryable: boolean | null = null;

    if (outcome === "HUNG") {
      checks["bounded_completion"] = "fail";
      problems.push(`request still pending after ${deadline}ms`);
      const notes = await chaos.releaseHung();
      if (notes.length) problems.push(...notes);
      // The dangling inject promise must not surface as an unhandled rejection later.
      injected.catch(() => undefined);
    } else {
      checks["bounded_completion"] = "pass";
      status = outcome.statusCode;
      const envelope = checkEnvelope(
        status,
        outcome.headers as Record<string, unknown>,
        outcome.body,
      );
      checks["typed_envelope"] = envelope.ok ? "pass" : "fail";
      problems.push(...envelope.problems);
      code = envelope.code ?? null;
      kind = envelope.kind ?? null;
      retryable = envelope.retryable ?? null;

      const leaks = findLeaks(outcome.body, SECRETS);
      checks["no_leak"] = leaks.length === 0 ? "pass" : "fail";
      problems.push(...leaks.map((l) => `leak:${l}`));

      // pg malformed/partial corrupt the driver RESULT after the statement ran
      // (see corruptResultOnly), so a 2xx there is not fake success; the
      // fetch/HEAD variants replace the upstream answer and are hard faults.
      const isPg = fault.dep === "pg.query" || fault.dep === "pg.tx";
      const hard =
        ["throw", "reject", "timeout", "never"].includes(fault.mode) ||
        (fault.mode === "malformed" && !isPg);
      const critical = scenario.critical.includes(fault.dep);
      if (hard && critical) {
        checks["no_fake_success"] = status >= 400 ? "pass" : "fail";
        if (status < 400) problems.push(`2xx despite critical ${fault.dep} ${fault.mode}`);
      } else checks["no_fake_success"] = "n/a";

      if (!critical && ["throw", "reject", "timeout"].includes(fault.mode)) {
        checks["non_critical_absorbed"] = status === scenario.happyStatus ? "pass" : "fail";
        if (status !== scenario.happyStatus)
          problems.push(`non-critical ${fault.dep} fault changed status to ${status}`);
      } else checks["non_critical_absorbed"] = "n/a";

      if (fault.mode === "slow") {
        checks["slow_passthrough"] = status === scenario.happyStatus ? "pass" : "fail";
        if (status !== scenario.happyStatus)
          problems.push(`slow dependency changed status to ${status}`);
      } else checks["slow_passthrough"] = "n/a";

      if (status >= 500 && critical && isTransientFault(fault)) {
        const ok =
          retryable === true && kind !== null && ["retryable", "timeout", "network"].includes(kind);
        checks["transient_is_retryable"] = ok ? "pass" : "fail";
        if (!ok)
          problems.push(
            `transient fault answered ${status} ${kind}/${code} retryable=${retryable}`,
          );
      } else checks["transient_is_retryable"] = "n/a";

      if (fault.mode === "malformed" && critical && fault.dep === "fetch.revenuecat") {
        // Provider returned 200 with garbage: contract says retryable invalid_response.
        const ok = retryable === true;
        checks["malformed_upstream_retryable"] = ok ? "pass" : "fail";
        if (!ok)
          problems.push(
            `malformed upstream body answered ${status} ${code} retryable=${retryable}`,
          );
      } else checks["malformed_upstream_retryable"] = "n/a";
    }

    let parsedBody: unknown = undefined;
    if (outcome !== "HUNG") {
      try {
        parsedBody = outcome.body ? JSON.parse(outcome.body) : undefined;
      } catch {
        parsedBody = undefined;
      }
    }
    // `success_*` problems mean a 2xx whose promised write is not there (fake
    // success); everything else is corrupted / half-written state.
    const stateProblems = await prepared.verify(status, parsedBody);
    const fakeSuccess = stateProblems.filter((p) => p.startsWith("success_"));
    const corrupt = stateProblems.filter((p) => !p.startsWith("success_"));
    checks["persisted_state"] = corrupt.length === 0 ? "pass" : "fail";
    problems.push(...corrupt.map((p) => `state:${p}`));
    if (fakeSuccess.length) {
      checks["no_fake_success"] = "fail";
      problems.push(...fakeSuccess.map((p) => `fake:${p}`));
    }

    const newUnhandled = unhandled.slice(unhandledBefore);
    checks["no_unhandled_rejection"] = newUnhandled.length === 0 ? "pass" : "fail";
    problems.push(...newUnhandled.map((u) => `unhandled:${String(u)}`));

    const verdict = Object.values(checks).includes("fail") ? "BROKEN" : "HELD";
    return {
      ...base,
      fired,
      status,
      code,
      kind,
      retryable,
      durationMs,
      hung: outcome === "HUNG",
      checks,
      problems,
      verdict,
    };
  }

  beforeAll(async () => {
    for (const k of ["REVENUECAT_SECRET_API_KEY", "REVENUECAT_WEBHOOK_AUTHORIZATION"]) {
      savedEnv[k] = process.env[k];
    }
    process.env["REVENUECAT_SECRET_API_KEY"] = RC_KEY;
    process.env["REVENUECAT_WEBHOOK_AUTHORIZATION"] = RC_WEBHOOK_AUTH;
    process.on("unhandledRejection", onUnhandled);

    db = new pg.Pool({ connectionString: testUrl });
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(db, migrationsDir);
    await seed(db);
    await publishTestScoringRelease(db);

    chaos = new Chaos();
    queue = new RecordingQueue();
    store = new FakeObjectStore();
    security = new ChaosSecuritySink(chaos);
    analytics = new ChaosAnalytics(chaos);
    restoreFetch = installChaosFetch(chaos, [
      {
        dep: "fetch.revenuecat",
        match: (url) => url.startsWith("https://api.revenuecat.com/"),
        happy: revenueCatHappyCustomer,
        malformed: (d) =>
          d === "html_body"
            ? textResponse("<html><body>502 Bad Gateway</body></html>", "text/html")
            : d === "truncated_json"
              ? textResponse('{"subscriber": {"entitlements": {', "application/json")
              : textResponse("OK", "text/plain"),
        partial: (d) =>
          d === "empty_object"
            ? {}
            : d === "subscriber_without_entitlements"
              ? { subscriber: { subscriptions: {} } }
              : {
                  subscriber: {
                    entitlements: { premium: { expires_date: null } },
                    subscriptions: {},
                  },
                },
      },
    ]);

    const config: ApiConfig = {
      env: "test",
      port: 0,
      host: "127.0.0.1",
      appVersion: "0.1.0-stress",
      databaseUrl: testUrl!,
      devAuthSecret: DEV_SECRET,
      oidcIssuer: undefined,
      oidcAudience: undefined,
      oidcJwksUrl: undefined,
      sqsQueueUrl: undefined,
      consentExportSigningKey: undefined,
      consentExportSigningKeyId: "consent-export-k1",
      appleIapConfigured: false,
      googlePlayConfigured: false,
      adminAuthSubjects: ["auth0|stress-admin"],
    };
    app = buildApp(config, {
      queue: new ChaosQueue(queue, chaos),
      objectStore: new ChaosObjectStore(store, chaos),
      analytics,
      securityEvents: security,
      sloRecorder: new ChaosSlo(chaos),
      // Generous budget: the campaign fires hundreds of requests from one token.
      rateLimit: { defaultLimit: 100_000, expensiveLimit: 100_000 },
    });
    const context = (app as unknown as { appContext: { pool: pg.Pool | null } }).appContext;
    wrapPool(context.pool!, chaos);

    minter = new DevTokenVerifier("test", DEV_SECRET);
    ({ token: userToken, id: userId } = await bootstrapUser("auth0|stress-user"));
    ({ token: billingToken, id: billingUserId } = await bootstrapUser("auth0|stress-billing"));
    ({ token: adminToken } = await bootstrapUser("auth0|stress-admin", "admin"));
    await db.query("UPDATE user_setting SET cloud_sync_enabled = true WHERE user_id = $1", [
      userId,
    ]);
    await db.query(
      `INSERT INTO entitlement (user_id, feature_key, valid_from, valid_to, source)
       VALUES ($1, 'premium', now() - interval '1 minute', NULL, 'admin')`,
      [userId],
    );

    // Profile: how many calls each scenario makes per dependency on the happy
    // path. Drives the `hit` index so every seed targets a call that exists.
    for (const scenario of scenarios) {
      const prepared = await scenario.prepare();
      chaos.startCounting();
      const res = await app.inject(prepared.request);
      expect(res.statusCode, `${scenario.name} happy path: ${res.body}`).toBe(scenario.happyStatus);
      const counts: Partial<Record<Dep, number>> = {};
      for (const dep of scenario.deps) counts[dep] = chaos.callsFor(dep);
      profile[scenario.name] = counts;
      const stateProblems = await prepared.verify(
        res.statusCode,
        res.body ? (res.json() as unknown) : undefined,
      );
      expect(stateProblems, `${scenario.name} happy-path state`).toEqual([]);
    }
  }, 120_000);

  afterAll(async () => {
    process.off("unhandledRejection", onUnhandled);
    restoreFetch?.();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (OUT) {
      mkdirSync(dirname(resolve(OUT)), { recursive: true });
      const executed = results.filter((r) => r.verdict === "HELD" || r.verdict === "BROKEN");
      writeFileSync(
        resolve(OUT),
        JSON.stringify(
          {
            campaignSeed: CAMPAIGN_SEED,
            iterations: STRESS_ITER,
            replay: REPLAY,
            slow: SLOW,
            deadlineMs: DEADLINE_MS,
            profile,
            summary: {
              executed: executed.length,
              held: executed.filter((r) => r.verdict === "HELD").length,
              broken: executed.filter((r) => r.verdict === "BROKEN").length,
              brokenByGap: Object.fromEntries(
                KNOWN_GAPS.map((gap) => [
                  gap.id,
                  executed.filter((r) => r.verdict === "BROKEN" && gap.matches(r)).length,
                ]),
              ),
              brokenUnexplained: executed.filter(
                (r) => r.verdict === "BROKEN" && !KNOWN_GAPS.some((gap) => gap.matches(r)),
              ).length,
              nofire: results.filter((r) => r.verdict === "NOFIRE").length,
              skippedSlow: results.filter((r) => r.verdict === "SKIPPED_SLOW").length,
              distinctFaults: new Set(executed.map((r) => r.faultId)).size,
            },
            results: results.map((r) => ({
              ...r,
              knownGap: KNOWN_GAPS.find((gap) => gap.matches(r))?.id ?? null,
            })),
          },
          null,
          2,
        ),
      );
    }
    await Promise.race([app?.close(), new Promise((r) => setTimeout(r, 5_000))]);
    await db?.end();
  });

  it("profiles every scenario's happy path with the chaos seams installed", () => {
    for (const scenario of scenarios) {
      const counts = profile[scenario.name]!;
      const reachable = scenario.deps.filter((dep) => (counts[dep] ?? 0) > 0);
      expect(
        reachable.length,
        `${scenario.name} reaches ${JSON.stringify(counts)}`,
      ).toBeGreaterThan(0);
    }
  });

  it(`campaign: ${REPLAY.length ? `replay ${REPLAY.join(",")}` : `${STRESS_ITER} seeded faults from ${CAMPAIGN_SEED}`}`, async () => {
    const seeds = REPLAY.length
      ? REPLAY
      : Array.from({ length: STRESS_ITER }, (_, i) => iterationSeed(CAMPAIGN_SEED, i));
    for (const [index, seed] of seeds.entries()) {
      results.push(await runIteration(index, seed));
    }
    const executed = results.filter((r) => r.verdict !== "NOFIRE" && r.verdict !== "SKIPPED_SLOW");
    const broken = executed.filter((r) => r.verdict === "BROKEN");
    const summary = broken
      .map(
        (r) =>
          `seed=${r.seed} ${r.scenario} ${r.faultId} -> ${r.status ?? "HUNG"} ${r.code ?? ""} [${r.problems.join("; ")}]`,
      )
      .join("\n");
    // The campaign is a measurement: every executed iteration must have fired
    // its fault, and structural invariants (typed envelope, no leaks, no
    // unhandled rejection, no half-written state) must hold on every one.
    const structural = executed.filter((r) =>
      (["typed_envelope", "no_leak", "no_unhandled_rejection", "persisted_state"] as const).some(
        (c) => r.checks[c] === "fail",
      ),
    );
    expect(structural.map((r) => `${r.seed}:${r.faultId}:${r.problems.join("|")}`)).toEqual([]);
    expect(executed.length, "every non-skipped iteration fired its fault").toBe(
      results.filter((r) => r.verdict !== "SKIPPED_SLOW").length,
    );
    // Behavioural invariants (bounded completion, retryable classification)
    // are pinned to the documented gap list: a BROKEN iteration that no
    // known gap explains is a new defect and fails the campaign. Fixing a
    // gap in production makes its entry unnecessary (the campaign still
    // passes) — delete it then.
    const unexplained = broken.filter((r) => !KNOWN_GAPS.some((gap) => gap.matches(r)));
    expect(
      unexplained.map((r) => `${r.seed}:${r.faultId}:${r.problems.join("|")}`),
      "BROKEN iterations not covered by KNOWN_GAPS",
    ).toEqual([]);
    if (broken.length) console.warn(`[stress] ${broken.length} BROKEN iterations:\n${summary}`);
  }, 600_000);
});
