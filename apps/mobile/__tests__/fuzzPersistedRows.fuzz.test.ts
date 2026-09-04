/**
 * Fuzz: SQLite repository rows → repository readers and the outbox drain.
 *
 * Each surface seeds ONE owner-scoped table row whose JSON column (or a
 * typed column) is replaced with adversarial content, then drives the real
 * reader in `src/data/repository.ts`, `src/data/sync.ts` or
 * `src/components/strokeResultData.ts`. Contract under test: a corrupt row
 * is skipped, quarantined (`UPDATE outbox … attempts + 1`) or reported as
 * `corrupt`, never thrown to the caller and never repaired into evidence.
 *
 * Scale: FUZZ_CASES (default 200) cases × 15 generators × 14 surfaces.
 * Replay one case: FUZZ_SEED=<seed> FUZZ_REPLAY=<surface>:<generator>:<index>
 * Report: artifacts/fuzz-mobile-persisted-state/<FUZZ_RUN_ID>/rows.json
 */
import { FuzzDb } from '../__fuzz__/support/fakeDb';
import {
  FUZZ_TEST_TIMEOUT_MS,
  FuzzRun,
  accepted,
  invariant,
  lenient,
  rejected,
  type CaseVerdict,
  type Surface,
} from '../__fuzz__/support/harness';
import {
  ANALYSIS_RECORD_TEMPLATE,
  CAPTURED_CLIP_TEMPLATE,
  CAPTURE_ROW_META,
  CAPTURE_TARGET_SEED_TEMPLATE,
  LIVE_SESSION_SUMMARY_TEMPLATE,
  OUTBOX_SESSION_TEMPLATE,
  OUTBOX_SHOT_TEMPLATE,
  OUTBOX_TRIAL_TEMPLATE,
  SHOT_ANALYSIS_TEMPLATE,
} from '../__fuzz__/support/templates';
import type { GeneratedInput, Json } from '../__fuzz__/support/generators';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import {
  getAnalysis,
  getCaptureTargetSeed,
  listAnalysisRecords,
  listCaptureHistory,
  listLiveSessionHistory,
  listPendingCaptures,
  listRealAnalysisFacts,
  listScoredCheckpointFacts,
} from '../src/data/repository';
import { drainOutbox, type SyncTransport } from '../src/data/sync';
import { loadStrokeResultEvidence } from '../src/components/strokeResultData';
import { buildFormReviewScript } from '../src/review/formReviewModel';
import { parseLiveSessionSummaryRecord } from '../src/flow/liveSessionSummary';

const OWNER = GUEST_DATA_OWNER;
const db = new FuzzDb();
const run = new FuzzRun('rows');

const SHOT_ID = (SHOT_ANALYSIS_TEMPLATE as { id: string }).id;
const CAPTURE_ID = CAPTURE_ROW_META.id;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function shotRow(payload: unknown): Record<string, unknown> {
  return {
    owner_key: OWNER,
    id: SHOT_ID,
    session_id: null,
    shot_type: 'forehand_drive',
    captured_at: '2026-08-26T18:00:00.000Z',
    source: 'real',
    result_kind: 'scored',
    overall_score: 7.4,
    payload,
  };
}

function seedShot(input: GeneratedInput): void {
  db.reset();
  db.seed('local_shot', [shotRow(input.value)]);
}

function realFactConforms(fact: unknown): string | null {
  if (!isPlainObject(fact)) return `fact is ${typeOf(fact)}`;
  if (typeof fact['id'] !== 'string') return `id is ${typeOf(fact['id'])}`;
  if (typeof fact['shotType'] !== 'string') {
    return `shotType is ${typeOf(fact['shotType'])}`;
  }
  if (typeof fact['capturedAt'] !== 'string') {
    return `capturedAt is ${typeOf(fact['capturedAt'])}`;
  }
  const score = fact['overallScore'];
  if (
    score !== null &&
    (typeof score !== 'number' || !Number.isFinite(score))
  ) {
    return `overallScore is ${typeOf(score)}`;
  }
  if (
    typeof fact['confidence'] !== 'number' ||
    !Number.isFinite(fact['confidence'])
  ) {
    return `confidence is ${typeOf(fact['confidence'])}`;
  }
  if (typeof fact['scoringModelVersion'] !== 'string') {
    return `scoringModelVersion is ${typeOf(fact['scoringModelVersion'])}`;
  }
  return null;
}

