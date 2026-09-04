import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Linking,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  useNavigation,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { PhaseKey, ShotAnalysis } from '@pickle/shared-types';
import {
  Button,
  BrandDialog,
  Card,
  CheckpointRow,
  ErrorState,
  LoadingState,
  Pill,
  PressableScale,
  ScoreRing,
  ScreenHeader,
  SectionTitle,
  useReducedMotion,
} from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import { getDb } from '../data/db';
import {
  getShotOutboxStatus,
  hasShotSyncReceipt,
  listRealAnalysisFacts,
  type ShotOutboxStatus,
} from '../data/repository';
import { OUTBOX_MAX_ATTEMPTS } from '../data/sync';
import type { RootStackParams } from '../navigation/params';
import {
  FixList,
  FormReviewCard,
  FormReviewPlayer,
  RecommendedDrills,
  buildFormReviewScript,
  directionPhrase,
  drillFocusFromAnalysis,
  fixList,
  loadReviewPoseSequence,
  strengthList,
  type FixItem,
  type FormReviewScript,
  type ReviewPoseSequence,
} from '../review';
import { PracticeSetCard } from '../progress/PracticeSetCard';
import {
  summarizePracticeSet,
  type PracticeSetSummary,
} from '../progress/practiceSetProgress';
import type { CatalogDrill } from '../training/api';
import { PlanDrillCard, prescriptionLabel } from '../training/components';
import { useTrainingStore } from '../training/store';
import type { InstructionalMedia, TrainingPlanItem } from '../training/types';
import {
  StrokeResult,
  StrokeResultAnalyzing,
  type StrokeResultClip,
} from '../components/StrokeResult';
import { DaySecuredBanner } from '../consistency/DaySecuredBanner';
import { useConsistencyStore } from '../consistency/store';
import {
  loadStrokeResultEvidence,
  type StrokeResultEvidence,
  type StrokeReviewEvidence,
} from '../components/strokeResultData';
import {
  CHECKPOINT_NAMES,
  selectInsight,
  techniqueScoreSectionVisible,
  type AttemptRef,
  type StrokeResultEvidenceRecord,
} from '../components/strokeResultModel';
import { AnalysisFeedbackPrompt } from '../components/AnalysisFeedbackPrompt';
import {
  DUPR_ESTIMATE_NOTE,
  formatDuprEstimate,
} from '../progress/duprEstimate';
import { armTryAgain, tryAgainFromResult } from './tryAgainHandoff';

/**
 * RESULT ROUTE — a stroke's outcome as a short sequential guide, reached
 * from Stroke Analysis (AnalyzeScreen) and Library/Home history rows. One
 * idea per page, stepped through with a pinned Next, and NO page scrolls on
 * a 6.1" phone:
 *
 *   1. SCORE       — the technique score ring, the DUPR-style estimate and
 *                    the ONE measured insight (plus this sitting's set).
 *   2. THE PROBLEM — the form-review replay IS the page: the stage fills
 *                    the height, frozen on the priority fault's stop, and
 *                    the player's own stop card under it names the fault
 *                    (PRIORITY FIX · phase, the measured headline, the
 *                    cue) — no second headline competes with the video and
 *                    nothing is drawn over the body. With no replay
 *                    evidence on this device a kicker + fault headline +
 *                    the top fix cards stand in for the player.
 *   3. DRILLS      — catalog drills for the fault, each saveable to the
 *                    library.
 *   4. NEXT        — try it again / done over ONE recap card: three tiles
 *                    (score, checkpoints held, checkpoints to fix) and the
 *                    priority-fix / strongest rows — the same evidence-
 *                    derived strings the earlier pages showed, nothing new.
 *                    The `ResultDetails` route (`ResultBreakdownSheet`) still
 *                    holds EVERYTHING else unchanged, but the guide no
 *                    longer links to it (product decision 2026-09-02).
 *
 * Pages that have no evidence to show are skipped (a clean stroke with no
 * replay has no "problem" page; no scored fault means no drills page), and
 * an abstained result collapses to ONE page: the honest explanation/ledger
 * the canonical StrokeResult renders (the same sheet, inline), with the same
 * TRY AGAIN / Done.
 *
 * This screen owns data loading and navigation wiring; every sentence on
 * every page is derived by the same pure selectors as before (nothing is
 * invented for a page to have something to say). `useStrokeResultEvidence`
 * and `ResultBreakdownSheet` are shared with `ResultDetailsScreen`.
 */

export type SyncEvidenceState =
  | { kind: 'checking' }
  | { kind: 'synced' }
  | { kind: 'pending' }
  | { kind: 'unknown' }
  | {
      kind: 'rejected' | 'exhausted';
      attempts: number;
      lastError: string | null;
    }
  | { kind: 'orphaned'; lastError: string | null };

function syncEvidenceFromOutbox(status: ShotOutboxStatus): SyncEvidenceState {
  switch (status.state) {
    case 'rejected':
    case 'exhausted':
      return {
        kind: status.state,
        attempts: status.attempts,
        lastError: status.lastError,
      };
    case 'orphaned':
      return { kind: 'orphaned', lastError: status.lastError };
    case 'queued':
      return { kind: 'pending' };
    case 'absent':
      return { kind: 'unknown' };
  }
}

type GuideStep = 'score' | 'problem' | 'drills' | 'next';

const STEP_LABEL: Record<GuideStep, string> = {
  score: 'SCORE',
  problem: 'THE PROBLEM',
  drills: 'DRILLS',
  next: 'NEXT',
};

/**
 * Embeds open their canonical watch page, never the raw /embed/ URL: YouTube
 * refuses embed surfaces loaded without an embedding referer (error 153),
 * while the watch page always plays in the YouTube app or browser.
 */
function mediaUrl(media: InstructionalMedia): string {
  return media.kind === 'hosted' ? media.playbackUrl : media.sourceUrl;
}

function humanize(value: string): string {
  return value.replace(/_/g, ' ');
}

/** The footer label that names what the NEXT page is about. */
function nextLabelFor(step: GuideStep, fixCount: number): string {
  switch (step) {
    case 'problem':
      return fixCount > 0 ? 'See what to fix' : 'Watch the replay';
    case 'drills':
      return 'Fix it with drills';
    default:
      return 'Continue';
  }
}

/**
 * The evidence every Result surface reads, loaded the same way wherever it
 * is hosted (the guide and the `ResultDetails` route are separate screens):
 * the three real stores behind `loadStrokeResultEvidence`, the hash-verified
 * pose sidecar, and the server's sync receipt. `evidence` is `undefined`
 * while the first read is in flight; a failed read is an honest empty
 * evidence set (the host shows "Result missing"), never a repair.
 */
