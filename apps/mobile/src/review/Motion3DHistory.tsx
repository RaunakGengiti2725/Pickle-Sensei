import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { listMotion3DHistory } from '../data/motion3dRepository';
import { getDb } from '../data/db';
import { subscribeDataOwnerChanges } from '../data/accountScope';
import { Button, PressableScale, SectionTitle } from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';

type Entries = Awaited<ReturnType<typeof listMotion3DHistory>>;

export function useMotion3DHistory(limit = 10) {
  const [entries, setEntries] = useState<Entries>([]);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      const unsubscribe = subscribeDataOwnerChanges(() => {
        cancelled = true;
        setEntries([]);
        setError(null);
      });
      void Promise.resolve()
        .then(() => listMotion3DHistory(getDb(), limit))
        .then(rows => {
          if (!cancelled) {
            setEntries(rows);
            setError(null);
          }
        })
        .catch(() => {
          if (!cancelled) setError('Motion history could not load.');
        });
      return () => {
        cancelled = true;
        unsubscribe();
      };
    }, [limit, revision]),
  );
  return { entries, error, retry: () => setRevision(value => value + 1) };
}

export function Motion3DHistory(props: {
  history: ReturnType<typeof useMotion3DHistory>;
  onOpen: (analysisId: string) => void;
  dark?: boolean;
}) {
  const { entries, error, retry } = props.history;
  if (entries.length === 0 && !error) return null;
  if (entries.length === 0 && error)
    return (
      <View style={styles.section} testID="motion3d-history-error">
        <Text
          style={[
            type.caption,
            { color: props.dark ? color.onDarkMuted : color.inkSoft },
          ]}
        >
          Some saved history could not be checked.
        </Text>
        <Button
          label="Retry"
          variant={props.dark ? 'dark' : 'ghost'}
          onPress={retry}
          testID="motion3d-history-retry"
        />
      </View>
    );
  const ink = props.dark ? color.onDark : color.ink;
  const muted = props.dark ? color.onDarkMuted : color.inkSoft;
  return (
    <View style={styles.section} testID="motion3d-history">
      {props.dark ? (
        <Text style={[type.micro, styles.darkHeading]}>MOTION RECORDINGS</Text>
      ) : (
        <SectionTitle title="Motion recordings" />
      )}
      <Text style={[type.caption, { color: muted }]}>
        3D estimates, saved on this device. Not technique ratings.
      </Text>
      {error ? (
        <View style={styles.error}>
          <Text style={[type.caption, { color: muted }]}>{error}</Text>
          <Button
            label="Retry"
            variant={props.dark ? 'dark' : 'ghost'}
            onPress={retry}
            testID="motion3d-history-retry"
          />
        </View>
      ) : null}
      {entries.map(entry => (
        <PressableScale
          key={entry.id}
          testID={`motion3d-history-${entry.id}`}
          accessibilityLabel={`Open 3D motion${entry.declaredStroke ? `, ${entry.declaredStroke.replace(/_/g, ' ')}` : ''}`}
          onPress={() => props.onOpen(entry.id)}
          style={[
            styles.row,
            {
              backgroundColor: props.dark
                ? color.inkElevated
                : color.surfaceElevated,
              borderColor: props.dark ? color.onDarkFaint : color.line,
            },
          ]}
        >
          <View style={styles.icon}>
            <Icon
              name="person"
              size={23}
              color={props.dark ? color.volt : color.court}
            />
          </View>
          <View style={styles.label}>
            <Text style={[type.bodyBold, { color: ink }]}>
              3D motion
              {entry.declaredStroke
                ? ` · ${entry.declaredStroke.replace(/_/g, ' ')}`
                : ''}
            </Text>
            <Text style={[type.caption, { color: muted }]}>
              {new Date(entry.capturedAtIso).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </Text>
          </View>
          <Icon name="chevron" size={18} color={muted} />
        </PressableScale>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.sm, marginVertical: space.lg },
  darkHeading: { color: color.onDarkMuted, letterSpacing: 1.2 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 72,
    padding: space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    gap: space.sm,
  },
  icon: { width: 32, alignItems: 'center' },
  label: { flex: 1, gap: space.xs },
  error: { gap: space.sm },
});
