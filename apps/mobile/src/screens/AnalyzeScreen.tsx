import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
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
  importStrokeVideo,
  subscribeToCameraEvents,
  type CameraEvent,
  type CapturedClip,
  type CaptureQualitySignalsV1,
} from '../camera/capture';
import { CaptureEvidenceCard } from '../camera/CaptureEvidenceCard';
import { CaptureGuidancePanel } from '../camera/CaptureGuidancePanel';
import {
  attemptCaptureEnvelope,
  liveCaptureEnvelope,
  type ReadinessSnapshot,
} from '../camera/captureEnvelope';
import type { EnvelopeVerdict } from '@pickle/shared-types';
import { TargetSelector, type TargetSelection } from '../camera/TargetSelector';
import { getDb } from '../data/db';
import { savePendingCapture, setDeclaredStroke } from '../data/repository';
import { runCaptureAnalysis } from '../analysis/runCaptureAnalysis';
import { getApiSession } from '../account/apiSession';
import { useAppStore } from '../state/appStore';
import { makeUuid } from '../util/uuid';
import {
  MVP_SHOT_TYPES,
  type MvpShotTypeSlug,
  type TechniqueIntent,
} from '@pickle/shared-types';
import type { CaptureAnalysisRecord } from '@pickle/analysis-pipeline';
import { TechniqueIntentPicker } from '../flow/TechniqueIntentPicker';
import type { RootStackParams } from '../navigation/params';
import { StrokeResultAnalyzing } from '../components/StrokeResult';
import {
  consumeTryAgainHandoff,
  techniqueIntentFromHandoff,
} from './tryAgainHandoff';

type Phase =
  | { kind: 'ready' }
  | { kind: 'working'; message: string }
  | { kind: 'saved'; clip: CapturedClip; captureId: string }
  | {
      kind: 'analyzed';
      analysisId: string;
      presentation: StrokeIntentPresentation;
    }
  | { kind: 'error'; message: string };

const READINESS_COPY: Record<string, string> = {
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
          Live pose guide
        </Text>
        <Text style={[type.caption, styles.previewCopy]}>
          Your skeleton and motion glow appear only when the camera actually
          sees you.
        </Text>
      </View>
      <View style={styles.previewBadge}>
        <View style={styles.previewDot} />
        <Text style={[type.micro, { color: color.onDark }]}>AUTO CAPTURE</Text>
      </View>
    </View>
  );
}

const STROKE_LABELS: Record<MvpShotTypeSlug, string> = {
  forehand_drive: 'Forehand drive',
  dink: 'Dink',
  third_shot_drop: 'Third-shot drop',
  serve: 'Serve',
};

/**
 * Stroke declaration — the user's statement of intent, stored separately
 * from any model prediction. A validated classifier will later make this
 * optional without changing anything downstream.
 */
