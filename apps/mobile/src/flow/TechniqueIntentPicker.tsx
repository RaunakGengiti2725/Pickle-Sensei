import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import {
  projectVoiceResolution,
  resolveVoiceTechniqueIntent,
  SELECTABLE_TECHNIQUES_V1,
  TECHNIQUE_INTENT_VERSION,
  type IntentResolution,
  type SelectableTechnique,
  type TechniqueIntent,
  type VoiceIntentResolution,
} from '@pickle/shared-types';
import { PressableScale } from '../design/components';
import { color, font, radius, space, type } from '../design/tokens';

/**
 * "WHAT ARE YOU WORKING ON?" — one canonical intent architecture for
 * TAP, VOICE, and AUTO.
 *
 * UI patterns researched on Mobbin (2026-08-28): Oura's activity picker
 * (search field where the iOS keyboard's built-in dictation provides voice
 * for free), Life Reset's tappable technique grid, Garmin Connect's
 * exercise list. Interaction lessons only — Pickle Sensei tokens and
 * components throughout.
 *
 * Every path terminates in SELECTABLE_TECHNIQUES_V1 (technique-intent-v1):
 * typing/dictating resolves through the deterministic registry resolver;
 * genuinely ambiguous phrases narrow the grid instead of guessing. The
 * declaration is CONTEXT — the analyzer's predictedStroke stays a separate
 * record and may disagree.
 *
 * AUTO DETECT emits a real intent ({source:'auto', canonical:null}) —
 * distinguishable from "nothing selected". The analyzer then runs the
 * hierarchical L1/L2 stroke classifier and resolves from the PREDICTION:
 * usually a family-level read (forehand/backhand), occasionally a committed
 * leaf, and an honest "couldn't classify" otherwise. Exact-stroke (L3)
 * detection is NOT promised — it needs bounce data nothing measures yet.
 */

/** The canonical AUTO DETECT intent — selected, but declaring nothing. */
export function autoDetectIntent(): TechniqueIntent {
  return {
    version: TECHNIQUE_INTENT_VERSION,
    source: 'auto',
    canonical: null,
    legacySlug: null,
    confidence: null,
  };
}

export function TechniqueIntentPicker(props: {
  value: TechniqueIntent | null;
  onChange: (intent: TechniqueIntent | null) => void;
  dark?: boolean;
}) {
  const [text, setText] = useState('');
  const autoSelected = props.value?.source === 'auto';

  // Transcript-in, intent-out: the voice-intent-v1 grammar resolves against
  // the 61-technique taxonomy, then projects into the capture-selectable
  // registry. Both steps are deterministic and registry-terminated.
  const voiceResolution: VoiceIntentResolution | null = useMemo(
    () => (text.trim().length >= 3 ? resolveVoiceTechniqueIntent(text) : null),
    [text],
  );
  const resolution: IntentResolution | null = useMemo(
    () => (voiceResolution ? projectVoiceResolution(voiceResolution) : null),
    [voiceResolution],
  );
  const visibleTechniques: readonly SelectableTechnique[] =
    resolution?.status === 'ambiguous'
      ? resolution.options
      : SELECTABLE_TECHNIQUES_V1;

  const select = (technique: SelectableTechnique, source: 'tap' | 'voice') => {
    props.onChange({
      version: TECHNIQUE_INTENT_VERSION,
      source,
      canonical: technique.canonical,
      legacySlug: technique.legacySlug,
      confidence: source === 'tap' ? 1 : 0.95,
      ...(source === 'voice' ? { rawUserText: text.trim() } : {}),
    });
  };

  const onSubmitText = () => {
    if (!resolution) return;
    if (resolution.status === 'resolved') select(resolution.technique, 'voice');
    else if (resolution.status === 'auto') props.onChange(autoDetectIntent());
  };

  return (
    <View>
      <TextInput
        accessibilityLabel="Type or dictate the technique you are working on"
        placeholder="Type or dictate — “backhand dink”"
        placeholderTextColor={props.dark ? color.onDarkSubtle : color.inkSoft}
        value={text}
        onChangeText={value => {
          setText(value);
          const resolved =
            value.trim().length >= 3
              ? projectVoiceResolution(resolveVoiceTechniqueIntent(value))
              : null;
          if (resolved?.status === 'resolved')
            select(resolved.technique, 'voice');
        }}
        onSubmitEditing={onSubmitText}
        autoCorrect={false}
        returnKeyType="done"
        style={[styles.intentField, props.dark && styles.intentFieldDark]}
      />
      {resolution?.status === 'ambiguous' ? (
        <Text
          style={[type.caption, styles.hint, props.dark && styles.hintDark]}
        >
          {resolution.reason} — pick one below.
        </Text>
      ) : resolution?.status === 'unknown' ? (
        <Text
          style={[type.caption, styles.hint, props.dark && styles.hintDark]}
        >
          {voiceResolution?.status === 'unknown'
            ? voiceResolution.rePrompt
            : 'No matching technique — tap one below.'}
        </Text>
      ) : null}

      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="Which technique are you working on?"
        style={styles.grid}
      >
        {visibleTechniques.map(technique => {
          const selected = props.value?.canonical === technique.canonical;
          return (
            <PressableScale
              key={technique.canonical}
              accessibilityRole="radio"
              accessibilityLabel={technique.displayName}
              accessibilityState={{ selected }}
              onPress={() => select(technique, 'tap')}
              style={[
                styles.chip,
                props.dark && styles.chipDark,
                selected && styles.chipSelected,
              ]}
            >
              <Text
                style={[
                  type.caption,
                  styles.chipLabel,
                  props.dark && !selected && { color: color.onDarkMuted },
                  selected && { color: color.onVolt },
                ]}
              >
                {technique.displayName}
              </Text>
            </PressableScale>
          );
        })}
        <PressableScale
          accessibilityRole="radio"
          accessibilityLabel="Auto detect"
          accessibilityState={{ selected: autoSelected }}
          onPress={() => props.onChange(autoDetectIntent())}
          style={[
            styles.chip,
            styles.chipAuto,
            props.dark && styles.chipDark,
            autoSelected && styles.chipSelected,
          ]}
        >
          <Text
            style={[
              type.caption,
              styles.chipLabel,
              { color: autoSelected ? color.onVolt : color.volt },
            ]}
          >
            Auto Detect
          </Text>
        </PressableScale>
      </View>
      {autoSelected ? (
        <Text
          style={[type.caption, styles.hint, props.dark && styles.hintDark]}
        >
          Auto Detect runs the on-device classifier on your recorded swing.
          Today it can usually read the swing family — forehand or backhand —
          not the exact stroke (that needs ball-bounce tracking this build
          doesn’t have). When it can’t classify, it says so and withholds the
          result instead of guessing.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  intentField: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surfaceElevated,
    color: color.ink,
    fontFamily: font.regular,
    paddingHorizontal: space.md,
    minHeight: 44,
    marginTop: space.sm,
  },
  intentFieldDark: {
    borderColor: color.lineMutedDark,
    backgroundColor: color.inkElevated,
    color: color.onDark,
  },
  hint: { marginTop: space.xs, color: color.inkSoft },
  hintDark: { color: color.onDarkSubtle },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: space.md,
  },
  chip: {
    paddingHorizontal: 14,
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surfaceElevated,
  },
  chipDark: {
    borderColor: color.lineMutedDark,
    backgroundColor: color.inkElevated,
  },
  chipSelected: { borderColor: color.volt, backgroundColor: color.volt },
  chipAuto: { borderColor: color.volt, backgroundColor: 'transparent' },
  chipLabel: { color: color.ink },
});
