import {
  ENVELOPE_DIMENSIONS,
  ENVELOPE_STATUSES,
  SHOT_TYPES,
  type EnvelopeVerdict,
  type ShotTypeSlug,
} from '@pickle/shared-types';
import { isConfirmationTimestamp } from '@pickle/analysis-pipeline';
import { sha256Hex } from '@pickle/swing-domain';
import { assertCapturedClip, type CapturedClip } from '../camera/capture';
import {
  captureArtifactFileName,
  MAX_NATIVE_MEDIA_BYTES,
} from '../camera/nativeMediaIdentity';
import type { PracticeSetPlan } from './practiceSet';
import { runJournal } from './runJournal';
import { confirmationCaptureHash } from './savedTechniqueConfirmation';

export const ORIGINAL_SETTINGS_MAX_BYTES = 65_536;
export type OriginalModelDescriptor = readonly [
  string,
  string,
  string,
  string,
  string | null,
  number,
  number,
];
/** Same ordered policy definition hashed by the existing online runner. */
export type OriginalModelPolicy = readonly [
  string,
  string,
  string,
  readonly [string, string],
  OriginalModelDescriptor | null,
  OriginalModelDescriptor | null,
  OriginalModelDescriptor | null,
  OriginalModelDescriptor | null,
  OriginalModelDescriptor | null,
  OriginalModelDescriptor | null,
  OriginalModelDescriptor | null,
  readonly OriginalModelDescriptor[],
];
export interface OriginalAnalysisSnapshot {
  readonly version: 'original-analysis-v1';
  readonly ownerKey: string;
  readonly apiOrigin: string;
  readonly captureId: string;
  readonly clip: CapturedClip;
  readonly declaredStroke: ShotTypeSlug | null;
  readonly declaredCanonical: string | null;
  readonly handedness: 'right' | 'left' | 'ambidextrous';
  readonly cameraView: 'side' | 'rear_oblique';
  readonly focusCheckpoint: string | null;
  readonly targetSeed: {
    point: { x: number; y: number };
    selectedAtIso: string;
  } | null;
  readonly sessionId: string | null;
  readonly practiceSet: PracticeSetPlan | null;
  readonly appVersion: string;
  /** Missing installed policy remains missing, never filled from a later app. */
  readonly modelPolicy: OriginalModelPolicy | null;
  readonly captureEnvelope: EnvelopeVerdict | null;
}

export class OriginalAnalysisValidationError extends Error {
  constructor() {
    super('The original analysis definition is invalid or unverifiable.');
    this.name = 'OriginalAnalysisValidationError';
  }
}
function invalid(): never {
  throw new OriginalAnalysisValidationError();
}
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function originalAnalysisId(value: unknown): string {
  return typeof value === 'string' && UUID.test(value) ? value : invalid();
}
export function originalDigest(value: unknown): string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
    ? value
    : invalid();
}
const word = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$/.test(value) &&
  !/(bearer|password|credential|secret|access.token|refresh.token|api.key)/i.test(
    value,
  ) &&
  !/^eyJ[^.]*\./.test(value);
const shot = (value: unknown) =>
  value === null || SHOT_TYPES.includes(value as ShotTypeSlug);
const unit = (value: unknown) =>
  typeof value === 'number' && value >= 0 && value <= 1;
function hasControls(value: string, includeSpace = false): boolean {
  return [...value].some(
    character =>
      character.charCodeAt(0) <= (includeSpace ? 32 : 31) ||
      character.charCodeAt(0) === 127,
  );
}

/** No getters, toJSON, prototypes, sparse/extra array fields, credentials or
 * unbounded JSON may reach durable storage. This is not a permissive JSON cast. */
