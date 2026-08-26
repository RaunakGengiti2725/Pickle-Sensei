import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  useNavigation,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Button, Card, LoadingState, SectionTitle } from '../design/components';
import { color, space, type } from '../design/tokens';
import { getDb } from '../data/db';
import type { RootStackParams } from '../navigation/params';

/** Session summary (spec p. 7): reps, trend, best, biggest gain, next focus. */

interface StoredSummary {
  validReps: number;
  lowConfidenceReps: number;
  startScore: number | null;
  endScore: number | null;
  bestScore: number | null;
  focusCheckpoint: string;
  focusStart: number | null;
  focusEnd: number | null;
  cuesSpoken: number;
}

export function LiveSummaryScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const route = useRoute<RouteProp<RootStackParams, 'LiveSummary'>>();
  const [summary, setSummary] = useState<StoredSummary | null | undefined>(
    undefined,
  );

  useEffect(() => {
    getDb()
      .execute(`SELECT summary FROM local_session WHERE id = ?`, [
        route.params.sessionId,
      ])
      .then(({ rows }) => {
        const raw = rows[0]?.['summary'];
        setSummary(raw ? (JSON.parse(String(raw)) as StoredSummary) : null);
      })
      .catch(() => setSummary(null));
  }, [route.params.sessionId]);

  if (summary === undefined) return <LoadingState label="Wrapping up…" />;

  const focusDelta =
    summary?.focusStart != null && summary?.focusEnd != null
      ? Math.round((summary.focusEnd - summary.focusStart) * 10) / 10
      : null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={[type.h1, { color: color.ink }]}>Session complete</Text>
      {summary === null ? (
        <Card style={{ marginTop: space.md }}>
          <Text style={[type.body, { color: color.inkSoft }]}>
            Summary unavailable for this session.
          </Text>
        </Card>
      ) : (
        <>
          <View style={styles.statRow}>
            <Card style={styles.stat}>
              <Text style={[type.score, { color: color.ink }]}>
                {summary.validReps}
              </Text>
              <Text style={[type.caption, { color: color.inkSoft }]}>
                scored reps
              </Text>
            </Card>
            <Card style={styles.stat}>
              <Text style={[type.score, { color: color.ink }]}>
                {summary.bestScore?.toFixed(1) ?? '—'}
              </Text>
              <Text style={[type.caption, { color: color.inkSoft }]}>best</Text>
            </Card>
          </View>
          <SectionTitle title="Trend" />
          <Card>
            <Text style={[type.h2, { color: color.ink }]}>
              {summary.startScore?.toFixed(1) ?? '—'} →{' '}
              {summary.endScore?.toFixed(1) ?? '—'}
            </Text>
            {focusDelta !== null && (
              <Text
                style={[
                  type.body,
                  {
                    color: focusDelta >= 0 ? color.good : color.bad,
                    marginTop: space.xs,
                  },
                ]}
              >
                {`Biggest ${focusDelta >= 0 ? 'gain' : 'slide'}: ${summary.focusCheckpoint.replace(/_/g, ' ')} ${focusDelta >= 0 ? '+' : ''}${focusDelta}`}
              </Text>
            )}
            {summary.lowConfidenceReps > 0 && (
              <Text
                style={[
                  type.caption,
                  { color: color.inkSoft, marginTop: space.sm },
                ]}
              >
                {`${summary.lowConfidenceReps} rep(s) couldn't be read reliably and were not scored.`}
              </Text>
            )}
          </Card>
        </>
      )}
      <View style={{ marginTop: space.lg }}>
        <Button label="Back to Home" onPress={() => navigation.popToTop()} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: { padding: space.lg },
  statRow: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
  stat: { flex: 1, alignItems: 'center' },
});
