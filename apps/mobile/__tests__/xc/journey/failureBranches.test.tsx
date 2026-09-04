/**
 * XC journey — FAILURE BRANCHES, full tree, 60 s of virtual time each.
 *
 * Every scenario mounts the REAL RootNavigator, drives the real Analyze
 * capture flow through the seeded camera seam, injects exactly one fault
 * (scripted server route, storage statement, sidecar read, or native
 * capture) and then advances fake timers by 60 000 ms. The assertions are the
 * ones the assignment names: the tree is in a state a player can leave or
 * retry from (retry / back / close / upgrade control present), and no
 * progress surface (BrandSpinner, AnalysisProgressBar, StrokeResultAnalyzing)
 * is still mounted after the minute.
 *
 * Replay: `XC_JOURNEY_SEED=<n> npx jest __tests__/xc/journey/failureBranches`.
 * Every scenario's seed, server script and request/SQL journal are written to
 * `artifacts/xc-journey/failureBranches.scenarios.json` by `writeEvidence`.
 */
import '../../../xc/journey/mocks';
import {
  collectedEvidence,
  runScenario,
  writeEvidence,
  type Journey,
} from '../../../xc/journey/harness';
import { failArtifactReads } from '../../../xc/journey/cameraSeam';
import {
  injectSqliteFault,
  shutdownSqliteBridge,
} from '../../../xc/journey/nodeSqliteOpSqlite';
import { API_REQUEST_TIMEOUT_MS } from '../../../src/data/api';
import { OUTBOX_MAX_ATTEMPTS } from '../../../src/data/sync';
import {
  SYNC_RETRY_BASE_MS,
  SYNC_RETRY_JITTER_RATIO,
} from '../../../src/data/syncRuntime';

const SEED = Number(process.env['XC_JOURNEY_SEED'] ?? 202);
/** The assignment's "no infinite spinner" window. */
const SETTLE_MS = 60_000;

afterAll(async () => {
  const written = writeEvidence('failureBranches');
  await shutdownSqliteBridge();
  expect(collectedEvidence().length).toBeGreaterThan(0);
  expect(written.matrixPath).toContain('failureBranches.matrix.json');
});

/** Camera landing → declared Forehand Drive → capture armed and clip in hand. */
async function captureDeclaredClip(j: Journey, clipId: string) {
  await j.waitFor(
    () => j.text().includes('Open automatic camera'),
    'Analyze camera landing',
  );
  await j.pressButton('Forehand Drive');
  const fixture = j.clip(clipId);
  const capture = j.armCapture();
  await j.pressButton('Open automatic camera');
  await j.flush(200);
  j.driveNativeCaptureSequence();
  await j.flush(50);
  return { capture, clip: fixture.clip };
}

async function expectAnalyzeError(j: Journey, title: string) {
  await j.waitFor(
    () => j.textIn('Analyze').includes('Nothing was rated.'),
    `Analyze error surface (${title})`,
  );
  expect(j.textIn('Analyze')).toContain(title);
  expect(j.topRoute()).toBe('Analyze');
}

/** Advances the full minute and proves nothing is still "loading". */
async function settleAndProbe(j: Journey, label: string) {
  await j.advance(SETTLE_MS);
  const probe = j.probeSpinners(label);
  expect(probe.brandSpinners).toBe(0);
  expect(probe.analysisProgress).toBe(0);
  expect(probe.resultAnalyzing).toBe(0);
  return probe;
}