export function boundedOriginalData(
  value: unknown,
  maximum = ORIGINAL_SETTINGS_MAX_BYTES,
): unknown {
  let nodes = 0;
  const copy = (entry: unknown, depth: number): unknown => {
    if (++nodes > 3000 || depth > 12) return invalid();
    if (entry === null || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number')
      return Number.isFinite(entry) ? entry : invalid();
    if (typeof entry === 'string') {
      if (
        entry.length > 4096 ||
        hasControls(entry) ||
        /\bBearer\s|\b(?:access_token|refresh_token|password|client_secret)\b/i.test(
          entry,
        )
      )
        return invalid();
      return entry;
    }
    if (!entry || typeof entry !== 'object') return invalid();
    const array = Array.isArray(entry);
    if (array) {
      if (
        Object.getPrototypeOf(entry) !== Array.prototype ||
        entry.length > 128 ||
        Reflect.ownKeys(entry).length !== entry.length + 1
      )
        return invalid();
      for (let index = 0; index < entry.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(entry, String(index)))
          return invalid();
      }
    } else if (
      Object.getPrototypeOf(entry) !== Object.prototype &&
      Object.getPrototypeOf(entry) !== null
    )
      return invalid();
    const result: Record<string, unknown> | unknown[] = array ? [] : {};
    for (const key of Reflect.ownKeys(entry)) {
      if (array && key === 'length') continue;
      if (
        typeof key !== 'string' ||
        /^(?:__proto__|prototype|constructor)$/.test(key)
      )
        return invalid();
      const field = Object.getOwnPropertyDescriptor(entry, key);
      if (!field?.enumerable || !('value' in field)) return invalid();
      (result as Record<string, unknown>)[key] = copy(field.value, depth + 1);
    }
    return result;
  };
  const cloned = copy(value, 0);
  // UTF-8 size without introducing Node/Buffer into React Native.
  const json = JSON.stringify(cloned);
  if (encodeURIComponent(json).replace(/%[A-F0-9]{2}/g, 'x').length > maximum)
    return invalid();
  return cloned;
}
function object(
  value: unknown,
  allowed: string[],
  required: string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).some(key => !allowed.includes(key)) ||
    required.some(key => !(key in data))
  )
    return invalid();
  return data;
}
const fields = (value: unknown, keys: string) => object(value, keys.split(' '));
function fileName(value: unknown): string {
  if (typeof value !== 'string') return invalid();
  return captureArtifactFileName(value) ?? invalid();
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function originalCanonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(originalCanonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        key =>
          `${JSON.stringify(key)}:${originalCanonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}
export function originalSettingsHash(
  snapshot: OriginalAnalysisSnapshot,
): string {
  return sha256Hex(originalCanonicalJson(snapshot));
}
export function originalModelPolicyHash(
  policy: OriginalModelPolicy | null,
): string | null {
  return policy === null ? null : sha256Hex(JSON.stringify(policy));
}

/** Exact existing v1 execution definition, shared rather than changing hashes
 * of saved confirmations. Original-operation settings additionally bind app,
 * session/practice and native creation expectation through settingsHash. The
 * metadata component is NOT a movie-byte verification. */
export function captureExecutionDefinitionHash(
  request: {
    clip: CapturedClip;
    declaredStroke: ShotTypeSlug | null;
    declaredCanonical?: string | null;
    handedness: OriginalAnalysisSnapshot['handedness'];
    cameraView: OriginalAnalysisSnapshot['cameraView'];
    focusCheckpoint?: string | null;
    targetSeed?: OriginalAnalysisSnapshot['targetSeed'];
    techniqueConfirmation?: { analysisId: string };
    captureEnvelope?: EnvelopeVerdict | null;
  },
  modelPolicyHash: string,
  observationHash: string,
): string {
  const { clip } = request;
  return sha256Hex(
    JSON.stringify({
      protocol: 'legacy-online-analysis-1',
      observationHash,
      capturePayloadHash: confirmationCaptureHash(clip),
      capture: [
        clip.captureMode,
        clip.capturedAtIso,
        clip.durationMs,
        clip.width,
        clip.height,
        clip.fps,
      ],
      trigger:
        clip.captureMode === 'automatic_pose_trigger'
          ? [
              clip.trigger.startMs,
              clip.trigger.endMs,
              clip.trigger.peakMotionMs ?? null,
              clip.trigger.confidence,
              clip.trigger.modelVersion,
            ]
          : null,
      intent: [
        request.declaredStroke,
        request.declaredCanonical ?? null,
        request.handedness,
        request.cameraView,
        request.focusCheckpoint ?? null,
        request.targetSeed?.point.x ?? null,
        request.targetSeed?.point.y ?? null,
        request.targetSeed?.selectedAtIso ?? null,
      ],
      confirmationOf: request.techniqueConfirmation?.analysisId ?? null,
      envelope: request.captureEnvelope ?? null,
      modelPolicyHash,
    }),
  );
}

export function assertOriginalClip(value: unknown): CapturedClip {
  const data = boundedOriginalData(value);
  const clip = fields(
    data,
    'uri durationMs fps width height byteSize nativeMediaIdentity capturedAtIso recognition posterUri captureMode trigger targetSeed targetLock captureEvidence ballSpeed preRollMs postRollMs poseSequence completion',
  );
  for (const key of ['uri', 'posterUri'])
    if (clip[key] !== undefined) fileName(clip[key]);
  fields(clip.recognition, 'status shotType confidence modelVersion reason');
  fields(
    clip.ballSpeed,
    'status reason milesPerHour metersPerSecond confidence source calibrationId trackerModelVersion measurementFrameRate trackPointCount trackedDistanceMeters trackedDurationMs reprojectionErrorPx',
  );
  if (clip.trigger !== undefined)
    fields(
      clip.trigger,
      'startMs endMs peakMotionMs confidence source modelVersion',
    );
  if (clip.targetSeed !== undefined) fields(clip.targetSeed, 'x y source');
  if (clip.poseSequence !== undefined) {
    const pose = fields(
      clip.poseSequence,
      'schemaVersion format uri frameCount sha256 coordinateSystem poseModelVersion',
    );
    fileName(pose.uri);
    if (
      typeof pose.frameCount !== 'number' ||
      pose.frameCount > 4000 ||
      !word(pose.poseModelVersion)
    )
      return invalid();
  }
  if (clip.captureEvidence !== undefined) {
    const evidence = fields(
      clip.captureEvidence,
      'schemaVersion window poseSource poseModelVersion triggerAlgorithmVersion motionUnit analysisInputFrameCount poseFrameCount poseMissingFrameCount trackedDurationMs meanCanonicalJointVisibility meanJointCoverage minimumJointCoverage fullBodyVisibleFrameCount jointMotion',
    );
    if (!Array.isArray(evidence.jointMotion)) return invalid();
    for (const item of evidence.jointMotion)
      fields(
        item,
        'joint sampleCount meanNormalizedPerSecond peakNormalizedPerSecond',
      );
  }
  if (clip.targetLock !== undefined) {
    const lock = fields(
      clip.targetLock,
      'schemaVersion algorithmVersion coordinateSystem tapPoint lockOutcome lockSource lockTorso tapToLockDistance timeToLockMs ambiguityEntered ambiguityDurationMs params',
    );
    fields(lock.tapPoint, 'x y');
    if (lock.lockTorso !== undefined) fields(lock.lockTorso, 'x y');
    fields(
      lock.params,
      'startRegionRadius occupancyFramesToLock sustainedGestureFrames ambiguityTimeoutMs gestureElevationThreshold',
    );
  }
  if (clip.completion !== undefined) {
    const completion = fields(
      clip.completion,
      'schemaVersion completionStrategy algorithmVersion motionUnit movementCompleteMs anchorMs finalizeMs peakMotionValue settleDetectedMs valleyDetectedMs safetyMaxHit observedUntilMs observedSampleCount params postCompletionMotion',
    );
    fields(
      completion.params,
      'settleFloorPerSecond settlePeakFraction settleHoldMs minFollowThroughMs safetyMaxMs valleyDipFraction valleyRiseRatio valleyRiseMinGapMs',
    );
    if (!Array.isArray(completion.postCompletionMotion)) return invalid();
    for (const item of completion.postCompletionMotion) fields(item, 'tMs v');
  }
  const parsed = assertCapturedClip(data);
  if (
    parsed.durationMs > 60_000 ||
    parsed.width > 16384 ||
    parsed.height > 16384 ||
    parsed.fps > 1000 ||
    (parsed.byteSize !== undefined &&
      parsed.byteSize > MAX_NATIVE_MEDIA_BYTES) ||
    !isConfirmationTimestamp(parsed.capturedAtIso)
  )
    return invalid();
  // Reject credential-shaped/free-form payload strings even on known fields.
  const checkStrings = (entry: unknown, key = ''): void => {
    if (
      typeof entry === 'string' &&
      !['uri', 'posterUri', 'capturedAtIso'].includes(key) &&
      !word(entry)
    )
      invalid();
    if (entry && typeof entry === 'object')
      for (const [childKey, child] of Object.entries(entry))
        checkStrings(child, childKey);
  };
  checkStrings(parsed);
  return freeze(parsed);
}

export function assertOriginalEnvelope(value: unknown): EnvelopeVerdict | null {
  if (value === null) return null;
  const data = boundedOriginalData(value);
  const keys =
    'thresholdsVersion provisional dimensions overall overallWithCoverage notMeasured'.split(
      ' ',
    );
  const envelope = object(data, keys, keys);
  if (
    !word(envelope.thresholdsVersion) ||
    typeof envelope.provisional !== 'boolean' ||
    !Array.isArray(envelope.dimensions) ||
    envelope.dimensions.length > ENVELOPE_DIMENSIONS.length ||
    !Array.isArray(envelope.notMeasured) ||
    !['SUPPORTED', 'DEGRADED', 'UNSUPPORTED'].includes(
      String(envelope.overall),
    ) ||
    !['SUPPORTED', 'SUPPORTED_UNMEASURED', 'DEGRADED', 'UNSUPPORTED'].includes(
      String(envelope.overallWithCoverage),
    )
  )
    return invalid();
  const seen = new Set<unknown>();
  const missing: unknown[] = [];
  for (const item of envelope.dimensions) {
    const dimensionKeys = 'dimension status measured unit thresholdId'.split(
      ' ',
    );
    const dimension = object(item, dimensionKeys, dimensionKeys);
    if (
      !ENVELOPE_DIMENSIONS.includes(dimension.dimension as never) ||
      seen.has(dimension.dimension) ||
      !ENVELOPE_STATUSES.includes(dimension.status as never) ||
      typeof dimension.unit !== 'string' ||
      dimension.unit.length > 80 ||
      !word(dimension.thresholdId) ||
      (dimension.status === 'NOT_MEASURED'
        ? dimension.measured !== null
        : typeof dimension.measured !== 'number')
    )
      return invalid();
    seen.add(dimension.dimension);
    if (dimension.status === 'NOT_MEASURED') missing.push(dimension.dimension);
  }
  if (
    envelope.notMeasured.length !== missing.length ||
    new Set(envelope.notMeasured).size !== missing.length ||
    envelope.notMeasured.some(item => !missing.includes(item))
  )
    return invalid();
  return freeze(data as EnvelopeVerdict);
}
function assertPolicy(value: unknown): OriginalModelPolicy | null {
  if (value === null) return null;
  if (
    !Array.isArray(value) ||
    value.length !== 12 ||
    !value.slice(0, 3).every(word) ||
    !Array.isArray(value[3]) ||
    value[3].length !== 2 ||
    !value[3].every(word) ||
    !Array.isArray(value[11]) ||
    value[11].length > 16
  )
    return invalid();
  const descriptor = (entry: unknown): boolean =>
    Array.isArray(entry) &&
    entry.length === 7 &&
    entry.slice(0, 4).every(word) &&
    (entry[4] === null ||
      (typeof entry[4] === 'string' && /^[a-f0-9]{64}$/.test(entry[4]))) &&
    entry.slice(5).every(number => Number.isSafeInteger(number) && number > 0);
  if (
    !value.slice(4, 11).every(entry => entry === null || descriptor(entry)) ||
    !value[11].every(descriptor)
  )
    return invalid();
  return value as unknown as OriginalModelPolicy;
}

export function assertOriginalAnalysisSnapshot(
  value: unknown,
): OriginalAnalysisSnapshot {
  const data = boundedOriginalData(value);
  const keys =
    'version ownerKey apiOrigin captureId clip declaredStroke declaredCanonical handedness cameraView focusCheckpoint targetSeed sessionId practiceSet appVersion modelPolicy captureEnvelope'.split(
      ' ',
    );
  const snapshot = object(data, keys, keys);
  if (snapshot.version !== 'original-analysis-v1') return invalid();
  const ownerKey = originalAnalysisId(snapshot.ownerKey);
  originalAnalysisId(snapshot.captureId);
  const scope = runJournal.scope({
    ownerKey,
    apiOrigin: snapshot.apiOrigin as string,
  });
  if (
    scope.apiOrigin !== snapshot.apiOrigin ||
    !shot(snapshot.declaredStroke) ||
    !(
      snapshot.declaredCanonical === null || word(snapshot.declaredCanonical)
    ) ||
    (snapshot.declaredStroke === null && snapshot.declaredCanonical !== null) ||
    !['right', 'left', 'ambidextrous'].includes(String(snapshot.handedness)) ||
    !['side', 'rear_oblique'].includes(String(snapshot.cameraView)) ||
    !(snapshot.focusCheckpoint === null || word(snapshot.focusCheckpoint)) ||
    !word(snapshot.appVersion)
  )
    return invalid();
  if (snapshot.sessionId !== null) originalAnalysisId(snapshot.sessionId);
  if (snapshot.targetSeed !== null) {
    const target = object(
      snapshot.targetSeed,
      ['point', 'selectedAtIso'],
      ['point', 'selectedAtIso'],
    );
    const point = object(target.point, ['x', 'y'], ['x', 'y']);
    if (
      !unit(point.x) ||
      !unit(point.y) ||
      !isConfirmationTimestamp(target.selectedAtIso)
    )
      return invalid();
  }
  snapshot.clip = assertOriginalClip(snapshot.clip);
  if (
    (snapshot.clip as CapturedClip).captureMode === 'automatic_pose_trigger' &&
    snapshot.targetSeed !== null
  )
    return invalid();
  if (snapshot.practiceSet !== null) {
    const planKeys =
      'sessionId resumed shotType startedAtIso nowIso owner'.split(' ');
    const plan = object(snapshot.practiceSet, planKeys, planKeys);
    if (
      originalAnalysisId(plan.sessionId) !== snapshot.sessionId ||
      plan.owner !== ownerKey ||
      typeof plan.resumed !== 'boolean' ||
      !shot(plan.shotType) ||
      !isConfirmationTimestamp(plan.startedAtIso) ||
      !isConfirmationTimestamp(plan.nowIso) ||
      Date.parse(plan.nowIso as string) <
        Date.parse(plan.startedAtIso as string)
    )
      return invalid();
  }
  snapshot.modelPolicy = assertPolicy(snapshot.modelPolicy);
  snapshot.captureEnvelope = assertOriginalEnvelope(snapshot.captureEnvelope);
  return freeze(snapshot as unknown as OriginalAnalysisSnapshot);
}

/** Allows app-container relocation, not file replacement or new native hashes.
 * An extracted sidecar may be added only if none existed at preparation. */
export function originalClipMatches(
  original: CapturedClip,
  current: CapturedClip,
): boolean {
  const address = (clip: CapturedClip, omitPose: boolean) => {
    const copy: Record<string, unknown> = { ...clip, uri: fileName(clip.uri) };
    delete copy.posterUri;
    if (omitPose) delete copy.poseSequence;
    else if (clip.poseSequence)
      copy.poseSequence = {
        ...clip.poseSequence,
        uri: fileName(clip.poseSequence.uri),
      };
    return originalCanonicalJson(copy);
  };
  return (
    address(original, original.poseSequence === undefined) ===
    address(current, original.poseSequence === undefined)
  );
}
