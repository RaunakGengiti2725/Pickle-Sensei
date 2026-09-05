import React, { useEffect, useState } from 'react';
import {
  StatusBar,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  useNavigation,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { ShotAnalysis } from '@pickle/shared-types';
import { Button, ErrorState, PressableScale } from '../design/components';
import { color, space, type } from '../design/tokens';
import { getDb } from '../data/db';
import type { RootStackParams } from '../navigation/params';
import {
  ACCESSIBLE_ANALYSIS_FONT_SCALE,
  AnalysisScreenHeader,
  StrokeResultAnalyzing,
  type StrokeResultClip,
} from '../components/StrokeResult';
import {
  loadStrokeResultEvidence,
  type StrokeReviewEvidence,
} from '../components/strokeResultData';
import type { StrokeResultEvidenceRecord } from '../components/strokeResultModel';
import {
  buildFormReviewScript,
  type FormReviewScript,
  type ReviewPoseSequence,
  type ReviewStop,
} from '../review/formReviewModel';
import { FormReviewPlayer } from '../review/FormReviewPlayer';
import { loadReviewPoseSequence } from '../review/poseSidecar';
import { armTryAgain, tryAgainFromResult } from './tryAgainHandoff';

/**
 * FORM REVIEW — the full-screen host of the flagship replay
 * (`review/FormReviewPlayer.tsx`: clip + exoskeleton + heat map + arrows,
 * pausing at every measured checkpoint). This route loads the evidence,
 * hash-verifies the pose sidecar, builds the pure script, and adds the
 * re-analyze / back CTAs; the Result guide renders the same player inline.
 *
 * Layout: header, then the player in FILL mode taking every point between
 * the header and the pinned CTAs — every control stays below the video. The
 * normal phone layout never needs to scroll; at large Dynamic Type only the
 * picture, full cue and disclosure scroll, never the transport or CTAs.
 *
 * Honesty contract: everything shown traces to the analysis record and the
 * hash-verified pose sidecar. A missing clip shows the pose alone; a missing
 * or corrupt sidecar shows the clip alone; nothing is interpolated or
 * invented to fill either gap.
 */

type LoadState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | {
      kind: 'ready';
      analysis: ShotAnalysis;
      record: StrokeResultEvidenceRecord | null;
      clip: StrokeResultClip | null;
      review: StrokeReviewEvidence | null;
      sequence: ReviewPoseSequence | null;
      script: FormReviewScript;
    };

export function FormReviewScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const route = useRoute<RouteProp<RootStackParams, 'FormReview'>>();
  const analysisId = route.params.analysisId;
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    (async () => {
      const evidence = await loadStrokeResultEvidence(
        getDb(),
        analysisId,
      ).catch(() => null);
      const analysis = evidence?.analysis ?? evidence?.record?.result ?? null;
      if (!analysis) {
        if (!cancelled) setState({ kind: 'missing' });
        return;
      }
      // The sidecar is read and hash-verified exactly like the engine does;
      // any failure is an honest null (pose-less replay), never a repair.
      const sidecar = evidence?.review?.poseSequence ?? null;
      const sequence = sidecar
        ? await loadReviewPoseSequence(sidecar).catch(() => null)
        : null;
      if (cancelled) return;
      setState({
        kind: 'ready',
        analysis,
        record: evidence?.record ?? null,
        clip: evidence?.clip ?? null,
        review: evidence?.review ?? null,
        sequence,
        script: buildFormReviewScript(analysis, sequence),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [analysisId]);

  if (state.kind === 'loading') {
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
        <StatusBar barStyle="light-content" />
        <AnalysisScreenHeader
          title="Form review"
          dark
          onClose={() => navigation.goBack()}
        />
        <StrokeResultAnalyzing caption="Preparing your form review…" dark />
      </SafeAreaView>
    );
  }
  if (state.kind === 'missing') {
    return (
      <ErrorState
        title="Review unavailable"
        detail="This stroke has no scored analysis on this device, so there is nothing to replay."
        onRetry={() => navigation.goBack()}
        dark
      />
    );
  }
  // A "See it in your form review" link names the phase it wants: open the
  // replay frozen on that stop (only when the script actually has one there).
  const requestedPhase = route.params.phase;
  const initialStop =
    requestedPhase !== undefined
      ? (state.script.stops.find(stop => stop.phase === requestedPhase) ?? null)
      : null;
  return (
    <FormReviewBody
      key={analysisId}
      analysis={state.analysis}
      clip={state.clip}
      review={state.review}
      sequence={state.sequence}
      script={state.script}
      initialStop={initialStop}
      onClose={() => navigation.goBack()}
      onReanalyze={() => {
        // Same re-arm as the Result screen's TRY AGAIN: the guided camera
        // opens with this stroke's declaration (or AUTO) and practice set.
        armTryAgain(tryAgainFromResult(state.record, state.analysis));
        navigation.navigate('Analyze', { source: 'camera' });
      }}
    />
  );
}

// ─── The replay host ────────────────────────────────────────────────────────

function FormReviewBody(props: {
  analysis: ShotAnalysis;
  clip: StrokeResultClip | null;
  review: StrokeReviewEvidence | null;
  sequence: ReviewPoseSequence | null;
  script: FormReviewScript;
  /** Open frozen on this stop (deep link from "See it in your form review"). */
  initialStop?: ReviewStop | null;
  onClose: () => void;
  onReanalyze: () => void;
}) {
  const { height, fontScale } = useWindowDimensions();
  const accessibleLayout = fontScale > ACCESSIBLE_ANALYSIS_FONT_SCALE;
  const compactActions = accessibleLayout && height < 760;
  const disclosure = (
    <Text
      style={[type.caption, styles.disclosure]}
      testID="form-review-disclosure"
    >
      Video and pose stay on this device. Analysis results sync with your
      account.
    </Text>
  );
  return (
    <SafeAreaView
      edges={['top', 'bottom']}
      style={styles.screen}
      testID="form-review-screen"
    >
      <StatusBar barStyle="light-content" />
      <AnalysisScreenHeader title="Form review" dark onClose={props.onClose} />
      {/* The player fills everything between the header and the CTAs. Its
          controls stay below the video; only its accessible content can scroll. */}
      <View style={styles.body}>
        <FormReviewPlayer
          analysis={props.analysis}
          clip={props.clip}
          review={props.review}
          sequence={props.sequence}
          script={props.script}
          initialStop={props.initialStop ?? null}
          fill
          contentFooter={accessibleLayout ? disclosure : undefined}
        />
      </View>

      {/* ── CTAs, pinned ──────────────────────────────────────────────── */}
      <View style={styles.footer}>
        <Button
          label="Re-analyze this stroke"
          variant="volt"
          icon="camera"
          onPress={props.onReanalyze}
          testID="form-review-reanalyze"
        />
        {compactActions ? (
          <PressableScale
            accessibilityLabel="Back to results"
            onPress={props.onClose}
            style={styles.backLink}
            testID="form-review-back"
          >
            <Text style={[type.bodyBold, styles.backLinkText]}>
              Back to results
            </Text>
          </PressableScale>
        ) : (
          <Button
            label="Back to results"
            variant="dark"
            onPress={props.onClose}
            testID="form-review-back"
          />
        )}
        {!accessibleLayout ? disclosure : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surfaceDark },
  body: { flex: 1, minHeight: 0, paddingHorizontal: space.lg },
  footer: {
    flexShrink: 0,
    gap: 10,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
  },
  backLink: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  backLinkText: { color: color.onDarkMuted, textAlign: 'center' },
  disclosure: {
    color: color.onDarkFaint,
    marginTop: space.xs,
    textAlign: 'center',
  },
});