export function useStrokeResultEvidence(analysisId: string): {
  evidence: StrokeResultEvidence | undefined;
  analysis: ShotAnalysis | null;
  /** The verified pose sequence; `undefined` while it is still being read. */
  sequence: ReviewPoseSequence | null | undefined;
  syncEvidence: SyncEvidenceState;
} {
  const [evidence, setEvidence] = useState<StrokeResultEvidence | undefined>(
    undefined,
  );
  const [syncEvidence, setSyncEvidence] = useState<SyncEvidenceState>({
    kind: 'checking',
  });

  useEffect(() => {
    let cancelled = false;
    setEvidence(undefined);
    loadStrokeResultEvidence(getDb(), analysisId)
      .then(loaded => {
        if (!cancelled) setEvidence(loaded);
      })
      .catch(() => {
        if (!cancelled) {
          setEvidence({
            analysis: null,
            record: null,
            clip: null,
            review: null,
            attempts: [],
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [analysisId]);

  const analysis = evidence?.analysis ?? evidence?.record?.result ?? null;

  // FORM REVIEW replay evidence: the pose sidecar is read and hash-verified
  // exactly like the engine does; any failure is an honest null (video-only
  // replay), never a repair. `undefined` while the read is in flight so the
  // inline player never flashes a "no pose" caption it would then retract.
  const [sequence, setSequence] = useState<
    ReviewPoseSequence | null | undefined
  >(undefined);
  useEffect(() => {
    let cancelled = false;
    setSequence(undefined);
    if (evidence === undefined) return;
    const sidecar = evidence.review?.poseSequence ?? null;
    if (!sidecar || !techniqueScoreSectionVisible(analysis)) {
      setSequence(null);
      return;
    }
    loadReviewPoseSequence(sidecar)
      .then(loaded => {
        if (!cancelled) setSequence(loaded);
      })
      .catch(() => {
        if (!cancelled) setSequence(null);
      });
    return () => {
      cancelled = true;
    };
  }, [analysis, evidence]);

  useEffect(() => {
    let cancelled = false;
    setSyncEvidence({ kind: 'checking' });
    if (!analysis) {
      return () => {
        cancelled = true;
      };
    }
    const db = getDb();
    hasShotSyncReceipt(db, analysis.id)
      .then(async accepted => {
        if (accepted) return { kind: 'synced' } as const;
        return syncEvidenceFromOutbox(
          await getShotOutboxStatus(db, analysis.id),
        );
      })
      .then(next => {
        if (!cancelled) setSyncEvidence(next);
      })
      .catch(() => {
        if (!cancelled) setSyncEvidence({ kind: 'unknown' });
      });
    return () => {
      cancelled = true;
    };
  }, [analysis]);

  return { evidence, analysis, sequence, syncEvidence };
}

export function ResultScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const route = useRoute<RouteProp<RootStackParams, 'Result'>>();
  const analysisId = route.params.analysisId;
  const { evidence, analysis, sequence, syncEvidence } =
    useStrokeResultEvidence(analysisId);
  const loadCurrentPlan = useTrainingStore(state => state.loadCurrentPlan);
  const refreshConsistency = useConsistencyStore(state => state.refresh);

  useEffect(() => {
    void loadCurrentPlan();
  }, [loadCurrentPlan]);

  // The analysis this screen shows was just persisted: re-derive the streak
  // so the first training of the day arms its "Day N secured" moment here.
  useEffect(() => {
    void refreshConsistency();
  }, [refreshConsistency, analysisId]);

  // PRACTICE SET: the other scored attempts of this sitting, compared only
  // when the stroke and scoring model match (practiceSetProgress). Null
  // until two comparable attempts exist — nothing is compared to nothing.
  const [practiceSet, setPracticeSet] = useState<PracticeSetSummary | null>(
    null,
  );
  const sessionId = analysis?.sessionId ?? null;
  useEffect(() => {
    let cancelled = false;
    setPracticeSet(null);
    if (!sessionId) return;
    listRealAnalysisFacts(getDb(), 200)
      .then(facts => {
        if (!cancelled) setPracticeSet(summarizePracticeSet(facts, sessionId));
      })
      .catch(() => {
        if (!cancelled) setPracticeSet(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, analysisId]);

  if (evidence === undefined) {
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
        <StatusBar barStyle="light-content" />
        <ScreenHeader
          title="Stroke analysis"
          dark
          onClose={() => navigation.popToTop()}
        />
        <StrokeResultAnalyzing caption="Opening your result…" dark />
      </SafeAreaView>
    );
  }
  const record = evidence.record;
  if (analysis === null && record === null) {
    return (
      <ErrorState
        title="Result missing"
        detail="This analysis is no longer on this device."
        onRetry={() => navigation.goBack()}
        retryLabel="Go back"
        dark
      />
    );
  }

  return (
    <ResultGuide
      // Keyed by attempt so repointing the route to another attempt starts
      // the guide over — no step, replay or save state survives the switch.
      key={analysisId}
      analysisId={analysisId}
      analysis={analysis}
      record={record}
      clip={evidence.clip}
      review={evidence.review}
      attempts={evidence.attempts}
      sequence={sequence}
      practiceSet={practiceSet}
      syncEvidence={syncEvidence}
      onClose={() => navigation.popToTop()}
      onTryAgain={() => {
        // §2 TRY AGAIN: re-arm the guided capture flow with the SAME intent —
        // AnalyzeScreen consumes the handoff, skips the picker and opens the
        // camera directly. Declared runs re-arm the declaration; AUTO runs
        // re-arm AUTO; nothing is invented for legacy rows.
        armTryAgain(tryAgainFromResult(record, analysis));
        navigation.navigate('Analyze', { source: 'camera' });
      }}
      onOpenAttempt={target =>
        target === analysisId
          ? undefined
          : navigation.replace('Result', { analysisId: target })
      }
      onOpenFormReview={phase =>
        navigation.navigate('FormReview', {
          analysisId,
          ...(phase !== undefined ? { phase } : {}),
        })
      }
      onOpenLibrary={() => navigation.navigate('DrillLibrary')}
    />
  );
}

// ─── The guide ──────────────────────────────────────────────────────────────

interface ResultGuideProps {
  analysisId: string;
  analysis: ShotAnalysis | null;
  record: StrokeResultEvidenceRecord | null;
  clip: StrokeResultClip | null;
  review: StrokeReviewEvidence | null;
  attempts: AttemptRef[];
  /** The verified pose sequence; `undefined` while it is still being read. */
  sequence: ReviewPoseSequence | null | undefined;
  practiceSet: PracticeSetSummary | null;
  syncEvidence: SyncEvidenceState;
  onClose: () => void;
  onTryAgain: () => void;
  onOpenAttempt: (analysisId: string) => void;
  onOpenFormReview: (phase?: PhaseKey) => void;
  onOpenLibrary: () => void;
}

function ResultGuide(props: ResultGuideProps) {
  const { analysis, record, clip, review, sequence } = props;
  const [stepIndex, setStepIndex] = useState(0);
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);

  // Every page below reads from these pure selectors — the same ones the
  // canonical StrokeResult and the form review use — so a page can only say
  // what the record backs.
  const scored = techniqueScoreSectionVisible(analysis) ? analysis : null;
  const fixes = useMemo<FixItem[]>(
    () => (scored ? fixList(scored) : []),
    [scored],
  );
  const priorityFix = fixes[0] ?? null;
  const drillFocus = useMemo(
    () => (scored ? drillFocusFromAnalysis(scored) : null),
    [scored],
  );
  const reviewAvailable =
    scored !== null && (clip !== null || review?.poseSequence != null);
  const script = useMemo<FormReviewScript | null>(
    () =>
      scored && sequence !== undefined
        ? buildFormReviewScript(scored, sequence)
        : null,
    [scored, sequence],
  );
  const insight = useMemo(
    () =>
      selectInsight({
        strokeIntent: record?.strokeIntent ?? null,
        contact: record?.contact ?? null,
        temporalPhasesV2: record?.temporalPhasesV2 ?? null,
        limitingFactors: record?.uncertainty?.limitingFactors ?? [],
        analysis,
      }),
    [analysis, record],
  );

  const steps = useMemo<GuideStep[]>(() => {
    if (!scored) return [];
    const list: GuideStep[] = ['score'];
    if (fixes.length > 0 || reviewAvailable) list.push('problem');
    if (drillFocus) list.push('drills');
    list.push('next');
    return list;
  }, [drillFocus, fixes.length, reviewAvailable, scored]);
  const total = steps.length;
  const step: GuideStep | null = steps[stepIndex] ?? null;
  const nextStep = steps[stepIndex + 1] ?? null;

  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [stepIndex]);

  const shotLabel = analysis ? humanize(analysis.shotType) : 'stroke';

  // ── Abstained: ONE honest page — the full sheet, inline ────────────────
  if (!scored || step === null) {
    return (
      <GuideShell
        stepKey="abstained"
        stepIndex={0}
        total={1}
        label="RESULT · NOT SCORED"
        onClose={props.onClose}
        footer={
          <GuideFooter
            primary={{
              label: 'Try it again',
              icon: 'camera',
              onPress: props.onTryAgain,
              testID: 'result-guide-try-again',
            }}
            done={props.onClose}
          />
        }
      >
        <View testID="result-guide-step-abstained">
          <ResultBreakdownSheet
            analysisId={props.analysisId}
            analysis={analysis}
            record={record}
            clip={clip}
            review={review}
            attempts={props.attempts}
            sequence={sequence}
            syncEvidence={props.syncEvidence}
            onOpenAttempt={props.onOpenAttempt}
            onTryAgain={props.onTryAgain}
            onDone={props.onClose}
            onOpenFormReview={props.onOpenFormReview}
            testID="result-guide-full-breakdown"
          />
        </View>
      </GuideShell>
    );
  }

  const isLast = stepIndex === total - 1;
  const goBack = () => setStepIndex(current => Math.max(0, current - 1));
  const goNext = () =>
    setStepIndex(current => Math.min(total - 1, current + 1));
  // THE PROBLEM with a replay and NEXT are fixed flex columns (the player
  // fills the page; the summary is three lines) — nothing to scroll.
  const fixedPage = (step === 'problem' && reviewAvailable) || step === 'next';

  return (
    <GuideShell
      stepKey={step}
      stepIndex={stepIndex}
      total={total}
      label={`${stepIndex + 1} OF ${total} · ${STEP_LABEL[step]}`}
      onClose={props.onClose}
      scrollRef={scrollRef}
      scroll={!fixedPage}
      footer={
        <GuideFooter
          primary={
            isLast
              ? {
                  label: 'Try it again',
                  icon: 'camera',
                  onPress: props.onTryAgain,
                  testID: 'result-guide-try-again',
                }
              : {
                  label: nextLabelFor(nextStep ?? 'next', fixes.length),
                  onPress: goNext,
                  testID: 'result-guide-next',
                }
          }
          {...(stepIndex > 0 ? { back: goBack } : {})}
          {...(isLast ? { done: props.onClose } : {})}
        />
      }
    >
      {step === 'score' ? (
        <ScorePage
          analysis={scored}
          shotLabel={shotLabel}
          insight={insight}
          practiceSet={props.practiceSet}
          onOpenAttempt={props.onOpenAttempt}
        />
      ) : step === 'problem' ? (
        <ProblemPage
          analysis={scored}
          fixes={fixes}
          insightSentence={insight.sentence}
          insightBasis={insight.basis}
          reviewAvailable={reviewAvailable}
          clip={clip}
          review={review}
          sequence={sequence}
          script={script}
        />
      ) : step === 'drills' ? (
        <DrillsPage
          analysis={scored}
          priorityFix={priorityFix}
          onOpenLibrary={props.onOpenLibrary}
        />
      ) : (
        <NextPage analysis={scored} priorityFix={priorityFix} />
      )}
    </GuideShell>
  );
}

// ─── Full breakdown: the complete evidence sheet (details route + abstained) ─

export interface ResultBreakdownSheetProps {
  analysisId: string;
  analysis: ShotAnalysis | null;
  record: StrokeResultEvidenceRecord | null;
  clip: StrokeResultClip | null;
  review: StrokeReviewEvidence | null;
  attempts: readonly AttemptRef[];
  /** The verified pose sequence; `undefined` while it is still being read. */
  sequence: ReviewPoseSequence | null | undefined;
  syncEvidence: SyncEvidenceState;
  onOpenAttempt: (analysisId: string) => void;
  onTryAgain: () => void;
  onDone: () => void;
  onOpenFormReview: (phase?: PhaseKey) => void;
  testID?: string;
}

/**
 * FULL BREAKDOWN — the complete result surface, logic unchanged: the
 * canonical `StrokeResult` (header, replay, ONE insight, measured rows,
 * ledger) with the form-review entry card, WHAT TO FIX in full, the stroke
 * map, the provenance trace, the personalized training plan and the
 * feedback prompt. It stays on its light surface so every evidence card
 * renders exactly as before. Hosted by the `ResultDetails` route ("See full
 * breakdown" on the guide's last page) and, inline, by the guide's abstained
 * page — the honest ledger IS that page.
 */
export function ResultBreakdownSheet(props: ResultBreakdownSheetProps) {
  const { analysis, record, clip, review, sequence } = props;
  const scored = techniqueScoreSectionVisible(analysis) ? analysis : null;
  const reviewAvailable =
    scored !== null && (clip !== null || review?.poseSequence != null);
  const script = useMemo<FormReviewScript | null>(
    () =>
      scored && sequence !== undefined
        ? buildFormReviewScript(scored, sequence)
        : null,
    [scored, sequence],
  );
  const shotLabel = analysis ? humanize(analysis.shotType) : 'stroke';
  const scoredReal =
    scored !== null && scored.source === 'real' && scored.overallScore !== null;

  return (
    <View style={styles.sheet} testID={props.testID}>
      <StrokeResult
        analysis={analysis}
        record={record}
        clip={clip}
        attempts={props.attempts}
        currentAnalysisId={props.analysisId}
        onOpenAttempt={props.onOpenAttempt}
        onTryAgain={props.onTryAgain}
        onDone={props.onDone}
        hideCtaRow
        reviewSlot={
          // Entry into the full-screen exoskeleton + heat-map playback that
          // pauses at every measured checkpoint with its coaching cue.
          reviewAvailable && script ? (
            <View style={styles.reviewSlot}>
              <FormReviewCard
                {...(clip?.posterUri !== undefined
                  ? { posterUri: clip.posterUri }
                  : {})}
                stopCount={script.stops.length}
                fixCount={
                  script.stops.filter(stop => stop.verdict === 'fix').length
                }
                onPress={() => props.onOpenFormReview()}
              />
            </View>
          ) : undefined
        }
        fixSlot={
          // WHAT TO FIX in full (three items + strengths), evidence-gated
          // inside — an abstained result shows none of it.
          scored ? (
            <FixList
              analysis={scored}
              {...(reviewAvailable
                ? { onOpenInReview: props.onOpenFormReview }
                : {})}
            />
          ) : undefined
        }
      >
        {scored ? (
          <>
            <SectionTitle
              title="Stroke map"
              right={
                <Text style={[type.caption, { color: color.inkSoft }]}>
                  {
                    scored.checkpoints.filter(
                      checkpoint => checkpoint.applicable,
                    ).length
                  }{' '}
                  observed
                </Text>
              }
            />
            <Card style={styles.checkpointsCard}>
              {scored.checkpoints
                .filter(checkpoint => checkpoint.applicable)
                .map((checkpoint, index) => (
                  <CheckpointRow
                    key={checkpoint.key}
                    name={CHECKPOINT_NAMES[checkpoint.key] ?? checkpoint.key}
                    score={checkpoint.score}
                    band={checkpoint.band}
                    revealDelay={index * 45}
                  />
                ))}
            </Card>

            <View style={styles.traceRow}>
              <Icon name="shield" size={17} color={color.inkSoft} />
              <Text style={[type.caption, styles.traceCopy]}>
                Scored with {scored.versionVector.scoringModelVersion} ·
                configuration {scored.versionVector.shotConfigVersion} ·
                verified on-device source
              </Text>
            </View>
          </>
        ) : null}

        <TrainingPlanSection
          analysis={analysis}
          scoredReal={scoredReal}
          syncEvidence={props.syncEvidence}
          shotLabel={shotLabel}
          onCaptureNewRead={props.onTryAgain}
        />

        {props.syncEvidence.kind === 'synced' ? (
          <AnalysisFeedbackPrompt analysisId={props.analysisId} />
        ) : null}
      </StrokeResult>
    </View>
  );
}

// ─── Shell: top row (close · progress · label), animated page, footer ───────

function GuideProgress(props: { step: number; total: number }) {
  return (
    <View
      accessibilityLabel={`Result step ${props.step + 1} of ${props.total}`}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 1, max: props.total, now: props.step + 1 }}
      style={styles.progressRow}
      testID="result-guide-progress"
    >
      {Array.from({ length: props.total }, (_, index) => (
        <View
          key={index}
          style={[
            styles.progressSegment,
            {
              backgroundColor:
                index <= props.step ? color.volt : color.lineDark,
            },
          ]}
        />
      ))}
    </View>
  );
}

/** Light opacity + rise on every page change; instant under reduced motion. */
function StepReveal(props: { stepKey: string; children: React.ReactNode }) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(1)).current;
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (reduced) {
      progress.setValue(1);
      return;
    }
    progress.setValue(0);
    Animated.timing(progress, {
      toValue: 1,
      duration: 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [progress, props.stepKey, reduced]);
  return (
    <Animated.View
      style={[
        styles.flex,
        {
          opacity: progress,
          transform: [
            {
              translateY: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [14, 0],
              }),
            },
          ],
        },
      ]}
    >
      {props.children}
    </Animated.View>
  );
}

