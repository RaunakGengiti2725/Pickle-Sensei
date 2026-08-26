import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Card, Pill, SectionTitle } from '../design/components';
import { color, space, type } from '../design/tokens';
import { useAppStore } from '../state/appStore';
import { tts } from '../audio/tts';

/** Settings + privacy center summary (spec p. 7). Server-backed toggles land with account sync. */

function Row(props: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={[type.body, { color: color.ink, flex: 1 }]}>
        {props.label}
      </Text>
      <Text style={[type.body, { color: color.inkSoft }]}>{props.value}</Text>
    </View>
  );
}

export function SettingsScreen() {
  const profile = useAppStore(s => s.profile);
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={[type.h1, { color: color.ink }]}>Settings</Text>

      <SectionTitle title="Profile" />
      <Card>
        <Row label="Skill level" value={profile?.skillLevel ?? '—'} />
        <Row label="Handedness" value={profile?.handedness ?? '—'} />
        <Row
          label="Focus"
          value={(profile?.focusCheckpoint ?? '—').replace(/_/g, ' ')}
        />
      </Card>

      <SectionTitle title="Voice" />
      <Card>
        <Row
          label="Audio coach"
          value={
            tts.available() ? 'Native TTS active' : 'Unavailable in this build'
          }
        />
      </Card>

      <SectionTitle title="Privacy" />
      <Card>
        <Row label="Where your videos live" value="This device" />
        <Row label="Cloud video sync" value="Off (opt-in)" />
        <Row label="ML training consent" value="Not granted" />
        <Text
          style={[type.caption, { color: color.inkSoft, marginTop: space.sm }]}
        >
          Your court video stays on your phone unless you choose to sync it.
          Export and deletion run through the account service once sign-in ships
          in this build.
        </Text>
      </Card>

      <SectionTitle title="About" />
      <Card>
        <Row label="App" value="0.1.0" />
        <Row label="Scoring model" value="sm-v1" />
        <View style={{ marginTop: space.sm }}>
          <Pill label="TECHNIQUE SCORE IS NOT A PLAYER RATING" />
        </View>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: { padding: space.lg },
  row: { flexDirection: 'row', paddingVertical: 10, alignItems: 'center' },
});
