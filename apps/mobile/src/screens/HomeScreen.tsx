import React, { useCallback, useState } from 'react';
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Button,
  Card,
  Pill,
  ScoreRing,
  SectionTitle,
} from '../design/components';
import { color, space, type } from '../design/tokens';
import { useAppStore } from '../state/appStore';
import { getDb } from '../data/db';
import { listShots, recentScores, type LocalShotRow } from '../data/repository';
import type { RootStackParams } from '../navigation/params';

/** Home (spec p. 8): score, one job — Analyze Shot / Live Court, today's focus. */

export function HomeScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const profile = useAppStore(s => s.profile);
  const [scores, setScores] = useState<number[]>([]);
  const [recent, setRecent] = useState<LocalShotRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const db = getDb();
      setScores(await recentScores(db, null, 30));
      setRecent(await listShots(db, 5));
    } catch {
      // local db unavailable — screens show empty state, nothing fabricated
      setScores([]);
      setRecent([]);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const current = scores.length ? scores[scores.length - 1]! : null;
  const monthDelta =
    scores.length >= 2
      ? Math.round((scores[scores.length - 1]! - scores[0]!) * 10) / 10
      : null;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void load().finally(() => setRefreshing(false));
          }}
        />
      }
    >
      <Text style={[type.caption, { color: color.inkSoft }]}>
        TECHNIQUE SCORE
      </Text>
      <View style={styles.scoreRow}>
        <ScoreRing
          score={current}
          label={
            monthDelta !== null
              ? `${monthDelta >= 0 ? '+' : ''}${monthDelta} recent`
              : 'no reps yet'
          }
        />
        <View style={styles.actions}>
          <Button
            label="Analyze Shot"
            onPress={() => navigation.navigate('Analyze')}
          />
          <View style={{ height: space.sm }} />
          <Button
            label="Live Court"
            variant="secondary"
            onPress={() => navigation.navigate('LiveCourt')}
          />
        </View>
      </View>

      <SectionTitle title="Today's focus" />
      <Card>
        <Text style={[type.h2, { color: color.ink }]}>
          {(profile?.focusCheckpoint ?? 'contact_position').replace(/_/g, ' ')}
        </Text>
        <Text
          style={[type.body, { color: color.inkSoft, marginTop: space.xs }]}
        >
          One fix at a time. Rep it until it holds.
        </Text>
      </Card>

      <SectionTitle title="Recent" />
      {recent.length === 0 ? (
        <Card>
          <Text style={[type.body, { color: color.inkSoft }]}>
            No analyzed strokes yet. Your first analysis takes under a minute.
          </Text>
        </Card>
      ) : (
        recent.map(shot => (
          <Card key={shot.id} style={{ marginBottom: space.sm }}>
            <View style={styles.recentRow}>
              <View style={{ flex: 1 }}>
                <Text style={[type.bodyBold, { color: color.ink }]}>
                  {shot.shotType.replace(/_/g, ' ')}
                </Text>
                <Text style={[type.caption, { color: color.inkSoft }]}>
                  {new Date(shot.capturedAt).toLocaleString()}
                </Text>
              </View>
              {shot.source === 'fixture' && (
                <Pill label="DEV FIXTURE" tone="bad" />
              )}
              <Text
                style={[
                  type.score,
                  { color: color.ink, fontSize: 28, marginLeft: space.sm },
                ]}
              >
                {shot.overallScore === null
                  ? '—'
                  : shot.overallScore.toFixed(1)}
              </Text>
            </View>
          </Card>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: { padding: space.lg },
  scoreRow: { flexDirection: 'row', alignItems: 'center', marginTop: space.md },
  actions: { flex: 1, marginLeft: space.lg },
  recentRow: { flexDirection: 'row', alignItems: 'center' },
});