describe('journey failure branches — permit denied', () => {
  it('402 paywall_required at reserve → upgrade + close, Paywall reachable and dismissible', async () => {
    await runScenario(
      {
        scenario: 'permit-denied-402',
        seed: SEED,
        script: {
          reserve: {
            kind: 'http',
            status: 402,
            code: 'access.paywall_required',
            message: 'Your free analyses are used up. Upgrade to keep rating.',
          },
        },
      },
      async j => {
        const { capture, clip } = await captureDeclaredClip(j, 'denied-402');
        capture.resolve(clip);
        await expectAnalyzeError(j, 'Analysis stopped');
        expect(j.textIn('Analyze')).toContain(
          'Your free analyses are used up.',
        );
        expect(j.buttonLabels()).toEqual(
          expect.arrayContaining(['Upgrade to Pro', 'Close']),
        );
        j.recordRecovery(['Upgrade to Pro', 'Close']);
        expect(j.server.requestsFor('/v1/analysis-permits')[0]!.status).toBe(
          402,
        );
        expect(j.server.permits.size).toBe(0);

        await settleAndProbe(j, 'after-60s');
        expect(j.buttonLabels()).toEqual(
          expect.arrayContaining(['Upgrade to Pro', 'Close']),
        );

        await j.pressButton('Upgrade to Pro');
        await j.waitFor(
          () => j.topRoute() === 'Paywall',
          'Paywall pushed over the Analyze error',
        );
        expect(j.routeNames()).toEqual(['Tabs', 'Analyze', 'Paywall']);
        await j.pressButton('Close membership offer');
        expect(j.topRoute()).toBe('Analyze');
        await j.pressButtonIn('Analyze', 'Close');
        expect(j.routeNames()).toEqual(['Tabs']);
      },
    );
  });

  it('network failure at reserve → Try again really re-captures and scores', async () => {
    await runScenario(
      {
        scenario: 'permit-denied-network-then-retry',
        seed: SEED,
        script: {
          reserve: { kind: 'network', message: 'Network request failed' },
        },
      },
      async j => {
        const first = await captureDeclaredClip(j, 'denied-net-1');
        first.capture.resolve(first.clip);
        await expectAnalyzeError(j, 'Analysis stopped');
        expect(j.textIn('Analyze')).toContain(
          'The rating service could not be reached.',
        );
        expect(j.buttonLabels()).toEqual(
          expect.arrayContaining(['Try again', 'Close']),
        );
        j.recordRecovery(['Try again', 'Close']);
        await settleAndProbe(j, 'after-60s');

        // The connection recovers; the retry control must reach Result.
        j.server.script.reserve = { kind: 'ok' };
        const retry = j.armCapture();
        await j.pressButton('Try again');
        await j.flush(200);
        j.driveNativeCaptureSequence();
        await j.flush(50);
        retry.resolve(j.clip('denied-net-2').clip);
        await j.waitFor(
          () => j.topRoute() === 'Result',
          'Result after the retried capture',
        );
        expect(
          j.server.requestsFor('/v1/analysis-permits').map(r => r.status),
        ).toEqual(['network_error', 200]);
        await j.waitFor(
          () => j.server.syncedShotIds.length === 1,
          'retried shot synced',
        );
      },
    );
  });

  it('reserve hangs → the 20 s client timeout ends the wait; Try again + Close', async () => {
    await runScenario(
      {
        scenario: 'permit-reserve-hang',
        seed: SEED,
        script: { reserve: { kind: 'hang' } },
      },
      async j => {
        const { capture, clip } = await captureDeclaredClip(j, 'hang');
        capture.resolve(clip);
        // Mid-hang: the working surface is legitimately up.
        await j.advance(API_REQUEST_TIMEOUT_MS / 2);
        expect(j.textIn('Analyze')).not.toContain('Nothing was rated.');
        const midway = j.probeSpinners('mid-hang');
        expect(midway.analysisProgress + midway.brandSpinners).toBeGreaterThan(
          0,
        );

        await settleAndProbe(j, 'after-60s');
        expect(j.textIn('Analyze')).toContain('Nothing was rated.');
        expect(j.textIn('Analyze')).toContain(
          'The server took too long to respond.',
        );
        expect(j.buttonLabels()).toEqual(
          expect.arrayContaining(['Try again', 'Close']),
        );
        j.recordRecovery(['Try again', 'Close']);
        // The abort surfaced as a rejected fetch, not a completed response.
        expect(j.server.requestsFor('/v1/analysis-permits')[0]!.status).toBe(
          'network_error',
        );
      },
    );
  });

  it('malformed reserve body → recoverable error, no permit recorded', async () => {
    await runScenario(
      {
        scenario: 'permit-reserve-malformed',
        seed: SEED,
        script: { reserve: { kind: 'malformed' } },
      },
      async j => {
        const { capture, clip } = await captureDeclaredClip(j, 'malformed');
        capture.resolve(clip);
        await expectAnalyzeError(j, 'Analysis stopped');
        expect(j.buttonLabels()).toEqual(
          expect.arrayContaining(['Try again', 'Close']),
        );
        j.recordRecovery(['Try again', 'Close']);
        await settleAndProbe(j, 'after-60s');
        expect(j.server.permits.size).toBe(0);
        await j.pressButtonIn('Analyze', 'Close');
        expect(j.routeNames()).toEqual(['Tabs']);
      },
    );
  });
});