function GuideShell(props: {
  stepKey: string;
  stepIndex: number;
  total: number;
  label: string;
  onClose: () => void;
  footer: React.ReactNode;
  scrollRef?: React.RefObject<React.ComponentRef<typeof ScrollView> | null>;
  /**
   * Default true: the page scrolls. False: the page is a flex column that
   * fills the space between the top row and the footer (a child with
   * `flex: 1` takes the rest) — for pages that must never scroll.
   */
  scroll?: boolean;
  children: React.ReactNode;
}) {
  const scroll = props.scroll !== false;
  return (
    <SafeAreaView
      edges={['top', 'bottom']}
      style={styles.screen}
      testID="result-guide"
    >
      <StatusBar barStyle="light-content" />
      <View style={styles.topRow}>
        <PressableScale
          accessibilityLabel="Close"
          hitSlop={8}
          onPress={props.onClose}
          containerStyle={styles.topSide}
          style={styles.iconButton}
          testID="result-guide-close"
        >
          <Icon name="close" size={20} color={color.onDark} />
        </PressableScale>
        <View style={styles.progressWrap}>
          {props.total > 1 ? (
            <GuideProgress step={props.stepIndex} total={props.total} />
          ) : null}
        </View>
        <Text
          style={[type.micro, styles.stepLabel]}
          numberOfLines={1}
          testID="result-guide-step-label"
        >
          {props.label}
        </Text>
      </View>
      <StepReveal stepKey={props.stepKey}>
        {scroll ? (
          <ScrollView
            ref={props.scrollRef}
            contentContainerStyle={styles.content}
            showsVerticalScrollIndicator={false}
            testID="result-guide-scroll"
          >
            {props.children}
          </ScrollView>
        ) : (
          <View style={styles.contentFixed} testID="result-guide-page">
            {props.children}
          </View>
        )}
      </StepReveal>
      <View style={styles.footer}>{props.footer}</View>
      {/* "Day N secured" — first meaningful training of the day lands here. */}
      <DaySecuredBanner />
    </SafeAreaView>
  );
}

