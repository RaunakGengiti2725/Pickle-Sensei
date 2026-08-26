import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  useNavigation,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { ShotAnalysis } from '@pickle/shared-types';
import {
  Button,
  Card,
  CheckpointRow,
  ErrorState,
  FixtureBanner,
  LoadingState,
  Pill,
  ScoreRing,
  SectionTitle,
} from '../design/components';
import { color, space, type } from '../design/tokens';
import { getDb } from '../data/db';
import { getAnalysis } from '../data/repository';
import type { RootStackParams } from '../navigation/params';

/**
 * Analysis result (spec p. 8): intentionally asymmetric — score, then ONE
 * priority fix with cause and cue, then the checkpoint list. Low-confidence
 * results abstain with setup guidance instead of a number.
 */

const CHECKPOINT_NAMES: Record<string, string> = {
  ready_position: 'Ready Position',
  athletic_base: 'Athletic Base',
  preparation: 'Preparation',
  paddle_set: 'Paddle Set',
  swing_length: 'Swing Length',
  sequencing: 'Sequencing',
  paddle_path: 'Paddle Path',
  contact_position: 'Contact Position',
  face_wrist_stability: 'Face / Wrist Stability',
  follow_through: 'Follow-Through',
  recovery: 'Recovery',
};

const FIX_COPY: Record<string, { what: string; why: string; cue: string }> = {
  contact_position: {
    what: 'Your paddle is meeting the ball later than your best reps.',
    why: 'Late contact cuts your room to accelerate forward while keeping the face stable.',
    cue: 'Meet it in front.',
  },
  preparation: {
    what: 'Your shoulder turn is starting late or staying short.',
    why: 'Late preparation forces a rushed path and late contact downstream.',
    cue: 'Turn as the ball leaves their paddle.',
  },
  swing_length: {
    what: 'Your backswing is longer than this shot wants.',
    why: 'A big swing costs control and recovery time at the kitchen.',
    cue: 'Keep it compact.',
  },
  paddle_set: {
    what: 'Your paddle set is drifting from the ready window.',
    why: 'A low or trailing set means the swing starts from behind schedule.',
    cue: 'Set it early, out front.',
  },
};

export function ResultScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const route = useRoute<RouteProp<RootStackParams, 'Result'>>();
  const [analysis, setAnalysis] = useState<ShotAnalysis | null | undefined>(
    undefined,
  );

  useEffect(() => {
    getAnalysis(getDb(), route.params.analysisId)
      .then(setAnalysis)
      .catch(() => setAnalysis(null));
  }, [route.params.analysisId]);

  if (analysis === undefined) return <LoadingState label="Loading result…" />;
  if (analysis === null) {
    return (
      <ErrorState
        title="Result missing"
        detail="This analysis is no longer on this device."
        onRetry={() => navigation.goBack()}
      />
    );
  }

  const fix = analysis.priorityFix;
  const fixCopy = fix ? FIX_COPY[fix.checkpoint] : undefined;
  const lowerConfidence =
    analysis.resultKind === 'scored' && analysis.analysisConfidence < 0.8;

  return (
    <View style={styles.screen}>
      {analysis.source === 'fixture' && <FixtureBanner />}
      <ScrollView contentContainerStyle={styles.content}>
        {analysis.resultKind === 'low_confidence' ? (
          <Card>
            <Text style={[type.h1, { color: color.ink }]}>
              Couldn't read this stroke
            </Text>
            <Text
              style={[type.body, { color: color.inkSoft, marginTop: space.sm }]}
            >
              {analysis.guidance ??
                'Reposition the phone so your whole body and paddle stay in frame.'}
            </Text>
          </Card>
        ) : (
          <>
            <View style={styles.scoreWrap}>
              <ScoreRing
                score={analysis.overallScore}
                label={analysis.shotType.replace(/_/g, ' ')}
              />
              {lowerConfidence && <Pill label="LOWER CONFIDENCE" tone="warn" />}
            </View>

            {fix && (
              <>
                <SectionTitle title="Priority" />
                <Card>
                  <Text style={[type.h2, { color: color.bad }]}>
                    {CHECKPOINT_NAMES[fix.checkpoint] ?? fix.checkpoint}
                  </Text>
                  <Text
                    style={[
                      type.body,
                      { color: color.ink, marginTop: space.sm },
                    ]}
                  >
                    {fixCopy?.what ??
                      'This checkpoint is costing you the most right now.'}
                  </Text>
                  <Text
                    style={[
                      type.caption,
                      { color: color.inkSoft, marginTop: space.sm },
                    ]}
                  >
                    WHY IT MATTERS
                  </Text>
                  <Text style={[type.body, { color: color.inkSoft }]}>
                    {fixCopy?.why ??
                      'Upstream faults cascade into contact quality.'}
                  </Text>
                  <Text
                    style={[
                      type.caption,
                      { color: color.inkSoft, marginTop: space.sm },
                    ]}
                  >
                    NEXT CUE
                  </Text>
                  <Text style={[type.h2, { color: color.court }]}>
                    "{fixCopy?.cue ?? 'One thing at a time.'}"
                  </Text>
                </Card>
              </>
            )}

            <SectionTitle title="Checkpoints" />
            <Card>
              {analysis.checkpoints
                .filter(c => c.applicable)
                .map(c => (
                  <CheckpointRow
                    key={c.key}
                    name={CHECKPOINT_NAMES[c.key] ?? c.key}
                    score={c.score}
                    band={c.band}
                    confidence={c.confidence}
                  />
                ))}
            </Card>

            <SectionTitle title="Traceability" />
            <Card>
              <Text style={[type.caption, { color: color.inkSoft }]}>
                {`confidence ${analysis.analysisConfidence.toFixed(2)} · scoring ${analysis.versionVector.scoringModelVersion} · config ${analysis.versionVector.shotConfigVersion} · source ${analysis.source}`}
              </Text>
            </Card>
          </>
        )}
        <View style={{ marginTop: space.lg }}>
          <Button
            label="Practice this in Live Court"
            onPress={() => navigation.navigate('LiveCourt')}
          />
          <View style={{ height: space.sm }} />
          <Button
            label="Done"
            variant="secondary"
            onPress={() => navigation.popToTop()}
          />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: { padding: space.lg },
  scoreWrap: { alignItems: 'center', gap: space.sm },
});
