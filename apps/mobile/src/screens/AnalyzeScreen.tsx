import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  Image,
  Modal,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import {
  useNavigation,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Button, PressableScale, ScreenHeader } from '../design/components';
import { Icon, type IconName } from '../design/icons';
import {
  MascotMoment,
  MascotStage,
  type MascotPose,
} from '../design/MascotMoment';
import { color, radius, space, type } from '../design/tokens';
import {
  cancelCameraOperation,
  captureStrokeVideo,
  extractImportedPoseSequence,
  importedPoseExtractionAvailable,
  importStrokeVideo,
  subscribeToCameraEvents,
  type CameraEvent,
  type CameraOperationOptions,
  type CameraReadinessState,
  type CapturedClip,
} from '../camera/capture';
import { CaptureEvidenceCard } from '../camera/CaptureEvidenceCard';
import { CaptureGuidancePanel } from '../camera/CaptureGuidancePanel';
import {
  attemptCaptureEnvelope,
  createAttemptEvidenceBuffer,
  liveCaptureEnvelope,
  qualityBlockedMessage,
} from '../camera/captureEnvelope';
import type { EnvelopeVerdict } from '@pickle/shared-types';
import { TargetSelector, type TargetSelection } from '../camera/TargetSelector';
import { getDb } from '../data/db';
import {
  captureDataOwnerContext,
  getDataOwnerSnapshot,
  subscribeToDataOwner,
  isDataOwnerContextCurrent,
  type DataOwnerContext,
} from '../data/accountScope';
import { forDataOwner } from '../data/transactions';
import { triggerOutboxSync } from '../data/syncRuntime';
import {
  savePendingCapture,
  updateCaptureClipPayload,
  setCaptureTargetSeed,
  setDeclaredStroke,
} from '../data/repository';
import {
  prepareOriginalCaptureAnalysis,
  reconcileOriginalCaptureAnalysis,
  runCaptureAnalysis,
  runOriginalCaptureAnalysis,
  type RunCaptureAnalysisOutcome,
  type RunCaptureAnalysisRequest,
} from '../analysis/runCaptureAnalysis';
import {
  OriginalAnalysisExecution,
  originalAnalysisOperations,
  type OriginalAnalysisOperation,
  type SavedOriginalAnalysisEntry,
} from '../analysis/originalAnalysisOperations';
import { planPracticeSet, type PracticeSetPlan } from '../analysis/practiceSet';
import { getApiSession, subscribeToApiSession } from '../account/apiSession';
import { getRuntimePublicConfig } from '../config/runtimeConfig';
import { useAppStore } from '../state/appStore';
import { useAccessStore } from '../state/accessStore';
import { makeUuid } from '../util/uuid';
import {
  SHOT_TYPES,
  type ShotTypeSlug,
  type TechniqueIntent,
} from '@pickle/shared-types';
import {
  isDeclaredTechniqueIntent,
  isAnalysisInputSelectionSnapshot,
  type CaptureAnalysisRecord,
  type NeedsTechniqueConfirmationRecord,
} from '@pickle/analysis-pipeline';
import { TechniqueIntentPicker } from '../flow/TechniqueIntentPicker';
import type { RootStackParams } from '../navigation/params';
import { StrokeResultAnalyzing } from '../components/StrokeResult';
import {
  analysisStageProgress,
  extractionProgress,
  observeExtractionProgress,
  type AnalysisProgressUi,
  type ExtractionEtaState,
} from '../components/AnalysisProgress';
import {
  OfflineAllocationCard,
  useOfflineJourneyOnFocus,
} from '../components/OfflineAllocationCard';
import {
  clearTryAgainHandoff,
  consumeTryAgainHandoff,
  techniqueIntentFromHandoff,
} from './tryAgainHandoff';
import { usabilityFunnel } from '../analysis/usabilityTelemetry';
import { stabilitySlo } from '../analysis/stabilityTelemetry';
import { reportScoredAnalysisForReview } from '../review/appStoreReview';

import {
  isSavedCaptureId,
  type SavedTechniqueConfirmation,
} from '../analysis/savedTechniqueConfirmation';
import { runJournal } from '../analysis/runJournal';

export type { SavedTechniqueConfirmation } from '../analysis/savedTechniqueConfirmation';

/** A token-free address, not authorization to create another attempt. */
interface SavedOriginalAnalysis {
  readonly operationId: string;
  readonly captureId: string;
  readonly ownerContext: DataOwnerContext;
  readonly apiOrigin: string;
}

function createOriginalAnalysisExecution(
  owner: DataOwnerContext,
  apiOrigin: string,
  signal: AbortSignal,
): OriginalAnalysisExecution {
  return new OriginalAnalysisExecution(owner, apiOrigin, signal);
}

function currentAnalysisService(): string | null {
  const session = getApiSession();
  if (!session) return null;
  try {
    return JSON.stringify(
      runJournal.scope({
        ownerKey: session.canonicalAppUserId,
        apiOrigin: session.apiBaseUrl,
      }),
    );
  } catch {
    return 'unavailable';
  }
}

function executionIsCurrent(
  execution: OriginalAnalysisExecution | null,
): boolean {
  try {
    execution?.assertCurrent();
    return true;
  } catch {
    return false;
  }
}

type Phase =
  | { kind: 'ready' }
  | { kind: 'working'; message: string }
  | {
      kind: 'saved';
      clip: CapturedClip;
      captureId: string;
      ownerContext: DataOwnerContext;
    }
  | {
      kind: 'analyzed';
      analysisId: string;
      presentation: StrokeIntentPresentation;
    }
  | {
      kind: 'needs_technique_confirmation';
      analysisId: string;
      record: NeedsTechniqueConfirmationRecord;
      clip: CapturedClip;
      captureId: string;
      ownerContext: DataOwnerContext;
      targetSeed: TargetSelection | null;
      apiOrigin: string;
      confirmationStatus: 'ready' | 'release_pending' | 'recovery_blocked';
      errorMessage?: string;
      paywallRequired?: boolean;
      uncertainContinuation?: boolean;
    }
  | {
      /** Scored run that consumed the LAST free rating: upgrade prompt. */
      kind: 'free_limit';
      analysisId: string;
    }
  | {
      kind: 'error';
      message: string;
      stage: 'capture' | 'analysis';
      recovery:
        | 'retry'
        | 'upgrade'
        | 'review_saved'
        | 'retry_saved'
        | 'reconcile_saved';
      original?: SavedOriginalAnalysis;
      /** Exact durable attempt displayed by this error, never a new key. */
      predecessorAttemptId?: string;
      canStartAnotherClip?: boolean;
      savedCapture?: {
        captureId: string;
        clip: CapturedClip;
        ownerContext: DataOwnerContext;
      };
    };

/** The four poses left after onboarding and deletion each own one analysis
 * role. Reusing a role on closely related states keeps the mascot language
 * coherent instead of turning every screen into a sticker collection. */
export const ANALYSIS_MASCOT_POSES = {
  ready: 'forehand',
  working: 'sprint',
  recovery: 'lunge',
  outcome: 'reach',
} satisfies Record<string, MascotPose>;

export const READINESS_COPY: Record<CameraReadinessState, string> = {
  no_person: 'Step fully into frame',
  full_body_required: 'Keep your whole body visible',
  move_closer: 'Move a little closer',
  move_farther: 'Take one step back',
  hold_still: 'Hold still while the camera locks on',
  ready: 'Ready — swing when comfortable',
};

const UNKNOWN_REASON_COPY: Record<string, string> = {
  validated_classifier_unavailable:
    'A validated pickleball stroke classifier is not installed in this build. The real clip is saved, but no stroke name or score was invented.',
  no_stroke_detected:
    'The camera did not find a complete stroke window. This did not use a rating.',
  unsupported_stroke:
    'The motion is outside the currently validated stroke set. This did not use a rating.',
};

function StepRow(props: {
  index: string;
  title: string;
  detail: string;
  icon: IconName;
}) {
  return (
    <View style={styles.stepRow}>
      <View style={styles.stepIcon}>
        <Icon name={props.icon} color={color.onDark} size={19} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[type.micro, styles.stepIndex]}>{props.index}</Text>
        <Text style={[type.bodyBold, styles.stepTitle]}>{props.title}</Text>
        <Text style={[type.caption, styles.stepDetail]}>{props.detail}</Text>
      </View>
    </View>
  );
}

/**
 * The player-outline template the native camera overlays while composing
 * (the same 130x240 figure ships in the iOS asset catalog as
 * CaptureSilhouette), so the landing previews exactly what the camera shows.
 */
const CAPTURE_SILHOUETTE = require('../../assets/capture/silhouette.png');

// Camera-mock geometry, in points. The outline keeps the template's 130:240
// aspect and the brackets enclose it with a small margin — the same
// "corners + outline read as one guide" composition the live camera draws
// (PoseOverlayView.fixedFramingGuidePath around the silhouette frame).
const PREVIEW_HEIGHT = 336;
const SILHOUETTE_HEIGHT = 168;
const SILHOUETTE_WIDTH = Math.round((SILHOUETTE_HEIGHT * 130) / 240);
const FRAME_WIDTH = SILHOUETTE_WIDTH + 2 * space.xl;
const FRAME_HEIGHT = SILHOUETTE_HEIGHT + 2 * space.sm;
// The brackets start under the status card, exactly as the live camera lays
// its guide band out between the status card and the shutter row.
const FRAME_TOP = 74;
const BRACKET_STROKE = 2.5;
/** Mirrors the camera's cornerPath: min(28, 0.18 x the shorter side). */
const BRACKET_LEG = Math.min(28, Math.min(FRAME_WIDTH, FRAME_HEIGHT) * 0.18);
const SHUTTER_RING = 54;
const SHUTTER_CORE = 40;

/** Four L-shaped corner brackets around a rect, inset so round caps stay
 * inside the drawing box. Same corner geometry as the native framing guide. */
function cornerBracketPath(
  width: number,
  height: number,
  leg: number,
  inset: number,
): string {
  const left = inset;
  const top = inset;
  const right = width - inset;
  const bottom = height - inset;
  return (
    `M${left} ${top + leg}V${top}H${left + leg}` +
    `M${right - leg} ${top}H${right}V${top + leg}` +
    `M${right} ${bottom - leg}V${bottom}H${right - leg}` +
    `M${left + leg} ${bottom}H${left}V${bottom - leg}`
  );
}

/**
 * Decorative mock of the live camera's setup state, in the camera's own
 * chrome language: the left-aligned glass status card (dot + kicker + one
 * instruction), framing brackets around the translucent player outline in
 * the band below it, and the record shutter (chalk ring, volt core). One
 * accessible element — nothing inside is interactive.
 */
function CameraMockPreview() {
  return (
    <View
      style={styles.preview}
      accessible
      accessibilityRole="image"
      accessibilityLabel="Camera preview: line up with the player outline, tap record and swing"
    >
      <View style={styles.previewFrame}>
        <Svg
          width={FRAME_WIDTH}
          height={FRAME_HEIGHT}
          viewBox={`0 0 ${FRAME_WIDTH} ${FRAME_HEIGHT}`}
          style={styles.previewBrackets}
        >
          <Path
            d={cornerBracketPath(
              FRAME_WIDTH,
              FRAME_HEIGHT,
              BRACKET_LEG,
              BRACKET_STROKE / 2,
            )}
            stroke={color.mint}
            strokeWidth={BRACKET_STROKE}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
        <Image
          source={CAPTURE_SILHOUETTE}
          resizeMode="contain"
          style={styles.previewSilhouette}
        />
      </View>
      <View style={styles.previewStatus}>
        <View style={styles.previewStatusKicker}>
          <View style={styles.previewStatusDot} />
          <Text style={[type.micro, { color: color.mint }]}>SET UP</Text>
        </View>
        <Text style={[type.caption, styles.previewStatusDetail]}>
          Match the outline, then tap record
        </Text>
      </View>
      <View style={styles.previewShutterRow}>
        <View style={styles.previewShutterRing}>
          <View style={styles.previewShutterCore} />
        </View>
      </View>
    </View>
  );
}

/**
 * The guided-capture walkthrough, as data so the zero-handholding protocol
 * (docs/USABILITY_ZERO_HANDHOLDING.md) can assert every funnel task the
 * user must perform unaided has an on-screen instruction. Order matters:
 * it is the order the user acts in — prop the phone, tap record, walk out
 * and set up until the copy reads Ready, swing once (the swing ends the clip
 * itself; the stop button is the fallback that analyzes the strongest swing
 * already recorded). There is no start spot to tap.
 */