function analysisConforms(analysis: unknown): string | null {
  if (!isPlainObject(analysis)) return `analysis is ${typeOf(analysis)}`;
  if (typeof analysis['id'] !== 'string')
    return `id is ${typeOf(analysis['id'])}`;
  if (typeof analysis['shotType'] !== 'string') {
    return `shotType is ${typeOf(analysis['shotType'])}`;
  }
  if (!Array.isArray(analysis['checkpoints'])) {
    return `checkpoints is ${typeOf(analysis['checkpoints'])}`;
  }
  if (!isPlainObject(analysis['versionVector'])) {
    return `versionVector is ${typeOf(analysis['versionVector'])}`;
  }
  return null;
}

function factsVerdict(
  facts: unknown[],
  conforms: (fact: unknown) => string | null,
): CaseVerdict {
  if (facts.length === 0) return rejected('row skipped');
  if (facts.length > 1) return invariant(`${facts.length} facts from one row`);
  const problem = conforms(facts[0]);
  if (problem) return lenient(`non-conforming fact kept: ${problem}`);
  return accepted();
}

function outboxRow(
  kind: string,
  payload: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    owner_key: OWNER,
    id: 41,
    kind,
    payload,
    attempts: 0,
    last_error: null,
    ...extra,
  };
}

interface TransportLog {
  shots: unknown[];
  sessions: unknown[];
  finalized: string[];
  trials: unknown[];
}

function transport(log: TransportLog): SyncTransport {
  return {
    async syncShots(shots) {
      log.shots.push(...shots);
      const acceptedIds: string[] = [];
      for (const shot of shots) {
        if (isPlainObject(shot) && typeof shot['id'] === 'string') {
          acceptedIds.push(shot['id']);
        }
      }
      return { acceptedIds, rejected: [] };
    },
    async createSession(session) {
      log.sessions.push(session);
    },
    async finalizeSession(id) {
      log.finalized.push(id);
    },
    async uploadEvaluationTrials(trials) {
      log.trials.push(...trials);
      const acceptedTrialIds: string[] = [];
      for (const trial of trials) {
        if (isPlainObject(trial) && typeof trial['trialId'] === 'string') {
          acceptedTrialIds.push(trial['trialId']);
        }
      }
      return { acceptedTrialIds, rejected: [] };
    },
  };
}

/**
 * What the drain did with the single seeded row: deleted (synced),
 * quarantined (attempts + 1 — permanent failure), retried (last_error only)
 * or left untouched. Anything else means the drain lost track of the row.
 */
function outboxDisposition():
  'deleted' | 'quarantined' | 'retried' | 'untouched' {
  const deleted = db.statements(/^DELETE FROM outbox/).length;
  const quarantined = db.statements(
    /^UPDATE outbox SET attempts = attempts \+ 1/,
  ).length;
  const retried = db.statements(/^UPDATE outbox SET last_error = \?/).length;
  if (deleted > 0) return 'deleted';
  if (quarantined > 0) return 'quarantined';
  if (retried > 0) return 'retried';
  return 'untouched';
}

/** Whether the seeded payload parses to a record the transport should see
 * unchanged; anything else that still reaches the transport is `lenient`. */
function payloadConforms(
  input: GeneratedInput,
  conforms: (value: unknown) => string | null,
): boolean {
  if (input.kind !== 'string') return false;
  try {
    return conforms(JSON.parse(input.value as string)) === null;
  } catch {
    return false;
  }
}

async function drainVerdict(
  conforming: boolean,
  transportSaw: () => number,
): Promise<CaseVerdict> {
  const result = await drainOutbox(db, transport(currentLog));
  const disposition = outboxDisposition();
  if (result.synced + result.failed !== 1) {
    return invariant(
      `drain reported synced=${result.synced} failed=${result.failed} for one row`,
    );
  }
  if (disposition === 'untouched') {
    return invariant(
      'row neither deleted nor marked (would be redrained forever)',
    );
  }
  if (disposition === 'retried') {
    return invariant(
      'malformed row recorded as TRANSIENT (attempts not consumed)',
    );
  }
  if (disposition === 'deleted') {
    if (transportSaw() !== 1) {
      return invariant(
        `row deleted but transport saw ${transportSaw()} entries`,
      );
    }
    return conforming
      ? accepted()
      : lenient('mutated payload reached the transport');
  }
  return rejected('quarantined: attempts + 1, last_error set');
}

