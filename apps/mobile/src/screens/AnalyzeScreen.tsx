import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Modal,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Line, Path, Rect } from 'react-native-svg';
import {
  useNavigation,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Button, PressableScale, ScreenHeader } from '../design/components';
import { Icon, type IconName } from '../design/icons';
import { color, radius, shadow, space, type } from '../design/tokens';
import {
  cancelCameraOperation,
  captureStrokeVideo,
  extractImportedPoseSequence,
  importedPoseExtractionAvailable,
  importStrokeVideo,
  subscribeToCameraEvents,
  type CameraEvent,
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
  savePendingCapture,
  setCaptureTargetSeed,
  setDeclaredStroke,
} from '../data/repository';
import { runCaptureAnalysis } from '../analysis/runCaptureAnalysis';
import { getApiSession } from '../account/apiSession';
import { useAppStore } from '../state/appStore';
import { makeUuid } from '../util/uuid';
import {
  SHOT_TYPES,
  type ShotTypeSlug,
  type TechniqueIntent,
} from '@pickle/shared-types';
import type { CaptureAnalysisRecord } from '@pickle/analysis-pipeline';
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
  clearTryAgainHandoff,
  consumeTryAgainHandoff,
  techniqueIntentFromHandoff,
} from './tryAgainHandoff';
import { usabilityFunnel } from '../analysis/usabilityTelemetry';
import { stabilitySlo } from '../analysis/stabilityTelemetry';

type Phase =
  | { kind: 'ready' }
  | { kind: 'working'; message: string }
  | { kind: 'saved'; clip: CapturedClip; captureId: string }
  | {
      kind: 'analyzed';
      analysisId: string;
      presentation: StrokeIntentPresentation;
    }
  | {
      /** Scored run that consumed the LAST free rating: upgrade prompt. */
      kind: 'free_limit';
      analysisId: string;
    }
  | { kind: 'error'; message: string };

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
        <Icon name={props.icon} color={color.courtDeep} size={19} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[type.micro, styles.stepIndex]}>{props.index}</Text>
        <Text style={[type.bodyBold, styles.stepTitle]}>{props.title}</Text>
        <Text style={[type.caption, styles.stepDetail]}>{props.detail}</Text>
      </View>
    </View>
  );
}

function FramingPreview() {
  return (
    <View style={styles.preview} accessibilityLabel="Camera framing guide">
      <Svg width="100%" height="100%" viewBox="0 0 340 236">
        <Rect
          x="1"
          y="1"
          width="338"
          height="234"
          rx="28"
          fill={color.cameraSurface}
        />
        <Path
          d="M28 63V32h31M281 32h31v31M28 173v31h31M281 204h31v-31"
          stroke={color.onDark}
          strokeWidth="2.5"
          fill="none"
          strokeLinecap="round"
        />
        <Line
          x1="42"
          y1="178"
          x2="298"
          y2="178"
          stroke={color.lineDark}
          strokeWidth="2"
        />
        <Line
          x1="170"
          y1="178"
          x2="170"
          y2="214"
          stroke={color.lineDark}
          strokeWidth="1"
        />
        <Line
          x1="84"
          y1="178"
          x2="59"
          y2="214"
          stroke={color.lineDark}
          strokeWidth="1"
        />
        <Line
          x1="256"
          y1="178"
          x2="281"
          y2="214"
          stroke={color.lineDark}
          strokeWidth="1"
        />
      </Svg>
      <View style={styles.previewCenter}>
        <View style={styles.previewCameraIcon}>
          <Icon name="camera" color={color.onVolt} size={25} />
        </View>
        <Text style={[type.h3, { color: color.onDark, marginTop: 12 }]}>
          Live body heat map
        </Text>
        <Text style={[type.caption, styles.previewCopy]}>
          Your body lights up with measured motion heat only when the camera
          actually sees you — cool at rest, blazing at full swing speed.
        </Text>
      </View>
      <View style={styles.previewBadge}>
        <View style={styles.previewDot} />
        <Text style={[type.micro, { color: color.onDark }]}>AUTO CAPTURE</Text>
      </View>
    </View>
  );
}

