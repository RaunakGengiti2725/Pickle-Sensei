/**
 * STRESS / concurrency — `runCaptureAnalysis` under a seeded scheduler.
 *
 * Real pipeline (generated pose sidecar → real fusion analysis → real
 * repository SQL). Seams under scheduler control: sidecar read, permit
 * reserve/finalize HTTP, every SQL statement, the analysis engine boundary
 * (only to inject provider throws), and injected actors (logout / account
 * rotation / abandoning caller).
 *
 * Invariants asserted on EVERY seed:
 *   permits   every reserved permit is consumed by exactly one outbox shot
 *             XOR released exactly once (or leaked ONLY when the finalize
 *             call itself failed); the server's free allowance reconciles;
 *   rows      local_shot ids unique; scored ⇔ one shot + one outbox row; low
 *             confidence ⇒ shot without outbox; one analysis record per
 *             analyzed run; a shot never exists without its outbox row;
 *   owner     nothing is written under an owner other than the run's start
 *             owner (logout / rotation mid-run), nothing under 'signed-out';
 *   liveness  every burst settles within the step + wall-clock budget, no
 *             transaction is left open.
 *
 * Replay:  STRESS_SEED=<seed> STRESS_TX_MODE=<sqlite|serialized> \
 *            npx jest __tests__/stress/runCaptureAnalysis.concurrency
 * Campaign: STRESS_ITER=60 STRESS_RUN_ID=<id> npx jest __tests__/stress
 */
import type { CapturedClip } from '../../src/camera/capture';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import type { ApiConfigState } from '../../src/data/api';
import {
  captureFixture,
  type CaptureFixture,
} from '../../testing/stress/captureFixture';
import { flushStressTable } from '../../testing/stress/evidence';
import {
  API_A,
  busy,
  OWNER_A,
  OWNER_B,
  stressScenario,
  TOKEN_A,
  type IterationContext,
} from '../../testing/stress/harness';
import type { StressScheduler } from '../../testing/stress/scheduler';

// ─── Seams ──────────────────────────────────────────────────────────────────

let mockSidecars = new Map<string, string>();
let mockActiveScheduler: StressScheduler | null = null;
jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: async (uri: string) => {
      if (mockActiveScheduler)
        await mockActiveScheduler.yieldAt('io:readSidecar');
      const json = mockSidecars.get(uri);
      if (json === undefined) throw new Error(`ENOENT ${uri}`);
      return json;
    },
  };
});

type ProviderFault = 'none' | 'throw_sync' | 'reject' | 'not_ok';
let mockProviderFaultFor: (captureId: string) => ProviderFault = () => 'none';
jest.mock('@pickle/analysis-pipeline', () => {
  const actual = jest.requireActual('@pickle/analysis-pipeline');
  return {
    ...actual,
    analyzeCapture: (
      providers: unknown,
      input: { captureId: string },
      options: unknown,
    ) => {
      const fault = mockProviderFaultFor(input.captureId);
      if (fault === 'throw_sync') {
        throw new Error('provider threw synchronously');
      }
      if (fault === 'reject') {
        return Promise.reject(new Error('provider rejected'));
      }
      if (fault === 'not_ok') {
        return Promise.resolve({
          ok: false,
          failure: { code: 'engine_failed', message: 'engine failed' },
        });
      }
      return actual.analyzeCapture(providers, input, options);
    },
  };
});

import {
  runCaptureAnalysis,
  type CaptureAnalysisOutcome,
} from '../../src/analysis/runCaptureAnalysis';

const SUITE = 'runCaptureAnalysis.concurrency';

// ─── Run wrapper ────────────────────────────────────────────────────────────

interface RunResult {
  captureId: string;
  outcome: CaptureAnalysisOutcome | null;
  error: string | null;
}

function fixtureFor(seed: number, i: number): CaptureFixture {
  const f = captureFixture(`s${seed}-${i}`, i % 2 === 0 ? 'right' : 'left');
  mockSidecars.set(f.clip.poseSequence!.uri, f.sidecarJson);
  return f;
}

