import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { Card, PressableScale } from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';

/**
 * Entry card for the FORM REVIEW, shown on the Result screen once a stroke
 * has a scored analysis. The poster is the real captured still (when one
 * exists); the counts come straight from the review script — nothing on the
 * card claims a checkpoint the engine did not score.
 */

function checkpointLine(stopCount: number): string {
  const stops = stopCount === 1 ? '1 checkpoint' : `${stopCount} checkpoints`;
  return `${stops} · exoskeleton + heat map · slow motion`;
}

function fixLine(fixCount: number): string {
  return fixCount === 1
    ? '1 FIX POINTED OUT ON YOUR BODY'
    : `${fixCount} FIXES POINTED OUT ON YOUR BODY`;
}

export function FormReviewCard(props: {
  posterUri?: string;
  stopCount: number;
  fixCount: number;
  onPress: () => void;
}) {
  const stopCount = Math.max(0, Math.floor(props.stopCount));
  const fixCount = Math.max(0, Math.floor(props.fixCount));
  return (
    <PressableScale
      onPress={props.onPress}
      accessibilityLabel={`Watch your form review, ${checkpointLine(stopCount)}${
        fixCount > 0 ? `, ${fixLine(fixCount).toLowerCase()}` : ''
      }`}
      testID="form-review-card"
    >
      <Card tone="dark" style={styles.card}>
        <View style={styles.poster}>
          {props.posterUri ? (
            <Image
              source={{ uri: props.posterUri }}
              resizeMode="cover"
              style={StyleSheet.absoluteFill}
              accessibilityIgnoresInvertColors
            />
          ) : null}
          <View style={styles.playBadge}>
            <Icon name="play" size={18} color={color.onVolt} />
          </View>
        </View>
        <View style={styles.copy}>
          <Text style={[type.micro, { color: color.volt }]}>FORM REVIEW</Text>
          <Text style={[type.h2, styles.title]}>Watch your form review</Text>
          <Text style={[type.caption, styles.caption]}>
            {checkpointLine(stopCount)}
          </Text>
          {fixCount > 0 ? (
            <Text style={[type.micro, styles.fixes]}>{fixLine(fixCount)}</Text>
          ) : null}
        </View>
        <Icon name="chevron" size={18} color={color.onDarkMuted} />
      </Card>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
  },
  poster: {
    width: 96,
    height: 128,
    borderRadius: radius.sm,
    overflow: 'hidden',
    backgroundColor: color.cameraSurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: color.volt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: { flex: 1, gap: space.xs },
  title: { color: color.onDark },
  caption: { color: color.onDarkMuted },
  fixes: { color: color.flame, marginTop: space.xs },
});
