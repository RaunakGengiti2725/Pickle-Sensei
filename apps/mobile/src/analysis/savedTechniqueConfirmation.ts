import {
  isAnalysisInputSelectionSnapshot,
  isConfirmationTimestamp,
  isVerifiedCompletedCaptureRecord,
  parseNeedsTechniqueConfirmationRecord,
  type AnalysisInputSelectionSnapshot,
  type VerifiedCompletedCaptureRecord,
  type VerifiedTechniqueConfirmationRecord,
} from '@pickle/analysis-pipeline';
import { Platform } from 'react-native';
import {
  parsePoseSequence,
  sha256Hex,
  type ModelRef,
} from '@pickle/swing-domain';
import { readCaptureArtifact, type CapturedClip } from '../camera/capture';
import type { LocalDb } from '../data/db';
import {
  assertDataOwnerContext,
  isDataOwnerContextCurrent,
  type DataOwnerContext,
} from '../data/accountScope';
import { readOfflineReceiptForOperation } from '../data/offlineCapabilities';
import {
  parseCaptureTargetSeed,
  readCaptureAnalysisSnapshot,
  type CaptureTargetSeed,
  type StoredCaptureAnalysisSnapshot,
} from '../data/repository';
import { offlineOutputSha256 } from '../data/sync';
import {
  readAnalysisJournal,
  runJournal,
  type RunJournalEntry,
} from './runJournal';

export interface SavedTechniqueConfirmation {
  captureId: string;
  clip: CapturedClip;
  record: VerifiedTechniqueConfirmationRecord;
  ownerContext: DataOwnerContext;
  apiOrigin: string;
  targetSeed: CaptureTargetSeed | null;
}

export type SavedConfirmationUnavailableReason =
  | 'missing'
  | 'legacy'
  | 'corrupt'
  | 'evidence_changed'
  | 'origin_mismatch'
  | 'account_changed'
  | 'superseded'
  | 'cancelled';

export type SavedTechniqueConfirmationLoad =
  | {
      kind: 'ready' | 'release_pending' | 'recovery_blocked';
      saved: SavedTechniqueConfirmation;
      journal: RunJournalEntry;
    }
  | {
      kind: 'already_completed';
      analysisId: string;
      resultKind: 'scored' | 'low_confidence';
      record: VerifiedCompletedCaptureRecord;
      journal: RunJournalEntry;
    }
  | {
      kind: 'unavailable';
      reason: SavedConfirmationUnavailableReason;
      clip?: CapturedClip;
    };

export interface LoadSavedTechniqueConfirmationRequest {
  db: LocalDb;
  ownerContext: DataOwnerContext;
  captureId: string;
  apiOrigin: string;
  originalAnalysisId?: string;
  requireLatest?: boolean;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}

export function isSavedCaptureId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function confirmationRecordHash(
  record: VerifiedTechniqueConfirmationRecord,
): string {
  return sha256Hex(canonicalJson(record));
}