async function runOnce(
  ctx: IterationContext,
  captureId: string,
  clip: CapturedClip,
  declared: 'forehand_drive' | null,
  apiConfig: ApiConfigState = API_A,
): Promise<RunResult> {
  try {
    const outcome = await runCaptureAnalysis({
      db: ctx.db.db,
      captureId,
      clip,
      declaredStroke: declared,
      declaredCanonical: declared ? 'FOREHAND_DRIVE' : null,
      handedness: 'right',
      cameraView: 'side',
      apiConfig,
      appVersion: '1.0.0-stress',
      sessionId: null,
    });
    return { captureId, outcome, error: null };
  } catch (error) {
    return {
      captureId,
      outcome: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── Invariant oracle ───────────────────────────────────────────────────────

interface AccountingOptions {
  /** Permits whose finalize call was made to fail (500 / throw / 401). */
  finalizeFailuresAllowed: boolean;
  startOwner: string;
}

function checkAccounting(
  ctx: IterationContext,
  results: RunResult[],
  opts: AccountingOptions,
): void {
  const { db, server, violations: v } = ctx;
  const shots = db.shotRows();
  const shotOutbox = db.outboxByKind('shot.sync');
  const outboxPayloads = shotOutbox.map(
    r => JSON.parse(r.payload) as { id: string; analysisPermitId?: string },
  );
  const consumedPermits = outboxPayloads.map(p => p.analysisPermitId ?? null);

  // Rows.
  const scored = results.filter(r => r.outcome?.kind === 'scored');
  const lowConf = results.filter(r => r.outcome?.kind === 'low_confidence');
  const scoredShotIds = shots
    .filter(s => s.resultKind === 'scored')
    .map(s => s.id);
  v.equal(
    scoredShotIds.length,
    scored.length,
    'scored local_shot rows == scored outcomes',
  );
  v.equal(
    new Set(shots.map(s => s.id)).size,
    shots.length,
    'local_shot ids unique',
  );
  v.equal(
    shotOutbox.length,
    scored.length,
    'shot.sync outbox rows == scored outcomes',
  );
  for (const id of scoredShotIds) {
    v.equal(
      outboxPayloads.filter(p => p.id === id).length,
      1,
      `scored shot ${id} has exactly one outbox row`,
    );
  }
  for (const p of outboxPayloads) {
    v.check(
      shots.some(s => s.id === p.id),
      `outbox shot ${p.id} has no local_shot row (outbox without shot)`,
    );
    v.check(
      typeof p.analysisPermitId === 'string' && p.analysisPermitId.length > 0,
      `outbox shot ${p.id} carries no permit id`,
    );
  }
  // Every analyzed run appends exactly one record; a run that threw AFTER
  // its record append (persistence fault / logout) legitimately leaves the
  // record behind, so the upper bound admits one per thrown run.
  const thrownRuns = results.filter(r => r.error !== null).length;
  v.check(
    db.records.size >= scored.length + lowConf.length &&
      db.records.size <= scored.length + lowConf.length + thrownRuns,
    `analysis records ${db.records.size} outside [${scored.length + lowConf.length}, ${scored.length + lowConf.length + thrownRuns}]`,
  );
  ctx.observed['recordsFromThrownRuns'] =
    db.records.size - (scored.length + lowConf.length);
  for (const r of lowConf) {
    const rec = r.outcome!.kind === 'low_confidence' ? r.outcome : null;
    if (rec && rec.record.result) {
      v.check(
        !outboxPayloads.some(p => p.id === rec.record.result!.id),
        `low_confidence analysis ${rec.record.result.id} reached the outbox`,
      );
    }
  }

  // Owner.
  const wrongOwner = [
    ...shots.map(s => s.owner),
    ...db.outbox.map(o => o.owner_key),
    ...[...db.records.values()].map(r => r.owner),
    ...[...db.sessions.values()].map(s => s.owner),
  ].filter(o => o !== opts.startOwner);
  v.check(
    wrongOwner.length === 0,
    `rows written under a different owner than the run started with: ${JSON.stringify([...new Set(wrongOwner)])}`,
  );
  v.check(
    !wrongOwner.includes(SIGNED_OUT_DATA_OWNER),
    'rows written under the signed-out owner',
  );

  // Permits.
  v.equal(
    new Set(consumedPermits).size,
    consumedPermits.length,
    'no permit consumed twice',
  );
  let leaked = 0;
  for (const entry of server.ledger.values()) {
    const consumed = consumedPermits.includes(entry.id);
    const released = entry.status === 'released';
    v.check(
      !(consumed && released),
      `permit ${entry.id} both consumed and released`,
    );
    v.check(
      entry.releaseCount <= 1,
      `permit ${entry.id} released ${entry.releaseCount} times`,
    );
    if (!consumed && !released) {
      const finalizeAttempted = server.requests.some(
        r => r.path.endsWith(`/${entry.id}/finalize`) && r.status !== 200,
      );
      if (finalizeAttempted && opts.finalizeFailuresAllowed) {
        leaked += 1;
      } else {
        v.list.push(
          `permit ${entry.id} neither consumed nor released (finalize attempted=${finalizeAttempted})`,
        );
      }
    }
  }
  // A scored outcome must hold a permit the server actually issued.
  for (const id of consumedPermits) {
    v.check(
      id !== null && server.ledger.has(id),
      `consumed permit ${id} unknown to server`,
    );
  }
  // Free allowance reconciles: issued − handed back − consumed − leaked.
  if (!server.premium) {
    const consumedFree = [...server.ledger.values()].filter(
      e => consumedPermits.includes(e.id) && e.accessSource === 'free',
    ).length;
    v.equal(
      server.available,
      server.initialAvailable - consumedFree - leaked,
      'server free allowance reconciles (no double spend)',
    );
    v.check(
      consumedFree <= server.initialAvailable,
      `more free ratings consumed (${consumedFree}) than the allowance (${server.initialAvailable})`,
    );
  }
  v.equal(db.openTransactions(), 0, 'no open transaction after burst');
  v.equal(db.strayTxEnds, 0, 'no COMMIT/ROLLBACK outside a transaction');

  ctx.observed['kinds'] = results.map(
    r => r.outcome?.kind ?? `throw:${r.error}`,
  );
  ctx.observed['shots'] = shots.length;
  ctx.observed['outbox'] = shotOutbox.length;
  ctx.observed['records'] = db.records.size;
  ctx.observed['permitsIssued'] = server.ledger.size;
  ctx.observed['permitsConsumed'] = consumedPermits.length;
  ctx.observed['permitsReleased'] = [...server.ledger.values()].filter(
    e => e.status === 'released',
  ).length;
  ctx.observed['permitsLeaked'] = leaked;
  ctx.observed['serverAvailable'] = server.available;
}

// ─── Scenarios ──────────────────────────────────────────────────────────────

afterAll(() => flushStressTable(SUITE));

beforeEach(() => {
  mockSidecars = new Map();
  mockProviderFaultFor = () => 'none';
});

describe('stress/concurrency: runCaptureAnalysis', () => {
  // A. Duplicate calls / call-during-call: k concurrent runs, same or distinct
  //    capture, with the free allowance sometimes smaller than the burst.
  stressScenario(
    SUITE,
    'duplicateBurst',
    {
      freeRatings: s => s.int(1, 4),
      premium: s => s.random() < 0.15,
    },
    async ctx => {
      const { scheduler: s, seed } = ctx;
      mockActiveScheduler = s;
      const k = s.int(2, 4);
      const sameCapture = s.random() < 0.5;
      const declared = Array.from({ length: k }, () =>
        s.random() < 0.7 ? ('forehand_drive' as const) : null,
      );
      const finalizeFail = s.random() < 0.25;
      ctx.server.finalizeBehaviour = () =>
        finalizeFail && s.random() < 0.5
          ? s.pick(['server_500', 'network_throw'] as const)
          : 'ok';
      const base = fixtureFor(seed, 0);
      const fixtures = sameCapture
        ? Array.from({ length: k }, () => base)
        : Array.from({ length: k }, (_, i) =>
            i === 0 ? base : fixtureFor(seed, i),
          );
      const captureIds = fixtures.map((_, i) =>
        sameCapture ? `capture-${seed}` : `capture-${seed}-${i}`,
      );
      for (const id of new Set(captureIds)) ctx.db.seedCapture(OWNER_A, id);
      ctx.inputs = {
        k,
        sameCapture,
        declared,
        finalizeFail,
        freeRatings: ctx.server.initialAvailable,
        premium: ctx.server.premium,
      };
      const run = await s.run(
        fixtures.map(
          (f, i) => () => runOnce(ctx, captureIds[i]!, f.clip, declared[i]!),
        ),
      );
      const results = run.results.map(r =>
        r.status === 'fulfilled'
          ? r.value
          : { captureId: '?', outcome: null, error: String(r.reason) },
      );
      ctx.observed['steps'] = run.steps;
      ctx.observed['trace'] = run.trace;
      for (const r of results) {
        // No fault was injected into the unit itself: a rejection is a break.
        v(ctx, r.error === null, `run for ${r.captureId} threw: ${r.error}`);
      }
      checkAccounting(ctx, results, {
        finalizeFailuresAllowed: finalizeFail,
        startOwner: OWNER_A,
      });
      if (sameCapture) {
        ctx.observed['sameCaptureScoredRuns'] = results.filter(
          r => r.outcome?.kind === 'scored',
        ).length;
      }
      mockActiveScheduler = null;
    },
  );

  // B. Provider throw + persistence faults while other runs are in flight.
  stressScenario(
    SUITE,
    'providerThrowAndDbFault',
    { freeRatings: () => 5 },
    async ctx => {
      const { scheduler: s, seed } = ctx;
      mockActiveScheduler = s;
      const k = s.int(1, 3);
      const faultKind = s.pick([
        'throw_sync',
        'reject',
        'not_ok',
        'db:INSERT INTO local_analysis_record',
        "db:UPDATE local_capture SET status = 'analyzed'",
        'db:INSERT OR REPLACE INTO local_shot',
        'db:INSERT INTO outbox',
        'db:COMMIT',
      ] as const);
      const faultedIndex = s.int(0, k - 1);
      const fixtures = Array.from({ length: k }, (_, i) => fixtureFor(seed, i));
      const captureIds = fixtures.map((_, i) => `capture-${seed}-${i}`);
      for (const id of captureIds) ctx.db.seedCapture(OWNER_A, id);
      if (
        faultKind === 'throw_sync' ||
        faultKind === 'reject' ||
        faultKind === 'not_ok'
      ) {
        const providerFault: ProviderFault = faultKind;
        mockProviderFaultFor = id =>
          id === captureIds[faultedIndex] ? providerFault : 'none';
      } else {
        // The n-th matching statement across the burst — which run it hits
        // depends on the interleaving; the oracle tolerates any run failing.
        ctx.db.failNth(faultKind.slice(3), s.int(1, k));
      }
      ctx.inputs = { k, faultKind, faultedIndex };
      const run = await s.run(
        fixtures.map(
          (f, i) => () =>
            runOnce(ctx, captureIds[i]!, f.clip, 'forehand_drive'),
        ),
      );
      const results = run.results.map(r =>
        r.status === 'fulfilled'
          ? r.value
          : { captureId: '?', outcome: null, error: String(r.reason) },
      );
      ctx.observed['steps'] = run.steps;
      ctx.observed['trace'] = run.trace;
      const thrown = results.filter(r => r.error !== null);
      ctx.observed['thrown'] = thrown.map(r => r.error);
      if (faultKind === 'not_ok') {
        const faulted = results[faultedIndex]!;
        v(
          ctx,
          faulted.outcome?.kind === 'unavailable',
          'engine ok:false → unavailable',
        );
      } else if (faultKind === 'throw_sync' || faultKind === 'reject') {
        v(
          ctx,
          results[faultedIndex]!.error !== null,
          'provider throw propagates to the caller',
        );
        v(
          ctx,
          thrown.length === 1,
          `exactly one run throws (got ${thrown.length})`,
        );
      } else {
        // The n-th matching statement may never occur (e.g. fewer scored
        // runs than `n` outbox inserts); then nothing may throw at all.
        const injected = ctx.db.statements.some(st =>
          st.error?.includes('SQLITE_FULL'),
        );
        ctx.observed['faultFired'] = injected;
        if (injected) {
          v(
            ctx,
            thrown.length >= 1,
            'the faulted persistence call surfaces as a throw',
          );
        } else {
          v(
            ctx,
            thrown.length === 0,
            `no fault fired but ${thrown.length} run(s) threw`,
          );
        }
        for (const t of thrown) {
          v(
            ctx,
            (t.error ?? '').includes('SQLITE') ||
              (t.error ?? '').includes('injected'),
            `unexpected throw: ${t.error}`,
          );
        }
      }
      // A thrown run must have released its permit as 'failed' (once).
      const failedReleases = [...ctx.server.ledger.values()].filter(
        e => e.releaseOutcome === 'failed',
      );
      v(
        ctx,
        failedReleases.length >=
          thrown.length + (faultKind === 'not_ok' ? 1 : 0),
        `every failed run released its permit as failed (releases=${failedReleases.length}, thrown=${thrown.length})`,
      );
      // The thrown run left no half-written scored rating.
      const shotsWithoutOutbox = ctx.db
        .shotRows()
        .filter(
          sh =>
            sh.resultKind === 'scored' &&
            !ctx.db
              .outboxByKind('shot.sync')
              .some(
                o => (JSON.parse(o.payload) as { id: string }).id === sh.id,
              ),
        );
      v(
        ctx,
        shotsWithoutOutbox.length === 0,
        `scored shot without outbox: ${shotsWithoutOutbox.map(x => x.id)}`,
      );
      checkAccounting(ctx, results, {
        finalizeFailuresAllowed: false,
        startOwner: OWNER_A,
      });
      mockActiveScheduler = null;
    },
  );

  // C. Cancel-during-call / logout / account rotation while a run is in
  //    flight. `runCaptureAnalysis` exposes no cancellation input, so
  //    "cancel" is the caller abandoning the promise; logout and rotation
  //    flip the process-wide data owner (and revoke the bearer) at a
  //    scheduler-chosen point.
  stressScenario(
    SUITE,
    'abandonLogoutRotate',
    { freeRatings: () => 4 },
    async ctx => {
      const { scheduler: s, seed } = ctx;
      mockActiveScheduler = s;
      const k = s.int(1, 3);
      const actor = s.pick([
        'abandon',
        'logout',
        'rotate_owner',
        'logout_then_other_user',
      ] as const);
      const fixtures = Array.from({ length: k }, (_, i) => fixtureFor(seed, i));
      const captureIds = fixtures.map((_, i) => `capture-${seed}-${i}`);
      for (const id of captureIds) ctx.db.seedCapture(OWNER_A, id);
      let abandoned = false;
      let actorFiredAtStep = -1;
      const config: ApiConfigState = { ...API_A };
      s.injectActor(`actor:${actor}`, () => {
        actorFiredAtStep = ctx.db.statements.length;
        switch (actor) {
          case 'abandon':
            abandoned = true;
            break;
          case 'logout':
            setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
            ctx.server.revokeToken(TOKEN_A);
            break;
          case 'rotate_owner':
            setActiveDataOwner(OWNER_B);
            break;
          case 'logout_then_other_user':
            setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
            ctx.server.revokeToken(TOKEN_A);
            setActiveDataOwner(OWNER_B);
            break;
        }
      });
      ctx.inputs = { k, actor };
      const run = await s.run(
        fixtures.map(
          (f, i) => () =>
            runOnce(ctx, captureIds[i]!, f.clip, 'forehand_drive', config),
        ),
      );
      const results = run.results.map(r =>
        r.status === 'fulfilled'
          ? r.value
          : { captureId: '?', outcome: null, error: String(r.reason) },
      );
      ctx.observed['steps'] = run.steps;
      ctx.observed['trace'] = run.trace;
      ctx.observed['actorFiredAfterStatements'] = actorFiredAtStep;
      ctx.observed['abandoned'] = abandoned;
      const thrown = results.filter(r => r.error !== null);
      ctx.observed['thrown'] = thrown.map(r => r.error);
      if (actor === 'abandon') {
        // Abandonment must not change durable accounting at all.
        for (const r of results)
          v(ctx, r.error === null, `run threw after abandon: ${r.error}`);
        checkAccounting(ctx, results, {
          finalizeFailuresAllowed: false,
          startOwner: OWNER_A,
        });
        ctx.observed['ratingsSpentWithNoWaitingCaller'] = results.filter(
          r => r.outcome?.kind === 'scored',
        ).length;
      } else {
        // Logout / rotation: a run may throw (signed-out writes are refused)
        // — acceptable — but every throw must be that refusal, never a
        // half-written row, and no row may land under another account.
        for (const t of thrown) {
          v(
            ctx,
            (t.error ?? '').includes('Sign in or continue locally'),
            `unexpected throw under ${actor}: ${t.error}`,
          );
        }
        checkAccounting(ctx, results, {
          // Revoked bearer → finalize 401 → the permit leaks until the sweep.
          finalizeFailuresAllowed: actor !== 'rotate_owner',
          startOwner: OWNER_A,
        });
      }
      mockActiveScheduler = null;
    },
  );

  // D. Server-side permit edge behaviour under a burst: paywall exhaustion,
  //    not-reserved status, reserve 500 / network throw, and a buggy server
  //    handing the SAME permit id to two reservations.
  stressScenario(
    SUITE,
    'serverPermitFaults',
    { freeRatings: s => s.int(0, 2) },
    async ctx => {
      const { scheduler: s, seed } = ctx;
      mockActiveScheduler = s;
      const k = s.int(2, 4);
      const plan = Array.from({ length: k }, () =>
        s.pick([
          'ok',
          'ok',
          'server_500',
          'network_throw',
          'not_reserved',
          'duplicate_permit_id',
        ] as const),
      );
      let call = 0;
      ctx.server.reserveBehaviour = () => plan[call++ % plan.length]!;
      const fixtures = Array.from({ length: k }, (_, i) => fixtureFor(seed, i));
      const captureIds = fixtures.map((_, i) => `capture-${seed}-${i}`);
      for (const id of captureIds) ctx.db.seedCapture(OWNER_A, id);
      ctx.inputs = { k, plan, freeRatings: ctx.server.initialAvailable };
      const run = await s.run(
        fixtures.map(
          (f, i) => () =>
            runOnce(ctx, captureIds[i]!, f.clip, 'forehand_drive'),
        ),
      );
      const results = run.results.map(r =>
        r.status === 'fulfilled'
          ? r.value
          : { captureId: '?', outcome: null, error: String(r.reason) },
      );
      ctx.observed['steps'] = run.steps;
      ctx.observed['trace'] = run.trace;
      for (const r of results)
        v(ctx, r.error === null, `run threw: ${r.error}`);
      const paywalled = results.filter(
        r =>
          r.outcome?.kind === 'unavailable' &&
          r.outcome.cause === 'paywall_required',
      ).length;
      ctx.observed['paywalled'] = paywalled;
      ctx.observed['status402'] = ctx.server.requests.filter(
        r => r.status === 402,
      ).length;
      v(
        ctx,
        paywalled === ctx.observed['status402'],
        '402 ⇔ unavailable(paywall_required)',
      );
      // Reserve failures never write and never release.
      const reserveFailedRuns = results.filter(
        r => r.outcome?.kind === 'unavailable',
      ).length;
      ctx.observed['reserveFailedRuns'] = reserveFailedRuns;
      const duplicated = plan.includes('duplicate_permit_id');
      if (duplicated) {
        // Server fault: the client cannot detect a reused id, so the oracle
        // only records how many scored shots share one permit.
        const consumed = ctx.db
          .outboxByKind('shot.sync')
          .map(
            o =>
              (JSON.parse(o.payload) as { analysisPermitId: string })
                .analysisPermitId,
          );
        ctx.observed['sharedPermitShots'] =
          consumed.length - new Set(consumed).size;
        v(ctx, ctx.db.openTransactions() === 0, 'no open transaction');
      } else {
        checkAccounting(ctx, results, {
          finalizeFailuresAllowed: false,
          startOwner: OWNER_A,
        });
      }
      mockActiveScheduler = null;
    },
  );

  // E. Clock skew: capturedAt far in the past / future, runs interleaved.
  stressScenario(SUITE, 'clockSkew', { freeRatings: () => 4 }, async ctx => {
    const { scheduler: s, seed } = ctx;
    mockActiveScheduler = s;
    const k = s.int(2, 3);
    const skews = Array.from({ length: k }, () =>
      s.pick([
        '1970-01-01T00:00:00.000Z',
        '2099-12-31T23:59:59.999Z',
        '2026-08-29T18:00:00.000Z',
        '2026-08-29T18:00:00.000+05:30',
        '2026-08-29T17:59:59.000Z',
      ] as const),
    );
    const fixtures = skews.map((iso, i) => {
      const f = captureFixture(`s${seed}-${i}`, 'right', iso);
      mockSidecars.set(f.clip.poseSequence!.uri, f.sidecarJson);
      return f;
    });
    const captureIds = fixtures.map((_, i) => `capture-${seed}-${i}`);
    for (const id of captureIds) ctx.db.seedCapture(OWNER_A, id);
    ctx.inputs = { k, skews };
    const run = await s.run(
      fixtures.map(
        (f, i) => () => runOnce(ctx, captureIds[i]!, f.clip, 'forehand_drive'),
      ),
    );
    const results = run.results.map(r =>
      r.status === 'fulfilled'
        ? r.value
        : { captureId: '?', outcome: null, error: String(r.reason) },
    );
    ctx.observed['steps'] = run.steps;
    ctx.observed['trace'] = run.trace;
    for (const r of results) v(ctx, r.error === null, `run threw: ${r.error}`);
    // A scored analysis must keep the clip's own capturedAt verbatim.
    results.forEach((r, i) => {
      if (r.outcome?.kind === 'scored') {
        v(
          ctx,
          r.outcome.record.result?.capturedAtIso === skews[i],
          `scored analysis ${i} capturedAtIso mutated: ${r.outcome.record.result?.capturedAtIso}`,
        );
      }
    });
    checkAccounting(ctx, results, {
      finalizeFailuresAllowed: false,
      startOwner: OWNER_A,
    });
    mockActiveScheduler = null;
  });

  // F. Second actor on the same row: a concurrent writer touches the SAME
  //    capture row / kv while the analysis persists. Detects lost updates
  //    and shared-connection transaction collisions.
  stressScenario(
    SUITE,
    'secondActorSameRow',
    { freeRatings: () => 4 },
    async ctx => {
      const { scheduler: s, seed } = ctx;
      mockActiveScheduler = s;
      const f = fixtureFor(seed, 0);
      const captureId = `capture-${seed}`;
      ctx.db.seedCapture(OWNER_A, captureId);
      const actorWrites = s.int(1, 3);
      ctx.inputs = { actorWrites };
      const secondActor = async (): Promise<RunResult> => {
        for (let i = 0; i < actorWrites; i += 1) {
          await busy(s, 'actor:think', s.int(0, 3));
          // Another writer opens its own transaction on the shared connection
          // (exactly the repository `inTransaction` pattern).
          await ctx.db.db.execute('BEGIN IMMEDIATE');
          try {
            await ctx.db.db.execute(
              `UPDATE local_capture SET status = 'retry_requested' WHERE owner_key = ? AND id = ?`,
              [OWNER_A, captureId],
            );
            await ctx.db.db.execute('COMMIT');
          } catch (error) {
            try {
              await ctx.db.db.execute('ROLLBACK');
            } catch {
              // mirror repository.ts: preserve the original error
            }
            throw error;
          }
        }
        return { captureId: 'actor', outcome: null, error: null };
      };
      const run = await s.run<RunResult>([
        () => runOnce(ctx, captureId, f.clip, 'forehand_drive'),
        () =>
          secondActor().catch(error => ({
            captureId: 'actor',
            outcome: null,
            error: error instanceof Error ? error.message : String(error),
          })),
      ]);
      ctx.observed['steps'] = run.steps;
      ctx.observed['trace'] = run.trace;
      const analysis =
        run.results[0]!.status === 'fulfilled' ? run.results[0]!.value : null;
      const actor =
        run.results[1]!.status === 'fulfilled' ? run.results[1]!.value : null;
      ctx.observed['actorError'] = actor?.error ?? null;
      ctx.observed['analysisError'] = analysis?.error ?? null;
      v(
        ctx,
        analysis !== null && analysis.error === null,
        `analysis threw: ${analysis?.error}`,
      );
      v(
        ctx,
        actor !== null && actor.error === null,
        `second actor threw: ${actor?.error}`,
      );
      checkAccounting(ctx, analysis ? [analysis] : [], {
        finalizeFailuresAllowed: false,
        startOwner: OWNER_A,
      });
      // Lost update: the analysis's own status write must survive.
      const capture = ctx.db.captures.get(`${OWNER_A}\u0000${captureId}`);
      ctx.observed['captureStatus'] = capture?.status ?? null;
      if (
        analysis?.outcome?.kind === 'scored' ||
        analysis?.outcome?.kind === 'low_confidence'
      ) {
        const analyzedWrite = ctx.db.statements.find(
          st => st.sql.includes("status = 'analyzed'") && st.error === null,
        );
        const lastActorWrite = [...ctx.db.statements]
          .reverse()
          .find(
            st =>
              st.sql.includes("status = 'retry_requested'") &&
              st.error === null,
          );
        const expected =
          analyzedWrite &&
          lastActorWrite &&
          lastActorWrite.seq > analyzedWrite.seq
            ? 'retry_requested'
            : 'analyzed';
        v(
          ctx,
          capture?.status === expected,
          `capture status lost update: expected last-writer ${expected}, got ${capture?.status}`,
        );
      }
      mockActiveScheduler = null;
    },
  );
});

function v(ctx: IterationContext, condition: boolean, message: string): void {
  ctx.violations.check(condition, message);
}