function GuideFooter(props: {
  primary: {
    label: string;
    onPress: () => void;
    testID: string;
    icon?: 'camera';
  };
  back?: () => void;
  done?: () => void;
}) {
  return (
    <>
      <Button
        label={props.primary.label}
        variant="volt"
        {...(props.primary.icon !== undefined
          ? { icon: props.primary.icon }
          : {})}
        onPress={props.primary.onPress}
        testID={props.primary.testID}
      />
      <View style={styles.footerLinks}>
        {props.back ? (
          <PressableScale
            accessibilityLabel="Back"
            onPress={props.back}
            containerStyle={styles.footerLinkContainer}
            style={styles.footerLink}
            testID="result-guide-back"
          >
            <Text style={[type.bodyBold, styles.footerLinkText]}>Back</Text>
          </PressableScale>
        ) : null}
        {props.done ? (
          <PressableScale
            accessibilityLabel="Done"
            onPress={props.done}
            containerStyle={styles.footerLinkContainer}
            style={styles.footerLink}
            testID="result-guide-done"
          >
            <Text style={[type.bodyBold, styles.footerLinkText]}>Done</Text>
          </PressableScale>
        ) : null}
      </View>
    </>
  );
}

// ─── Page 1: SCORE ──────────────────────────────────────────────────────────

function ScorePage(props: {
  analysis: ShotAnalysis & { overallScore: number };
  shotLabel: string;
  insight: ReturnType<typeof selectInsight>;
  practiceSet: PracticeSetSummary | null;
  onOpenAttempt: (analysisId: string) => void;
}) {
  const { analysis, insight } = props;
  const insightMeasured =
    insight.basis === 'measured_fault' || insight.basis === 'measured_clean';
  return (
    <View testID="result-guide-step-score">
      <Text style={[type.micro, styles.kicker]}>
        TECHNIQUE SCORE · {props.shotLabel.toUpperCase()}
      </Text>
      <View style={styles.ringWrap}>
        <ScoreRing
          score={analysis.overallScore}
          label="out of 10"
          size={190}
          dark
        />
      </View>
      <Text style={[type.caption, styles.duprEstimate]}>
        {formatDuprEstimate(analysis.overallScore)}
      </Text>
      <Text style={[type.caption, styles.duprNote]}>{DUPR_ESTIMATE_NOTE}</Text>

      {/* ONE insight: the strongest defensible evidence — for a scored read,
          the engine's own worst measured checkpoint plus the cue that matches
          its measured direction (selectInsight), never a guess. */}
      <Card
        tone="dark"
        style={styles.insightCard}
        testID="result-guide-insight"
      >
        <View style={styles.insightHeader}>
          <Icon name="spark" size={17} color={color.volt} />
          <Text style={[type.micro, { color: color.volt }]}>
            {insightMeasured ? 'WHAT THE CAMERA MEASURED' : 'MEASURED INSIGHT'}
          </Text>
        </View>
        <Text style={[type.bodyBold, styles.insightSentence]}>
          {insight.sentence}
        </Text>
      </Card>

      {props.practiceSet ? (
        // THIS SET: the delta across this sitting's comparable attempts —
        // rendered only once two comparable attempts exist.
        <View style={styles.setSlot}>
          <PracticeSetCard
            compact
            summary={props.practiceSet}
            onOpenAttempt={props.onOpenAttempt}
            testID="result-guide-practice-set"
          />
        </View>
      ) : null}
    </View>
  );
}

