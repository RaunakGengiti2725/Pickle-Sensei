import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import {
  captureGuidanceLines,
  readyGate,
  type EnvelopeVerdict,
} from './captureEnvelope';

/**
 * Pre-Ready capture guidance — actionable envelope feedback shown while the
 * camera is reading the scene, BEFORE the player swings. Renders one line
 * per measured non-SUPPORTED dimension, plus an honest Ready gate note when
 * an UNSUPPORTED dimension is blocking. Renders nothing when the measured
 * envelope is clean (the readiness caption already says Ready).
 */
export function CaptureGuidancePanel(props: {
  envelope: EnvelopeVerdict | null;
}) {
  const lines = captureGuidanceLines(props.envelope);
  if (lines.length === 0) return null;
  const gate = readyGate(props.envelope);
  return (
    <View
      style={styles.panel}
      accessibilityRole="text"
      accessibilityLabel="Capture guidance"
    >
      {lines.map(line => (
        <View key={line.dimension} style={styles.row}>
          <Icon
            name={line.verdict === 'UNSUPPORTED' ? 'shield' : 'spark'}
            color={line.verdict === 'UNSUPPORTED' ? color.warn : color.mint}
            size={16}
          />
          <Text style={[type.caption, styles.lineText]}>{line.text}</Text>
        </View>
      ))}
      <Text style={[type.micro, styles.gateText]}>
        {gate.blocked
          ? 'Ready is on hold until the items above are fixed.'
          : 'Ready is not blocked — fixing the items above improves the read.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    marginTop: space.lg,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineDark,
    backgroundColor: color.inkElevated,
    gap: space.sm,
    alignSelf: 'stretch',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  lineText: { color: color.onDark, flex: 1 },
  gateText: { color: color.onDarkSubtle },
});