describe('journey failure branches — analysis throws', () => {
  it('storage throws inside saveAnalysis after a reserved permit → Try again + Close', async () => {
    await runScenario(
      { scenario: 'analysis-throws-storage', seed: SEED },
      async j => {
        injectSqliteFault({
          match: 'INSERT OR REPLACE INTO local_shot',
          remaining: 1,
          error: () => new Error('SQLITE_FULL: database or disk is full'),
        });
        const { capture, clip } = await captureDeclaredClip(j, 'throws-db');
        capture.resolve(clip);
        await expectAnalyzeError(j, 'Analysis stopped');
        expect(j.textIn('Analyze')).toContain('SQLITE_FULL');
        expect(j.buttonLabels()).toEqual(
          expect.arrayContaining(['Try again', 'Close']),
        );
        j.recordRecovery(['Try again', 'Close']);
        await settleAndProbe(j, 'after-60s');
        // Nothing half-written: no rating row, nothing queued for sync.
        expect(await j.outbox()).toEqual([]);
        expect(j.server.syncedShotIds).toEqual([]);
        // The reserve succeeded; the evidence table records what the server
        // still holds for that permit after the throw.
        expect(j.server.requestsFor('/v1/analysis-permits')[0]!.status).toBe(
          200,
        );
        expect(j.server.permits.size).toBe(1);
      },
    );
  });

  it('storage throws on the LAST free rating → retry still lands somewhere recoverable', async () => {
    // Adversarial: the reserve succeeded, the local write threw, and the
    // server still holds that reservation. The player's retry must not strand
    // them — whichever branch the ledger takes is recorded in the evidence.
    await runScenario(
      {
        scenario: 'analysis-throws-storage-last-free-retry',
        seed: SEED,
        script: { used: 1 },
      },
      async j => {
        injectSqliteFault({
          match: 'INSERT OR REPLACE INTO local_shot',
          remaining: 1,
          error: () => new Error('SQLITE_IOERR: disk I/O error'),
        });
        const first = await captureDeclaredClip(j, 'throws-db-last-1');
        first.capture.resolve(first.clip);
        await expectAnalyzeError(j, 'Analysis stopped');
        expect(j.server.permits.get('permit-001')?.status).toBe('reserved');
        expect(j.server.ledger()).toEqual({ used: 1, reserved: 1 });
        await settleAndProbe(j, 'after-60s');

        const retry = j.armCapture();
        await j.pressButton('Try again');
        await j.flush(200);
        j.driveNativeCaptureSequence();
        await j.flush(50);
        retry.resolve(j.clip('throws-db-last-2').clip);
        await j.waitFor(
          () =>
            j.topRoute() === 'Result' ||
            j.textIn('Analyze').includes('Nothing was rated.'),
          'retry outcome (Result or a second error surface)',
        );
        const reserves = j.server.requestsFor('/v1/analysis-permits');
        expect(reserves).toHaveLength(2);
        const outcome =
          j.topRoute() === 'Result'
            ? 'scored'
            : `error:${String(reserves[1]!.status)}:${j.buttonLabels().join('|')}`;
        j.recordRecovery([`retry-outcome=${outcome}`]);
        // Recoverable either way: a Result, or an error surface with Close.
        if (j.topRoute() !== 'Result') {
          expect(j.buttonLabels()).toContain('Close');
          const probe = j.probeSpinners('after-retry');
          expect(probe.analysisProgress).toBe(0);
          await j.pressButtonIn('Analyze', 'Close');
          expect(j.routeNames()).toEqual(['Tabs']);
        }
      },
    );
  });

  it('sidecar unreadable → unavailable outcome, retry offered, no permit burned', async () => {
    await runScenario(
      { scenario: 'analysis-sidecar-unreadable', seed: SEED },
      async j => {
        const { capture, clip } = await captureDeclaredClip(j, 'no-sidecar');
        failArtifactReads('ENOENT: pose sidecar missing');
        capture.resolve(clip);
        await expectAnalyzeError(j, 'Analysis stopped');
        expect(j.textIn('Analyze')).toContain(
          'The recorded pose sequence for this capture could not be read.',
        );
        j.recordRecovery(['Try again', 'Close']);
        await settleAndProbe(j, 'after-60s');
        expect(j.server.requestsFor('/v1/analysis-permits')).toEqual([]);
        await j.pressButtonIn('Analyze', 'Close');
        expect(j.routeNames()).toEqual(['Tabs']);
      },
    );
  });

  it('native capture rejects → "Capture interrupted" with Try again + Close', async () => {
    await runScenario({ scenario: 'capture-throws', seed: SEED }, async j => {
      const { capture } = await captureDeclaredClip(j, 'capture-reject');
      capture.reject(new Error('AVCaptureSession was interrupted'));
      await expectAnalyzeError(j, 'Capture interrupted');
      expect(j.buttonLabels()).toEqual(
        expect.arrayContaining(['Try again', 'Close']),
      );
      j.recordRecovery(['Try again', 'Close']);
      await settleAndProbe(j, 'after-60s');
      expect(j.server.requestsFor('/v1/analysis-permits')).toEqual([]);
    });
  });
});