function StrokeDeclaration(props: {
  value: MvpShotTypeSlug | null;
  onChange: (value: MvpShotTypeSlug) => void;
  dark?: boolean;
}) {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel="Which stroke are you practicing?"
      style={styles.strokeChips}
    >
      {MVP_SHOT_TYPES.map(slug => {
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
  declaredStroke: MvpShotTypeSlug | null,
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
 * pose sequence. Imported videos stay declared-only: runCaptureAnalysis
 * honestly rejects them before stroke routing (no recorded pose sequence),
 * so offering AUTO there would promise a read that cannot happen.
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
          `The classifier committed to the ${side.toLowerCase()} swing family, ` +
          'not to an exact stroke — separating a drive from a dink or volley ' +
          'needs ball-bounce data this build doesn’t measure. The family-level ' +
          'read is saved with your capture; no per-technique score was ' +
          'invented and this did not use a rating.',
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

function clipTitle(clip: CapturedClip) {
  if (clip.recognition.status !== 'recognized')
    return 'Captured. Label withheld.';
  return clip.recognition.shotType.replace(/_/g, ' ');
}

function clipExplanation(clip: CapturedClip) {
  if (clip.recognition.status === 'recognized') {
    return `Recognized at ${Math.round(
      clip.recognition.confidence * 100,
    )}% confidence by ${
      clip.recognition.modelVersion
    }. Technique scoring will run only when its validated model bundle is available.`;
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
  const [rearm] = useState(() =>
    source === 'camera' ? consumeTryAgainHandoff() : null,
  );
  const [phase, setPhase] = useState<Phase>({ kind: 'ready' });
  const [declaredStroke, setDeclared] = useState<MvpShotTypeSlug | null>(
    (rearm?.declaredStroke as MvpShotTypeSlug | null) ?? null,
  );
  const [techniqueIntent, setTechniqueIntent] =
    useState<TechniqueIntent | null>(
      rearm ? techniqueIntentFromHandoff(rearm) : null,
    );
  const [targetSeed, setTargetSeed] = useState<TargetSelection | null>(null);
  const [captureEnvelope, setCaptureEnvelope] =
    useState<EnvelopeVerdict | null>(null);
  // Last measured live signals, kept for the attempt-time envelope: the
  // readiness read closest to the swing and the latest native quality
  // signals (null until an emitter exists — those dims stay NOT_MEASURED).
  const lastReadiness = useRef<ReadinessSnapshot | null>(null);
  const lastQuality = useRef<CaptureQualitySignalsV1 | null>(null);
  const profile = useAppStore(s => s.profile);
  const operationActive = useRef(false);
  const scoringActive = useRef(false);
  const autoLaunchStarted = useRef(false);

  useEffect(
    () =>
      subscribeToCameraEvents((event: CameraEvent) => {
        if (event.type === 'readiness') {
          lastReadiness.current = {
            state: event.state,
            jointCoverage: event.jointCoverage,
          };
          setCaptureEnvelope(
            liveCaptureEnvelope(lastReadiness.current, lastQuality.current),
          );
          setPhase({
            kind: 'working',
            message: READINESS_COPY[event.state] ?? 'Reading your position…',
          });
        } else if (event.type === 'capture_quality') {
          lastQuality.current = event.signals;
          setCaptureEnvelope(
            liveCaptureEnvelope(lastReadiness.current, lastQuality.current),
          );
        } else if (event.type === 'stroke_detected') {
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
        }
      }),
    [],
  );

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
      setPhase({
        kind: 'working',
        message: declaredStroke
          ? 'Measuring your swing…'
          : 'Measuring your swing and reading the stroke…',
      });
      try {
        // The declaration column records USER statements only — an AUTO run
        // writes nothing there; the prediction lives in the analysis record.
        if (declaredStroke) {
          await setDeclaredStroke(getDb(), captureId, declaredStroke);
        }
        const outcome = await runCaptureAnalysis({
          db: getDb(),
          captureId,
          clip,
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
                  lastQuality.current,
                  lastReadiness.current,
                )
              : null,
        });
        if (outcome.kind === 'unavailable') {
          setPhase({ kind: 'error', message: outcome.reason });
          return;
        }
        if (outcome.kind === 'quality_blocked') {
          // Honest abstention: nothing was analyzed or rated.
          setPhase({ kind: 'error', message: outcome.reason });
          return;
        }
        // Auto-detected outcomes (family-level reads, honest abstentions)
        // and declared-vs-predicted disagreements are surfaced here; the
        // clean declared path keeps its straight hop to the Result screen.
        const presentation = strokeIntentPresentation(outcome.record);
        if (presentation) {
          setPhase({
            kind: 'analyzed',
            analysisId: outcome.analysisId,
            presentation,
          });
          return;
        }
        navigation.replace('Result', { analysisId: outcome.analysisId });
      } catch (error) {
        setPhase({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        scoringActive.current = false;
      }
    },
    [declaredStroke, navigation, profile, techniqueIntent],
  );

  const run = useCallback(async () => {
    if (operationActive.current) return;
    operationActive.current = true;
    // Each capture attempt starts with a clean envelope verdict and target
    // seed: both describe ONE clip and must never carry into the next one.
    setCaptureEnvelope(null);
    setTargetSeed(null);
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
        setPhase({ kind: 'saved', clip, captureId });
        void scoreCapture(captureId, clip, liveSeed);
        return;
      }
      setPhase({ kind: 'saved', clip, captureId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('cancel')) {
        if (source === 'library') navigation.goBack();
        else setPhase({ kind: 'ready' });
      } else {
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
        {phase.message.startsWith('Measuring') ? (
          // ANALYZING state (MOBBIN brief §1): single-state arc with the
          // honest stage caption scoreCapture set — captions are stages,
          // never fake progress percentages.
          <StrokeResultAnalyzing dark caption={phase.message} />
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
            setTechniqueIntent(intent);
            // The legacy capture/analysis chain consumes the slug; the
            // canonical intent (incl. voice provenance) rides alongside.
            setDeclared((intent?.legacySlug as MvpShotTypeSlug | null) ?? null);
          }}
        />

        <FramingPreview />

        <View style={styles.steps}>
          <StepRow
            index="01"
            icon="person"
            title="Step fully into frame"
            detail="Place the phone at waist height and keep your full body inside the corners."
          />
          <StepRow
            index="02"
            icon="spark"
            title="Wait for Ready"
            detail="Live pose landmarks turn the camera into an automatic trigger—no timer or shutter."
          />
          <StepRow
            index="03"
            icon="camera"
            title="Make one natural stroke"
            detail="The saved clip includes two seconds before motion and 1.5 seconds after it."
          />
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