// ─── Page 2: THE PROBLEM ────────────────────────────────────────────────────

function ProblemPage(props: {
  analysis: ShotAnalysis & { overallScore: number };
  fixes: FixItem[];
  insightSentence: string;
  insightBasis: ReturnType<typeof selectInsight>['basis'];
  reviewAvailable: boolean;
  clip: StrokeResultClip | null;
  review: StrokeReviewEvidence | null;
  sequence: ReviewPoseSequence | null | undefined;
  script: FormReviewScript | null;
}) {
  const fix = props.fixes[0] ?? null;
  // The replay opens frozen on the priority fault's own checkpoint frame —
  // the arrow points at the joint that was measured off target — and plays
  // the rest of the swing from there. The stop that scored that checkpoint
  // wins; its phase is the fallback for a record whose stops were built
  // without it.
  const initialStop =
    fix && props.script
      ? (props.script.stops.find(stop =>
          stop.checkpoints.some(checkpoint => checkpoint.key === fix.key),
        ) ??
        props.script.stops.find(stop => stop.phase === fix.phase) ??
        null)
      : null;
  const clean = props.insightBasis === 'measured_clean';
  const playerReady =
    props.reviewAvailable &&
    props.script !== null &&
    props.sequence !== undefined;

  if (props.reviewAvailable) {
    // The replay IS the page: the stage takes every point the shell leaves,
    // and the player's own stop card under it names the fault (PRIORITY
    // FIX · phase, the measured headline, the cue) — a page headline would
    // only repeat it and cost the video its height.
    return (
      <View style={styles.flex} testID="result-guide-step-problem">
        {playerReady && props.script ? (
          <FormReviewPlayer
            analysis={props.analysis}
            clip={props.clip}
            review={props.review}
            sequence={props.sequence ?? null}
            script={props.script}
            initialStop={initialStop}
            fill
          />
        ) : (
          <View style={styles.playerLoading}>
            <LoadingState label="Preparing your replay…" dark />
          </View>
        )}
      </View>
    );
  }

  // No replay evidence on this device: kicker → fix name → ONE measured sub
  // line, then the top fix cards — the engine's number, the measured
  // direction and the coaching cue for that direction — are the whole page.
  // Nothing is drawn from nowhere.
  return (
    <View testID="result-guide-step-problem">
      <Text style={[type.micro, styles.kickerFlame]}>
        {fix
          ? fix.isPriority
            ? 'THE PROBLEM · PRIORITY'
            : 'THE PROBLEM'
          : 'THE REPLAY'}
      </Text>
      <Text style={[type.h1, styles.headline]} numberOfLines={2}>
        {fix ? fix.name : clean ? 'Every checkpoint held' : 'Your replay'}
      </Text>
      <Text style={[type.body, styles.sub]} numberOfLines={2}>
        {fix
          ? `Scored ${Math.round(fix.score)} — ${directionPhrase(fix.direction)}.`
          : props.insightSentence}
      </Text>
      {props.fixes.length > 0 ? (
        <View style={styles.fixSlot}>
          <FixList analysis={props.analysis} limit={2} dark compact />
        </View>
      ) : null}
    </View>
  );
}

// ─── Page 3: DRILLS ─────────────────────────────────────────────────────────

function DrillsPage(props: {
  analysis: ShotAnalysis & { overallScore: number };
  priorityFix: FixItem | null;
  onOpenLibrary: () => void;
}) {
  const savedDrills = useTrainingStore(state => state.savedDrills);
  const mutation = useTrainingStore(state => state.mutation);
  const mutationError = useTrainingStore(state => state.mutationError);
  const setDrillSaved = useTrainingStore(state => state.setDrillSaved);
  const clearMutationError = useTrainingStore(
    state => state.clearMutationError,
  );
  // Saves confirmed by the server on this page; the catalog snapshot and the
  // store's saved ledger answer for everything else.
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const pendingSlug = mutation.startsWith('saving:')
    ? mutation.slice('saving:'.length)
    : null;
  const isSaved = (drill: CatalogDrill) =>
    confirmed[drill.slug] ??
    (savedDrills.some(saved => saved.slug === drill.slug) || drill.saved);
  const toggleSaved = async (drill: CatalogDrill, saved: boolean) => {
    const ok = await setDrillSaved(drill.slug, saved);
    if (ok) setConfirmed(current => ({ ...current, [drill.slug]: saved }));
  };

  return (
    <View testID="result-guide-step-drills">
      <Text style={[type.micro, styles.kicker]}>DRILLS</Text>
      <Text style={[type.h1, styles.headline]}>Drills to fix it</Text>
      <Text style={[type.body, styles.sub]}>
        {props.priorityFix
          ? `For ${props.priorityFix.name.toLowerCase()}. Save the ones you’ll practice — they land in Library → Saved drills.`
          : 'Save the ones you’ll practice — they land in Library → Saved drills.'}
      </Text>
      <RecommendedDrills
        analysis={props.analysis}
        dark
        onOpenLibrary={props.onOpenLibrary}
        onToggleSaved={(drill, saved) => void toggleSaved(drill, saved)}
        isSaved={isSaved}
        pendingSlug={pendingSlug}
      />
      {mutationError ? (
        <MutationErrorCard
          message={mutationError.message}
          onDismiss={clearMutationError}
          dark
        />
      ) : null}
    </View>
  );
}

// ─── Page 4: NEXT ───────────────────────────────────────────────────────────

/** Every participating checkpoint counts here — the lists are never capped. */
const ALL_CHECKPOINTS = Number.MAX_SAFE_INTEGER;

/**
 * The last page is a quick recap to move on from: ONE card with three tiles
 * (the score, how many checkpoints held, how many are to fix) and the
 * priority-fix / strongest rows — every value the same evidence-derived
 * number or string the earlier pages showed, nothing new said. Try it again /
 * Done live in the pinned footer.
 */
function NextPage(props: {
  analysis: ShotAnalysis & { overallScore: number };
  priorityFix: FixItem | null;
}) {
  const { analysis, priorityFix } = props;
  const held = strengthList(analysis, ALL_CHECKPOINTS).length;
  const toFix = fixList(analysis, ALL_CHECKPOINTS).length;
  const strongest = strengthList(analysis, 1)[0] ?? null;
  // "Every checkpoint held" is a measured claim: no scored checkpoint fell
  // below green AND at least one green checkpoint exists. With neither a
  // fault nor a strength on record the row is omitted, not filled in.
  const clean = priorityFix === null && strongest !== null;
  return (
    <View testID="result-guide-step-next">
      <Text style={[type.micro, styles.kicker]}>NEXT</Text>
      <Text style={[type.h1, styles.headline]}>Ready for another swing?</Text>

      <Card
        tone="dark"
        style={styles.summaryCard}
        testID="result-guide-summary"
      >
        <View style={styles.tiles}>
          <RecapTile
            value={analysis.overallScore.toFixed(1)}
            unit="/10"
            label="SCORE"
            accessibilityLabel={`Score ${analysis.overallScore.toFixed(1)} out of 10`}
            testID="result-guide-tile-score"
          />
          <View style={styles.tileDivider} />
          <RecapTile
            value={String(held)}
            label="HELD"
            accessibilityLabel={`${held} checkpoints held`}
            testID="result-guide-tile-held"
          />
          <View style={styles.tileDivider} />
          <RecapTile
            value={String(toFix)}
            label="TO FIX"
            accessibilityLabel={`${toFix} checkpoints to fix`}
            testID="result-guide-tile-to-fix"
          />
        </View>
        {priorityFix || clean ? (
          <View style={[styles.summaryRow, styles.summaryRowDivider]}>
            <Text style={[type.caption, styles.summaryLabel]}>
              Priority fix
            </Text>
            <Text
              style={[type.bodyBold, styles.summaryValue]}
              numberOfLines={2}
            >
              {priorityFix
                ? `${priorityFix.name} — ${directionPhrase(priorityFix.direction)}`
                : 'Every checkpoint held'}
            </Text>
          </View>
        ) : null}
        {strongest ? (
          <View style={[styles.summaryRow, styles.summaryRowDivider]}>
            <Text style={[type.caption, styles.summaryLabel]}>Strongest</Text>
            <Text
              style={[type.bodyBold, styles.summaryValue]}
              numberOfLines={2}
            >
              {`${strongest.name} · ${Math.round(strongest.score)}`}
            </Text>
          </View>
        ) : null}
      </Card>
    </View>
  );
}