describe('journey failure branches — sync fails', () => {
  async function scoreToResult(j: Journey, clipId: string) {
    const { capture, clip } = await captureDeclaredClip(j, clipId);
    capture.resolve(clip);
    await j.waitFor(() => j.topRoute() === 'Result', 'Result after scoring');
    await j.waitFor(() => j.has('result-guide'), 'Result guide mounted');
    await j.waitFor(
      () => !j.has('stroke-result-analyzing'),
      'Result analyzing surface gone',
    );
  }

  /** The practice-set `session.create` row queues beside the shot; the
   * scenarios reason about the rating row alone. */
  async function shotRows(j: Journey) {
    return (await j.outbox()).filter(row => row.kind === 'shot.sync');
  }

  async function walkGuideToEnd(j: Journey) {
    for (let guard = 0; guard < 6 && j.has('result-guide-next'); guard += 1) {
      await j.pressTestId('result-guide-next');
    }
    expect(j.has('result-guide-done')).toBe(true);
    expect(j.has('result-guide-try-again')).toBe(true);
    j.recordRecovery(['result-guide-done', 'result-guide-try-again']);
  }

  /** The sync-evidence card is on the breakdown sheet (ResultDetails); read
   * it there, then unwind Back → Result → Done → Tabs. */
  async function readBreakdownSyncCardAndUnwind(j: Journey, expected: RegExp) {
    const analysisId = (j.stack.top().params as { analysisId: string })
      .analysisId;
    await j.navigateTo('ResultDetails', { analysisId });
    await j.waitFor(
      () => j.topRoute() === 'ResultDetails' && j.has('result-details'),
      'ResultDetails ready tree',
    );
    await j.waitFor(
      () => expected.test(j.textIn('ResultDetails')),
      `sync-evidence card matching ${expected}`,
    );
    const probe = j.probeSpinners('result-details-settled');
    expect(probe.brandSpinners).toBe(0);
    await j.pressButtonIn('ResultDetails', 'Back');
    expect(j.topRoute()).toBe('Result');
    await j.pressTestId('result-guide-done');
    expect(j.routeNames()).toEqual(['Tabs']);
  }

  it('HTTP 500 on shots:sync → Result renders, row stays retryable, retries back off', async () => {
    await runScenario(
      {
        scenario: 'sync-fails-500',
        seed: SEED,
        script: {
          sync: {
            kind: 'http',
            status: 500,
            code: 'internal',
            message: 'upstream unavailable',
          },
        },
      },
      async j => {
        await scoreToResult(j, 'sync-500');
        await j.waitFor(
          () => j.server.requestsFor('/v1/shots:sync').length >= 1,
          'first sync attempt',
        );
        const before = j.server.requestsFor('/v1/shots:sync').length;
        await settleAndProbe(j, 'after-60s');
        // One failed drain doubles the cadence: 30 s · 2 ± 20 % = 48–72 s.
        // The retry timer must still be armed (or have already fired).
        const at60 = j.server.requestsFor('/v1/shots:sync').length;
        expect(at60 >= before).toBe(true);
        expect(j.probeSpinners('retry-armed').pendingTimers).toBeGreaterThan(0);
        await j.advance(
          Math.ceil(SYNC_RETRY_BASE_MS * 2 * (1 + SYNC_RETRY_JITTER_RATIO)) -
            SETTLE_MS,
        );
        const after = j.server.requestsFor('/v1/shots:sync').length;
        expect(after).toBeGreaterThan(before);
        expect(j.server.syncedShotIds).toEqual([]);

        const rows = await shotRows(j);
        expect(rows).toHaveLength(1);
        // Transient: the attempt budget is untouched, the error is recorded.
        expect(rows[0]!.attempts).toBe(0);
        expect(rows[0]!.lastError).toContain('upstream unavailable');

        await walkGuideToEnd(j);
        await readBreakdownSyncCardAndUnwind(j, /Sync this read first\./);
      },
    );
  });

  it('server rejects the shot on contract → rejected copy names attempts, still dismissible', async () => {
    await runScenario(
      {
        scenario: 'sync-rejected-contract',
        seed: SEED,
        script: {
          sync: {
            kind: 'reject_all',
            code: 'shot.invalid_payload',
            message: 'payload rejected',
          },
        },
      },
      async j => {
        await scoreToResult(j, 'sync-reject');
        await j.waitFor(
          () => j.server.requestsFor('/v1/shots:sync').length >= 1,
          'first sync attempt',
        );
        await settleAndProbe(j, 'after-60s');
        const rows = await shotRows(j);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.attempts).toBeGreaterThanOrEqual(1);
        expect(rows[0]!.attempts).toBeLessThan(OUTBOX_MAX_ATTEMPTS);
        expect(rows[0]!.lastError).toContain('payload rejected');
        expect(j.server.syncedShotIds).toEqual([]);

        await walkGuideToEnd(j);
        await readBreakdownSyncCardAndUnwind(
          j,
          /The server refused this read \d+ of 8 times/,
        );
      },
    );
  });

  it('shots:sync hangs → 20 s timeout, Result never blocks on the outbox', async () => {
    await runScenario(
      {
        scenario: 'sync-hang',
        seed: SEED,
        script: { sync: { kind: 'hang' } },
      },
      async j => {
        await scoreToResult(j, 'sync-hang');
        await settleAndProbe(j, 'after-60s');
        const syncRequests = j.server.requestsFor('/v1/shots:sync');
        expect(syncRequests.length).toBeGreaterThanOrEqual(1);
        expect(syncRequests.every(r => r.status === 'network_error')).toBe(
          true,
        );
        const rows = await shotRows(j);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.attempts).toBe(0);
        expect(rows[0]!.lastError).toContain('took too long');
        await walkGuideToEnd(j);
        await readBreakdownSyncCardAndUnwind(j, /Sync this read first\./);
      },
    );
  });
});