/** A lookup address, not a new reservation key. One per immutable original. */
export function confirmationContinuationOperationId(
  ownerKey: string,
  captureId: string,
  analysisId: string,
): string {
  const definition = sha256Hex(
    JSON.stringify(['technique-confirmation-v1', analysisId.toLowerCase()]),
  );
  const hash = sha256Hex(
    JSON.stringify([
      ownerKey.toLowerCase(),
      captureId.toLowerCase(),
      definition,
    ]),
  );
  const variant = ((Number.parseInt(hash.slice(16, 17), 16) & 3) | 8).toString(
    16,
  );
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function sameConfirmationJournalIdentity(
  a: RunJournalEntry,
  b: RunJournalEntry,
): boolean {
  return (
    a.ownerKey === b.ownerKey &&
    a.ownerGeneration === b.ownerGeneration &&
    a.apiOrigin === b.apiOrigin &&
    a.operationId === b.operationId &&
    a.captureId === b.captureId &&
    a.analysisId === b.analysisId &&
    a.requestHash === b.requestHash &&
    a.reservationKey === b.reservationKey &&
    a.permitId === b.permitId
  );
}

function captureArtifactName(uri: string): string | null {
  try {
    const url = new URL(uri);
    const name = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
    return url.protocol === 'file:' &&
      !url.search &&
      !url.hash &&
      name.length > 0 &&
      !name.includes('/') &&
      !name.includes('\\')
      ? name
      : null;
  } catch {
    return null;
  }
}

export function confirmationCaptureHash(clip: CapturedClip): string {
  // iOS may relocate the app container, but that cannot authorize swapping
  // the saved video/sidecar for a differently named artifact. Poster refresh
  // is presentation-only and is not evidence of a different analysis input.
  return sha256Hex(
    canonicalJson({
      ...clip,
      uri: captureArtifactName(clip.uri),
      posterUri: undefined,
      poseSequence: clip.poseSequence
        ? {
            ...clip.poseSequence,
            uri: captureArtifactName(clip.poseSequence.uri),
          }
        : undefined,
    }),
  );
}

export function sameConfirmationTarget(
  a: CaptureTargetSeed | null | undefined,
  b: CaptureTargetSeed | null | undefined,
): boolean {
  return a == null || b == null
    ? a == null && b == null
    : a.point.x === b.point.x &&
        a.point.y === b.point.y &&
        a.selectedAtIso === b.selectedAtIso;
}

export function confirmationInputsMatch(
  selection: AnalysisInputSelectionSnapshot,
  clip: CapturedClip,
  target: CaptureTargetSeed | null | undefined,
): boolean {
  const capture = selection.capture;
  const pose = clip.poseSequence;
  if (
    !pose ||
    selection.observationHash !== pose.sha256 ||
    capture.poseFrameCount !== pose.frameCount ||
    capture.poseModelVersion !== pose.poseModelVersion ||
    capture.payloadHash !== confirmationCaptureHash(clip) ||
    capture.captureMode !== clip.captureMode ||
    capture.capturedAtIso !== clip.capturedAtIso ||
    capture.durationMs !== clip.durationMs ||
    capture.width !== clip.width ||
    capture.height !== clip.height ||
    capture.fps !== clip.fps ||
    !sameConfirmationTarget(selection.target.userSelection, target)
  )
    return false;
  const trigger = selection.trigger;
  if (clip.captureMode === 'automatic_pose_trigger') {
    if (
      trigger.startMs !== clip.trigger.startMs ||
      trigger.endMs !== clip.trigger.endMs ||
      trigger.peakMotionMs !== (clip.trigger.peakMotionMs ?? null) ||
      trigger.confidence !== clip.trigger.confidence ||
      trigger.modelVersion !== clip.trigger.modelVersion
    )
      return false;
    const tap = selection.target.guidedStartTap;
    if (
      clip.targetLock
        ? !tap ||
          tap.point.x !== clip.targetLock.tapPoint.x ||
          tap.point.y !== clip.targetLock.tapPoint.y
        : tap !== null
    )
      return false;
    const anchor = selection.target.acquiredAnchor;
    if (
      clip.targetSeed
        ? !anchor ||
          anchor.point.x !== clip.targetSeed.x ||
          anchor.point.y !== clip.targetSeed.y ||
          anchor.source !== clip.targetSeed.source
        : anchor !== null
    )
      return false;
  }
  return true;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unavailable(
  reason: SavedConfirmationUnavailableReason,
): SavedTechniqueConfirmationLoad {
  return { kind: 'unavailable', reason };
}

/** A court-offline rating never held a permit: its run keeps the unanswered
 * reservation and the receipt that spent the grant on exactly this output is
 * the durable proof of completion. */
export async function receiptPaidRun(
  db: LocalDb,
  journal: RunJournalEntry,
  result: VerifiedCompletedCaptureRecord['result'],
): Promise<boolean> {
  if (
    journal.permitId !== null ||
    journal.state !== 'release_pending' ||
    journal.releaseOutcome !== 'failed' ||
    journal.resultId !== null ||
    result.resultKind !== 'scored'
  )
    return false;
  const receipt = await readOfflineReceiptForOperation(db, journal.operationId);
  return (
    receipt !== null &&
    receipt.resultId === result.id &&
    receipt.fullOutputSha256 === offlineOutputSha256(result)
  );
}

async function completed(
  db: LocalDb,
  snapshot: StoredCaptureAnalysisSnapshot,
  record: Record<string, unknown>,
  journal: RunJournalEntry,
): Promise<SavedTechniqueConfirmationLoad> {
  const row = snapshot.recordRow;
  if (
    !row ||
    !isVerifiedCompletedCaptureRecord(record, {
      id: row.id,
      captureId: row.captureId,
      createdAtIso: row.createdAtIso,
      engineVersion: row.engineVersion,
      scoringModelVersion: row.scoringModelVersion,
    }) ||
    !isAnalysisInputSelectionSnapshot(record.inputSelection)
  )
    return unavailable('corrupt');
  const result = record.result;
  const selection = record.inputSelection;
  try {
    if (
      typeof snapshot.resultPayload !== 'string' ||
      canonicalJson(JSON.parse(snapshot.resultPayload)) !==
        canonicalJson(result)
    )
      return unavailable('corrupt');
  } catch {
    return unavailable('corrupt');
  }
  const metadata = snapshot.resultMetadata;
  if (
    metadata.capturedAtIso !== result.capturedAtIso ||
    metadata.shotType !== result.shotType ||
    metadata.sessionId !== result.sessionId ||
    metadata.overallScore !== result.overallScore ||
    metadata.analysisConfidence !== result.analysisConfidence
  )
    return unavailable('corrupt');
  const receiptPaid =
    journal.permitId === null && (await receiptPaidRun(db, journal, result));
  if (
    snapshot.status !== 'analyzed' ||
    journal.analysisId !== record.id ||
    journal.captureId !== record.captureId ||
    selection.definitionHash !== journal.requestHash ||
    selection.ownerKey !== journal.ownerKey ||
    selection.ownerGeneration !== journal.ownerGeneration ||
    selection.apiOrigin !== journal.apiOrigin ||
    (journal.permitId === null && !receiptPaid) ||
    result.resultKind !== snapshot.resultKind ||
    result.source !== snapshot.resultSource ||
    result.id !== snapshot.resultId ||
    (result.resultKind === 'scored'
      ? !receiptPaid &&
        (journal.state !== 'committed' || journal.resultId !== result.id)
      : journal.resultId !== null ||
        journal.releaseOutcome !== 'low_confidence' ||
        !['released', 'release_pending', 'terminal'].includes(journal.state))
  )
    return unavailable('corrupt');
  return {
    kind: 'already_completed',
    analysisId: journal.analysisId,
    resultKind: result.resultKind,
    record,
    journal,
  };
}

export async function loadSavedTechniqueConfirmation(
  request: LoadSavedTechniqueConfirmationRequest,
): Promise<SavedTechniqueConfirmationLoad> {
  const owner = Object.freeze({ ...request.ownerContext });
  let retainedClip: CapturedClip | undefined;
  const unavailable = (
    reason: SavedConfirmationUnavailableReason,
  ): SavedTechniqueConfirmationLoad => ({
    kind: 'unavailable',
    reason,
    ...(retainedClip &&
    isDataOwnerContextCurrent(owner) &&
    !request.signal?.aborted
      ? { clip: retainedClip }
      : {}),
  });
  const assertCurrent = () => {
    assertDataOwnerContext(owner);
    if (request.signal?.aborted)
      throw new Error('Saved confirmation load cancelled.');
    request.assertCurrent?.();
  };
  try {
    assertCurrent();
    if (
      !isSavedCaptureId(request.captureId) ||
      (request.originalAnalysisId !== undefined &&
        !isSavedCaptureId(request.originalAnalysisId))
    )
      return unavailable('missing');
    const scope = runJournal.scope({
      ownerKey: owner.ownerKey,
      apiOrigin: request.apiOrigin,
    });
    const snapshot = await readCaptureAnalysisSnapshot(
      request.db,
      owner,
      request.captureId,
      request.originalAnalysisId,
    );
    assertCurrent();
    if (!snapshot) return unavailable('missing');
    if (snapshot.capture.evidenceStatus !== 'valid' || !snapshot.capture.clip)
      return unavailable(
        snapshot.capture.evidenceStatus === 'legacy'
          ? 'legacy'
          : snapshot.capture.evidenceStatus === 'metadata_mismatch'
            ? 'evidence_changed'
            : 'corrupt',
      );
    retainedClip = snapshot.capture.clip;
    const row = snapshot.recordRow;
    if (!row) return unavailable('legacy');
    let record: unknown;
    try {
      record = typeof row.record === 'string' ? JSON.parse(row.record) : null;
    } catch {
      return unavailable('corrupt');
    }
    if (
      !object(record) ||
      record.schemaVersion !== 1 ||
      record.id !== row.id ||
      record.captureId !== row.captureId ||
      record.createdAtIso !== row.createdAtIso ||
      !isConfirmationTimestamp(record.createdAtIso) ||
      record.engineVersion !== row.engineVersion ||
      !(
        record.kind === undefined ||
        record.kind === 'analyzed' ||
        record.kind === 'needs_technique_confirmation'
      )
    )
      return unavailable('corrupt');
    const parsed =
      record.kind === 'needs_technique_confirmation'
        ? parseNeedsTechniqueConfirmationRecord(record, {
            id: row.id,
            captureId: row.captureId,
            createdAtIso: row.createdAtIso,
            engineVersion: row.engineVersion,
            scoringModelVersion: row.scoringModelVersion,
          })
        : null;
    if (parsed && !parsed.ok)
      return unavailable(
        parsed.failure.code === 'confirmation.legacy' ? 'legacy' : 'corrupt',
      );
    if (snapshot.journalApiOrigin !== scope.apiOrigin)
      return unavailable(
        snapshot.journalApiOrigin == null ? 'legacy' : 'origin_mismatch',
      );
    if (!isSavedCaptureId(snapshot.journalOperationId))
      return unavailable('corrupt');
    const journal = await readAnalysisJournal(request.db, {
      ...scope,
      operationId: snapshot.journalOperationId,
    });
    assertCurrent();
    if (
      !journal ||
      journal.captureId !== request.captureId ||
      journal.analysisId !== row.id
    )
      return unavailable('corrupt');
    if (
      (record.kind === 'needs_technique_confirmation' ||
        (request.requireLatest ?? true)) &&
      snapshot.newestRecordId !== row.id
    )
      return unavailable('superseded');
    if (record.kind !== 'needs_technique_confirmation') {
      const result = await completed(request.db, snapshot, record, journal);
      assertCurrent();
      if (result.kind !== 'already_completed') return result;
      // Completion replay needs no new inference or sidecar, but publishing
      // a newest-result lookup must still survive every intervening await.
      const latest = await readCaptureAnalysisSnapshot(
        request.db,
        owner,
        request.captureId,
        request.originalAnalysisId,
      );
      assertCurrent();
      if (!latest || canonicalJson(latest) !== canonicalJson(snapshot))
        return unavailable('evidence_changed');
      const authoritative = await readAnalysisJournal(request.db, journal);
      assertCurrent();
      if (
        !authoritative ||
        !sameConfirmationJournalIdentity(authoritative, journal)
      )
        return unavailable('corrupt');
      return await completed(request.db, latest, record, authoritative);
    }
    if (!parsed?.ok) return unavailable('corrupt');
    const original = parsed.value;
    const selection = original.inputSelection;
    if (
      selection.ownerKey !== scope.ownerKey ||
      selection.apiOrigin !== scope.apiOrigin ||
      selection.ownerGeneration !== journal.ownerGeneration ||
      selection.definitionHash !== journal.requestHash ||
      // A court-offline abstention's reservation was never answered: the
      // permit arrives when recovery finishes the release with signal.
      (journal.permitId === null && journal.state !== 'release_pending') ||
      journal.resultId !== null ||
      journal.releaseOutcome !== 'low_confidence' ||
      snapshot.resultId !== null ||
      !['released', 'release_pending', 'terminal'].includes(journal.state) ||
      snapshot.status !== 'awaiting_model'
    )
      return unavailable('corrupt');
    const target = parseCaptureTargetSeed(snapshot.rawTargetSeed);
    if (target.kind === 'corrupt') return unavailable('corrupt');
    const seed = target.kind === 'valid' ? target.seed : null;
    const clip = snapshot.capture.clip;
    if (
      snapshot.declaredStrokeRaw !== selection.declaredStroke ||
      !confirmationInputsMatch(selection, clip, seed)
    )
      return unavailable('evidence_changed');
    if (selection.target.guidedStartTap?.selectedAtIso === null)
      return unavailable('legacy');
    assertCurrent();
    let sidecar: string;
    // Native artifact reading resolves container relocation. Verify the CURRENT
    // saved reference against the immutable bytes, never revive an old URI.
    try {
      sidecar = await readCaptureArtifact(clip.poseSequence!.uri);
    } catch {
      assertCurrent();
      return unavailable('evidence_changed');
    }
    assertCurrent();
    if (sha256Hex(sidecar) !== original.observationHash)
      return unavailable('evidence_changed');
    const pose = parsePoseSequence(sidecar, {
      providerId:
        Platform.OS === 'android' ? 'pose.mediapipe' : 'pose.apple-vision',
      runtime: Platform.OS === 'android' ? 'mediapipe' : 'vision_framework',
      executionTarget: 'on_device',
      artifactHash: null,
    });
    if (!pose.ok) return unavailable('evidence_changed');
    const sequence = pose.value;
    if (
      sequence.frames.length !== selection.capture.poseFrameCount ||
      sequence.producedBy.modelVersion !== selection.capture.poseModelVersion ||
      sequence.video.width !== clip.width ||
      sequence.video.height !== clip.height ||
      sequence.video.fps !== clip.fps
    )
      return unavailable('evidence_changed');
    const triggerProducer: ModelRef = {
      providerId:
        clip.captureMode === 'automatic_pose_trigger'
          ? 'trigger.temporal-heuristic'
          : 'trigger.imported-full-clip',
      modelVersion: selection.trigger.modelVersion,
      runtime: 'deterministic',
      executionTarget: 'on_device',
      artifactHash: null,
    };
    if (
      [sequence.producedBy, triggerProducer].some(
        expected =>
          !original.provenance.providerVersions.some(
            actual =>
              actual.providerId === expected.providerId &&
              actual.modelVersion === expected.modelVersion &&
              actual.runtime === expected.runtime &&
              actual.executionTarget === expected.executionTarget &&
              actual.artifactHash === expected.artifactHash,
          ),
      )
    )
      return unavailable('corrupt');
    const latest = await readCaptureAnalysisSnapshot(
      request.db,
      owner,
      request.captureId,
      request.originalAnalysisId,
    );
    assertCurrent();
    if (!latest || canonicalJson(latest) !== canonicalJson(snapshot))
      return unavailable('evidence_changed');
    const authoritative = await readAnalysisJournal(request.db, journal);
    assertCurrent();
    if (
      !authoritative ||
      !sameConfirmationJournalIdentity(authoritative, journal) ||
      authoritative.resultId !== null ||
      authoritative.releaseOutcome !== 'low_confidence' ||
      !['released', 'release_pending', 'terminal'].includes(authoritative.state)
    )
      return unavailable('corrupt');
    const continuation = await runJournal.read(request.db, {
      ...scope,
      operationId: confirmationContinuationOperationId(
        scope.ownerKey,
        request.captureId,
        original.id,
      ),
    });
    assertCurrent();
    return {
      kind: continuation
        ? 'recovery_blocked'
        : authoritative.state === 'released'
          ? 'ready'
          : authoritative.state === 'release_pending'
            ? 'release_pending'
            : 'recovery_blocked',
      saved: {
        captureId: request.captureId,
        clip,
        record: original,
        ownerContext: owner,
        apiOrigin: scope.apiOrigin,
        targetSeed: seed,
      },
      journal: authoritative,
    };
  } catch {
    if (!isDataOwnerContextCurrent(owner))
      return unavailable('account_changed');
    if (request.signal?.aborted) return unavailable('cancelled');
    return unavailable('corrupt');
  }
}
