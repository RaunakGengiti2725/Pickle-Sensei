import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Button,
  Card,
  ErrorState,
  FixtureBanner,
  Pill,
} from '../design/components';
import { color, space, type } from '../design/tokens';
import { LiveCourtEngine, type LiveRep } from '../flow/liveCourt';
import { selectVisionProviders } from '../vision/providers';
import { tts } from '../audio/tts';
import { useAppStore } from '../state/appStore';
import { getDb } from '../data/db';
import { finishSession, saveAnalysis, saveSession } from '../data/repository';
import { makeUuid } from '../util/uuid';
import type { RootStackParams } from '../navigation/params';

/**
 * Live Court (spec pp. 9, 35–37): near-screenless once running. Player hits,
 * app scores and speaks. Stroke auto-detection from the camera is the native
 * VisionCore trigger; in development, reps are driven by the labeled fixture
 * provider on a practice-paced timer. Voice runs through the native
 * AVSpeechSynthesizer module — cues also render on screen (accessibility §56).
 */

type Phase = 'setup' | 'running' | 'paused' | 'unavailable';

const REP_INTERVAL_MS = 6000;

export function LiveCourtScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const profile = useAppStore(s => s.profile);
  const shotType = useAppStore(s => s.lastShotType);
  const [phase, setPhase] = useState<Phase>('setup');
  const [reps, setReps] = useState<LiveRep[]>([]);
  const [lastCue, setLastCue] = useState<string | null>(null);
  const engineRef = useRef<LiveCourtEngine | null>(null);
  const sessionIdRef = useRef<string>('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [unavailableReason, setUnavailableReason] = useState('');

  const focus = profile?.focusCheckpoint ?? 'contact_position';

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => stopTimer, [stopTimer]);

  const start = useCallback(async () => {
    const availability = selectVisionProviders(shotType);
    if (availability.kind === 'unavailable') {
      setUnavailableReason(availability.reason);
      setPhase('unavailable');
      return;
    }
    const sessionId = makeUuid();
    sessionIdRef.current = sessionId;
    try {
      await saveSession(getDb(), {
        id: sessionId,
        mode: 'live',
        shotType,
        focusCheckpoint: focus,
        startedAt: new Date().toISOString(),
      });
    } catch {
      setUnavailableReason(
        'Local storage unavailable — cannot record the session.',
      );
      setPhase('unavailable');
      return;
    }
    engineRef.current = new LiveCourtEngine(availability.providers, {
      sessionId,
      shotType,
      focusCheckpoint: focus,
      handedness: profile?.handedness ?? 'right',
      appVersion: '0.1.0',
      modelBundleVersion:
        availability.kind === 'fixture' ? 'fixture-1' : 'unknown',
      makeId: makeUuid,
    });
    setReps([]);
    setLastCue(null);
    setPhase('running');
    timerRef.current = setInterval(() => {
      void (async () => {
        const engine = engineRef.current;
        if (!engine) return;
        const rep = await engine.onStroke({
          uri: `fixture://${shotType}/live`,
          durationMs: 2400,
          fps: 30,
          width: 720,
          height: 1280,
        });
        if (!rep) return;
        try {
          await saveAnalysis(getDb(), rep.analysis);
        } catch {
          // persist failure surfaces at session end; the rep list still shows it
        }
        setReps(prev => [...prev, rep]);
        if (rep.cue.text) {
          setLastCue(rep.cue.text);
          tts.speak(rep.cue.text);
        }
      })();
    }, REP_INTERVAL_MS);
  }, [focus, profile?.handedness, shotType]);

  const endSession = useCallback(async () => {
    stopTimer();
    const engine = engineRef.current;
    if (!engine) return navigation.goBack();
    const summary = engine.summary();
    try {
      await finishSession(
        getDb(),
        sessionIdRef.current,
        summary as unknown as Record<string, unknown>,
      );
    } catch {
      // summary still shown from memory
    }
    tts.stop();
    navigation.replace('LiveSummary', { sessionId: sessionIdRef.current });
  }, [navigation, stopTimer]);

  if (phase === 'unavailable') {
    return (
      <ErrorState
        title="Live Court unavailable"
        detail={unavailableReason}
        onRetry={() => setPhase('setup')}
      />
    );
  }

  if (phase === 'setup') {
    return (
      <View style={styles.screen}>
        {__DEV__ && <FixtureBanner />}
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={[type.h1, { color: color.ink }]}>Live Court</Text>
          <Card style={{ marginTop: space.md }}>
            <Text style={[type.caption, { color: color.inkSoft }]}>SHOT</Text>
            <Text style={[type.h2, { color: color.ink }]}>
              {shotType.replace(/_/g, ' ')}
            </Text>
            <Text
              style={[
                type.caption,
                { color: color.inkSoft, marginTop: space.sm },
              ]}
            >
              FOCUS
            </Text>
            <Text style={[type.h2, { color: color.ink }]}>
              {focus.replace(/_/g, ' ')}
            </Text>
            <Text
              style={[
                type.caption,
                { color: color.inkSoft, marginTop: space.sm },
              ]}
            >
              VOICE
            </Text>
            <Text style={[type.h2, { color: color.ink }]}>
              {tts.available()
                ? 'Balanced'
                : 'On-screen only (native TTS unavailable)'}
            </Text>
          </Card>
          <Text
            style={[type.body, { color: color.inkSoft, marginTop: space.md }]}
          >
            Once you start, just play. Every rep is detected, scored, saved, and
            coached out loud. In development, reps come from the labeled fixture
            provider on a practice cadence.
          </Text>
          <View style={{ marginTop: space.lg }}>
            <Button label="START SESSION" onPress={() => void start()} />
          </View>
        </ScrollView>
      </View>
    );
  }

  const latest = reps[reps.length - 1] ?? null;
  const best = reps.reduce<number | null>((acc, r) => {
    const s = r.analysis.overallScore;
    return s === null ? acc : acc === null ? s : Math.max(acc, s);
  }, null);

  return (
    <View style={[styles.screen, styles.liveScreen]}>
      {latest?.analysis.source === 'fixture' && <FixtureBanner />}
      <View style={styles.liveBody}>
        <Text
          style={[type.micro, { color: color.volt }]}
        >{`SHOT ${reps.length}`}</Text>
        <Text style={[type.display, { color: color.onDark, fontSize: 96 }]}>
          {latest?.analysis.overallScore?.toFixed(1) ?? '—'}
        </Text>
        <Text style={[type.h2, { color: color.onDark, opacity: 0.85 }]}>
          {focus.replace(/_/g, ' ')}
          {latest
            ? ` ${
                latest.analysis.checkpoints
                  .find(c => c.key === focus)
                  ?.score?.toFixed(0) ?? '—'
              }`
            : ''}
        </Text>
        {best !== null && (
          <Text
            style={[
              type.body,
              { color: color.onDark, opacity: 0.6, marginTop: space.sm },
            ]}
          >{`Best today: ${best.toFixed(1)}`}</Text>
        )}
        {lastCue && (
          <View style={styles.cueWrap}>
            <Text style={[type.h2, { color: color.ink }]}>"{lastCue}"</Text>
          </View>
        )}
        {phase === 'paused' && <Pill label="PAUSED" tone="warn" />}
      </View>
      <View style={styles.liveControls}>
        {phase === 'running' ? (
          <Button
            label="Pause"
            variant="secondary"
            onPress={() => {
              stopTimer();
              setPhase('paused');
            }}
          />
        ) : (
          <Button
            label="Resume"
            variant="secondary"
            onPress={() => void start()}
          />
        )}
        <View style={{ height: space.sm }} />
        <Button
          label="End Session"
          variant="danger"
          onPress={() => void endSession()}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  liveScreen: { backgroundColor: color.ink },
  content: { padding: space.lg },
  liveBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.lg,
  },
  cueWrap: {
    marginTop: space.lg,
    backgroundColor: color.volt,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: 14,
  },
  liveControls: { padding: space.lg },
});