let currentLog: TransportLog = {
  shots: [],
  sessions: [],
  finalized: [],
  trials: [],
};

function resetLog(): void {
  currentLog = { shots: [], sessions: [], finalized: [], trials: [] };
}

function captureRow(
  payload: unknown,
  targetSeed: unknown = null,
): Record<string, unknown> {
  return {
    owner_key: OWNER,
    ...CAPTURE_ROW_META,
    target_seed: targetSeed,
    payload,
  };
}

/** Row-level fuzz: the generated value is a whole outbox row when it parses
 * to an object, otherwise it becomes the payload of an otherwise valid row. */
function rowFromInput(
  input: GeneratedInput,
  kind: string,
): Record<string, unknown> {
  if (input.kind === 'string') {
    try {
      const parsed: unknown = JSON.parse(input.value as string);
      if (isPlainObject(parsed)) return { owner_key: OWNER, ...parsed };
    } catch {
      // Not a JSON object: fall through and use the raw text as payload.
    }
    return outboxRow(kind, input.value);
  }
  return outboxRow(kind, input.value);
}

const OUTBOX_ROW_TEMPLATE: Json = {
  id: 41,
  kind: 'shot.sync',
  payload: JSON.stringify(OUTBOX_SHOT_TEMPLATE),
  attempts: 0,
  last_error: null,
};

