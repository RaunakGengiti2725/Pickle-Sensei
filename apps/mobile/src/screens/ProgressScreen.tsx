import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Card, SectionTitle, TrendChart } from '../design/components';
import { color, space, type } from '../design/tokens';
import { getDb } from '../data/db';
import { recentScores } from '../data/repository';
import { MVP_SHOT_TYPES } from '@pickle/shared-types';

/** Progress: overall + per-stroke local trends. Server trends are scoring-model-version aware. */

export function ProgressScreen() {
  const [overall, setOverall] = useState<number[]>([]);
  const [byShot, setByShot] = useState<Record<string, number[]>>({});

  useFocusEffect(
    useCallback(() => {
      void (async () => {
        try {
          const db = getDb();
          setOverall(await recentScores(db, null, 60));
          const next: Record<string, number[]> = {};
          for (const shotType of MVP_SHOT_TYPES) {
            next[shotType] = await recentScores(db, shotType, 30);
          }
          setByShot(next);
        } catch {
          setOverall([]);
          setByShot({});
        }
      })();
    }, []),
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={[type.h1, { color: color.ink }]}>Progress</Text>
      <SectionTitle title="Overall trend" />
      <Card>
        <TrendChart points={overall} />
      </Card>
      {MVP_SHOT_TYPES.map(shotType => (
        <React.Fragment key={shotType}>
          <SectionTitle title={shotType.replace(/_/g, ' ')} />
          <Card>
            <TrendChart points={byShot[shotType] ?? []} height={56} />
          </Card>
        </React.Fragment>
      ))}
      <Text
        style={[type.caption, { color: color.inkSoft, marginTop: space.lg }]}
      >
        Trends compare reps scored under the same scoring model version. Scores
        never silently change when models update.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: { padding: space.lg },
});