export const ANALYZE_STEPS: ReadonlyArray<{
  index: string;
  icon: IconName;
  title: string;
  detail: string;
}> = [
  {
    index: '01',
    icon: 'person',
    title: 'Frame the court side-on',
    detail:
      'Prop the phone at waist height, side-on to your swing, with the whole outline inside the corners.',
  },
  {
    index: '02',
    icon: 'camera',
    title: 'Tap record to start',
    detail:
      'Tap the record button, then walk out and line your body up with the outline — the skeleton locks on as soon as you are in view.',
  },
  {
    index: '03',
    icon: 'stroke',
    title: 'Set up until it reads Ready',
    detail:
      'Big on-screen copy tells you to step in, move closer or set your feet — readable from the court. A swing counts even before it says Ready.',
  },
  {
    index: '04',
    icon: 'court',
    title: 'Make one natural stroke',
    detail:
      'Your swing is captured automatically and ends the recording by itself — two seconds before, 1.5 after. Missed? Tap stop and the strongest swing in the last 15 seconds is analyzed.',
  },
];

const STROKE_LABELS: Record<ShotTypeSlug, string> = {
  serve: 'Serve',
  return: 'Return',
  forehand_drive: 'Forehand drive',
  backhand_drive: 'Backhand drive',
  third_shot_drop: 'Third-shot drop',
  dink: 'Dink',
  volley: 'Volley',
  overhead: 'Overhead',
};

/**
 * Stroke declaration — the user's statement of intent, stored separately
 * from any model prediction. Every ShotTypeSlug is selectable and scoreable.
 */
function StrokeDeclaration(props: {
  value: ShotTypeSlug | null;
  onChange: (value: ShotTypeSlug) => void;
  dark?: boolean;
}) {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel="Which stroke are you practicing?"
      style={styles.strokeChips}
    >
      {SHOT_TYPES.map(slug => {
        const selected = props.value === slug;
        return (
          <PressableScale
            key={slug}
            accessibilityRole="radio"
            accessibilityLabel={STROKE_LABELS[slug]}
            accessibilityState={{ selected }}
            onPress={() => props.onChange(slug)}
            style={[
              styles.strokeChip,
              props.dark && styles.strokeChipDark,
              selected && styles.strokeChipSelected,
            ]}
          >
            <Text
              style={[
                type.caption,
                styles.strokeChipLabel,
                props.dark && !selected && { color: color.onDarkMuted },
                selected && { color: color.onVolt },
              ]}
            >
              {STROKE_LABELS[slug]}
            </Text>
          </PressableScale>
        );
      })}
    </View>
  );
}

/**
 * Saved-phase scoring gate.
 *
 * - Guided captures ('automatic_pose_trigger') are scorable only when the
 *   recorded pose-sequence sidecar exists: analysis runs exclusively on that
 *   real recording, so legacy pose-less captures stay honestly unscorable.
 * - Imported videos always enter the scoring flow. They carry no live target
 *   lock from camera setup, so the user seeds target identity by tapping
 *   themselves on the clip before analysis is attempted.
 */
export function clipSupportsScoring(clip: CapturedClip): boolean {
  if (clip.captureMode === 'imported_video') return true;
  return clip.poseSequence !== undefined;
}

/**
 * Imported clips only: once the stroke is declared and no target seed has
 * been confirmed yet, the tap-the-person selector must run (or be explicitly
 * skipped). Guided captures never need it — their seed was locked live in
 * the camera.
 */
export function importedClipNeedsTargetTap(
  clip: CapturedClip,
  declaredStroke: ShotTypeSlug | null,
  targetSeed: TargetSelection | null,
): boolean {
  return (
    clip.captureMode === 'imported_video' &&
    declaredStroke !== null &&
    targetSeed === null
  );
}

/**
 * AUTO DETECT admission gate. A declared-null analysis is allowed ONLY when
 * the user explicitly armed Auto Detect ({source:'auto'} — distinguishable
 * from "nothing selected") AND the clip is a guided capture with a recorded
 * pose sequence. Imported videos stay declared-only: their pose sequence
 * exists only after the on-demand extraction pass, so offering AUTO there
 * would promise a read this flow cannot guarantee before it starts.
 */
export function canAutoScoreWithoutDeclaration(
  clip: CapturedClip,
  intent: TechniqueIntent | null,
): boolean {
  return (
    intent?.source === 'auto' &&
    clip.captureMode === 'automatic_pose_trigger' &&
    clip.poseSequence !== undefined
  );
}

export interface StrokeIntentPresentation {
  eyebrow: string;
  tone: 'good' | 'warn';
  title: string;
  body: string;
  /** A ShotAnalysis exists locally, so the Result screen can open it. */
  showResult: boolean;
}

/**
 * Honest outcome surface for the strokeIntent envelope every capture
 * analysis now carries. Returns null ONLY for the unchanged legacy path —
 * a declared run whose classifier raised no disagreement — which keeps
 * navigating straight to the Result screen exactly as before.
 *
 * declared/predicted stay separate everywhere: this surface REPORTS the
 * envelope (family-level reads, abstentions, disagreements); it never
 * relabels the analysis.
 */
export function strokeIntentPresentation(
  record: CaptureAnalysisRecord,
): StrokeIntentPresentation | null {
  const intent = record.strokeIntent;
  const hasResult = record.result !== null;
  if (record.kind === 'needs_technique_confirmation') {
    const side = intent.predictedStroke?.label;
    return {
      eyebrow: 'RATING NOT CONSUMED',
      tone: 'warn',
      title:
        record.confirmationReason === 'family_only'
          ? `Auto-detected: ${side} (family)`
          : 'Confirm the technique for this capture.',
      body:
        record.confirmationReason === 'family_only'
          ? 'A swing family cannot choose between a dink, drive, or volley. Choose the exact technique for this same saved capture. No score was created and this did not use a rating.'
          : 'An exact technique could not be established for scoring. Choose the technique you intended for this same saved capture. The original prediction stays recorded separately; this did not use a rating.',
      showResult: false,
    };
  }
  switch (intent.resolutionBasis) {
    case 'abstained':
      return {
        eyebrow: 'RATING NOT CONSUMED',
        tone: 'warn',
        title: 'We couldn’t identify this stroke — result withheld.',
        body:
          'The classifier read the motion but would not commit to a stroke, ' +
          'so no label or score was invented and this did not use a rating. ' +
          'Re-record with your full body and paddle side clearly in frame, ' +
          'or declare the technique to analyze this capture.',
        showResult: hasResult,
      };
    case 'predicted_family': {
      const side = intent.predictedStroke?.label ?? 'UNKNOWN';
      return {
        eyebrow: 'AUTO-DETECTED · RATING NOT CONSUMED',
        tone: 'good',
        title: `Auto-detected: ${side} (family)`,
        body:
          `The camera committed to the ${side.toLowerCase()} swing family, ` +
          'not to an exact stroke — but this attempt couldn’t be measured ' +
          'cleanly enough to score, so no score was invented and this did ' +
          'not use a rating. Re-record with your full body in frame, or ' +
          'declare the technique for a stroke-specific read.',
        showResult: hasResult,
      };
    }
    case 'predicted_l3': {
      const label =
        intent.predictedStroke?.leaf ??
        record.result?.shotType.replace(/_/g, ' ') ??
        'stroke';
      return {
        eyebrow: 'AUTO-DETECTED',
        tone: 'good',
        title: `Auto-detected: ${label}`,
        body:
          'The classifier committed to this exact stroke, and the full ' +
          'technique analysis ran on it. The prediction is stored as a ' +
          'prediction — separate from anything you declare, never rewritten.',
        showResult: hasResult,
      };
    }
    case 'declared': {
      if (!intent.disagreement) return null;
      const declared = intent.disagreement.declared.replace(/_/g, ' ');
      return {
        eyebrow: 'DECLARED VS OBSERVED',
        tone: 'warn',
        title: `You declared ${declared} — the camera read ${intent.disagreement.predictedLabel}.`,
        body:
          `Your declaration was kept: scoring and coaching targets ran on ` +
          `${declared}. The classifier’s different read is recorded beside ` +
          'it — neither ever silently overwrites the other.',
        showResult: hasResult,
      };
    }
  }
}

/**
 * Honest copy for a failed imported-video pose extraction. The two frozen
 * native rejection codes get actionable product copy; anything else surfaces
 * its real message rather than an invented cause. Nothing is rated on any of
 * these paths.
 */
export function importedPoseExtractionFailureMessage(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
  if (code === 'camera.import_too_long') {
    return (
      'This video is too long to analyze. Trim it to the single stroke — ' +
      'a few seconds around the swing — and import it again.'
    );
  }
  if (code === 'camera.import_no_person') {
    return (
      'No person could be tracked in this video, so it cannot be scored. ' +
      'Use a clip where the player is clearly visible for the whole swing.'
    );
  }
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : 'Reading player movement from this video failed.';
}

/** The rejection code both native bridges emit when the user backs out of
 * the guided camera or the video picker. */
const CAMERA_USER_CANCELLED_CODE = 'camera.cancelled';

/**
 * True only for a rejection the native bridge typed as a user cancel. Every
 * other capture rejection is a real failure — including ones whose message
 * happens to contain "cancel" (AVFoundation/Vision word interrupted sessions
 * that way) — and must reach the error surface.
 */
export function isUserCancelledCapture(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === CAMERA_USER_CANCELLED_CODE
  );
}

/** Start-region lock outcome for the funnel's T4 (select starting location). */
export function captureSavedDetail(clip: CapturedClip): string {
  if (clip.captureMode !== 'automatic_pose_trigger') return 'imported';
  if (clip.targetLock) return clip.targetLock.lockOutcome;
  return clip.targetSeed ? 'start_tapped' : 'no_start_tap';
}

function clipTitle(clip: CapturedClip) {
  if (clip.recognition.status !== 'recognized')
    return 'Captured. Label withheld.';
  return clip.recognition.shotType.replace(/_/g, ' ');
}

function clipExplanation(clip: CapturedClip) {
  if (clip.recognition.status === 'recognized') {
    return (
      'Recognized by the on-device camera. Get your score to see the full ' +
      'technique read.'
    );
  }
  return (
    UNKNOWN_REASON_COPY[clip.recognition.reason] ??
    `The camera abstained: ${clip.recognition.reason.replace(
      /_/g,
      ' ',
    )}. No score was created.`
  );
}

/**
 * "both" reads naturally only while the free allowance really is 2; any
 * other server-declared limit falls back to "all N" so the copy never lies
 * about how many free analyses the account actually had.
 */
export function freeAnalysesPhrase(limit: number): string {
  return limit === 2 ? 'both' : `all ${limit}`;
}