/** One recap tile: a card numeral (the same 30/34 `type.score` role every
 * card score uses) over a micro label. */
function RecapTile(props: {
  value: string;
  unit?: string;
  label: string;
  accessibilityLabel: string;
  testID: string;
}) {
  return (
    <View
      style={styles.tile}
      accessible
      accessibilityLabel={props.accessibilityLabel}
      testID={props.testID}
    >
      <Text style={styles.tileValue}>
        {props.value}
        {props.unit !== undefined ? (
          <Text style={[type.caption, styles.tileUnit]}>{props.unit}</Text>
        ) : null}
      </Text>
      <Text style={[type.micro, styles.tileLabel]}>{props.label}</Text>
    </View>
  );
}

// ─── Personalized training (server-reviewed plan) ───────────────────────────

function MutationErrorCard(props: {
  message: string;
  onDismiss: () => void;
  dark?: boolean;
}) {
  return (
    <Card
      tone={props.dark ? 'dark' : 'soft'}
      style={styles.mutationError}
      testID="training-mutation-error"
    >
      <View style={styles.mutationErrorRow}>
        <Icon
          name="close"
          size={19}
          color={props.dark ? color.flame : color.bad}
        />
        <View style={styles.flex}>
          <Text
            style={[
              type.bodyBold,
              { color: props.dark ? color.flame : color.bad },
            ]}
          >
            Training not changed
          </Text>
          <Text
            style={[
              type.caption,
              styles.mutationErrorCopy,
              { color: props.dark ? color.onDarkMuted : color.bad },
            ]}
          >
            {props.message}
          </Text>
        </View>
      </View>
      <View style={styles.dismissError}>
        <Button
          label="Dismiss"
          variant={props.dark ? 'dark' : 'ghost'}
          compact
          onPress={props.onDismiss}
        />
      </View>
    </Card>
  );
}