const surfaces: Surface[] = [
  {
    name: 'repository.getAnalysis',
    template: SHOT_ANALYSIS_TEMPLATE,
    run: async input => {
      seedShot(input);
      // Sole caller: strokeResultData.ts:107 `getAnalysis(...).catch(() => null)`.
      // A parse error here is therefore a contained rejection, and the
      // `strokeResultData.loadStrokeResultEvidence` surface below proves it.
      let analysis: unknown;
      try {
        analysis = await getAnalysis(db, SHOT_ID);
      } catch (error) {
        return rejected(
          `threw ${error instanceof Error ? error.name : typeof error} (caught by the one caller)`,
        );
      }
      if (analysis === null) return rejected('null (empty/falsy payload)');
      const problem = analysisConforms(analysis);
      if (problem) return lenient(`cast without validation: ${problem}`);
      return accepted();
    },
  },
  {
    name: 'strokeResultData.loadStrokeResultEvidence',
    template: SHOT_ANALYSIS_TEMPLATE,
    run: async input => {
      seedShot(input);
      db.seed('local_analysis_record', [
        {
          owner_key: OWNER,
          id: SHOT_ID,
          capture_id: CAPTURE_ID,
          created_at: '2026-08-26T18:00:00.000Z',
          record: input.value,
        },
      ]);
      db.seed('local_capture', [
        captureRow(JSON.stringify(CAPTURED_CLIP_TEMPLATE)),
      ]);
      const evidence = await loadStrokeResultEvidence(db, SHOT_ID);
      if (!Array.isArray(evidence.attempts)) {
        return invariant(`attempts is ${typeOf(evidence.attempts)}`);
      }
      if (evidence.analysis === null) return rejected('analysis=null');
      const problem = analysisConforms(evidence.analysis);
      if (problem)
        return lenient(
          `non-conforming analysis surfaced to the screen: ${problem}`,
        );
      return accepted();
    },
  },
  {
    // FormReviewScreen.tsx:75-97 verbatim: the effect has no try/catch, so a
    // throw from buildFormReviewScript is an unhandled rejection and the
    // screen stays on its loading state (setState({kind:'ready'}) is never
    // reached). Anything that escapes here is exactly that hang.
    name: 'formReviewScreen.loadEffectChain',
    template: SHOT_ANALYSIS_TEMPLATE,
    run: async input => {
      seedShot(input);
      const evidence = await loadStrokeResultEvidence(db, SHOT_ID).catch(
        () => null,
      );
      const analysis = evidence?.analysis ?? evidence?.record?.result ?? null;
      if (!analysis) return rejected("state 'missing'");
      const script = buildFormReviewScript(analysis, null);
      if (!Array.isArray(script.stops)) {
        return invariant(`script.stops is ${typeOf(script.stops)}`);
      }
      return analysisConforms(analysis)
        ? lenient('script built from a non-conforming analysis')
        : accepted();
    },
  },
  {
    name: 'repository.listRealAnalysisFacts',
    template: SHOT_ANALYSIS_TEMPLATE,
    run: async input => {
      seedShot(input);
      return factsVerdict(await listRealAnalysisFacts(db), realFactConforms);
    },
  },
  {
    name: 'repository.listScoredCheckpointFacts',
    template: SHOT_ANALYSIS_TEMPLATE,
    run: async input => {
      seedShot(input);
      return factsVerdict(await listScoredCheckpointFacts(db), fact => {
        if (!isPlainObject(fact)) return `fact is ${typeOf(fact)}`;
        if (typeof fact['id'] !== 'string')
          return `id is ${typeOf(fact['id'])}`;
        if (!Array.isArray(fact['checkpoints']))
          return 'checkpoints not an array';
        return null;
      });
    },
  },
  {
    name: 'repository.listAnalysisRecords',
    template: ANALYSIS_RECORD_TEMPLATE,
    run: async input => {
      db.reset();
      db.seed('local_analysis_record', [
        {
          owner_key: OWNER,
          id: SHOT_ID,
          capture_id: CAPTURE_ID,
          created_at: '2026-08-26T18:00:00.000Z',
          record: input.value,
        },
      ]);
      const records = await listAnalysisRecords(db, CAPTURE_ID);
      return factsVerdict(records, record => {
        if (!isPlainObject(record)) return `record is ${typeOf(record)}`;
        if (record['schemaVersion'] !== 1)
          return `schemaVersion=${String(record['schemaVersion'])}`;
        if (typeof record['id'] !== 'string')
          return `id is ${typeOf(record['id'])}`;
        if (!isPlainObject(record['result']))
          return `result is ${typeOf(record['result'])}`;
        return null;
      });
    },
  },
  {
    name: 'repository.getCaptureTargetSeed',
    template: CAPTURE_TARGET_SEED_TEMPLATE,
    run: async input => {
      db.reset();
      db.seed('local_capture', [captureRow(null, input.value)]);
      const seed = await getCaptureTargetSeed(db, CAPTURE_ID);
      if (seed === null) return rejected();
      if (
        !isPlainObject(seed.point) ||
        typeof seed.point.x !== 'number' ||
        typeof seed.point.y !== 'number' ||
        typeof seed.selectedAtIso !== 'string'
      ) {
        return invariant(`malformed seed kept: ${JSON.stringify(seed)}`);
      }
      return accepted();
    },
  },
  {
    name: 'repository.listPendingCaptures.clipPayload',
    template: CAPTURED_CLIP_TEMPLATE,
    run: async input => {
      db.reset();
      db.seed('local_capture', [captureRow(input.value)]);
      const [pending] = await listPendingCaptures(db);
      const history = await listCaptureHistory(db);
      if (!pending)
        return invariant('capture row dropped from the pending queue');
      if (history.length !== 1)
        return invariant(`history returned ${history.length} rows`);
      if (pending.evidenceStatus === 'valid') {
        return pending.clip
          ? accepted()
          : invariant('valid status without clip');
      }
      if (pending.clip !== null) {
        return invariant(
          `clip surfaced with evidenceStatus=${pending.evidenceStatus}`,
        );
      }
      if (input.value === null && pending.evidenceStatus !== 'legacy') {
        return invariant(`null payload classified ${pending.evidenceStatus}`);
      }
      return rejected(pending.evidenceStatus);
    },
  },
  {
    name: 'repository.listLiveSessionHistory.summary',
    template: LIVE_SESSION_SUMMARY_TEMPLATE,
    run: async input => {
      db.reset();
      db.seed('local_session', [
        {
          owner_key: OWNER,
          id: 'live-1',
          started_at: '2026-09-04T05:00:00.000Z',
          ended_at: '2026-09-04T05:07:00.000Z',
          mode: 'live_court',
          completed: 1,
          summary: input.value,
        },
      ]);
      const [row] = await listLiveSessionHistory(db);
      if (!row) return invariant('session row dropped');
      if (row.summary !== null && typeof row.summary !== 'string') {
        return invariant(`summary is ${typeOf(row.summary)}`);
      }
      const record =
        row.summary === null
          ? null
          : parseLiveSessionSummaryRecord(row.summary);
      if (record === null)
        return rejected(
          row.summary === null ? 'null summary' : 'strict parser rejected',
        );
      if (record.version !== 1 || !Number.isSafeInteger(record.strokeCount)) {
        return invariant(
          `malformed summary kept: ${JSON.stringify(record).slice(0, 120)}`,
        );
      }
      return accepted();
    },
  },
  {
    name: 'sync.drainOutbox.shotPayload',
    template: OUTBOX_SHOT_TEMPLATE,
    run: async input => {
      db.reset();
      resetLog();
      db.seed('outbox', [outboxRow('shot.sync', input.value)]);
      return drainVerdict(
        payloadConforms(input, value => {
          const problem = analysisConforms(value);
          if (problem) return problem;
          return typeof (value as Record<string, unknown>)[
            'analysisPermitId'
          ] === 'string'
            ? null
            : 'analysisPermitId missing';
        }),
        () => currentLog.shots.length,
      );
    },
  },
  {
    name: 'sync.drainOutbox.sessionCreatePayload',
    template: OUTBOX_SESSION_TEMPLATE,
    run: async input => {
      db.reset();
      resetLog();
      db.seed('outbox', [outboxRow('session.create', input.value)]);
      return drainVerdict(
        payloadConforms(input, value =>
          isPlainObject(value) &&
          typeof value['id'] === 'string' &&
          typeof value['shotType'] === 'string'
            ? null
            : 'not a session record',
        ),
        () => currentLog.sessions.length,
      );
    },
  },
  {
    name: 'sync.drainOutbox.evaluationTrialPayload',
    template: OUTBOX_TRIAL_TEMPLATE,
    run: async input => {
      db.reset();
      resetLog();
      db.seed('outbox', [outboxRow('evaluation.trial', input.value)]);
      return drainVerdict(
        payloadConforms(input, value =>
          isPlainObject(value) &&
          typeof value['trialId'] === 'string' &&
          typeof value['shotId'] === 'string'
            ? null
            : 'not a trial record',
        ),
        () => currentLog.trials.length,
      );
    },
  },
  {
    name: 'sync.drainOutbox.wholeRow',
    template: OUTBOX_ROW_TEMPLATE,
    run: async input => {
      db.reset();
      resetLog();
      const row = rowFromInput(input, 'shot.sync');
      db.seed('outbox', [row]);
      const result = await drainOutbox(db, transport(currentLog));
      const disposition = outboxDisposition();
      const kind = row['kind'];
      const knownKind =
        kind === 'shot.sync' ||
        kind === 'session.create' ||
        kind === 'session.finalize' ||
        kind === 'evaluation.trial';
      if (result.synced + result.failed !== 1) {
        return invariant(
          `drain reported synced=${result.synced} failed=${result.failed} for one row (kind=${String(kind)})`,
        );
      }
      if (disposition === 'untouched') {
        return invariant(`row untouched (kind=${String(kind)})`);
      }
      if (disposition === 'retried') {
        return invariant('malformed row recorded as TRANSIENT');
      }
      if (disposition === 'deleted') {
        return knownKind &&
          row['payload'] ===
            (OUTBOX_ROW_TEMPLATE as { payload: string }).payload
          ? accepted()
          : lenient(`row with kind=${String(kind)} synced`);
      }
      return rejected(`quarantined (kind=${String(kind)})`);
    },
  },
];

describe('fuzz: SQLite repository rows → readers and outbox drain', () => {
  beforeAll(() => {
    setActiveDataOwner(OWNER);
  });
  afterAll(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    const path = run.write();
    console.info(`[fuzz rows] report: ${path}\n${run.renderMatrix()}`);
  });

  for (const surface of surfaces) {
    (run.targets(surface.name) ? it : it.skip)(
      `${surface.name}: never throws; corrupt rows are skipped or quarantined`,
      async () => {
        const summary = await run.fuzzSurface(surface);
        expect(summary.cases).toBeGreaterThan(0);
        expect(run.assertions(surface)).toEqual([]);
      },
      FUZZ_TEST_TIMEOUT_MS,
    );
  }
});
