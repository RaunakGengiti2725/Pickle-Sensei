import React, { useEffect, useState } from 'react';
import {
  Alert,
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
import {
  Button,
  Card,
  CheckpointRow,
  ErrorState,
  LoadingState,
  Pill,
  ScoreRing,
  ScreenHeader,
  SectionTitle,
} from '../design/components';
import { Icon } from '../design/icons';
import { color, space, type } from '../design/tokens';
import { getDb } from '../data/db';
import { hasShotSyncReceipt } from '../data/repository';
import type { RootStackParams } from '../navigation/params';
import { PlanDrillCard, prescriptionLabel } from '../training/components';
import { useTrainingStore } from '../training/store';
import type { InstructionalMedia, TrainingPlanItem } from '../training/types';
import {
  StrokeResult,
  StrokeResultAnalyzing,
} from '../components/StrokeResult';
import { DaySecuredBanner } from '../consistency/DaySecuredBanner';
import { useConsistencyStore } from '../consistency/store';
import {
  loadStrokeResultEvidence,
  type StrokeResultEvidence,
} from '../components/strokeResultData';
import {
  CHECKPOINT_NAMES,
  techniqueScoreSectionVisible,
} from '../components/strokeResultModel';
import { AnalysisFeedbackPrompt } from '../components/AnalysisFeedbackPrompt';
import {
  DUPR_ESTIMATE_NOTE,
  formatDuprEstimate,
} from '../progress/duprEstimate';
import { armTryAgain, tryAgainFromResult } from './tryAgainHandoff';

/**
 * RESULT ROUTE — the single entry point for a stroke's outcome, reached from
 * Stroke Analysis (AnalyzeScreen) and Library/Home history rows. The
 * consumer hierarchy is the canonical StrokeResult component (MOBBIN brief
 * §1: one component, two entry points); this screen adds only data loading,
 * the validated-training sections it has always owned, and navigation
 * wiring for TRY AGAIN / attempts.
 */

type SyncEvidenceState = 'checking' | 'synced' | 'pending' | 'unknown';

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

export function ResultScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const route = useRoute<RouteProp<RootStackParams, 'Result'>>();
  const [evidence, setEvidence] = useState<StrokeResultEvidence | undefined>(
    undefined,
  );
  const [syncEvidence, setSyncEvidence] =
    useState<SyncEvidenceState>('checking');
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
  const refreshConsistency = useConsistencyStore(state => state.refresh);

  useEffect(() => {
    let cancelled = false;
    setEvidence(undefined);
    loadStrokeResultEvidence(getDb(), route.params.analysisId)
      .then(loaded => {
        if (!cancelled) setEvidence(loaded);
      })
      .catch(() => {
        if (!cancelled) {
          setEvidence({
            analysis: null,
            record: null,
            clip: null,
            attempts: [],
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [route.params.analysisId]);

  useEffect(() => {
    void loadCurrentPlan();
  }, [loadCurrentPlan]);

  // The analysis this screen shows was just persisted: re-derive the streak
  // so the first training of the day arms its "Day N secured" moment here.
  useEffect(() => {
    void refreshConsistency();
  }, [refreshConsistency, route.params.analysisId]);

  const analysis = evidence?.analysis ?? evidence?.record?.result ?? null;

  useEffect(() => {
    let cancelled = false;
    setSyncEvidence('checking');
    if (!analysis) {
      return () => {
        cancelled = true;
      };
    }
    hasShotSyncReceipt(getDb(), analysis.id)
      .then(accepted => {
        if (!cancelled) setSyncEvidence(accepted ? 'synced' : 'pending');
      })
      .catch(() => {
        if (!cancelled) setSyncEvidence('unknown');
      });
    return () => {
      cancelled = true;
    };
  }, [analysis]);

  const openMedia = async (media: InstructionalMedia) => {
    const url = mediaUrl(media);
    try {
      if (!(await Linking.canOpenURL(url))) throw new Error('unsupported');
      await Linking.openURL(url);
    } catch {
      Alert.alert(
        'Video unavailable',
        'This rights-cleared coaching video could not be opened. Refresh the plan and try again.',
      );
    }
  };

  const confirmCompletion = (item: TrainingPlanItem) => {
    const target = prescriptionLabel(item);
    if (!item.drill || !target) return;
    Alert.alert(
      'Log real practice?',
      `Confirm only if you completed ${target} of “${item.drill.title}.”`,
      [
        { text: 'Not yet', style: 'cancel' },
        {
          text: 'I completed it',
          onPress: () => void completePlanItem(item),
        },
      ],
    );
  };

  if (evidence === undefined) {
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
        <StatusBar barStyle="dark-content" />
        <ScreenHeader
          title="Stroke analysis"
          onClose={() => navigation.popToTop()}
        />
        <StrokeResultAnalyzing caption="Opening your result…" />
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
      />
    );
  }

  const fix = analysis?.priorityFix ?? null;
  const priorityCheckpoint =
    analysis && fix
      ? analysis.checkpoints.find(
          checkpoint => checkpoint.key === fix.checkpoint,
        )
      : null;
  const shotLabel = analysis ? humanize(analysis.shotType) : 'stroke';
  const planForThisRead =
    analysis !== null && currentPlan?.sourceShotId === analysis.id;
  const completedByThisRead =
    analysis !== null && currentPlan?.reassessmentShotId === analysis.id;
  const prescribedItems = currentPlan?.items.filter(item => item.drill) ?? [];
  const completedItems = prescribedItems.filter(item => item.completion);
  const allPrescribedComplete =
    prescribedItems.length === 3 && completedItems.length === 3;
  const scoredReal =
    analysis !== null &&
    analysis.source === 'real' &&
    analysis.resultKind === 'scored' &&
    analysis.overallScore !== null;
  const syncedScoredReal = scoredReal && syncEvidence === 'synced';
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

  const requestPlan = () => {
    if (!analysis || !syncedScoredReal) return;
    if (currentPlan?.status === 'active' && !planForThisRead) {
      Alert.alert(
        'Replace the current plan?',
        'The server will supersede your current plan and build reviewed work from this scored read.',
        [
          { text: 'Keep current plan', style: 'cancel' },
          {
            text: 'Replace plan',
            style: 'destructive',
            onPress: () => void createPlan(analysis.id),
          },
        ],
      );
      return;
    }
    void createPlan(analysis.id);
  };

  // §2 TRY AGAIN: re-arm the guided capture flow with the SAME intent —
  // AnalyzeScreen consumes the handoff, skips the picker and opens the
  // camera directly. Declared runs re-arm the declaration; AUTO runs
  // re-arm AUTO; nothing is invented for legacy rows.
  const tryAgain = () => {
    armTryAgain(tryAgainFromResult(record, analysis));
    navigation.navigate('Analyze', { source: 'camera' });
  };

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
      <StatusBar barStyle="dark-content" />
      <ScreenHeader
        title="Stroke analysis"
        onClose={() => navigation.popToTop()}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <StrokeResult
          key={route.params.analysisId}
          analysis={analysis}
          record={record}
          clip={evidence.clip}
          attempts={evidence.attempts}
          currentAnalysisId={route.params.analysisId}
          onOpenAttempt={analysisId =>
            navigation.replace('Result', { analysisId })
          }
          onTryAgain={tryAgain}
          onDone={() => navigation.popToTop()}
          scoreSlot={
            // Score-first: the technique score stage renders at the very
            // top of the result surface, under the compact header. The
            // abstained path passes nothing — the ledger explains it.
            techniqueScoreSectionVisible(analysis) ? (
              <Card tone="dark" style={styles.resultStage}>
                <Text style={[type.micro, { color: color.volt }]}>
                  TECHNIQUE SCORE
                </Text>
                <Text style={[type.caption, styles.shotLabel]}>
                  {shotLabel}
                </Text>
                <View style={styles.scoreWrap}>
                  <ScoreRing
                    score={analysis.overallScore}
                    label="out of 10"
                    size={190}
                    dark
                  />
                </View>
                {typeof analysis.overallScore === 'number' ? (
                  <>
                    <Text style={[type.caption, styles.duprEstimate]}>
                      {formatDuprEstimate(analysis.overallScore)}
                    </Text>
                    <Text style={[type.caption, styles.duprNote]}>
                      {DUPR_ESTIMATE_NOTE}
                    </Text>
                  </>
                ) : null}
              </Card>
            ) : undefined
          }
        >
          {techniqueScoreSectionVisible(analysis) ? (
            <>
              {fix ? (
                <>
                  <SectionTitle title="Measured priority" />
                  <Card style={styles.fixCard}>
                    <View style={styles.fixHeader}>
                      <View style={styles.priorityBadge}>
                        <Text style={[type.micro, { color: color.onVolt }]}>
                          01
                        </Text>
                      </View>
                      <Text style={[type.micro, { color: color.bad }]}>
                        HIGHEST OBSERVED FAULT
                      </Text>
                    </View>
                    <Text style={[type.h1, styles.fixTitle]}>
                      {CHECKPOINT_NAMES[fix.checkpoint] ??
                        humanize(fix.checkpoint)}
                    </Text>
                    <Text style={[type.body, styles.fixBody]}>
                      The scoring model ranked this checkpoint first from this
                      captured stroke. Coaching below appears only when the
                      server has a reviewed prescription for this exact read.
                    </Text>
                    <View style={styles.observationGrid}>
                      <View style={styles.observationCell}>
                        <Text style={[type.micro, { color: color.inkSoft }]}>
                          DIRECTION
                        </Text>
                        <Text style={[type.h3, styles.observationValue]}>
                          {priorityCheckpoint
                            ? humanize(priorityCheckpoint.direction)
                            : 'not reported'}
                        </Text>
                      </View>
                      <View style={styles.observationCell}>
                        <Text style={[type.micro, { color: color.inkSoft }]}>
                          CHECKPOINT
                        </Text>
                        <Text style={[type.h3, styles.observationValue]}>
                          {priorityCheckpoint?.score === null ||
                          priorityCheckpoint?.score === undefined
                            ? '—'
                            : Math.round(priorityCheckpoint.score)}
                        </Text>
                      </View>
                    </View>
                  </Card>
                </>
              ) : null}

              <SectionTitle
                title="Stroke map"
                right={
                  <Text style={[type.caption, { color: color.inkSoft }]}>
                    {
                      analysis.checkpoints.filter(
                        checkpoint => checkpoint.applicable,
                      ).length
                    }{' '}
                    observed
                  </Text>
                }
              />
              <Card style={styles.checkpointsCard}>
                {analysis.checkpoints
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
                  Scored with {analysis.versionVector.scoringModelVersion} ·
                  configuration {analysis.versionVector.shotConfigVersion} ·
                  verified on-device source
                </Text>
              </View>
            </>
          ) : null}

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
                  One warm-up and two targeted prescriptions selected by the
                  server for {humanize(currentPlan.priorityCheckpoint)} ·{' '}
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
                            : (completedItems.length / prescribedItems.length) *
                              100
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
                  detail={
                    item.drill ? drillDetails[item.drill.slug] : undefined
                  }
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
                  <Text style={[type.h3, { color: color.ink }]}>
                    Reassessment
                  </Text>
                  <Text
                    style={[
                      type.caption,
                      { color: color.inkSoft, marginTop: 3 },
                    ]}
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
                This is a newer synced {shotLabel} read. The server will verify
                shot type, timing, scoring model, and completed practice before
                comparing it.
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
          ) : syncEvidence === 'checking' ? (
            <View style={styles.planLoading}>
              <LoadingState label="Checking sync evidence…" />
            </View>
          ) : syncEvidence !== 'synced' ? (
            <Card tone="soft" style={styles.trainingStateCard}>
              <View style={styles.trainingStateIcon}>
                <Icon name="upload" size={22} color={color.court} />
              </View>
              <Text style={[type.h2, styles.trainingStateTitle]}>
                Sync this read first.
              </Text>
              <Text style={[type.body, styles.trainingStateBody]}>
                {syncEvidence === 'pending'
                  ? 'This real score is still in the secure outbox. Personalized training unlocks after the server accepts the shot.'
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
                The server will create a plan only if this shot has a real score
                and the exact fault has one reviewed warm-up plus two reviewed
                targeted drills.
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
            <Card tone="soft" style={styles.mutationError}>
              <View style={styles.mutationErrorRow}>
                <Icon name="close" size={19} color={color.bad} />
                <View style={styles.flex}>
                  <Text style={[type.bodyBold, { color: color.bad }]}>
                    Training not changed
                  </Text>
                  <Text style={[type.caption, styles.mutationErrorCopy]}>
                    {mutationError.message}
                  </Text>
                </View>
              </View>
              <View style={styles.dismissError}>
                <Button
                  label="Dismiss"
                  variant="ghost"
                  compact
                  onPress={clearMutationError}
                />
              </View>
            </Card>
          ) : null}

          {syncEvidence === 'synced' ? (
            <AnalysisFeedbackPrompt analysisId={route.params.analysisId} />
          ) : null}
        </StrokeResult>
      </ScrollView>
      {/* "Day N secured" — first meaningful training of the day lands here. */}
      <DaySecuredBanner />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  flex: { flex: 1 },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xl,
  },
  resultStage: { minHeight: 352, marginTop: space.lg, padding: space.lg },
  shotLabel: {
    color: color.onDarkFaint,
    textTransform: 'capitalize',
    marginTop: 4,
  },
  scoreWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space.md,
  },
  duprEstimate: { color: color.onDarkMuted, textAlign: 'center' },
  duprNote: {
    color: color.onDarkFaint,
    textAlign: 'center',
    marginTop: space.xs,
  },
  fixCard: { padding: space.lg },
  fixHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  priorityBadge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: color.volt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fixTitle: { color: color.ink, marginTop: space.lg },
  fixBody: { color: color.inkSoft, marginTop: space.sm },
  observationGrid: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
    marginTop: space.lg,
    paddingTop: space.md,
  },
  observationCell: { flex: 1, gap: 5 },
  observationValue: { color: color.ink, textTransform: 'capitalize' },
  checkpointsCard: { paddingHorizontal: space.lg, paddingVertical: 5 },
  traceRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: space.sm,
    marginTop: space.lg,
  },
  traceCopy: { color: color.inkSoft, flex: 1 },
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
  mutationErrorCopy: { color: color.bad, marginTop: 3 },
  dismissError: { marginTop: space.md },
});
