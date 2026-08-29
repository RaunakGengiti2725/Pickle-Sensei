import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations, seed } from "@pickle/database";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";
import { publishTestScoringRelease } from "./support/scoringRelease.js";

const testUrl = process.env["DATABASE_URL_TEST"];
const secret = "training-system-secret-0123456789";
const schemaName = `training_system_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

function schemaUrl(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

function versionVector() {
  return {
    appVersion: "0.1.0",
    modelBundleVersion: "test-native-1",
    poseModelVersion: "test-pose-1",
    paddleModelVersion: "test-paddle-1",
    strokeDetectorVersion: "test-stroke-1",
    phaseModelVersion: "test-phase-1",
    scoringModelVersion: "sm-v1",
    shotConfigVersion: "forehand_drive@1",
  };
}

function shotPayload(id: string, analysisPermitId: string, capturedAt: string, overallScore = 7.4) {
  return {
    id,
    analysisPermitId,
    sessionId: null,
    shotType: "forehand_drive",
    cameraView: "side",
    capturedAt,
    timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
    overallScore,
    confidence: 0.94,
    resultKind: "scored",
    source: "real",
    phases: [],
    checkpoints: [
      {
        key: "contact_position",
        score: 58,
        confidence: 0.94,
        band: "red",
        direction: "late",
        severity: 0.42,
        applicable: true,
      },
    ],
    versionVector: versionVector(),
  };
}

describe.skipIf(!testUrl)("real training system (isolated PostgreSQL schema)", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let userToken: string;
  let streakUserToken: string;
  let adminToken: string;
  let sourceShotId: string;
  let planId: string;
  let planItems: Array<{
    id: string;
    kind: string;
    drill: { slug: string } | null;
    targetSets: number | null;
    targetRepetitionsPerSet: number | null;
    targetDurationSeconds: number | null;
  }>;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const bootstrapBody = {
    locale: "en-US",
    timezone: "UTC",
    device: {
      platform: "ios" as const,
      osVersion: "18.0",
      appVersion: "0.1.0",
      model: "iPhone16,1",
    },
  };

  async function reservePermit(token: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/analysis-permits",
      headers: auth(token),
      payload: { idempotencyKey: randomUUID() },
    });
    expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
    return (response.json() as { permit: { id: string } }).permit.id;
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testUrl });
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    const scopedUrl = schemaUrl(testUrl!, schemaName);
    pool = new pg.Pool({ connectionString: scopedUrl });
    await runMigrations(pool, migrationsDir);
    await seed(pool);
    await publishTestScoringRelease(pool);

    const adminSubject = `training|admin-${randomUUID()}`;
    const config: ApiConfig = {
      env: "test",
      port: 0,
      host: "127.0.0.1",
      appVersion: "0.1.0-test",
      databaseUrl: scopedUrl,
      devAuthSecret: secret,
      oidcIssuer: undefined,
      oidcAudience: undefined,
      oidcJwksUrl: undefined,
      sqsQueueUrl: undefined,
      consentExportSigningKey: undefined,
      consentExportSigningKeyId: "consent-export-k1",
      appleIapConfigured: false,
      googlePlayConfigured: false,
      adminAuthSubjects: [adminSubject],
    };
    app = buildApp(config);
    const minter = new DevTokenVerifier("test", secret);
    userToken = await minter.mint(`training|user-${randomUUID()}`);
    streakUserToken = await minter.mint(`training|streak-${randomUUID()}`);
    adminToken = await minter.mint(adminSubject, "admin");
    for (const token of [userToken, streakUserToken, adminToken]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/account/bootstrap",
        headers: auth(token),
        payload: bootstrapBody,
      });
      expect(response.statusCode).toBe(200);
    }

    const drills = [
      {
        slug: "test-ready-warmup",
        title: "Ready Contact Warm-up",
        role: "warmup",
        sets: 1,
        reps: 10,
        duration: null,
        priority: 5,
      },
      {
        slug: "test-contact-shadow",
        title: "Contact Shadow Reps",
        role: "targeted",
        sets: 3,
        reps: 8,
        duration: null,
        priority: 9,
      },
      {
        slug: "test-contact-rhythm",
        title: "Contact Rhythm Holds",
        role: "targeted",
        sets: 2,
        reps: null,
        duration: 60,
        priority: 8,
      },
    ] as const;
    for (const drill of drills) {
      const create = await app.inject({
        method: "PUT",
        url: `/v1/admin/drills/${drill.slug}`,
        headers: auth(adminToken),
        payload: {
          slug: drill.slug,
          title: drill.title,
          description: `Reviewed test description for ${drill.title}`,
          coachName: "Coach Test",
          difficultyMin: "2.5",
          difficultyMax: "4.5",
          active: true,
          mappings: [],
        },
      });
      expect(create.statusCode).toBe(200);
      const publish = await app.inject({
        method: "PUT",
        url: `/v1/admin/training/drills/${drill.slug}/prescription`,
        headers: auth(adminToken),
        payload: {
          shotType: "forehand_drive",
          checkpoint: "contact_position",
          planRole: drill.role,
          faultDirections: ["late"],
          priority: drill.priority,
          cueText: "Meet the ball comfortably in front.",
          targetSets: drill.sets,
          targetRepetitionsPerSet: drill.reps,
          targetDurationSeconds: drill.duration,
          restSeconds: 20,
          coachApprovalReference: `coach-review-${drill.slug}`,
        },
      });
      expect(publish.statusCode).toBe(200);
    }
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  });

  it("saves and unsaves only an active non-fixture drill", async () => {
    const save = await app.inject({
      method: "PUT",
      url: "/v1/me/saved-drills/test-contact-shadow",
      headers: auth(userToken),
    });
    expect(save.statusCode).toBe(200);
    expect(save.json()).toMatchObject({ slug: "test-contact-shadow", saved: true });

    const saved = await app.inject({
      method: "GET",
      url: "/v1/me/saved-drills",
      headers: auth(userToken),
    });
    expect(
      (saved.json() as { items: Array<{ slug: string }> }).items.map((item) => item.slug),
    ).toEqual(["test-contact-shadow"]);

    const fixture = await app.inject({
      method: "PUT",
      url: "/v1/me/saved-drills/dev-contact-out-front",
      headers: auth(userToken),
    });
    expect(fixture.statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/v1/me/saved-drills/test-contact-shadow",
          headers: auth(userToken),
        })
      ).statusCode,
    ).toBe(204);
  });

  it("generates one idempotent plan from a real scored shot and reviewed mappings", async () => {
    sourceShotId = randomUUID();
    const permitId = await reservePermit(userToken);
    const sync = await app.inject({
      method: "POST",
      url: "/v1/shots:sync",
      headers: auth(userToken),
      payload: { shots: [shotPayload(sourceShotId, permitId, new Date().toISOString())] },
    });
    expect(sync.statusCode).toBe(200);

    const create = await app.inject({
      method: "POST",
      url: "/v1/training-plans",
      headers: auth(userToken),
      payload: { sourceShotId },
    });
    expect(create.statusCode).toBe(200);
    const plan = (create.json() as { plan: { id: string; items: typeof planItems } }).plan;
    planId = plan.id;
    planItems = plan.items;
    expect(plan.items.map((item) => item.kind)).toEqual([
      "warmup",
      "targeted",
      "targeted",
      "reassessment",
    ]);
    expect(plan.items.slice(0, 3).map((item) => item.drill?.slug)).toEqual([
      "test-ready-warmup",
      "test-contact-shadow",
      "test-contact-rhythm",
    ]);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/training-plans",
      headers: auth(userToken),
      payload: { sourceShotId },
    });
    expect((replay.json() as { plan: { id: string } }).plan.id).toBe(planId);
  });

  it("records actual completion evidence and allows reassessment only after all prescriptions", async () => {
    const before = await app.inject({
      method: "POST",
      url: `/v1/training-plans/${planId}/reassessment`,
      headers: auth(userToken),
      payload: { shotId: sourceShotId },
    });
    expect(before.statusCode).toBe(409);

    for (const item of planItems.filter((candidate) => candidate.drill)) {
      const targetReps =
        item.targetRepetitionsPerSet === null
          ? null
          : item.targetSets! * item.targetRepetitionsPerSet;
      const targetDuration =
        item.targetDurationSeconds === null ? null : item.targetSets! * item.targetDurationSeconds;
      const completion = await app.inject({
        method: "POST",
        url: "/v1/drill-completions",
        headers: auth(userToken),
        payload: {
          id: randomUUID(),
          drillSlug: item.drill!.slug,
          trainingPlanItemId: item.id,
          completedAt: new Date().toISOString(),
          actualRepetitions: targetReps,
          actualDurationSeconds: targetDuration,
        },
      });
      expect(completion.statusCode).toBe(200);
      expect(completion.json()).toMatchObject({ completion: { qualifiesForStreak: true } });
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
    const reassessmentShotId = randomUUID();
    const permitId = await reservePermit(userToken);
    const sync = await app.inject({
      method: "POST",
      url: "/v1/shots:sync",
      headers: auth(userToken),
      payload: {
        shots: [shotPayload(reassessmentShotId, permitId, new Date().toISOString(), 8.1)],
      },
    });
    expect(sync.json()).toMatchObject({ acceptedIds: [reassessmentShotId] });
    const evidence = await pool.query<{
      reassessment_type: string;
      plan_type: string;
      reassessment_at: Date;
      plan_created_at: Date;
    }>(
      `SELECT s.shot_type_id::text AS reassessment_type,
              tp.shot_type_id::text AS plan_type,
              s.captured_at AS reassessment_at, tp.created_at AS plan_created_at
       FROM shot s, training_plan tp WHERE s.id = $1 AND tp.id = $2`,
      [reassessmentShotId, planId],
    );
    expect(evidence.rows[0]?.reassessment_type).toBe(evidence.rows[0]?.plan_type);
    expect(evidence.rows[0]!.reassessment_at.getTime()).toBeGreaterThan(
      evidence.rows[0]!.plan_created_at.getTime(),
    );
    const reassess = await app.inject({
      method: "POST",
      url: `/v1/training-plans/${planId}/reassessment`,
      headers: auth(userToken),
      payload: { shotId: reassessmentShotId },
    });
    expect(reassess.statusCode, JSON.stringify(reassess.json())).toBe(200);
    expect(reassess.json()).toMatchObject({
      plan: { status: "completed", reassessmentShotId, scoreDelta: 0.7 },
    });
  });

  it("exposes only fully reviewed/licensed instructional playback", async () => {
    const drill = await pool.query<{ id: string }>(
      "SELECT id FROM drill WHERE slug = 'test-contact-shadow'",
    );
    await pool.query(
      `INSERT INTO drill_instructional_media (
         drill_id, external_provider, external_video_id, source_url, active
       ) VALUES ($1, 'youtube', 'pending123', 'https://www.youtube.com/watch?v=pending123', true)`,
      [drill.rows[0]!.id],
    );
    const publish = await app.inject({
      method: "POST",
      url: "/v1/admin/training/drills/test-contact-shadow/instructional-media",
      headers: auth(adminToken),
      payload: {
        id: randomUUID(),
        source: {
          kind: "embed",
          provider: "youtube",
          videoId: "abc123_DEF",
          sourceUrl: "https://www.youtube.com/watch?v=abc123_DEF",
        },
        creatorName: "Coach Test",
        licenseName: "Creator permission",
        licenseUrl: "https://www.youtube.com/terms",
        attribution: "Instruction by Coach Test",
        rightsReviewReference: "rights-ticket-123",
        coachReviewReference: "coach-ticket-123",
        rightsExpiresAt: null,
        displayOrder: 1,
      },
    });
    expect(publish.statusCode).toBe(200);

    const detail = await app.inject({
      method: "GET",
      url: "/v1/catalog/drills/test-contact-shadow",
      headers: auth(userToken),
    });
    const media = (detail.json() as { instructionalMedia: Array<Record<string, unknown>> })
      .instructionalMedia;
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({
      kind: "embed",
      provider: "youtube",
      videoId: "abc123_DEF",
      embedUrl: "https://www.youtube-nocookie.com/embed/abc123_DEF",
    });
  });

  it("derives streaks from qualifying drill completions in the user's timezone", async () => {
    const today = new Date();
    for (let offset = 2; offset >= 0; offset -= 1) {
      const completed = new Date(today);
      completed.setUTCDate(today.getUTCDate() - offset);
      if (offset > 0) {
        completed.setUTCHours(12, 0, 0, 0);
      }
      const response = await app.inject({
        method: "POST",
        url: "/v1/drill-completions",
        headers: auth(streakUserToken),
        payload: {
          id: randomUUID(),
          drillSlug: "test-ready-warmup",
          completedAt: completed.toISOString(),
          actualRepetitions: 10,
          actualDurationSeconds: null,
        },
      });
      expect(response.json()).toMatchObject({ completion: { qualifiesForStreak: true } });
    }
    const progress = await app.inject({
      method: "GET",
      url: "/v1/progress",
      headers: auth(streakUserToken),
    });
    expect(progress.statusCode).toBe(200);
    expect(progress.json()).toMatchObject({
      series: [],
      streak: { currentDays: 3, longestDays: 3, practicedToday: true },
    });
  });
});
