import React, { useEffect } from 'react';
import { ScrollView, StatusBar, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  useNavigation,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ErrorState, ScreenHeader } from '../design/components';
import { color, space } from '../design/tokens';
import type { RootStackParams } from '../navigation/params';
import { StrokeResultAnalyzing } from '../components/StrokeResult';
import { useTrainingStore } from '../training/store';
import { ResultBreakdownSheet, useStrokeResultEvidence } from './ResultScreen';
import { armTryAgain, tryAgainFromResult } from './tryAgainHandoff';

/**
 * RESULT DETAILS — the "Full breakdown" of one analysis on its own route,
 * reached from the last page of the Result guide. It holds EXACTLY what the
 * guide's collapsed disclosure used to unfold inline (`ResultBreakdownSheet`:
 * the canonical `StrokeResult`, the form-review card, WHAT TO FIX in full,
 * the stroke map, the provenance trace, the personalized training plan and
 * the feedback prompt), unchanged, on its light surface — so the guide's
 * "Next" page can stay a single card.
 *
 * A separate route means separate loading: the same evidence hook the guide
 * uses (`useStrokeResultEvidence`) reads the three stores, hash-verifies the
 * pose sidecar and checks the sync receipt; the training plan is refreshed
 * the same way. Nothing here derives a sentence the guide does not.
 */

export function ResultDetailsScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const route = useRoute<RouteProp<RootStackParams, 'ResultDetails'>>();
  const analysisId = route.params.analysisId;
  const { evidence, analysis, sequence, syncEvidence } =
    useStrokeResultEvidence(analysisId);
  const loadCurrentPlan = useTrainingStore(state => state.loadCurrentPlan);

  useEffect(() => {
    void loadCurrentPlan();
  }, [loadCurrentPlan]);

  if (evidence === undefined) {
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
        <StatusBar barStyle="dark-content" />
        <ScreenHeader
          title="Full breakdown"
          onBack={() => navigation.goBack()}
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
        retryLabel="Go back"
      />
    );
  }

  return (
    <SafeAreaView
      edges={['top', 'bottom']}
      style={styles.screen}
      testID="result-details"
    >
      <StatusBar barStyle="dark-content" />
      <ScreenHeader title="Full breakdown" onBack={() => navigation.goBack()} />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        testID="result-details-scroll"
      >
        <ResultBreakdownSheet
          // Keyed by attempt so repointing the route starts the sheet over.
          key={analysisId}
          analysisId={analysisId}
          analysis={analysis}
          record={record}
          clip={evidence.clip}
          review={evidence.review}
          attempts={evidence.attempts}
          sequence={sequence}
          syncEvidence={syncEvidence}
          onOpenAttempt={target =>
            // Attempt chips repoint the GUIDE (the route under this one) at
            // the other attempt and pop back to it — never a second stack.
            target === analysisId
              ? undefined
              : navigation.popTo('Result', { analysisId: target })
          }
          onTryAgain={() => {
            // Same re-arm as the guide's TRY AGAIN: the guided camera opens
            // with this stroke's declaration (or AUTO) and practice set.
            armTryAgain(tryAgainFromResult(record, analysis));
            navigation.navigate('Analyze', { source: 'camera' });
          }}
          onDone={() => navigation.popToTop()}
          onOpenFormReview={phase =>
            navigation.navigate('FormReview', {
              analysisId,
              ...(phase !== undefined ? { phase } : {}),
            })
          }
          testID="result-details-breakdown"
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  // The sheet bleeds to the page edges by design (see ResultScreen's
  // `sheet` style); this padding is what it bleeds against.
  content: {
    paddingHorizontal: space.lg,
    paddingBottom: space.xl,
  },
});