export function AnalyzeScreen({
  savedTechniqueConfirmation,
  savedOriginalAnalysis,
  savedConfirmationStatus = 'ready',
  isSavedConfirmationCurrent,
  savedConfirmationSignal,
}: {
  savedTechniqueConfirmation?: SavedTechniqueConfirmation;
  savedOriginalAnalysis?: SavedOriginalAnalysisEntry;
  savedConfirmationStatus?: 'ready' | 'release_pending' | 'recovery_blocked';
  isSavedConfirmationCurrent?: () => boolean;
  savedConfirmationSignal?: AbortSignal;
} = {}) {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const route = useRoute<RouteProp<RootStackParams, 'Analyze'>>();
  const accessibleLayout = useWindowDimensions().fontScale > 1.3;
  const source = savedOriginalAnalysis
    ? savedOriginalAnalysis.clip.captureMode === 'imported_video'
      ? 'library'
      : 'camera'
    : (route.params?.source ?? 'camera');
  const savedRoute =
    route.params != null &&
    Object.prototype.hasOwnProperty.call(route.params, 'captureId');
  const ownerEpoch = useSyncExternalStore(
    subscribeToDataOwner,
    getDataOwnerSnapshot,
    getDataOwnerSnapshot,
  );
  const mountOwner = useRef(ownerEpoch);
  const offlineJourney = useOfflineJourneyOnFocus(navigation);
  const [mountService] = useState(currentAnalysisService);
  const [routeController] = useState(() => new AbortController());
  const routeExecution = useRef<OriginalAnalysisExecution | null>(null);
  const activeOriginalExecution = useRef<OriginalAnalysisExecution | null>(
    null,
  );
  const retainedOriginal = useRef<SavedOriginalAnalysis | null>(null);
  const [executionInvalidated, setExecutionInvalidated] = useState(false);
  const bindingInvalidated = useRef(false);
  const routeIdentity = JSON.stringify([
    route.key,
    source,
    savedRoute,
    route.params?.captureId,
    route.params?.mode,
    savedOriginalAnalysis?.reference.captureId,
    savedOriginalAnalysis?.reference.operationId,
    savedOriginalAnalysis?.reference.ownerContext.ownerKey,
    savedOriginalAnalysis?.reference.ownerContext.generation,
    savedOriginalAnalysis?.reference.apiOrigin,
    savedTechniqueConfirmation?.captureId,
    savedTechniqueConfirmation?.record.id,
    savedTechniqueConfirmation?.ownerContext.ownerKey,
    savedTechniqueConfirmation?.ownerContext.generation,
    savedTechniqueConfirmation?.apiOrigin,
  ]);
  const mountedRoute = useRef(routeIdentity);
  const routeChanged = useRef(false);
  if (routeIdentity !== mountedRoute.current) routeChanged.current = true;
  // TRY AGAIN loop (MOBBIN brief §2): a Result screen hands the ORIGINAL
  // run's technique intent back here; it is consumed exactly once (lazy
  // initializer) and seeds the picker/zero-touch gate so the player skips
  // re-picking and goes straight back to their spot.
  const [rearm] = useState(() => {
    if (savedTechniqueConfirmation || savedOriginalAnalysis || savedRoute) {
      clearTryAgainHandoff();
      return null;
    }
    if (source === 'camera') return consumeTryAgainHandoff();
    // An import run is not a re-arm: drop any armed handoff so it cannot
    // seed a later capture with the abandoned run's declaration.
    clearTryAgainHandoff();
    return null;
  });
  const [phase, setPhase] = useState<Phase>(() => {
    if (savedOriginalAnalysis) {
      const reference = savedOriginalAnalysis.reference;
      if (
        savedTechniqueConfirmation ||
        !savedRoute ||
        route.params?.mode !== 'original' ||
        !isSavedCaptureId(reference.operationId) ||
        !isSavedCaptureId(reference.captureId) ||
        route.params?.captureId?.toLowerCase() !==
          reference.captureId.toLowerCase() ||
        !isDataOwnerContextCurrent(reference.ownerContext) ||
        !isSavedConfirmationCurrent?.() ||
        !savedConfirmationSignal ||
        savedConfirmationSignal.aborted
      ) {
        return {
          kind: 'error',
          stage: 'analysis',
          recovery: 'review_saved',
          message:
            'Open this saved analysis from the current account’s Library.',
        };
      }
      const original = Object.freeze({
        ...reference,
        ownerContext: Object.freeze({ ...reference.ownerContext }),
      });
      retainedOriginal.current = original;
      return {
        kind: 'error',
        stage: 'analysis',
        recovery: 'reconcile_saved',
        original,
        canStartAnotherClip: false,
        message:
          'Your original clip and analysis settings are saved. Check the saved analysis before choosing whether to retry. Opening this screen does not start a rating.',
      };
    }
    if (!savedTechniqueConfirmation)
      return savedRoute
        ? {
            kind: 'error',
            stage: 'analysis',
            recovery: 'review_saved',
            message:
              'Open this saved capture through its verified library loader.',
          }
        : { kind: 'ready' };
    const saved = savedTechniqueConfirmation;
    if (
      !isDataOwnerContextCurrent(saved.ownerContext) ||
      saved.record.captureId !== saved.captureId ||
      saved.record.kind !== 'needs_technique_confirmation' ||
      saved.record.result !== null
    ) {
      return {
        kind: 'error',
        stage: 'analysis',
        recovery: 'review_saved',
        message:
          'This saved confirmation is not available in the current account.',
      };
    }
    return {
      ...saved,
      ownerContext: Object.freeze({ ...saved.ownerContext }),
      kind: 'needs_technique_confirmation',
      analysisId: saved.record.id,
      confirmationStatus: savedConfirmationStatus,
    };
  });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  // A confirmation owns this screen from the moment it appears, including
  // its transient working/error phases. Retained new-capture handlers must
  // never re-arm the camera while the same saved capture is continuing.
  const confirmationBound = useRef(false);
  const confirmationBinding = useRef<{
    ownerContext: DataOwnerContext;
    apiOrigin: string;
  } | null>(null);
  if (phase.kind === 'needs_technique_confirmation') {
    confirmationBound.current = true;
    confirmationBinding.current ??= {
      ownerContext: phase.ownerContext,
      apiOrigin: phase.apiOrigin,
    };
  }
  const [declaredStroke, setDeclared] = useState<ShotTypeSlug | null>(
    rearm?.declaredStroke ?? null,
  );
  const [techniqueIntent, setTechniqueIntent] =
    useState<TechniqueIntent | null>(
      rearm ? techniqueIntentFromHandoff(rearm) : null,
    );
  const selectionRef = useRef({ techniqueIntent, declaredStroke });
  selectionRef.current = { techniqueIntent, declaredStroke };
  const [targetSeed, setTargetSeed] = useState<TargetSelection | null>(null);
  const [captureEnvelope, setCaptureEnvelope] =
    useState<EnvelopeVerdict | null>(null);
  // Last measured live signals of the CURRENT attempt, kept for the
  // attempt-time envelope: the readiness read closest to the swing and the
  // latest native quality signals (null until an emitter exists — those
  // dims stay NOT_MEASURED). Cleared at every attempt start so evidence
  // from one clip is never attributed to the next.
  const attemptEvidence = useRef(createAttemptEvidenceBuffer());
  const profile = useAppStore(s => s.profile);
  // Server-declared free-analysis allowance; the free-limit dialog derives
  // its wording from this instead of hardcoding "both".
  const freeRatingsLimit: number = useAccessStore(
    s => s.canonicalAccess?.freeRatings.limit ?? 2,
  );
  const operationActive = useRef(false);
  const cameraRun = useRef<{
    captureId: string | null;
    stage: 'watching' | 'captured' | 'saving';
  } | null>(null);
  const scoringActive = useRef(false);
  const abandoned = useRef(false);
  const activeAnalysisOperation = useRef<AbortController | null>(null);
  const savedGuard = useRef(isSavedConfirmationCurrent);
  savedGuard.current = isSavedConfirmationCurrent;
  const screenCurrent = useCallback(() => {
    if (
      abandoned.current ||
      routeChanged.current ||
      routeController.signal.aborted ||
      !isDataOwnerContextCurrent(mountOwner.current) ||
      currentAnalysisService() !== mountService ||
      mountService === 'unavailable' ||
      !executionIsCurrent(routeExecution.current) ||
      navigation.isFocused?.() === false ||
      !(savedGuard.current?.() ?? true)
    )
      return false;
    const binding = confirmationBinding.current;
    const session = getApiSession();
    if (!binding || !session) return true;
    try {
      const scope = runJournal.scope({
        ownerKey: session.canonicalAppUserId,
        apiOrigin: session.apiBaseUrl,
      });
      return (
        isDataOwnerContextCurrent(binding.ownerContext) &&
        scope.ownerKey === binding.ownerContext.ownerKey &&
        scope.apiOrigin === binding.apiOrigin
      );
    } catch {
      return false;
    }
  }, [mountService, navigation, routeController]);
  const phaseCurrent = () => screenCurrent() && phaseRef.current === phase;
  const confirmationCurrent = useCallback(
    (pending: Extract<Phase, { kind: 'needs_technique_confirmation' }>) => {
      if (!screenCurrent() || !isDataOwnerContextCurrent(pending.ownerContext))
        return false;
      const session = getApiSession();
      if (!session) return true;
      try {
        const scope = runJournal.scope({
          ownerKey: session.canonicalAppUserId,
          apiOrigin: session.apiBaseUrl,
        });
        return (
          scope.ownerKey === pending.ownerContext.ownerKey &&
          scope.apiOrigin === pending.apiOrigin
        );
      } catch {
        return false;
      }
    },
    [screenCurrent],
  );
  const cancelActiveAnalysisOperation = useCallback(() => {
    activeAnalysisOperation.current?.abort();
    activeOriginalExecution.current?.dispose();
  }, []);
  const autoLaunchStarted = useRef(false);
  const activeCameraOperation = useRef<{
    id: string;
    controller: AbortController;
  } | null>(null);
  const withCameraOperation = useCallback(
    async <T,>(
      operation: (options: CameraOperationOptions) => Promise<T>,
    ): Promise<T> => {
      if (
        !screenCurrent() ||
        (mountService !== null && !routeExecution.current)
      )
        throw new Error('Camera operation was canceled.');
      routeExecution.current?.assertCurrent();
      const active = { id: makeUuid(), controller: new AbortController() };
      const abort = () => active.controller.abort();
      routeController.signal.addEventListener('abort', abort, { once: true });
      activeCameraOperation.current = active;
      try {
        return await operation({
          operationId: active.id,
          signal: active.controller.signal,
        });
      } finally {
        routeController.signal.removeEventListener('abort', abort);
        if (activeCameraOperation.current === active)
          activeCameraOperation.current = null;
      }
    },
    [mountService, routeController, screenCurrent],
  );
  const cancelActiveCameraOperation = useCallback(() => {
    const active = activeCameraOperation.current;
    if (!active) return;
    activeCameraOperation.current = null;
    active.controller.abort();
    cancelCameraOperation(active.id);
  }, []);
  const leaveScreen = useCallback(
    (leave: () => void) => {
      if (!screenCurrent()) return;
      abandoned.current = true;
      routeController.abort();
      cancelActiveCameraOperation();
      cancelActiveAnalysisOperation();
      routeExecution.current?.dispose();
      leave();
    },
    [
      cancelActiveAnalysisOperation,
      cancelActiveCameraOperation,
      routeController,
      screenCurrent,
    ],
  );
  // Every scoring run reserves a permit that is then consumed or released,
  // so the access snapshot the rest of the app reads (Settings membership
  // row, tab-bar rating gate, Paywall allowance) is stale the moment a run
  // starts. It is re-read from the server once this screen is GONE — never
  // while it is mounted: the route gate replaces a screen whose
  // canStartRating flips false, and the "last free analysis" prompt has to
  // finish on top of the saved score first. The re-read waits for the run
  // that touched the ledger to settle (permit consumed or released): a read
  // issued while the permit is still reserved would pin the snapshot on an
  // intermediate state nothing else refreshes.
  const ratingLedgerTouched = useRef(false);
  const ledgerRunSettled = useRef<Promise<void>>(Promise.resolve());
  const trackLedgerRun = useCallback(<T,>(run: Promise<T>) => {
    ratingLedgerTouched.current = true;
    ledgerRunSettled.current = Promise.allSettled([
      ledgerRunSettled.current,
      run,
    ]).then(() => undefined);
    return run;
  }, []);
  // This cleanup runs before the route's subscription cleanup below. Service
  // ABA remains observable even after Close disposed the action lease; only
  // the original binding may request its deferred access refresh.
  useLayoutEffect(() => {
    let serviceChanged = false;
    const stopObserving = subscribeToApiSession(() => {
      if (currentAnalysisService() !== mountService) serviceChanged = true;
    });
    const bindingCurrent = () =>
      !serviceChanged &&
      !bindingInvalidated.current &&
      currentAnalysisService() === mountService &&
      isDataOwnerContextCurrent(mountOwner.current);
    return () => {
      if (!ratingLedgerTouched.current || !bindingCurrent()) {
        stopObserving();
        return;
      }
      void ledgerRunSettled.current.then(() => {
        stopObserving();
        const access = useAccessStore.getState();
        if (access.status === 'idle' || !bindingCurrent()) return;
        void access.refreshAccess();
      });
    };
  }, [mountService]);
  // Honest progress surface for the scoring flow (parallel to `phase`, so
  // every existing message/transition stays byte-identical). Non-null only
  // while scoreCapture is in flight.
  const [analysisProgress, setAnalysisProgress] =
    useState<AnalysisProgressUi | null>(null);
  // The in-flight imported-video pose extraction, when one exists. The
  // native captureId is latched from its first event so a stale pass can
  // never drive this run's bar; the ETA state folds every REAL native
  // progress event (never a synthesized fraction).
  const extractionRun = useRef<{
    nativeCaptureId: string | null;
    eta: ExtractionEtaState | null;
  } | null>(null);

  useEffect(
    () =>
      subscribeToCameraEvents((event: CameraEvent) => {
        const active = activeCameraOperation.current;
        if (
          !screenCurrent() ||
          !active ||
          active.controller.signal.aborted ||
          (event.operationId !== undefined && event.operationId !== active.id)
        )
          return;
        const capture = cameraRun.current;
        if (event.type === 'session') {
          if (
            capture &&
            capture.captureId === null &&
            typeof event.captureId === 'string' &&
            ['configured', 'composing', 'observing'].includes(event.state)
          ) {
            capture.captureId = event.captureId;
          }
          return;
        }
        if (
          event.type === 'readiness' ||
          event.type === 'capture_quality' ||
          event.type === 'stroke_detected' ||
          event.type === 'processing'
        ) {
          if (
            !capture ||
            (event.captureId !== undefined &&
              event.captureId !== capture.captureId) ||
            (event.type !== 'processing' && capture.stage !== 'watching') ||
            (event.type === 'processing' && capture.stage === 'saving')
          )
            return;
          if (event.type === 'stroke_detected') capture.stage = 'captured';
          if (event.type === 'processing') capture.stage = 'saving';
        }
        if (event.type === 'readiness') {
          usabilityFunnel.log('readiness_state', event.state);
          if (event.state === 'ready') usabilityFunnel.log('ready');
          attemptEvidence.current.noteReadiness({
            state: event.state,
            jointCoverage: event.jointCoverage,
          });
          setCaptureEnvelope(
            liveCaptureEnvelope(
              attemptEvidence.current.readiness,
              attemptEvidence.current.quality,
            ),
          );
          setPhase({
            kind: 'working',
            message: READINESS_COPY[event.state] ?? 'Reading your position…',
          });
        } else if (event.type === 'capture_quality') {
          attemptEvidence.current.noteQuality(event.signals);
          setCaptureEnvelope(
            liveCaptureEnvelope(
              attemptEvidence.current.readiness,
              attemptEvidence.current.quality,
            ),
          );
        } else if (event.type === 'stroke_detected') {
          usabilityFunnel.log('stroke_captured');
          setCaptureEnvelope(null);
          setPhase({
            kind: 'working',
            message: 'Motion captured — no need to swing again.',
          });
        } else if (event.type === 'processing') {
          setPhase({ kind: 'working', message: 'Saving the private clip…' });
        } else if (event.type === 'import') {
          const messages = {
            selecting: 'Choose one video…',
            copying: 'Copying video into private storage…',
            completed: 'Video secured on this device.',
          } as const;
          setPhase({ kind: 'working', message: messages[event.state] });
        } else if (event.type === 'import_pose_extraction') {
          // Native progress for the offline pose pass. Only the active state
          // updates the caption — completion/failure surfaces come from the
          // extraction promise itself, never from a racing event.
          const run = extractionRun.current;
          if (run) {
            if (
              run.nativeCaptureId === null &&
              typeof event.captureId === 'string'
            ) {
              run.nativeCaptureId = event.captureId;
            }
            const matchesRun =
              event.captureId === undefined ||
              event.captureId === run.nativeCaptureId;
            // Real measured fraction only: 'extracting' events carry the
            // native pass's progress; 'completed' IS the measured 1.0.
            const fraction =
              event.state === 'completed'
                ? 1
                : event.state === 'extracting'
                  ? event.progress
                  : undefined;
            if (matchesRun && typeof fraction === 'number') {
              const emittedAtMs = Date.parse(event.emittedAtIso);
              run.eta = observeExtractionProgress(
                run.eta,
                Number.isFinite(emittedAtMs) ? emittedAtMs : Date.now(),
                fraction,
              );
              setAnalysisProgress(extractionProgress(run.eta));
            }
            if (matchesRun && event.state === 'extracting') {
              setPhase({
                kind: 'working',
                message: 'Reading player movement…',
              });
            }
          }
        }
      }),
    [screenCurrent],
  );

  // Zero-handholding funnel (docs/USABILITY_ZERO_HANDHOLDING.md): observe
  // the surface, never gate it. Logged exactly once per mount.
  useEffect(() => {
    usabilityFunnel.log('analyze_opened', source);
    if (rearm) usabilityFunnel.log('try_again_rearm');
  }, []);

  const publishOutcome = useCallback(
    (
      outcome: RunCaptureAnalysisOutcome,
      context: {
        captureId: string;
        clip: CapturedClip;
        targetSeed: TargetSelection | null;
        ownerContext: DataOwnerContext;
        apiOrigin: string;
        current: () => boolean;
        pendingConfirmation?: Extract<
          Phase,
          { kind: 'needs_technique_confirmation' }
        >;
      },
    ) => {
      if (!context.current()) return;
      const {
        captureId,
        clip,
        targetSeed: selection,
        ownerContext,
        pendingConfirmation,
      } = context;
      setAnalysisProgress(analysisStageProgress('saving'));
      if (outcome.kind === 'unavailable') {
        usabilityFunnel.log('error_shown', outcome.reason);
        const paywallRequired = outcome.cause === 'paywall_required';
        if (pendingConfirmation) {
          setPhase({
            ...pendingConfirmation,
            errorMessage: outcome.reason,
            paywallRequired,
            uncertainContinuation: outcome.cause === 'recovery_pending',
          });
        } else {
          setPhase({
            kind: 'error',
            message: outcome.reason,
            stage: 'analysis',
            recovery: paywallRequired
              ? 'upgrade'
              : outcome.cause === 'recovery_pending'
                ? 'review_saved'
                : 'retry',
            savedCapture: { captureId, clip, ownerContext },
          });
        }
        return;
      }
      if (outcome.kind === 'quality_blocked') {
        const message = qualityBlockedMessage(outcome.reason, outcome.envelope);
        if (pendingConfirmation)
          setPhase({ ...pendingConfirmation, errorMessage: message });
        else
          setPhase({
            kind: 'error',
            message,
            stage: 'analysis',
            recovery: 'retry',
            savedCapture: { captureId, clip, ownerContext },
          });
        return;
      }
      if (outcome.kind === 'scored') {
        // Publication, sync nudges and review requests belong to the same live
        // lease. A late A cannot publish UI or start B's outbox/review work.
        if (!context.current()) return;
        triggerOutboxSync();
        if (!context.current()) return;
        if (outcome.freeLimitReached && !outcome.replayed) {
          usabilityFunnel.log('free_limit_prompt_shown');
          setPhase({ kind: 'free_limit', analysisId: outcome.analysisId });
          return;
        }
        usabilityFunnel.log('result_opened');
        if (!outcome.replayed) void reportScoredAnalysisForReview();
        leaveScreen(() =>
          navigation.replace('Result', { analysisId: outcome.analysisId }),
        );
        return;
      }
      if (outcome.kind === 'needs_technique_confirmation') {
        confirmationBound.current = true;
        confirmationBinding.current = {
          ownerContext,
          apiOrigin: context.apiOrigin,
        };
        selectionRef.current = { techniqueIntent: null, declaredStroke: null };
        setDeclared(null);
        setTechniqueIntent(null);
        setPhase({
          kind: 'needs_technique_confirmation',
          analysisId: outcome.analysisId,
          record: outcome.record,
          captureId,
          clip,
          targetSeed: selection,
          ownerContext,
          apiOrigin:
            outcome.record.inputSelection?.apiOrigin ?? context.apiOrigin,
          confirmationStatus: 'release_pending',
        });
        return;
      }
      if (outcome.kind === 'partial') {
        usabilityFunnel.log('result_opened');
        leaveScreen(() =>
          navigation.replace('Result', { analysisId: outcome.analysisId }),
        );
        return;
      }
      const presentation = strokeIntentPresentation(outcome.record);
      if (presentation) {
        usabilityFunnel.log('intent_outcome_shown', presentation.eyebrow);
        setPhase({
          kind: 'analyzed',
          analysisId: outcome.analysisId,
          presentation,
        });
        return;
      }
      usabilityFunnel.log('result_opened');
      leaveScreen(() =>
        navigation.replace('Result', { analysisId: outcome.analysisId }),
      );
    },
    [leaveScreen, navigation],
  );

  const showOriginalRecovery = useCallback(
    async (
      original: SavedOriginalAnalysis,
      execution: OriginalAnalysisExecution,
      current: () => boolean,
      paywallRequired = false,
    ) => {
      let recovery: Extract<Phase, { kind: 'error' }>['recovery'] =
        'reconcile_saved';
      let predecessorAttemptId: string | undefined;
      let canStartAnotherClip = false;
      try {
        const operation = await originalAnalysisOperations.read(
          getDb(),
          execution,
          original.operationId,
        );
        if (!current()) return;
        if (
          operation?.snapshot.captureId === original.captureId &&
          operation.finalRecordId === null &&
          !runJournal
            .activeOperationIds(execution.scope)
            .includes(operation.operationId)
        ) {
          if (operation.currentAttemptId === null) {
            // Preparation/extraction did not admit a permit. Retrying still
            // goes through the core's fresh byte/model/observation checks.
            recovery =
              operation.snapshot.clip.nativeMediaIdentity &&
              operation.modelPolicyHash
                ? 'retry_saved'
                : 'review_saved';
            canStartAnotherClip = true;
          } else {
            const attempt = await originalAnalysisOperations.readAttempt(
              getDb(),
              operation,
              operation.currentAttemptId,
            );
            const run = attempt.run;
            if (!current()) return;
            if (
              run.state === 'released' &&
              run.releaseOutcome === 'failed' &&
              run.permitId !== null &&
              run.resultId === null &&
              run.terminalReason === null &&
              run.lastHttpStatus === null &&
              run.attemptCount >= 1 &&
              attempt.technicalFailure !== null &&
              !runJournal
                .activeOperationIds(execution.scope)
                .includes(run.operationId)
            ) {
              recovery = 'retry_saved';
              predecessorAttemptId = run.operationId;
              canStartAnotherClip = true;
            }
          }
        }
      } catch {
        // Unknown storage is not empty storage or proof of release.
      }
      if (!current()) return;
      setPhase({
        kind: 'error',
        stage: 'analysis',
        original,
        predecessorAttemptId,
        canStartAnotherClip,
        recovery: paywallRequired ? 'upgrade' : recovery,
        message: paywallRequired
          ? 'The rating service requires an upgrade before another rating can start. This saved analysis has not been replaced.'
          : recovery === 'retry_saved'
            ? 'The clip and original analysis settings are saved. Retry this saved analysis without recording or importing again.'
            : recovery === 'review_saved'
              ? 'This saved analysis has no complete original file or model proof. Keep the clip in Library; its missing proof will not be recreated from current settings.'
              : 'The saved analysis or its rating hold is still uncertain. Check only reconciles this original analysis; it does not start another rating.',
      });
    },
    [],
  );

  const finishOriginalOutcome = useCallback(
    async (
      outcome: RunCaptureAnalysisOutcome,
      original: SavedOriginalAnalysis,
      execution: OriginalAnalysisExecution,
      current: () => boolean,
    ) => {
      if (!current()) return;
      if (outcome.kind === 'unavailable') {
        await showOriginalRecovery(
          original,
          execution,
          current,
          outcome.cause === 'paywall_required',
        );
        return;
      }
      if (outcome.kind === 'quality_blocked') {
        setPhase({
          kind: 'error',
          stage: 'analysis',
          recovery: 'review_saved',
          original,
          canStartAnotherClip: true,
          message: qualityBlockedMessage(outcome.reason, outcome.envelope),
        });
        return;
      }
      const operation = await originalAnalysisOperations.read(
        getDb(),
        execution,
        original.operationId,
      );
      if (!current()) return;
      if (!operation || operation.snapshot.captureId !== original.captureId) {
        await showOriginalRecovery(original, execution, current);
        return;
      }
      publishOutcome(outcome, {
        captureId: original.captureId,
        clip: operation.observation?.clip ?? operation.snapshot.clip,
        targetSeed: operation.snapshot.targetSeed,
        ownerContext: original.ownerContext,
        apiOrigin: original.apiOrigin,
        current,
      });
    },
    [publishOutcome, showOriginalRecovery],
  );

  const retrySavedAnalysis = useCallback(
    async (failure: Extract<Phase, { kind: 'error' }>) => {
      const original = failure.original;
      if (
        !original ||
        phaseRef.current !== failure ||
        !screenCurrent() ||
        scoringActive.current ||
        operationActive.current ||
        !['retry_saved', 'reconcile_saved'].includes(failure.recovery)
      )
        return;
      scoringActive.current = true;
      const controller = new AbortController();
      activeAnalysisOperation.current = controller;
      let execution: OriginalAnalysisExecution | null = null;
      const current = () =>
        activeAnalysisOperation.current === controller &&
        !controller.signal.aborted &&
        screenCurrent() &&
        executionIsCurrent(execution);
      try {
        execution = createOriginalAnalysisExecution(
          original.ownerContext,
          original.apiOrigin,
          routeController.signal,
        );
        activeOriginalExecution.current = execution;
        const request = {
          db: getDb(),
          execution,
          operationId: original.operationId,
        };
        setPhase({
          kind: 'working',
          message:
            failure.recovery === 'retry_saved'
              ? 'Measuring your saved swing…'
              : 'Checking your saved analysis…',
        });
        setAnalysisProgress(analysisStageProgress('verifying'));
        if (failure.recovery === 'reconcile_saved') {
          await trackLedgerRun(reconcileOriginalCaptureAnalysis(request));
          if (!current()) return;
          const operation = await originalAnalysisOperations.read(
            request.db,
            execution,
            original.operationId,
          );
          if (!current()) return;
          const settledRefusal =
            operation !== null &&
            (await originalAnalysisOperations.hasSettledRefusal(
              request.db,
              execution,
              operation,
            ));
          if (!current()) return;
          if (!operation?.finalRecordId && !settledRefusal) {
            // A released hold may enable a NEW explicit retry button, never
            // an automatic successor while the user only asked to reconcile.
            await showOriginalRecovery(original, execution, current);
            return;
          }
        }
        const outcome = await trackLedgerRun(
          runOriginalCaptureAnalysis({
            ...request,
            ...(failure.recovery === 'retry_saved' &&
            failure.predecessorAttemptId
              ? { predecessorAttemptId: failure.predecessorAttemptId }
              : {}),
          }),
        );
        if (!current()) return;
        await finishOriginalOutcome(outcome, original, execution, current);
      } catch {
        if (current())
          setPhase({
            ...failure,
            recovery: 'reconcile_saved',
            canStartAnotherClip: false,
            message:
              'This saved analysis could not be verified. Check the original again when its storage and rating service are available.',
          });
      } finally {
        const wasCurrent = current();
        execution?.dispose();
        if (activeOriginalExecution.current === execution)
          activeOriginalExecution.current = null;
        if (activeAnalysisOperation.current === controller) {
          activeAnalysisOperation.current = null;
          scoringActive.current = false;
        }
        if (wasCurrent) setAnalysisProgress(null);
      }
    },
    [
      finishOriginalOutcome,
      routeController,
      screenCurrent,
      showOriginalRecovery,
      trackLedgerRun,
    ],
  );

  const scoreCapture = useCallback(
    async (
      captureId: string,
      clip: CapturedClip,
      targetSeed: TargetSelection | null,
      ownerContext: DataOwnerContext,
      pendingConfirmation?: Extract<
        Phase,
        { kind: 'needs_technique_confirmation' }
      >,
    ) => {
      if (
        selectionRef.current.techniqueIntent !== techniqueIntent ||
        selectionRef.current.declaredStroke !== declaredStroke ||
        (!pendingConfirmation &&
          retainedOriginal.current?.captureId === captureId)
      )
        return;
      if (
        pendingConfirmation &&
        (!isDeclaredTechniqueIntent(techniqueIntent) ||
          !confirmationCurrent(pendingConfirmation) ||
          pendingConfirmation.confirmationStatus === 'recovery_blocked')
      )
        return;
      if (
        !screenCurrent() ||
        !isDataOwnerContextCurrent(ownerContext) ||
        savedConfirmationSignal?.aborted
      )
        return;
      const originalSettings = pendingConfirmation?.record.inputSelection;
      if (
        pendingConfirmation &&
        !isAnalysisInputSelectionSnapshot(originalSettings)
      ) {
        setPhase({
          ...pendingConfirmation,
          errorMessage:
            'This older confirmation has no complete original settings. The clip stays saved and read-only.',
          confirmationStatus: 'recovery_blocked',
        });
        return;
      }
      // Declared runs proceed as always. Declared-null runs proceed ONLY on
      // the guided-capture path with Auto Detect explicitly armed; imported
      // videos still require a concrete declared technique.
      if (
        !declaredStroke &&
        !canAutoScoreWithoutDeclaration(clip, techniqueIntent)
      ) {
        return;
      }
      // One capture, one analysis: a second tap while a run is in flight is
      // ignored rather than reserving a second permit for the same clip.
      if (scoringActive.current || abandoned.current) return;
      scoringActive.current = true;
      const controller = new AbortController();
      const abortSavedOperation = () => controller.abort();
      savedConfirmationSignal?.addEventListener('abort', abortSavedOperation, {
        once: true,
      });
      routeController.signal.addEventListener('abort', abortSavedOperation, {
        once: true,
      });
      if (savedConfirmationSignal?.aborted || routeController.signal.aborted)
        controller.abort();
      activeAnalysisOperation.current = controller;
      let execution: OriginalAnalysisExecution | null = null;
      let original: SavedOriginalAnalysis | null = null;
      const executionCurrent = () =>
        activeAnalysisOperation.current === controller &&
        !controller.signal.aborted &&
        screenCurrent() &&
        executionIsCurrent(execution) &&
        isDataOwnerContextCurrent(ownerContext) &&
        (!pendingConfirmation || confirmationCurrent(pendingConfirmation));
      const session = getApiSession();
      // Imported clips carry no recorded pose sequence until the explicit
      // native extraction pass runs. When the bridge method exists, this run
      // measures the sequence now (seeded by the user's tap when there is
      // one); when it doesn't, the clip proceeds unchanged and
      // runCaptureAnalysis keeps its honest unavailable message.
      const needsPoseExtraction =
        !pendingConfirmation &&
        clip.captureMode === 'imported_video' &&
        clip.poseSequence === undefined &&
        importedPoseExtractionAvailable();
      usabilityFunnel.log('analysis_started', declaredStroke ?? 'auto');
      setPhase({
        kind: 'working',
        message: needsPoseExtraction
          ? 'Reading player movement…'
          : declaredStroke
            ? 'Measuring your swing…'
            : 'Measuring your swing and reading the stroke…',
      });
      // Stage model for the progress bar (parallel to the caption above,
      // which keeps its exact strings): stages advance only at boundaries
      // this screen actually observes, and only the extraction stage ever
      // shows a percentage — the one place a real fraction is measured.
      setAnalysisProgress(analysisStageProgress('verifying'));
      try {
        if (session) {
          execution = createOriginalAnalysisExecution(
            ownerContext,
            pendingConfirmation?.apiOrigin ?? session.apiBaseUrl,
            controller.signal,
          );
          activeOriginalExecution.current = execution;
        }
        if (!executionCurrent()) return;
        const rawDb = getDb();
        const db = forDataOwner(rawDb, ownerContext);
        // The declaration column records USER statements only — an AUTO run
        // writes nothing there; the prediction lives in the analysis record.
        if (declaredStroke && !pendingConfirmation) {
          await setDeclaredStroke(db, captureId, declaredStroke);
          if (!executionCurrent()) return;
        }
        // The tap is user input tied to the capture: persist it with the
        // row so it survives restarts and stays available to any later
        // analysis pass, whether or not this run can analyze the clip.
        if (targetSeed && !pendingConfirmation) {
          await setCaptureTargetSeed(db, captureId, targetSeed);
          if (!executionCurrent()) return;
        }
        // A completed AUTO confirmation keeps its dedicated continuation.
        // If it came from a new original operation, reuse that saved practice
        // plan even after Library reopening. Legacy records are never backfilled.
        let confirmationOriginal: OriginalAnalysisOperation | null = null;
        if (pendingConfirmation && execution) {
          const { rows } = await rawDb.execute(
            'SELECT operation_id FROM analysis_logical_operations WHERE owner_key = ? AND capture_id = ?',
            [ownerContext.ownerKey, captureId],
          );
          if (!executionCurrent()) return;
          if (rows[0]) {
            confirmationOriginal = await originalAnalysisOperations.read(
              rawDb,
              execution,
              String(rows[0].operation_id),
            );
            if (!executionCurrent()) return;
            if (
              !confirmationOriginal ||
              confirmationOriginal.finalRecordId !==
                pendingConfirmation.analysisId ||
              confirmationOriginal.completionKind !==
                'needs_technique_confirmation'
            )
              throw new Error(
                'The original saved confirmation could not be verified.',
              );
          }
        }
        let practiceSet: PracticeSetPlan | null =
          confirmationOriginal?.snapshot.practiceSet ?? null;
        if (!confirmationOriginal) {
          try {
            practiceSet = await planPracticeSet(db, {
              shotType: declaredStroke,
              preferredSessionId: rearm?.sessionId ?? null,
            });
          } catch {
            practiceSet = null;
          }
        }
        if (!executionCurrent()) return;
        const request: RunCaptureAnalysisRequest = {
          db: rawDb,
          ownerContext,
          signal: execution?.signal ?? controller.signal,
          captureId,
          clip,
          declaredStroke,
          declaredCanonical: techniqueIntent?.canonical ?? null,
          ...(pendingConfirmation && isDeclaredTechniqueIntent(techniqueIntent)
            ? {
                techniqueConfirmation: {
                  analysisId: pendingConfirmation.analysisId,
                  intent: { ...techniqueIntent },
                  confirmedAtIso: new Date().toISOString(),
                },
              }
            : {}),
          handedness:
            originalSettings?.handedness ?? profile?.handedness ?? 'right',
          cameraView: originalSettings?.cameraView ?? 'side',
          apiConfig: {
            baseUrl:
              execution?.scope.apiOrigin ??
              pendingConfirmation?.apiOrigin ??
              session?.apiBaseUrl ??
              '',
            get token() {
              const current = getApiSession();
              return current?.canonicalAppUserId === ownerContext.ownerKey &&
                executionCurrent()
                ? current.bearerToken
                : null;
            },
          },
          appVersion:
            confirmationOriginal?.snapshot.appVersion ??
            getRuntimePublicConfig().appVersion,
          sessionId:
            confirmationOriginal?.snapshot.sessionId ??
            practiceSet?.sessionId ??
            null,
          practiceSet,
          focusCheckpoint: originalSettings
            ? (originalSettings.focusCheckpoint ?? undefined)
            : profile?.focusCheckpoint,
          targetSeed,
          captureEnvelope: pendingConfirmation
            ? (pendingConfirmation.record.captureEnvelope ?? null)
            : clip.captureMode === 'automatic_pose_trigger'
              ? attemptCaptureEnvelope(
                  clip,
                  attemptEvidence.current.quality,
                  attemptEvidence.current.readiness,
                )
              : null,
        };
        if (
          execution &&
          !pendingConfirmation &&
          clipSupportsScoring(clip) &&
          (clip.poseSequence !== undefined || needsPoseExtraction)
        ) {
          original = Object.freeze({
            operationId: makeUuid(),
            captureId,
            ownerContext: execution.ownerContext,
            apiOrigin: execution.scope.apiOrigin,
          });
          // Retain the chosen lookup ID BEFORE awaiting preparation: a lost
          // commit acknowledgement must not mint another definition on retry.
          retainedOriginal.current = original;
          const operation = await prepareOriginalCaptureAnalysis(
            request,
            execution,
            original.operationId,
          );
          if (!executionCurrent()) return;
          original = Object.freeze({
            ...original,
            operationId: operation.operationId,
          });
          retainedOriginal.current = original;
          // The core owns saved-file extraction and the one-time observation
          // seal. It exposes no native progress ID, so this bar stays honest
          // and indeterminate instead of accepting a stale extraction event.
          const outcome = await trackLedgerRun(
            runOriginalCaptureAnalysis({
              db: rawDb,
              execution,
              operationId: original.operationId,
            }),
          );
          if (!executionCurrent()) return;
          await finishOriginalOutcome(
            outcome,
            original,
            execution,
            executionCurrent,
          );
          return;
        }
        // Unavailable/session-less and pose-less legacy entry points retain
        // their existing honest outcomes. They do not gain saved-retry proof.
        let analysisClip = clip;
        if (needsPoseExtraction && clip.captureMode === 'imported_video') {
          // Arm the extraction progress surface BEFORE the native pass
          // starts so its very first event finds the active run. The bar
          // stays indeterminate until native reports a real fraction.
          extractionRun.current = { nativeCaptureId: null, eta: null };
          setAnalysisProgress(extractionProgress(null));
          try {
            const extraction = await withCameraOperation(options => {
              if (extractionRun.current) {
                extractionRun.current.nativeCaptureId =
                  options.operationId ?? null;
              }
              return extractImportedPoseSequence(
                clip,
                targetSeed?.point ?? null,
                options,
              );
            });
            if (!executionCurrent()) return;
            analysisClip = {
              ...clip,
              poseSequence: extraction.poseSequence,
              ...(extraction.posterUri !== undefined
                ? { posterUri: extraction.posterUri }
                : {}),
            };
            // The measured pose sequence is evidence ABOUT this clip, so it
            // is persisted with the capture row: the Form Review opened
            // from Progress days later replays the import's exoskeleton
            // instead of finding a payload that predates the extraction.
            // A persistence hiccup never fails the analysis in hand.
            try {
              await updateCaptureClipPayload(db, captureId, analysisClip);
              if (!executionCurrent()) return;
            } catch {
              // The run continues on the in-memory clip.
            }
          } catch (error) {
            if (!executionCurrent()) return;
            const message = importedPoseExtractionFailureMessage(error);
            usabilityFunnel.log('error_shown', message);
            setPhase({
              kind: 'error',
              message,
              stage: 'analysis',
              recovery: 'retry',
              savedCapture: { captureId, clip, ownerContext },
            });
            return;
          } finally {
            extractionRun.current = null;
          }
          setPhase({ kind: 'working', message: 'Measuring your swing…' });
        }
        if (!executionCurrent()) return;
        setAnalysisProgress(analysisStageProgress('measuring'));
        const outcome = await trackLedgerRun(
          runCaptureAnalysis({
            ...request,
            clip: analysisClip,
          }),
        );
        publishOutcome(outcome, {
          captureId,
          clip: analysisClip,
          targetSeed,
          ownerContext,
          apiOrigin: request.apiConfig.baseUrl,
          pendingConfirmation,
          current: executionCurrent,
        });
      } catch (error) {
        if (!executionCurrent()) return;
        if (original) {
          setPhase({
            kind: 'error',
            stage: 'analysis',
            recovery: 'reconcile_saved',
            original,
            message:
              'This saved analysis could not be verified. Check the original again when its storage and rating service are available.',
          });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        usabilityFunnel.log('error_shown', message);
        if (pendingConfirmation && isDataOwnerContextCurrent(ownerContext)) {
          setPhase({
            ...pendingConfirmation,
            errorMessage: message,
            uncertainContinuation: true,
          });
          return;
        }
        setPhase({
          kind: 'error',
          message,
          stage: 'analysis',
          recovery: 'retry',
          savedCapture: { captureId, clip, ownerContext },
        });
      } finally {
        savedConfirmationSignal?.removeEventListener(
          'abort',
          abortSavedOperation,
        );
        routeController.signal.removeEventListener(
          'abort',
          abortSavedOperation,
        );
        const current = executionCurrent();
        execution?.dispose();
        if (activeOriginalExecution.current === execution)
          activeOriginalExecution.current = null;
        if (activeAnalysisOperation.current === controller) {
          activeAnalysisOperation.current = null;
          scoringActive.current = false;
        }
        // The progress surface describes ONE scoring run; it never outlives
        // it (error surfaces and the next run start clean).
        if (current) {
          extractionRun.current = null;
          setAnalysisProgress(null);
        }
      }
    },
    [
      confirmationCurrent,
      screenCurrent,
      declaredStroke,
      finishOriginalOutcome,
      publishOutcome,
      profile,
      rearm,
      routeController,
      savedConfirmationSignal,
      techniqueIntent,
      trackLedgerRun,
      withCameraOperation,
    ],
  );

  const run = useCallback(async () => {
    const currentPhase = phaseRef.current;
    if (
      operationActive.current ||
      scoringActive.current ||
      !screenCurrent() ||
      savedRoute ||
      savedTechniqueConfirmation ||
      savedOriginalAnalysis ||
      confirmationBound.current ||
      currentPhase.kind === 'working' ||
      (currentPhase.kind === 'error' &&
        (currentPhase.recovery === 'reconcile_saved' ||
          (currentPhase.original && !currentPhase.canStartAnotherClip))) ||
      selectionRef.current.techniqueIntent !== techniqueIntent ||
      selectionRef.current.declaredStroke !== declaredStroke
    )
      return;
    operationActive.current = true;
    retainedOriginal.current = null;
    cameraRun.current =
      source === 'camera' ? { captureId: null, stage: 'watching' } : null;
    // Each capture attempt starts with a clean envelope verdict, live
    // evidence buffer, target seed, and live-window signals: all of them
    // describe ONE clip's live window and must never carry into the next one.
    attemptEvidence.current.beginAttempt();
    setCaptureEnvelope(null);
    setTargetSeed(null);
    if (source === 'camera') usabilityFunnel.log('camera_opened');
    setPhase({
      kind: 'working',
      message:
        source === 'library' ? 'Opening video library…' : 'Opening camera…',
    });
    try {
      const ownerContext = captureDataOwnerContext();
      let clip: CapturedClip;
      try {
        clip = await withCameraOperation(options =>
          source === 'library'
            ? importStrokeVideo(options)
            : captureStrokeVideo({
                ...options,
                handedness: profile?.handedness ?? 'right',
              }),
        );
      } catch (error) {
        if (!screenCurrent() || !isDataOwnerContextCurrent(ownerContext))
          return;
        if (isUserCancelledCapture(error)) {
          // User cancel is not a startup failure.
          usabilityFunnel.log('attempt_abandoned');
          if (source === 'library') leaveScreen(() => navigation.goBack());
          else setPhase({ kind: 'ready' });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (source === 'camera') {
          stabilitySlo.record({
            kind: 'camera_startup_failed',
            reason: 'guided_capture_error',
          });
        }
        usabilityFunnel.log('error_shown', message);
        setPhase({
          kind: 'error',
          message,
          stage: 'capture',
          recovery: 'retry',
        });
        return;
      }
      cameraRun.current = null;
      if (source === 'camera') {
        stabilitySlo.record({ kind: 'camera_startup_succeeded' });
      }
      if (!screenCurrent() || !isDataOwnerContextCurrent(ownerContext)) return;
      const captureId = makeUuid();
      const shotType =
        clip.recognition.status === 'recognized'
          ? clip.recognition.shotType
          : 'unrecognized';
      const db = forDataOwner(getDb(), ownerContext);
      await savePendingCapture(db, captureId, shotType, clip, declaredStroke);
      if (!screenCurrent() || !isDataOwnerContextCurrent(ownerContext)) return;
      if (
        clip.captureMode === 'automatic_pose_trigger' &&
        (declaredStroke !== null ||
          canAutoScoreWithoutDeclaration(clip, techniqueIntent))
      ) {
        // ZERO-TOUCH PATH: technique declared — or Auto Detect explicitly
        // armed — before recording, with the camera's acquired person anchor
        // kept distinct from any user tap, so analysis starts without any
        // further interaction. Auto runs route declared=null through the
        // classifier ladder; they never invent a declaration.
        const liveSeed = null;
        usabilityFunnel.log('capture_saved', captureSavedDetail(clip));
        setPhase({ kind: 'saved', clip, captureId, ownerContext });
        void scoreCapture(captureId, clip, liveSeed, ownerContext);
        return;
      }
      usabilityFunnel.log('capture_saved', captureSavedDetail(clip));
      setPhase({ kind: 'saved', clip, captureId, ownerContext });
    } catch (error) {
      if (!screenCurrent()) return;
      // The clip exists: this is a local persistence failure after a
      // successful capture, never a camera startup failure.
      const message = error instanceof Error ? error.message : String(error);
      usabilityFunnel.log('error_shown', message);
      setPhase({
        kind: 'error',
        message,
        stage: 'capture',
        recovery: 'retry',
      });
    } finally {
      cameraRun.current = null;
      operationActive.current = false;
    }
  }, [
    declaredStroke,
    leaveScreen,
    navigation,
    profile?.handedness,
    savedRoute,
    savedTechniqueConfirmation,
    savedOriginalAnalysis,
    screenCurrent,
    scoreCapture,
    source,
    techniqueIntent,
    withCameraOperation,
  ]);

  // Library imports auto-launch (no declaration is useful for them yet);
  // guided capture waits for the user to declare a stroke and start.
  useEffect(() => {
    if (
      source !== 'library' ||
      autoLaunchStarted.current ||
      savedRoute ||
      savedTechniqueConfirmation
    )
      return;
    autoLaunchStarted.current = true;
    const timer = setTimeout(() => void run(), 160);
    return () => clearTimeout(timer);
  }, [run, source, savedRoute, savedTechniqueConfirmation]);

  // TRY AGAIN re-arms the camera directly: same intent, same capture mode,
  // same camera config — the state above was seeded before `run` was first
  // created, so the zero-touch scoring gate sees the preserved declaration
  // (or armed AUTO) exactly as the original run did.
  useEffect(() => {
    if (!rearm || autoLaunchStarted.current) return;
    autoLaunchStarted.current = true;
    const timer = setTimeout(() => void run(), 160);
    return () => clearTimeout(timer);
  }, [rearm, run]);

  useLayoutEffect(() => {
    let mounted = true;
    let execution: OriginalAnalysisExecution | null = null;
    const abandon = () => {
      if (
        !isDataOwnerContextCurrent(mountOwner.current) ||
        currentAnalysisService() !== mountService
      )
        bindingInvalidated.current = true;
      const wasAbandoned = abandoned.current;
      abandoned.current = true;
      routeController.abort();
      cancelActiveCameraOperation();
      cancelActiveAnalysisOperation();
      execution?.dispose();
      if (mounted && !wasAbandoned) setExecutionInvalidated(true);
    };
    const session = getApiSession();
    try {
      if (session) {
        execution = createOriginalAnalysisExecution(
          mountOwner.current,
          session.apiBaseUrl,
          routeController.signal,
        );
        routeExecution.current = execution;
        execution.signal.addEventListener('abort', abandon, { once: true });
      }
      if (routeChanged.current || currentAnalysisService() !== mountService)
        abandon();
    } catch {
      abandon();
    }
    const blur = navigation.addListener?.('blur', abandon);
    const ownerChanged = subscribeToDataOwner(() => {
      if (!isDataOwnerContextCurrent(mountOwner.current)) abandon();
    });
    // Also fence a session-less legacy surface. A -> B -> A is observed
    // synchronously, not merely compared when an old callback settles.
    const serviceChanged = subscribeToApiSession(() => {
      if (currentAnalysisService() !== mountService) abandon();
    });
    return () => {
      mounted = false;
      blur?.();
      ownerChanged();
      serviceChanged();
      execution?.signal.removeEventListener('abort', abandon);
      abandon();
      execution?.dispose();
      if (routeExecution.current === execution) routeExecution.current = null;
    };
  }, [
    navigation,
    mountService,
    routeController,
    routeIdentity,
    cancelActiveCameraOperation,
    cancelActiveAnalysisOperation,
  ]);

  if (
    executionInvalidated ||
    routeChanged.current ||
    !isDataOwnerContextCurrent(mountOwner.current) ||
    (confirmationBinding.current && !screenCurrent()) ||
    (savedTechniqueConfirmation &&
      (!isDataOwnerContextCurrent(savedTechniqueConfirmation.ownerContext) ||
        !(isSavedConfirmationCurrent?.() ?? true))) ||
    (phase.kind === 'needs_technique_confirmation' &&
      !confirmationCurrent(phase))
  ) {
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
        <ScreenHeader
          title="Saved capture"
          onClose={() => {
            if (phaseCurrent()) leaveScreen(() => navigation.goBack());
          }}
        />
        <View style={styles.stateBody}>
          <Text accessibilityRole="alert" style={[type.body, styles.stateCopy]}>
            This capture is no longer open in its bound account and service.
            Reopen it from Library. The saved clip has not been changed.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (phase.kind === 'working') {
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.darkScreen}>
        <StatusBar barStyle="light-content" />
        <ScreenHeader
          dark
          title={
            savedTechniqueConfirmation || savedRoute
              ? 'Saved capture'
              : source === 'library'
                ? 'Import video'
                : 'Auto Analyze'
          }
          onClose={() => {
            if (phaseCurrent()) leaveScreen(() => navigation.goBack());
          }}
        />
        {phase.message.startsWith('Measuring') ||
        phase.message.startsWith('Reading player movement') ? (
          // ANALYZING state (MOBBIN brief §1): single-state arc with the
          // honest stage caption scoreCapture set, plus the progress bar —
          // determinate ONLY for the natively-measured extraction pass,
          // indeterminate stage pulses everywhere else. Never a fake
          // percentage.
          <StrokeResultAnalyzing
            dark
            caption={phase.message}
            progress={analysisProgress}
          />
        ) : (
          <View style={styles.workingBody} accessibilityLiveRegion="polite">
            <MascotStage
              dark
              pose={ANALYSIS_MASCOT_POSES.working}
              icon={source === 'library' ? 'upload' : 'camera'}
              tone="volt"
              testID="analysis-mascot-working"
            />
            <Text style={[type.h2, styles.workingTitle]}>{phase.message}</Text>
            <Text style={[type.body, styles.workingCopy]}>
              {source === 'library'
                ? 'The selected file is copied into protected app storage before anything else happens.'
                : cameraRun.current?.stage === 'captured' ||
                    cameraRun.current?.stage === 'saving'
                  ? 'Your swing is captured. Keep the app open while your private clip is prepared.'
                  : 'Tap record, take your spot, and swing once. The camera saves the swing automatically.'}
            </Text>
            {source !== 'library' ? (
              <CaptureGuidancePanel envelope={captureEnvelope} />
            ) : null}
          </View>
        )}
      </SafeAreaView>
    );
  }

  if (phase.kind === 'error') {
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
        <StatusBar barStyle="dark-content" />
        <ScreenHeader
          title={
            phase.stage === 'capture'
              ? 'Capture interrupted'
              : 'Analysis stopped'
          }
          onClose={() => {
            if (phaseCurrent()) leaveScreen(() => navigation.goBack());
          }}
        />
        <ScrollView
          contentContainerStyle={styles.stateScrollBody}
          accessibilityRole="alert"
        >
          <MascotStage
            compact
            pose={ANALYSIS_MASCOT_POSES.recovery}
            tone="danger"
            testID="analysis-mascot-error"
          />
          <Text style={[type.h1, styles.stateTitle]}>
            {phase.original
              ? 'Your saved analysis is held.'
              : phase.recovery === 'review_saved'
                ? 'Your analysis needs recovery.'
                : 'Nothing was rated.'}
          </Text>
          <Text style={[type.body, styles.stateCopy]}>{phase.message}</Text>
          <View style={styles.stateActions}>
            {phase.recovery === 'retry_saved' ||
            phase.recovery === 'reconcile_saved' ? (
              <Button
                label={
                  phase.recovery === 'retry_saved'
                    ? 'Retry saved analysis'
                    : 'Check saved analysis'
                }
                variant="dark"
                onPress={() => {
                  if (phaseCurrent()) void retrySavedAnalysis(phase);
                }}
              />
            ) : phase.recovery === 'upgrade' ? (
              <Button
                label="Upgrade to Pro"
                variant="volt"
                onPress={() => {
                  if (phaseCurrent())
                    leaveScreen(() =>
                      navigation.navigate('Paywall', { source: 'rating' }),
                    );
                }}
              />
            ) : phase.recovery === 'review_saved' ? (
              <Button
                label="Open Library"
                variant="dark"
                onPress={() => {
                  if (phaseCurrent())
                    leaveScreen(() =>
                      navigation.navigate('Tabs', { screen: 'Library' }),
                    );
                }}
              />
            ) : (
              <Button
                label={
                  phase.stage === 'capture'
                    ? 'Try again'
                    : source === 'library'
                      ? 'Import another video'
                      : 'Record another clip'
                }
                variant="dark"
                onPress={() => {
                  if (phaseCurrent()) void run();
                }}
              />
            )}
            {phase.original && phase.canStartAnotherClip ? (
              <Button
                label={
                  source === 'library'
                    ? 'Import another video'
                    : 'Record another clip'
                }
                variant="secondary"
                onPress={() => {
                  if (!phaseCurrent()) return;
                  if (savedOriginalAnalysis) {
                    leaveScreen(() =>
                      navigation.replace('Analyze', { source }),
                    );
                  } else {
                    void run();
                  }
                }}
              />
            ) : null}
            <Button
              label="Close"
              variant="ghost"
              onPress={() => {
                if (phaseCurrent()) leaveScreen(() => navigation.goBack());
              }}
            />
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (phase.kind === 'needs_technique_confirmation') {
    const presentation = strokeIntentPresentation(phase.record)!;
    const readOnly =
      phase.confirmationStatus === 'recovery_blocked' ||
      !isAnalysisInputSelectionSnapshot(phase.record.inputSelection) ||
      phase.record.inputSelection.target.guidedStartTap?.selectedAtIso === null;
    const held =
      readOnly ||
      phase.confirmationStatus !== 'ready' ||
      phase.uncertainContinuation;
    const current = () =>
      phaseRef.current === phase &&
      confirmationCurrent(phase) &&
      selectionRef.current.techniqueIntent === techniqueIntent &&
      selectionRef.current.declaredStroke === declaredStroke;
    const closeConfirmation = () => {
      if (!current()) return;
      leaveScreen(() => navigation.goBack());
    };
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
        <StatusBar barStyle="dark-content" />
        <ScreenHeader title="Confirm technique" onClose={closeConfirmation} />
        <ScrollView
          contentContainerStyle={styles.savedContent}
          showsVerticalScrollIndicator={false}
        >
          <Text
            style={[type.micro, styles.intentEyebrow, { color: color.warn }]}
          >
            {held ? 'SAVED ANALYSIS HELD' : presentation.eyebrow}
          </Text>
          <Text style={[type.h1, styles.intentTitle]}>
            {presentation.title}
          </Text>
          <Text style={[type.body, styles.stateCopy]}>
            {held
              ? 'The existing operation and original selection for this same saved capture must be verified before continuing. Your clip is retained; no replacement operation will be started while its outcome or rating hold is uncertain.'
              : presentation.body}
          </Text>
          <Text style={[type.caption, styles.scoreCopy]}>
            {readOnly
              ? 'This saved proof is read-only. Its release or original selection could not be established safely.'
              : 'The original rating hold must be confirmed released before the selected technique can start its own rating.'}
          </Text>
          <CaptureEvidenceCard clip={phase.clip} />
          <View style={styles.scoreSection}>
            <Text style={[type.h3, { color: color.ink }]}>
              Which technique was this?
            </Text>
            <TechniqueIntentPicker
              value={techniqueIntent}
              onChange={intent => {
                if (!current() || readOnly) return;
                selectionRef.current = {
                  techniqueIntent: intent,
                  declaredStroke: isDeclaredTechniqueIntent(intent)
                    ? intent.legacySlug
                    : null,
                };
                setTechniqueIntent(intent);
                setDeclared(
                  isDeclaredTechniqueIntent(intent) ? intent.legacySlug : null,
                );
              }}
            />
            {phase.errorMessage ? (
              <Text
                accessibilityRole="alert"
                style={[type.body, styles.scoreCopy]}
              >
                {phase.errorMessage}
              </Text>
            ) : null}
            <Button
              label="Confirm technique"
              variant="volt"
              disabled={readOnly || !isDeclaredTechniqueIntent(techniqueIntent)}
              onPress={() => {
                if (!current() || readOnly) return;
                void scoreCapture(
                  phase.captureId,
                  phase.clip,
                  phase.targetSeed,
                  phase.ownerContext,
                  phase,
                );
              }}
            />
            {phase.paywallRequired ? (
              <Button
                label="Upgrade to Pro"
                variant="dark"
                onPress={() => {
                  if (current())
                    leaveScreen(() =>
                      navigation.navigate('Paywall', { source: 'rating' }),
                    );
                }}
              />
            ) : null}
            {held ? (
              <Button
                label="Reload saved capture"
                variant="secondary"
                onPress={() => {
                  if (!current()) return;
                  leaveScreen(() =>
                    navigation.replace('Analyze', {
                      captureId: phase.captureId,
                    }),
                  );
                }}
              />
            ) : null}
            <Button label="Close" variant="ghost" onPress={closeConfirmation} />
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (phase.kind === 'analyzed') {
    // Honest strokeIntent surface: family-level auto reads, explicit
    // abstentions, and declared-vs-predicted disagreements. Scored results
    // without any of those never reach this phase (straight to Result).
    const { presentation, analysisId } = phase;
    const toneColor = presentation.tone === 'warn' ? color.ink : color.good;
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
        <StatusBar barStyle="dark-content" />
        <ScreenHeader
          title="Stroke analysis"
          onClose={() => {
            if (phaseCurrent()) leaveScreen(() => navigation.popToTop());
          }}
        />
        <View style={styles.stateBody} accessibilityLiveRegion="polite">
          <MascotStage
            compact
            pose={ANALYSIS_MASCOT_POSES.outcome}
            tone={presentation.tone === 'warn' ? 'warn' : 'court'}
            accessibilityLabel="Stroke analysis outcome"
            testID="analysis-mascot-outcome"
          />
          <Text
            style={[type.micro, styles.intentEyebrow, { color: toneColor }]}
          >
            {presentation.eyebrow}
          </Text>
          <Text style={[type.h1, styles.intentTitle]}>
            {presentation.title}
          </Text>
          <Text style={[type.body, styles.stateCopy]}>{presentation.body}</Text>
          <View style={styles.stateActions}>
            {presentation.showResult ? (
              <Button
                label="See the full read"
                variant="volt"
                onPress={() => {
                  if (phaseCurrent())
                    leaveScreen(() =>
                      navigation.replace('Result', { analysisId }),
                    );
                }}
              />
            ) : null}
            {confirmationBound.current ? (
              <Button
                label="Open Library"
                variant="dark"
                onPress={() => {
                  if (phaseCurrent())
                    leaveScreen(() =>
                      navigation.navigate('Tabs', { screen: 'Library' }),
                    );
                }}
              />
            ) : (
              <Button
                label={
                  source === 'library'
                    ? 'Import another video'
                    : 'Record another clip'
                }
                variant="dark"
                icon={source === 'library' ? 'upload' : 'camera'}
                onPress={() => {
                  if (phaseCurrent()) void run();
                }}
              />
            )}
            <Button
              label="Close"
              variant="ghost"
              onPress={() => {
                if (phaseCurrent()) leaveScreen(() => navigation.goBack());
              }}
            />
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (phase.kind === 'free_limit') {
    // The scored result is saved and one tap away — this popup only tells
    // the player their two free analyses are used up and Pro unlocks more.
    const { analysisId } = phase;
    const seeScore = () => {
      if (!screenCurrent() || phaseRef.current !== phase) return;
      usabilityFunnel.log('result_opened');
      leaveScreen(() => navigation.replace('Result', { analysisId }));
    };
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
        <StatusBar barStyle="dark-content" />
        <ScreenHeader title="Stroke analysis" onClose={seeScore} />
        <Modal
          visible
          transparent
          animationType="fade"
          onRequestClose={seeScore}
        >
          <View style={styles.freeLimitRoot}>
            <View
              accessibilityViewIsModal
              accessibilityLabel={`You've used ${freeAnalysesPhrase(
                freeRatingsLimit,
              )} free analyses`}
              style={styles.freeLimitDialog}
            >
              <MascotStage
                compact
                pose={ANALYSIS_MASCOT_POSES.outcome}
                icon="lock"
                tone="court"
                testID="analysis-mascot-free-limit"
              />
              <Text style={[type.h2, styles.freeLimitTitle]}>
                That was your last free analysis.
              </Text>
              <Text style={[type.body, styles.freeLimitBody]}>
                Your score is saved. You’ve used{' '}
                {freeAnalysesPhrase(freeRatingsLimit)} free analyses — upgrade
                to Pickle Sensei Pro to keep rating every swing.
              </Text>
              <View style={styles.freeLimitActions}>
                <Button
                  label="Upgrade to Pro"
                  variant="volt"
                  onPress={() => {
                    if (!screenCurrent() || phaseRef.current !== phase) return;
                    navigation.replace('Result', { analysisId });
                    if (
                      routeController.signal.aborted ||
                      !isDataOwnerContextCurrent(mountOwner.current) ||
                      currentAnalysisService() !== mountService ||
                      !executionIsCurrent(routeExecution.current)
                    )
                      return;
                    navigation.navigate('Paywall', { source: 'rating' });
                    leaveScreen(() => {});
                  }}
                />
                <Button
                  label="See my score"
                  variant="ghost"
                  onPress={seeScore}
                />
              </View>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    );
  }

  if (phase.kind === 'saved') {
    const { clip } = phase;
    const selectionCurrent = () =>
      phaseCurrent() &&
      !scoringActive.current &&
      !operationActive.current &&
      selectionRef.current.techniqueIntent === techniqueIntent &&
      selectionRef.current.declaredStroke === declaredStroke;
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
        <StatusBar barStyle="dark-content" />
        <ScreenHeader
          title="Capture complete"
          onClose={() => {
            if (phaseCurrent()) leaveScreen(() => navigation.popToTop());
          }}
        />
        <ScrollView
          contentContainerStyle={styles.savedContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.savedStatus}>
            <View style={styles.savedIcon}>
              <Icon
                name="check"
                color={color.onVolt}
                size={26}
                strokeWidth={2.4}
              />
            </View>
            <Text
              style={[
                type.micro,
                {
                  color:
                    clip.recognition.status === 'recognized'
                      ? color.good
                      : color.ink,
                },
              ]}
            >
              {clip.recognition.status === 'recognized'
                ? 'STROKE RECOGNIZED'
                : 'RATING NOT CONSUMED'}
            </Text>
          </View>

          <Text
            style={[
              type.hero,
              styles.savedTitle,
              clip.recognition.status === 'recognized' && {
                textTransform: 'capitalize',
              },
            ]}
          >
            {clipTitle(clip)}
          </Text>
          <Text style={[type.body, styles.savedCopy]}>
            {clipExplanation(clip)}
          </Text>

          <MascotMoment
            pose={ANALYSIS_MASCOT_POSES.outcome}
            tone={clip.recognition.status === 'recognized' ? 'court' : 'warn'}
            eyebrow="CAPTURE IN HAND"
            caption="Review the evidence, then choose how you want this swing analyzed."
            accessibilityLabel="Capture review guidance"
            testID="analysis-mascot-saved"
            style={styles.savedMascot}
          />

          <CaptureEvidenceCard clip={clip} />

          {clipSupportsScoring(clip) ? (
            <View style={styles.scoreSection}>
              <Text style={[type.h3, { color: color.ink }]}>
                Which stroke was this?
              </Text>
              <Text style={[type.caption, styles.scoreCopy]}>
                Your declaration selects the coaching targets. It is stored as
                your statement — separate from any model prediction — and the
                analyzer will say if what it measured disagrees.
              </Text>
              <StrokeDeclaration
                value={declaredStroke}
                onChange={stroke => {
                  if (!selectionCurrent()) return;
                  selectionRef.current = {
                    techniqueIntent: null,
                    declaredStroke: stroke,
                  };
                  setTechniqueIntent(null);
                  setDeclared(stroke);
                }}
              />
              {declaredStroke === null &&
              canAutoScoreWithoutDeclaration(clip, techniqueIntent) ? (
                <Text style={[type.caption, styles.scoreCopy]}>
                  Auto Detect is armed: analyze without declaring and the
                  classifier commits only to what it can defend — usually the
                  swing family, with an honest “couldn’t classify” otherwise.
                  Declaring a technique instead runs its exact coaching targets.
                </Text>
              ) : null}
              {importedClipNeedsTargetTap(clip, declaredStroke, targetSeed) ? (
                <TargetSelector
                  frameUri={clip.uri}
                  posterUri={clip.posterUri}
                  sourceWidth={clip.width}
                  sourceHeight={clip.height}
                  onConfirm={selection => {
                    if (!selectionCurrent()) return;
                    setTargetSeed(selection);
                    void scoreCapture(
                      phase.captureId,
                      clip,
                      selection,
                      phase.ownerContext,
                    );
                  }}
                  onSkip={() => {
                    if (!selectionCurrent()) return;
                    void scoreCapture(
                      phase.captureId,
                      clip,
                      null,
                      phase.ownerContext,
                    );
                  }}
                />
              ) : (
                <Button
                  label={
                    declaredStroke === null &&
                    canAutoScoreWithoutDeclaration(clip, techniqueIntent)
                      ? 'Analyze with Auto Detect'
                      : 'Get my Technique Score'
                  }
                  variant="volt"
                  disabled={
                    declaredStroke === null &&
                    !canAutoScoreWithoutDeclaration(clip, techniqueIntent)
                  }
                  onPress={() => {
                    if (!selectionCurrent()) return;
                    void scoreCapture(
                      phase.captureId,
                      clip,
                      targetSeed,
                      phase.ownerContext,
                    );
                  }}
                />
              )}
            </View>
          ) : (
            // Only pose-less guided captures land here: imported clips always
            // enter the scoring flow above via the tap-the-person selector.
            <View style={styles.scoreSection}>
              <Text style={[type.caption, styles.scoreCopy]}>
                This capture has no recorded pose sequence, so it cannot be
                scored.
              </Text>
            </View>
          )}

          <View style={styles.savedActions}>
            {confirmationBound.current ? (
              <Button
                label="Open Library"
                variant="dark"
                onPress={() => {
                  if (phaseCurrent())
                    leaveScreen(() =>
                      navigation.navigate('Tabs', { screen: 'Library' }),
                    );
                }}
              />
            ) : (
              <Button
                label={
                  source === 'library'
                    ? 'Import another video'
                    : 'Record another clip'
                }
                variant="dark"
                icon={source === 'library' ? 'upload' : 'camera'}
                onPress={() => {
                  if (phaseCurrent()) void run();
                }}
              />
            )}
            <Button
              label="Open Library"
              variant="ghost"
              onPress={() => {
                if (phaseCurrent())
                  leaveScreen(() =>
                    navigation.navigate('Tabs', { screen: 'Library' }),
                  );
              }}
            />
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.darkScreen}>
      <StatusBar barStyle="light-content" />
      <ScreenHeader
        dark
        title="Auto Analyze"
        onClose={() => {
          if (phaseCurrent()) leaveScreen(() => navigation.goBack());
        }}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        testID="analyze-setup-content"
      >
        <Text style={[type.micro, { color: color.volt }]}>
          AUTOMATIC CAPTURE
        </Text>
        <Text style={[type.hero, styles.hero]}>
          Tap record.{`\n`}Swing once.
        </Text>
        <Text style={[type.body, styles.heroCopy]}>
          Prop the phone side-on at waist height. Tap record, match the outline
          and swing naturally — your stroke is captured by itself, or tap stop
          to analyze what you have.
        </Text>

        <MascotMoment
          dark
          pose={ANALYSIS_MASCOT_POSES.ready}
          tone="volt"
          eyebrow="YOUR COURT-SIDE COACH"
          caption="Choose a technique, frame one natural swing, and Sensei handles the read."
          accessibilityLabel="Camera setup guidance"
          testID="analysis-mascot-ready"
          style={styles.readyMascot}
        />

        <Text style={[type.micro, styles.declareEyebrow]}>
          WHAT ARE YOU WORKING ON?
        </Text>
        <TechniqueIntentPicker
          dark
          value={techniqueIntent}
          onChange={intent => {
            if (
              !phaseCurrent() ||
              scoringActive.current ||
              operationActive.current ||
              selectionRef.current.techniqueIntent !== techniqueIntent ||
              selectionRef.current.declaredStroke !== declaredStroke
            )
              return;
            selectionRef.current = {
              techniqueIntent: intent,
              declaredStroke: intent?.legacySlug ?? null,
            };
            usabilityFunnel.log(
              'intent_selected',
              intent === null
                ? 'cleared'
                : intent.source === 'auto'
                  ? 'AUTO'
                  : (intent.canonical ?? intent.legacySlug ?? 'unknown'),
            );
            setTechniqueIntent(intent);
            // The legacy capture/analysis chain consumes the slug; the
            // canonical intent (incl. voice provenance) rides alongside.
            setDeclared(intent?.legacySlug ?? null);
          }}
        />

        <CameraMockPreview />

        <View style={styles.steps}>
          {ANALYZE_STEPS.map(step => (
            <StepRow
              key={step.index}
              index={step.index}
              icon={step.icon}
              title={step.title}
              detail={step.detail}
            />
          ))}
        </View>

        <View style={styles.notes}>
          <View style={styles.noteRow}>
            <Icon name="shield" color={color.onDarkMuted} size={18} />
            <Text style={[type.caption, styles.noteCopy]}>
              Camera processing and clip storage stay on this device unless you
              explicitly enable cloud video sync.
            </Text>
          </View>
          <View style={styles.noteRow}>
            <Icon name="stroke" color={color.onDarkMuted} size={18} />
            <Text style={[type.caption, styles.noteCopy]}>
              You’ll see your exoskeleton and a light motion heat map live, then
              a frame-by-frame form review after the swing.
            </Text>
          </View>
        </View>
        {offlineJourney ? (
          <OfflineAllocationCard
            dark
            state={offlineJourney}
            style={styles.offlineCard}
          />
        ) : null}
        {accessibleLayout ? (
          <Text style={[type.caption, styles.footerHint]}>
            Camera opens first. You control record.
          </Text>
        ) : null}
      </ScrollView>
      <View style={styles.footer} testID="analyze-camera-actions">
        {accessibleLayout ? null : (
          <Text style={[type.caption, styles.footerHint]}>
            Camera opens first. You control record.
          </Text>
        )}
        <Button
          label="Open automatic camera"
          largeTextLabel="Open camera"
          variant="volt"
          icon="camera"
          onPress={() => {
            if (phaseCurrent()) void run();
          }}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  darkScreen: { flex: 1, backgroundColor: color.surfaceDark },
  freeLimitRoot: {
    flex: 1,
    backgroundColor: color.overlayStrong,
    justifyContent: 'center',
    alignItems: 'center',
    padding: space.lg,
  },
  freeLimitDialog: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: color.surface,
    borderRadius: radius.xl,
    padding: space.lg,
    alignItems: 'center',
  },
  freeLimitTitle: {
    color: color.ink,
    marginTop: space.md,
    textAlign: 'center',
  },
  freeLimitBody: {
    color: color.inkSoft,
    marginTop: space.sm,
    textAlign: 'center',
  },
  freeLimitActions: {
    alignSelf: 'stretch',
    marginTop: space.lg,
    gap: space.sm,
  },
  declareEyebrow: { color: color.onDarkSubtle, marginTop: space.lg },
  strokeChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: space.md,
  },
  strokeChip: {
    paddingHorizontal: 14,
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surfaceElevated,
  },
  strokeChipDark: {
    borderColor: color.lineMutedDark,
    backgroundColor: color.inkElevated,
  },
  strokeChipSelected: {
    borderColor: color.volt,
    backgroundColor: color.volt,
  },
  strokeChipLabel: { color: color.ink },
  scoreSection: { marginTop: space.xl, gap: space.md },
  scoreCopy: { color: color.inkSoft },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xl,
  },
  hero: { color: color.onDark, marginTop: space.sm },
  heroCopy: { color: color.onDarkSubtle, marginTop: space.sm, maxWidth: 340 },
  readyMascot: { marginTop: space.xl },
  preview: {
    height: PREVIEW_HEIGHT,
    marginTop: space.xl,
    paddingTop: FRAME_TOP,
    alignItems: 'center',
    borderRadius: radius.xl,
    overflow: 'hidden',
    backgroundColor: color.cameraSurface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineDark,
  },
  previewFrame: {
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewBrackets: { position: 'absolute', top: 0, left: 0, opacity: 0.72 },
  previewSilhouette: {
    width: SILHOUETTE_WIDTH,
    height: SILHOUETTE_HEIGHT,
    tintColor: color.onDark,
    opacity: 0.32,
  },
  // The camera's status card: left-aligned glass, dot + kicker, one line.
  previewStatus: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 3,
    borderRadius: radius.md,
    backgroundColor: color.overlayStrong,
    borderWidth: 1,
    borderColor: color.onDarkTint,
  },
  previewStatusKicker: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  previewStatusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.mint,
  },
  previewStatusDetail: { color: color.onDark },
  previewShutterRow: {
    position: 'absolute',
    bottom: 14,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  previewShutterRing: {
    width: SHUTTER_RING,
    height: SHUTTER_RING,
    borderRadius: SHUTTER_RING / 2,
    borderWidth: 3,
    borderColor: color.onDark,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewShutterCore: {
    width: SHUTTER_CORE,
    height: SHUTTER_CORE,
    borderRadius: SHUTTER_CORE / 2,
    backgroundColor: color.volt,
  },
  steps: {
    marginTop: space.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.lineDark,
  },
  stepRow: {
    minHeight: 84,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.lineDark,
  },
  stepIcon: {
    width: 42,
    height: 42,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.inkElevated,
  },
  stepIndex: { color: color.onDarkMuted, marginBottom: space.xxs },
  stepTitle: { color: color.onDark },
  stepDetail: { color: color.onDarkSubtle, marginTop: 3 },
  notes: { paddingVertical: space.lg, gap: space.md },
  noteRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  noteCopy: { color: color.onDarkSubtle, flex: 1 },
  offlineCard: { marginBottom: space.lg },
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    gap: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.lineDark,
    backgroundColor: color.surfaceDark,
  },
  footerHint: { color: color.onDarkSubtle, textAlign: 'center' },
  workingBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
  },
  workingTitle: {
    color: color.onDark,
    textAlign: 'center',
    marginTop: space.lg,
  },
  workingCopy: {
    color: color.onDarkSubtle,
    textAlign: 'center',
    marginTop: space.sm,
    maxWidth: 340,
  },
  stateBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
  },
  stateScrollBody: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    paddingVertical: space.lg,
  },
  stateTitle: { color: color.ink, textAlign: 'center', marginTop: space.lg },
  intentEyebrow: { textAlign: 'center', marginTop: space.lg },
  intentTitle: { color: color.ink, textAlign: 'center', marginTop: space.sm },
  stateCopy: {
    color: color.inkSoft,
    textAlign: 'center',
    marginTop: space.sm,
    maxWidth: 340,
  },
  stateActions: { alignSelf: 'stretch', gap: 10, marginTop: space.xl },
  savedContent: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xl,
  },
  savedStatus: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  savedIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.volt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  savedTitle: { color: color.ink, marginTop: space.lg },
  savedCopy: { color: color.inkSoft, marginTop: space.md, maxWidth: 370 },
  savedMascot: { marginTop: space.lg },
  savedActions: { gap: 10, marginTop: space.xl },
});