function TrainingPlanSection(props: {
  analysis: ShotAnalysis | null;
  scoredReal: boolean;
  syncEvidence: SyncEvidenceState;
  shotLabel: string;
  /** Re-arm the camera — the only way forward once the server has refused
   * this read for good (its retry budget is spent). */
  onCaptureNewRead: () => void;
}) {
  const { analysis, scoredReal, syncEvidence, shotLabel } = props;
  const planStatus = useTrainingStore(state => state.planStatus);
  const currentPlan = useTrainingStore(state => state.currentPlan);
  const planError = useTrainingStore(state => state.planError);
  const mutation = useTrainingStore(state => state.mutation);
  const mutationError = useTrainingStore(state => state.mutationError);
  const drillDetails = useTrainingStore(state => state.drillDetails);
  const loadCurrentPlan = useTrainingStore(state => state.loadCurrentPlan);
  const createPlan = useTrainingStore(state => state.createPlan);
  const reassessCurrentPlan = useTrainingStore(
    state => state.reassessCurrentPlan,
  );
  const setDrillSaved = useTrainingStore(state => state.setDrillSaved);
  const completePlanItem = useTrainingStore(state => state.completePlanItem);
  const clearMutationError = useTrainingStore(
    state => state.clearMutationError,
  );
  const [dialog, setDialog] = useState<{
    title: string;
    detail: string;
    tone: 'neutral' | 'danger';
    confirmLabel?: string;
    onConfirm?: () => void;
  } | null>(null);

  const planForThisRead =
    analysis !== null && currentPlan?.sourceShotId === analysis.id;
  const completedByThisRead =
    analysis !== null && currentPlan?.reassessmentShotId === analysis.id;
  const prescribedItems = currentPlan?.items.filter(item => item.drill) ?? [];
  const completedItems = prescribedItems.filter(item => item.completion);
  const allPrescribedComplete =
    prescribedItems.length === 3 && completedItems.length === 3;
  const syncedScoredReal = scoredReal && syncEvidence.kind === 'synced';
  const newerThanPlan =
    analysis !== null && currentPlan
      ? new Date(analysis.capturedAtIso).getTime() >
        new Date(currentPlan.createdAt).getTime()
      : false;
  const canReassess =
    analysis !== null &&
    syncedScoredReal &&
    currentPlan?.status === 'active' &&
    !planForThisRead &&
    allPrescribedComplete &&
    currentPlan.shotType === analysis.shotType &&
    newerThanPlan;

  const openMedia = async (media: InstructionalMedia) => {
    const url = mediaUrl(media);
    try {
      if (!(await Linking.canOpenURL(url))) throw new Error('unsupported');
      await Linking.openURL(url);
    } catch {
      setDialog({
        title: 'Video unavailable',
        detail:
          'This rights-cleared coaching video could not be opened. Refresh the plan and try again.',
        tone: 'danger',
      });
    }
  };

  const confirmCompletion = (item: TrainingPlanItem) => {
    const target = prescriptionLabel(item);
    if (!item.drill || !target) return;
    setDialog({
      title: 'Log real practice?',
      detail: `Confirm only if you completed ${target} of “${item.drill.title}.”`,
      tone: 'neutral',
      confirmLabel: 'I completed it',
      onConfirm: () => void completePlanItem(item),
    });
  };

  const requestPlan = () => {
    if (!analysis || !syncedScoredReal) return;
    if (currentPlan?.status === 'active' && !planForThisRead) {
      setDialog({
        title: 'Replace the current plan?',
        detail:
          'The server will supersede your current plan and build reviewed work from this scored read.',
        tone: 'danger',
        confirmLabel: 'Replace plan',
        onConfirm: () => void createPlan(analysis.id),
      });
      return;
    }
    void createPlan(analysis.id);
  };

  return (
    <View testID="training-plan-section">
      <SectionTitle title="Personalized training" />
      {!scoredReal || !analysis ? (
        <Card tone="soft" style={styles.trainingStateCard}>
          <View style={styles.trainingStateIcon}>
            <Icon name="shield" size={22} color={color.court} />
          </View>
          <Text style={[type.h2, styles.trainingStateTitle]}>
            A score is required.
          </Text>
          <Text style={[type.body, styles.trainingStateBody]}>
            No plan is generated from an uncertain capture. Try another
            full-body read; this attempt does not consume a rating.
          </Text>
        </Card>
      ) : planStatus === 'loading' || planStatus === 'idle' ? (
        <View style={styles.planLoading}>
          <LoadingState label="Checking reviewed training…" />
        </View>
      ) : planStatus === 'unconfigured' ? (
        <Card tone="soft" style={styles.trainingStateCard}>
          <View style={styles.trainingStateIcon}>
            <Icon name="lock" size={22} color={color.court} />
          </View>
          <Text style={[type.h2, styles.trainingStateTitle]}>
            Training is not connected.
          </Text>
          <Text style={[type.body, styles.trainingStateBody]}>
            {planError?.message ??
              'A canonical signed-in account and authenticated training API are required. The app will not substitute local recommendations.'}
          </Text>
        </Card>
      ) : planStatus === 'error' ? (
        <Card tone="soft" style={styles.trainingStateCard}>
          <Text style={[type.h2, styles.trainingStateTitle]}>
            Training could not be verified.
          </Text>
          <Text style={[type.body, styles.trainingStateBody]}>
            {planError?.message ??
              'The reviewed training catalog is temporarily unavailable.'}
          </Text>
          <View style={styles.trainingAction}>
            <Button
              label="Try again"
              variant="secondary"
              onPress={() => void loadCurrentPlan()}
            />
          </View>
        </Card>
      ) : completedByThisRead && currentPlan?.status === 'completed' ? (
        <Card tone="dark" style={styles.improvementCard}>
          <Text style={[type.micro, { color: color.volt }]}>
            REASSESSMENT VERIFIED
          </Text>
          <Text style={[type.h1, styles.improvementTitle]}>
            {currentPlan.scoreDelta === null
              ? 'Plan complete'
              : `${
                  currentPlan.scoreDelta >= 0 ? '+' : ''
                }${currentPlan.scoreDelta.toFixed(1)} points`}
          </Text>
          <Text style={[type.body, styles.improvementBody]}>
            {currentPlan.scoreDelta === null
              ? 'Your reassessment used a different scoring model, so the server did not invent a comparison.'
              : 'Change from the plan baseline, verified on the server using the same scoring model.'}
          </Text>
        </Card>
      ) : planForThisRead && currentPlan ? (
        <>
          <Card tone="dark" style={styles.planIntro}>
            <View style={styles.planIntroTop}>
              <Text style={[type.micro, { color: color.volt }]}>
                YOUR REVIEWED PLAN
              </Text>
              <Pill
                label={`${completedItems.length}/${prescribedItems.length} DONE`}
                tone="dark"
              />
            </View>
            <Text style={[type.h1, styles.planIntroTitle]}>
              Build the next point.
            </Text>
            <Text style={[type.body, styles.planIntroBody]}>
              One warm-up and two targeted prescriptions selected by the server
              for {humanize(currentPlan.priorityCheckpoint)} ·{' '}
              {humanize(currentPlan.priorityDirection)}.
            </Text>
            <View style={styles.planProgressTrack}>
              <View
                style={[
                  styles.planProgressFill,
                  {
                    width: `${
                      prescribedItems.length === 0
                        ? 0
                        : (completedItems.length / prescribedItems.length) * 100
                    }%`,
                  },
                ]}
              />
            </View>
          </Card>
          {prescribedItems.map(item => (
            <PlanDrillCard
              key={item.id}
              item={item}
              detail={item.drill ? drillDetails[item.drill.slug] : undefined}
              busy={mutation !== 'idle'}
              onToggleSaved={() =>
                item.drill
                  ? void setDrillSaved(item.drill.slug, !item.drill.saved)
                  : undefined
              }
              onConfirmComplete={() => confirmCompletion(item)}
              onOpenMedia={media => void openMedia(media)}
            />
          ))}
          <Card tone="soft" style={styles.reassessmentCard}>
            <View style={styles.reassessmentIcon}>
              <Icon
                name={allPrescribedComplete ? 'check' : 'lock'}
                size={21}
                color={allPrescribedComplete ? color.good : color.inkSoft}
              />
            </View>
            <View style={styles.reassessmentCopy}>
              <Text style={[type.h3, { color: color.ink }]}>Reassessment</Text>
              <Text
                style={[type.caption, { color: color.inkSoft, marginTop: 3 }]}
              >
                {allPrescribedComplete
                  ? `Capture a newer ${shotLabel} read. The server will compare it only when the shot and model evidence are valid.`
                  : 'Complete all three reviewed prescriptions before a new read can close the loop.'}
              </Text>
            </View>
          </Card>
        </>
      ) : canReassess && currentPlan ? (
        <Card tone="dark" style={styles.trainingStateCard}>
          <Text style={[type.micro, { color: color.volt }]}>
            PLAN WORK COMPLETE
          </Text>
          <Text style={[type.h1, styles.reassessTitle]}>
            Measure the change.
          </Text>
          <Text style={[type.body, styles.reassessBody]}>
            This is a newer synced {shotLabel} read. The server will verify shot
            type, timing, scoring model, and completed practice before comparing
            it.
          </Text>
          <View style={styles.trainingAction}>
            <Button
              label={
                mutation === 'reassessing'
                  ? 'Verifying…'
                  : 'Use as reassessment'
              }
              variant="volt"
              disabled={mutation !== 'idle'}
              onPress={() => void reassessCurrentPlan(analysis.id)}
            />
          </View>
        </Card>
      ) : syncEvidence.kind === 'checking' ? (
        <View style={styles.planLoading}>
          <LoadingState label="Checking sync evidence…" />
        </View>
      ) : syncEvidence.kind === 'exhausted' ? (
        <Card tone="soft" style={styles.trainingStateCard}>
          <View style={styles.trainingStateIcon}>
            <Icon name="close" size={22} color={color.bad} />
          </View>
          <Text style={[type.h2, styles.trainingStateTitle]}>
            The server did not accept this read.
          </Text>
          <Text style={[type.body, styles.trainingStateBody]}>
            {`Sync was refused ${syncEvidence.attempts} times and this read will not be sent again${
              syncEvidence.lastError
                ? ` (last response: ${syncEvidence.lastError})`
                : ''
            }. It stays on this device; capture a new read to build training.`}
          </Text>
          <View style={styles.trainingAction}>
            <Button
              label="Capture a new read"
              variant="secondary"
              onPress={props.onCaptureNewRead}
            />
          </View>
        </Card>
      ) : syncEvidence.kind === 'orphaned' ? (
        <Card tone="soft" style={styles.trainingStateCard}>
          <View style={styles.trainingStateIcon}>
            <Icon name="upload" size={22} color={color.court} />
          </View>
          <Text style={[type.h2, styles.trainingStateTitle]}>
            The server did not accept this read.
          </Text>
          <Text style={[type.body, styles.trainingStateBody]}>
            {`The practice set this read belongs to was refused or has not reached the server${
              syncEvidence.lastError
                ? ` (last response: ${syncEvidence.lastError})`
                : ''
            }. Sync is paused until the set is accepted; the set is asked for again when a new read is saved into it, and once it is accepted this read is sent again automatically. It stays on this device; capture a new read to build training now.`}
          </Text>
          <View style={styles.trainingAction}>
            <Button
              label="Capture a new read"
              variant="secondary"
              onPress={props.onCaptureNewRead}
            />
          </View>
        </Card>
      ) : syncEvidence.kind !== 'synced' ? (
        <Card tone="soft" style={styles.trainingStateCard}>
          <View style={styles.trainingStateIcon}>
            <Icon name="upload" size={22} color={color.court} />
          </View>
          <Text style={[type.h2, styles.trainingStateTitle]}>
            Sync this read first.
          </Text>
          <Text style={[type.body, styles.trainingStateBody]}>
            {syncEvidence.kind === 'pending'
              ? 'This real score is still in the secure outbox. Personalized training unlocks after the server accepts the shot.'
              : syncEvidence.kind === 'rejected'
                ? `The server refused this read ${syncEvidence.attempts} of ${OUTBOX_MAX_ATTEMPTS} times${
                    syncEvidence.lastError
                      ? ` (last response: ${syncEvidence.lastError})`
                      : ''
                  }. It stays in the secure outbox and will be retried; training unlocks only if the server accepts it.`
                : 'The app could not verify whether this shot reached the server, so plan creation is paused.'}
          </Text>
        </Card>
      ) : (
        <Card style={styles.createPlanCard}>
          <View style={styles.trainingStateIcon}>
            <Icon name="spark" size={22} color={color.court} />
          </View>
          <Text style={[type.h2, styles.trainingStateTitle]}>
            {currentPlan?.status === 'active'
              ? 'Build from this read instead?'
              : 'Turn this read into a plan.'}
          </Text>
          <Text style={[type.body, styles.trainingStateBody]}>
            The server will create a plan only if this shot has a real score and
            the exact fault has one reviewed warm-up plus two reviewed targeted
            drills.
          </Text>
          <View style={styles.trainingAction}>
            <Button
              label={
                mutation === 'creating-plan'
                  ? 'Building plan…'
                  : 'Build reviewed plan'
              }
              variant="dark"
              disabled={mutation !== 'idle'}
              onPress={requestPlan}
            />
          </View>
        </Card>
      )}

      {mutationError ? (
        <MutationErrorCard
          message={mutationError.message}
          onDismiss={clearMutationError}
        />
      ) : null}
      <BrandDialog
        visible={dialog !== null}
        title={dialog?.title ?? ''}
        detail={dialog?.detail ?? ''}
        tone={dialog?.tone ?? 'neutral'}
        eyebrow={dialog?.onConfirm ? 'CONFIRM ACTION' : 'COACHING VIDEO'}
        onDismiss={() => setDialog(null)}
        testID="training-plan-dialog"
        actions={
          dialog?.onConfirm
            ? [
                {
                  label:
                    dialog.confirmLabel === 'Replace plan'
                      ? 'Keep current plan'
                      : 'Not yet',
                  variant: 'dark',
                  onPress: () => setDialog(null),
                },
                {
                  label: dialog.confirmLabel ?? 'Confirm',
                  variant:
                    dialog.confirmLabel === 'Replace plan'
                      ? 'danger'
                      : 'secondary',
                  onPress: () => {
                    const confirm = dialog.onConfirm;
                    setDialog(null);
                    confirm?.();
                  },
                },
              ]
            : [
                {
                  label: 'Got it',
                  variant: 'dark',
                  onPress: () => setDialog(null),
                },
              ]
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surfaceDark },
  flex: { flex: 1 },
  // ── Shell ──
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    minHeight: 52,
  },
  topSide: { width: 44, alignSelf: 'center' },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.inkElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineDark,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressWrap: { flex: 1, height: 44, justifyContent: 'center' },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  progressSegment: { flex: 1, height: 3, borderRadius: 2 },
  stepLabel: { color: color.onDarkSubtle, flexShrink: 0 },
  content: {
    flexGrow: 1,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xl,
  },
  // Non-scrolling page: a flex column between the top row and the footer.
  contentFixed: {
    flex: 1,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
  },
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.lineDark,
    backgroundColor: color.surfaceDark,
  },
  footerLinks: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: space.xl,
    minHeight: 44,
    marginTop: space.xs,
  },
  footerLinkContainer: { alignSelf: 'center' },
  footerLink: {
    minHeight: 44,
    minWidth: 88,
    paddingHorizontal: space.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footerLinkText: { color: color.onDarkMuted },
  // ── Page title block (micro kicker → h1 → body sub) ──
  kicker: { color: color.volt },
  kickerFlame: { color: color.flame },
  headline: { color: color.onDark, marginTop: space.sm },
  sub: { color: color.onDarkMuted, marginTop: space.sm, maxWidth: 340 },
  // ── Score page ──
  ringWrap: { alignItems: 'center', marginTop: space.lg },
  duprEstimate: {
    color: color.onDarkMuted,
    textAlign: 'center',
    marginTop: space.md,
  },
  duprNote: {
    color: color.onDarkFaint,
    textAlign: 'center',
    marginTop: space.xs,
    alignSelf: 'center',
    maxWidth: 320,
  },
  insightCard: { marginTop: space.lg, padding: space.lg },
  insightHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  insightSentence: { color: color.onDark, marginTop: space.sm },
  setSlot: { marginTop: space.md },
  // ── Problem page ──
  // The replay takes the whole page (GuideShell `scroll={false}`).
  playerLoading: { flex: 1, minHeight: 240, justifyContent: 'center' },
  fixSlot: { marginTop: space.lg },
  // ── Next page ──
  summaryCard: {
    marginTop: space.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.xs,
  },
  tiles: {
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingVertical: space.md,
  },
  tile: { flex: 1, alignItems: 'center' },
  tileDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: color.lineDark,
    marginHorizontal: space.sm,
  },
  tileValue: {
    ...type.score,
    color: color.onDark,
    fontSize: 30,
    lineHeight: 34,
  },
  tileUnit: { color: color.onDarkSubtle, letterSpacing: 0 },
  tileLabel: { color: color.onDarkSubtle, marginTop: space.xs },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space.md,
    paddingVertical: 13,
  },
  summaryRowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.lineDark,
  },
  summaryLabel: { color: color.onDarkMuted, width: 92, flexShrink: 0 },
  summaryValue: { color: color.onDark, flex: 1, textAlign: 'right' },
  // The breakdown keeps today's light surface: every evidence card renders
  // exactly as before, on a sheet that bleeds to the page edges.
  sheet: {
    marginTop: space.md,
    marginHorizontal: -space.lg,
    marginBottom: -space.xl,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xl,
    backgroundColor: color.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
  },
  reviewSlot: { marginTop: space.md },
  checkpointsCard: { paddingHorizontal: space.lg, paddingVertical: 5 },
  traceRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: space.sm,
    marginTop: space.lg,
  },
  traceCopy: { color: color.inkSoft, flex: 1 },
  // ── Personalized training (unchanged from the single-page surface) ──
  trainingStateCard: { padding: space.lg },
  trainingStateIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: color.courtSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trainingStateTitle: { color: color.ink, marginTop: space.lg },
  trainingStateBody: { color: color.inkSoft, marginTop: space.sm },
  trainingAction: { marginTop: space.lg },
  planLoading: { minHeight: 240 },
  improvementCard: { padding: space.lg },
  improvementTitle: { color: color.onDark, marginTop: space.lg },
  improvementBody: { color: color.onDarkMuted, marginTop: space.sm },
  planIntro: { padding: space.lg, marginBottom: 12 },
  planIntroTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  planIntroTitle: { color: color.onDark, marginTop: space.lg },
  planIntroBody: { color: color.onDarkMuted, marginTop: space.sm },
  planProgressTrack: {
    height: 6,
    backgroundColor: color.lineDark,
    borderRadius: 3,
    overflow: 'hidden',
    marginTop: space.lg,
  },
  planProgressFill: { height: '100%', backgroundColor: color.volt },
  reassessmentCard: {
    padding: space.lg,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
  },
  reassessmentIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: color.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reassessmentCopy: { flex: 1 },
  reassessTitle: { color: color.onDark, marginTop: space.lg },
  reassessBody: { color: color.onDarkMuted, marginTop: space.sm },
  createPlanCard: { padding: space.lg },
  mutationError: { padding: space.lg, marginTop: space.md },
  mutationErrorRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  mutationErrorCopy: { marginTop: 3 },
  dismissError: { marginTop: space.md },
});