/**
 * The guided-capture walkthrough, as data so the zero-handholding protocol
 * (docs/USABILITY_ZERO_HANDHOLDING.md) can assert every funnel task the
 * user must perform unaided has an on-screen instruction. Order matters:
 * it is the order the user acts in.
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
    title: 'Step fully into frame',
    detail:
      'Place the phone at waist height and keep your full body inside the corners.',
  },
  {
    index: '02',
    icon: 'court',
    title: 'Tap where you will start',
    detail:
      'On the live camera, tap your starting spot, then walk out to it — the person standing there is who gets analyzed.',
  },
  {
    index: '03',
    icon: 'spark',
    title: 'Wait for Ready',
    detail:
      'Live pose landmarks turn the camera into an automatic trigger—no timer or shutter.',
  },
  {
    index: '04',
    icon: 'camera',
    title: 'Make one natural stroke',
    detail:
      'The saved clip includes two seconds before motion and 1.5 seconds after it.',
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
          'declare the technique for the most precise read.',
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

export function AnalyzeScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const route = useRoute<RouteProp<RootStackParams, 'Analyze'>>();
  const source = route.params?.source ?? 'camera';
  // TRY AGAIN loop (MOBBIN brief §2): a Result screen hands the ORIGINAL
  // run's technique intent back here; it is consumed exactly once (lazy
  // initializer) and seeds the picker/zero-touch gate so the player skips
  // re-picking and goes straight back to their spot.
  const [rearm] = useState(() => {
    if (source === 'camera') return consumeTryAgainHandoff();
    // An import run is not a re-arm: drop any armed handoff so it cannot
    // seed a later capture with the abandoned run's declaration.
    clearTryAgainHandoff();
    return null;
  });
  const [phase, setPhase] = useState<Phase>({ kind: 'ready' });
  const [declaredStroke, setDeclared] = useState<ShotTypeSlug | null>(
    rearm?.declaredStroke ?? null,
  );
  const [techniqueIntent, setTechniqueIntent] =
    useState<TechniqueIntent | null>(
      rearm ? techniqueIntentFromHandoff(rearm) : null,
    );
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
  const operationActive = useRef(false);
  const scoringActive = useRef(false);
  const autoLaunchStarted = useRef(false);
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
            message: 'Motion captured — saving the motion window…',
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
          }
          if (event.state === 'extracting') {
            setPhase({ kind: 'working', message: 'Reading player movement…' });
          }
        }
      }),
    [],
  );

  // Zero-handholding funnel (docs/USABILITY_ZERO_HANDHOLDING.md): observe
  // the surface, never gate it. Logged exactly once per mount.
  useEffect(() => {
    usabilityFunnel.log('analyze_opened', source);
    if (rearm) usabilityFunnel.log('try_again_rearm');
  }, []);

  const scoreCapture = useCallback(
    async (
      captureId: string,
      clip: CapturedClip,
      targetSeed: TargetSelection | null,
    ) => {
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
      if (scoringActive.current) return;
      scoringActive.current = true;
      const session = getApiSession();
      // Imported clips carry no recorded pose sequence until the explicit
      // native extraction pass runs. When the bridge method exists, this run
      // measures the sequence now (seeded by the user's tap when there is
      // one); when it doesn't, the clip proceeds unchanged and
      // runCaptureAnalysis keeps its honest unavailable message.
      const needsPoseExtraction =
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
        // The declaration column records USER statements only — an AUTO run
        // writes nothing there; the prediction lives in the analysis record.
        if (declaredStroke) {
          await setDeclaredStroke(getDb(), captureId, declaredStroke);
        }
        // The tap is user input tied to the capture: persist it with the
        // row so it survives restarts and stays available to any later
        // analysis pass, whether or not this run can analyze the clip.
        if (targetSeed) {
          await setCaptureTargetSeed(getDb(), captureId, targetSeed);
        }
        let analysisClip = clip;
        if (needsPoseExtraction && clip.captureMode === 'imported_video') {
          // Arm the extraction progress surface BEFORE the native pass
          // starts so its very first event finds the active run. The bar
          // stays indeterminate until native reports a real fraction.
          extractionRun.current = { nativeCaptureId: null, eta: null };
          setAnalysisProgress(extractionProgress(null));
          try {
            const extraction = await extractImportedPoseSequence(
              clip,
              targetSeed?.point ?? null,
            );
            // A NEW clip object for this run only — the saved capture row
            // keeps the original import payload untouched.
            analysisClip = {
              ...clip,
              poseSequence: extraction.poseSequence,
              ...(extraction.posterUri !== undefined
                ? { posterUri: extraction.posterUri }
                : {}),
            };
          } catch (error) {
            const message = importedPoseExtractionFailureMessage(error);
            usabilityFunnel.log('error_shown', message);
            setPhase({ kind: 'error', message });
            return;
          } finally {
            extractionRun.current = null;
          }
          setPhase({ kind: 'working', message: 'Measuring your swing…' });
        }
        setAnalysisProgress(analysisStageProgress('measuring'));
        const outcome = await runCaptureAnalysis({
          db: getDb(),
          captureId,
          clip: analysisClip,
          declaredStroke,
          declaredCanonical: techniqueIntent?.canonical ?? null,
          handedness: profile?.handedness ?? 'right',
          cameraView: 'side',
          apiConfig: {
            baseUrl: session?.apiBaseUrl ?? '',
            token: session?.bearerToken ?? null,
          },
          appVersion: '0.1.0',
          focusCheckpoint: profile?.focusCheckpoint,
          targetSeed,
          captureEnvelope:
            clip.captureMode === 'automatic_pose_trigger'
              ? attemptCaptureEnvelope(
                  clip,
                  attemptEvidence.current.quality,
                  attemptEvidence.current.readiness,
                )
              : null,
        });
        // The measured/saved boundary lives inside runCaptureAnalysis (no
        // incremental signal is exposed); once it returns, the remaining
        // work is routing the already-persisted outcome.
        setAnalysisProgress(analysisStageProgress('saving'));
        if (outcome.kind === 'unavailable') {
          usabilityFunnel.log('error_shown', outcome.reason);
          setPhase({ kind: 'error', message: outcome.reason });
          return;
        }
        if (outcome.kind === 'quality_blocked') {
          // Honest abstention: nothing was analyzed or rated. The message
          // carries the actionable guidance for every failing dimension.
          usabilityFunnel.log('error_shown', outcome.reason);
          setPhase({
            kind: 'error',
            message: qualityBlockedMessage(outcome.reason, outcome.envelope),
          });
          return;
        }
        if (outcome.kind === 'scored') {
          // Score first: every scored run goes straight to the Result
          // screen. When this run consumed the account's FINAL free
          // rating, the upgrade prompt is surfaced once, on top of it.
          if (outcome.freeLimitReached) {
            usabilityFunnel.log('free_limit_prompt_shown');
            setPhase({ kind: 'free_limit', analysisId: outcome.analysisId });
            return;
          }
          usabilityFunnel.log('result_opened');
          navigation.replace('Result', { analysisId: outcome.analysisId });
          return;
        }
        // Non-scored outcomes (family-level low reads, honest abstentions,
        // disagreement-only records) are surfaced with actionable guidance.
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
        navigation.replace('Result', { analysisId: outcome.analysisId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        usabilityFunnel.log('error_shown', message);
        setPhase({ kind: 'error', message });
      } finally {
        scoringActive.current = false;
        // The progress surface describes ONE scoring run; it never outlives
        // it (error surfaces and the next run start clean).
        extractionRun.current = null;
        setAnalysisProgress(null);
      }
    },
    [declaredStroke, navigation, profile, techniqueIntent],
  );

  const run = useCallback(async () => {
    if (operationActive.current) return;
    operationActive.current = true;
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
      const clip =
        source === 'library'
          ? await importStrokeVideo()
          : await captureStrokeVideo();
      if (source === 'camera') {
        stabilitySlo.record({ kind: 'camera_startup_succeeded' });
      }
      const captureId = makeUuid();
      const shotType =
        clip.recognition.status === 'recognized'
          ? clip.recognition.shotType
          : 'unrecognized';
      await savePendingCapture(
        getDb(),
        captureId,
        shotType,
        clip,
        declaredStroke,
      );
      if (
        clip.captureMode === 'automatic_pose_trigger' &&
        (declaredStroke !== null ||
          canAutoScoreWithoutDeclaration(clip, techniqueIntent))
      ) {
        // ZERO-TOUCH PATH: technique declared — or Auto Detect explicitly
        // armed — before recording, target tapped live in the camera, motion
        // auto-captured and auto-finalized, so analysis starts without any
        // further interaction. Auto runs route declared=null through the
        // classifier ladder; they never invent a declaration.
        const liveSeed = clip.targetSeed
          ? {
              point: { x: clip.targetSeed.x, y: clip.targetSeed.y },
              selectedAtIso: new Date().toISOString(),
            }
          : null;
        usabilityFunnel.log('capture_saved', captureSavedDetail(clip));
        setPhase({ kind: 'saved', clip, captureId });
        void scoreCapture(captureId, clip, liveSeed);
        return;
      }
      usabilityFunnel.log('capture_saved', captureSavedDetail(clip));
      setPhase({ kind: 'saved', clip, captureId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('cancel')) {
        // User cancel is not a startup failure.
        usabilityFunnel.log('attempt_abandoned');
        if (source === 'library') navigation.goBack();
        else setPhase({ kind: 'ready' });
      } else {
        if (source === 'camera') {
          stabilitySlo.record({
            kind: 'camera_startup_failed',
            reason: 'guided_capture_error',
          });
        }
        usabilityFunnel.log('error_shown', message);
        setPhase({ kind: 'error', message });
      }
    } finally {
      operationActive.current = false;
    }
  }, [declaredStroke, navigation, scoreCapture, source, techniqueIntent]);

  // Library imports auto-launch (no declaration is useful for them yet);
  // guided capture waits for the user to declare a stroke and start.
  useEffect(() => {
    if (source !== 'library' || autoLaunchStarted.current) return;
    autoLaunchStarted.current = true;
    const timer = setTimeout(() => void run(), 160);
    return () => clearTimeout(timer);
  }, [run, source]);

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

  useEffect(
    () => () => {
      if (operationActive.current) cancelCameraOperation();
    },
    [],
  );

  if (phase.kind === 'working') {
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.darkScreen}>
        <StatusBar barStyle="light-content" />
        <ScreenHeader
          dark
          title={source === 'library' ? 'Import video' : 'Auto Analyze'}
          onClose={() => {
            cancelCameraOperation();
            navigation.goBack();
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
            <View style={styles.processingOrb}>
              <Icon
                name={source === 'library' ? 'upload' : 'camera'}
                color={color.onVolt}
                size={30}
              />
            </View>
            <Text style={[type.h2, styles.workingTitle]}>{phase.message}</Text>
            <Text style={[type.body, styles.workingCopy]}>
              {source === 'library'
                ? 'The selected file is copied into protected app storage before anything else happens.'
                : 'The native camera guides framing, waits for a stable full-body read, and captures the stroke automatically.'}
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
          title="Capture interrupted"
          onClose={() => navigation.goBack()}
        />
        <View style={styles.stateBody} accessibilityRole="alert">
          <View style={[styles.stateIcon, { backgroundColor: color.badSoft }]}>
            <Icon name="close" color={color.bad} size={23} />
          </View>
          <Text style={[type.h1, styles.stateTitle]}>Nothing was rated.</Text>
          <Text style={[type.body, styles.stateCopy]}>{phase.message}</Text>
          <View style={styles.stateActions}>
            <Button
              label="Try again"
              variant="dark"
              onPress={() => void run()}
            />
            <Button
              label="Close"
              variant="ghost"
              onPress={() => navigation.goBack()}
            />
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (phase.kind === 'analyzed') {
    // Honest strokeIntent surface: family-level auto reads, explicit
    // abstentions, and declared-vs-predicted disagreements. Scored results
    // without any of those never reach this phase (straight to Result).
    const { presentation, analysisId } = phase;
    const toneColor = presentation.tone === 'warn' ? color.warn : color.good;
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
        <StatusBar barStyle="dark-content" />
        <ScreenHeader
          title="Stroke analysis"
          onClose={() => navigation.popToTop()}
        />
        <View style={styles.stateBody} accessibilityLiveRegion="polite">
          <View
            style={[
              styles.stateIcon,
              {
                backgroundColor:
                  presentation.tone === 'warn'
                    ? color.warnSoft
                    : color.goodSoft,
              },
            ]}
          >
            <Icon
              name={presentation.tone === 'warn' ? 'shield' : 'spark'}
              color={toneColor}
              size={23}
            />
          </View>
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
                onPress={() => navigation.replace('Result', { analysisId })}
              />
            ) : null}
            <Button
              label={
                source === 'library' ? 'Import another' : 'Capture another'
              }
              variant="dark"
              icon={source === 'library' ? 'upload' : 'camera'}
              onPress={() => void run()}
            />
            <Button
              label="Close"
              variant="ghost"
              onPress={() => navigation.goBack()}
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
      usabilityFunnel.log('result_opened');
      navigation.replace('Result', { analysisId });
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
              accessibilityLabel="You've used both free analyses"
              style={styles.freeLimitDialog}
            >
              <View style={styles.freeLimitIcon}>
                <Icon name="spark" color={color.court} size={24} />
              </View>
              <Text style={[type.h2, styles.freeLimitTitle]}>
                That was your last free analysis.
              </Text>
              <Text style={[type.body, styles.freeLimitBody]}>
                Your score is saved. You’ve used both free analyses — upgrade
                to Pickle Sensei Pro to keep rating every swing.
              </Text>
              <View style={styles.freeLimitActions}>
                <Button
                  label="Upgrade to Pro"
                  variant="volt"
                  onPress={() => {
                    navigation.replace('Result', { analysisId });
                    navigation.navigate('Paywall', { source: 'rating' });
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
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
        <StatusBar barStyle="dark-content" />
        <ScreenHeader
          title="Capture complete"
          onClose={() => navigation.popToTop()}
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
                      : color.warn,
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
                onChange={setDeclared}
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
                    setTargetSeed(selection);
                    void scoreCapture(phase.captureId, clip, selection);
                  }}
                  onSkip={() => void scoreCapture(phase.captureId, clip, null)}
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
                  onPress={() =>
                    void scoreCapture(phase.captureId, clip, targetSeed)
                  }
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
            <Button
              label={
                source === 'library' ? 'Import another' : 'Capture another'
              }
              variant="dark"
              icon={source === 'library' ? 'upload' : 'camera'}
              onPress={() => void run()}
            />
            <Button
              label="Open Library"
              variant="ghost"
              onPress={() => navigation.navigate('Tabs', { screen: 'Library' })}
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
        onClose={() => navigation.goBack()}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[type.micro, { color: color.volt }]}>
          AUTOMATIC CAPTURE
        </Text>
        <Text style={[type.hero, styles.hero]}>
          Set the phone.{`\n`}Swing naturally.
        </Text>
        <Text style={[type.body, styles.heroCopy]}>
          The camera finds your body, waits until the frame is stable, and
          captures a complete motion window — including the full pose sequence
          for scoring.
        </Text>

        <Text style={[type.micro, styles.declareEyebrow]}>
          WHAT ARE YOU WORKING ON?
        </Text>
        <TechniqueIntentPicker
          dark
          value={techniqueIntent}
          onChange={intent => {
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

        <FramingPreview />

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

        <View style={styles.trustRow}>
          <Icon name="shield" color={color.mint} size={18} />
          <Text style={[type.caption, styles.trustCopy]}>
            Camera processing and clip storage stay on this device unless you
            explicitly enable cloud video sync.
          </Text>
        </View>
        <View style={styles.measurementDisclosure}>
          <Icon name="spark" color={color.volt} size={18} />
          <Text style={[type.caption, styles.measurementCopy]}>
            The body glow reflects measured joint motion. Ball speed stays
            withheld until a calibrated ball tracker can support a real MPH
            reading.
          </Text>
        </View>
      </ScrollView>
      <View style={styles.footer}>
        <Button
          label="Open automatic camera"
          variant="volt"
          icon="camera"
          onPress={() => void run()}
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
  freeLimitIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: color.goodSoft,
    alignItems: 'center',
    justifyContent: 'center',
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
  declareEyebrow: { color: color.onDarkSubtle, marginTop: space.xl },
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
  heroCopy: { color: color.onDarkSubtle, marginTop: space.md, maxWidth: 370 },
  preview: {
    height: 250,
    marginTop: space.xl,
    borderRadius: radius.xl,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineDark,
  },
  previewCenter: {
    position: 'absolute',
    left: 44,
    right: 44,
    top: 66,
    alignItems: 'center',
  },
  previewCameraIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: color.volt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewCopy: {
    color: color.onDarkSubtle,
    textAlign: 'center',
    marginTop: 5,
  },
  previewBadge: {
    position: 'absolute',
    top: 16,
    left: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: color.overlayDeep,
  },
  previewDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: color.volt,
  },
  steps: {
    marginTop: space.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.lineDark,
  },
  stepRow: {
    minHeight: 94,
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
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.volt,
  },
  stepIndex: { color: color.mint, marginBottom: 2 },
  stepTitle: { color: color.onDark },
  stepDetail: { color: color.onDarkSubtle, marginTop: 3 },
  trustRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: space.lg,
  },
  trustCopy: { color: color.onDarkSubtle, flex: 1 },
  measurementDisclosure: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: color.inkElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineDark,
  },
  measurementCopy: { color: color.onDarkSubtle, flex: 1 },
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.lineDark,
    backgroundColor: color.surfaceDark,
  },
  workingBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
  },
  processingOrb: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.volt,
    ...shadow.floating,
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
  stateIcon: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
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
  savedActions: { gap: 10, marginTop: space.xl },
});
