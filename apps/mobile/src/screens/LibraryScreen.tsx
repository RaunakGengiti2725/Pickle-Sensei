import React, { useCallback, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Card, EmptyState, Pill } from '../design/components';
import { color, space, type } from '../design/tokens';
import { getDb } from '../data/db';
import { listShots, type LocalShotRow } from '../data/repository';
import type { RootStackParams } from '../navigation/params';
import { Pressable } from 'react-native';

export function LibraryScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const [shots, setShots] = useState<LocalShotRow[] | null>(null);

  useFocusEffect(
    useCallback(() => {
      listShots(getDb(), 100)
        .then(setShots)
        .catch(() => setShots([]));
    }, []),
  );

  if (shots !== null && shots.length === 0) {
    return (
      <EmptyState
        title="Your library is empty"
        body="Every analyzed stroke and Live Court rep lands here, on this device first."
      />
    );
  }

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={styles.content}
      data={shots ?? []}
      keyExtractor={item => item.id}
      renderItem={({ item }) => (
        <Pressable
          onPress={() => navigation.navigate('Result', { analysisId: item.id })}
        >
          <Card style={{ marginBottom: space.sm }}>
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={[type.bodyBold, { color: color.ink }]}>
                  {item.shotType.replace(/_/g, ' ')}
                </Text>
                <Text style={[type.caption, { color: color.inkSoft }]}>
                  {new Date(item.capturedAt).toLocaleString()}
                </Text>
              </View>
              {item.source === 'fixture' && (
                <Pill label="DEV FIXTURE" tone="bad" />
              )}
              {item.resultKind === 'low_confidence' ? (
                <Pill label="NOT READ" tone="warn" />
              ) : (
                <Text
                  style={[
                    type.score,
                    { color: color.ink, fontSize: 26, marginLeft: space.sm },
                  ]}
                >
                  {item.overallScore?.toFixed(1)}
                </Text>
              )}
            </View>
          </Card>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: { padding: space.lg },
  row: { flexDirection: 'row', alignItems: 'center' },
});