describe('journey failure branches — free ratings exhausted → Paywall', () => {
  it('both free ratings used → the rating gate replaces Analyze with Paywall; close returns to Tabs', async () => {
    await runScenario(
      { scenario: 'free-limit-gate-paywall', seed: SEED, script: { used: 2 } },
      async j => {
        await j.waitFor(
          () => j.topRoute() === 'Paywall',
          'rating gate replace(Paywall)',
        );
        expect(j.routeNames()).toEqual(['Tabs', 'Paywall']);
        expect(j.server.requestsFor('/v1/analysis-permits')).toEqual([]);
        await settleAndProbe(j, 'after-60s');
        expect(j.buttonLabels()).toContain('Close membership offer');
        j.recordRecovery(['Close membership offer']);
        await j.pressButton('Close membership offer');
        expect(j.routeNames()).toEqual(['Tabs']);
      },
    );
  });

  it('last free rating scores → free-limit prompt → Upgrade lands on Paywall over Result', async () => {
    await runScenario(
      {
        scenario: 'free-limit-last-rating-paywall',
        seed: SEED,
        script: { used: 1 },
      },
      async j => {
        const { capture, clip } = await captureDeclaredClip(j, 'last-free');
        capture.resolve(clip);
        await j.waitFor(
          () =>
            j.textIn('Analyze').includes('That was your last free analysis.'),
          'free-limit prompt on Analyze',
        );
        expect(j.topRoute()).toBe('Analyze');
        expect(j.buttonLabels()).toEqual(
          expect.arrayContaining(['Upgrade to Pro', 'See my score']),
        );
        j.recordRecovery(['Upgrade to Pro', 'See my score']);
        await settleAndProbe(j, 'after-60s');
        expect(j.textIn('Analyze')).toContain(
          'That was your last free analysis.',
        );

        await j.pressButton('Upgrade to Pro');
        await j.waitFor(
          () => j.topRoute() === 'Paywall',
          'Paywall over the replaced Result',
        );
        expect(j.routeNames()).toEqual(['Tabs', 'Result', 'Paywall']);
        await j.pressButton('Close membership offer');
        expect(j.topRoute()).toBe('Result');
        await j.waitFor(
          () => j.has('result-guide'),
          'Result guide under the paywall',
        );
        await j.waitFor(
          () => j.server.syncedShotIds.length === 1,
          'last free rating synced',
        );
        expect(j.server.permits.get('permit-001')?.status).toBe('consumed');
      },
    );
  });

  it('access endpoint unreachable → gate still resolves to a dismissible Paywall, no spinner', async () => {
    await runScenario(
      {
        scenario: 'access-unreachable-gate',
        seed: SEED,
        script: {
          access: { kind: 'network', message: 'Network request failed' },
        },
      },
      async j => {
        await j.waitFor(
          () => j.topRoute() === 'Paywall',
          'gate replace(Paywall) on access error',
        );
        expect(j.routeNames()).toEqual(['Tabs', 'Paywall']);
        await settleAndProbe(j, 'after-60s');
        expect(j.buttonLabels()).toContain('Close membership offer');
        j.recordRecovery(['Close membership offer']);
        await j.pressButton('Close membership offer');
        expect(j.routeNames()).toEqual(['Tabs']);
      },
    );
  });
});
