import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { MVP_SHOT_TYPES, type MvpShotTypeSlug } from '@pickle/shared-types';
import { analyzeClip } from '@pickle/analysis-pipeline';
import {
  Button,
  Card,
  ErrorState,
  FixtureBanner,
  LoadingState,
} from '../design/components';
import { color, space, type } from '../design/tokens';
import { selectVisionProviders } from '../vision/providers';
import { getDb } from '../data/db';
import { saveAnalysis } from '../data/repository';
import { useAppStore } from '../state/appStore';
import { makeUuid } from '../util/uuid';
import type { RootStackParams } from '../navigation/params';

/**
 * Analyze Shot flow. Honest states: shot select → capture source → processing
 * → result. Native camera capture is Stage-3 native work; in development the
 * flow runs the REAL analysis pipeline over the labeled fixture provider. In
 * release builds without models this screen reports MODEL_UNAVAILABLE.
 */

type Phase =
  | { kind: 'select' }
  | { kind: 'preflight'; shotType: MvpShotTypeSlug }
  | { kind: 'processing' }
  | { kind: 'model_unavailable'; reason: string }
  | { kind: 'error'; message: string };

const SHOT_LABELS: Record<MvpShotTypeSlug, string> = {
  forehand_drive: 'Forehand Drive',
  dink: 'Dink',
  third_shot_drop: 'Third-Shot Drop',
  serve: 'Serve',
};

export function AnalyzeScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const profile = useAppStore(s => s.profile);
  const setLastShotType = useAppStore(s => s.setLastShotType);
  const [phase, setPhase] = useState<Phase>({ kind: 'select' });
  const [isFixture, setIsFixture] = useState(false);

  const run = async (shotType: MvpShotTypeSlug) => {
    const availability = selectVisionProviders(shotType);
    if (availability.kind === 'unavailable') {
      setPhase({ kind: 'model_unavailable', reason: availability.reason });
      return;
    }
    setIsFixture(availability.kind === 'fixture');
    setPhase({ kind: 'processing' });
    const result = await analyzeClip(
      availability.providers,
      {
        uri: `fixture://${shotType}`,
        durationMs: 2400,
        fps: 30,
        width: 720,
        height: 1280,
      },
      {
        analysisId: makeUuid(),
        sessionId: null,
        shotType,
        handedness: profile?.handedness ?? 'right',
        cameraView: 'side',
        appVersion: '0.1.0',
        modelBundleVersion:
          availability.kind === 'fixture' ? 'fixture-1' : 'unknown',
        capturedAtIso: new Date().toISOString(),
        ...(profile?.focusCheckpoint
          ? { focusCheckpoint: profile.focusCheckpoint }
          : {}),
      },
    );
    if (!result.ok) {
      setPhase({ kind: 'error', message: result.failure.message });
      return;
    }
    try {
      await saveAnalysis(getDb(), result.value);
    } catch {
      setPhase({
        kind: 'error',
        message: 'Could not save the analysis locally.',
      });
      return;
    }
    setLastShotType(shotType);
    setPhase({ kind: 'select' });
    navigation.replace('Result', { analysisId: result.value.id });
  };

  if (phase.kind === 'processing') {
    return (
      <View style={styles.screen}>
        {isFixture && <FixtureBanner />}
        <LoadingState label="Reading your movement…" />
      </View>
    );
  }
  if (phase.kind === 'model_unavailable') {
    return (
      <View style={styles.screen}>
        <ErrorState title="Analysis unavailable" detail={phase.reason} />
      </View>
    );
  }
  if (phase.kind === 'error') {
    return (
      <View style={styles.screen}>
        <ErrorState
          title="Couldn't analyze"
          detail={phase.message}
          onRetry={() => setPhase({ kind: 'select' })}
        />
      </View>
    );
  }
  if (phase.kind === 'preflight') {
    return (
      <View style={styles.screen}>
        {__DEV__ && <FixtureBanner />}
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={[type.h1, { color: color.ink }]}>
            Where is your phone?
          </Text>
          <Text
            style={[type.body, { color: color.inkSoft, marginTop: space.sm }]}
          >
            Side view, waist height, whole body and paddle in frame. Live camera
            preflight ships with the native capture engine; in development the
            analysis runs on a labeled fixture clip.
          </Text>
          <View style={{ marginTop: space.lg }}>
            <Button
              label={`Analyze ${SHOT_LABELS[phase.shotType]}`}
              onPress={() => void run(phase.shotType)}
            />
          </View>
          <View style={{ marginTop: space.sm }}>
            <Button
              label="Back"
              variant="ghost"
              onPress={() => setPhase({ kind: 'select' })}
            />
          </View>
        </ScrollView>
      </View>
    );
  }
  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[type.h1, { color: color.ink }]}>
          What are we working on?
        </Text>
        <View style={{ marginTop: space.lg }}>
          {MVP_SHOT_TYPES.map(shotType => (
            <Card key={shotType} style={{ marginBottom: space.sm }}>
              <Button
                label={SHOT_LABELS[shotType]}
                variant="secondary"
                onPress={() => setPhase({ kind: 'preflight', shotType })}
              />
            </Card>
          ))}
        </View>
        <Text
          style={[type.caption, { color: color.inkSoft, marginTop: space.md }]}
        >
          Return, backhand, volley and overhead unlock as their scoring models
          ship.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: { padding: space.lg },
});
