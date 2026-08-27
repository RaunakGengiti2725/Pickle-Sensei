import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '../design/components';
import { color, radius, space, type } from '../design/tokens';

/**
 * Launch screen (spec p. 5): one job — communicate the product in five
 * seconds and move to sign-in. The demo transcript IS the pitch (spec p. 59).
 */

const DEMO_LINES = [
  { who: 'You hit a forehand.', coach: '"7.2. Contact late."' },
  { who: 'You hit again.', coach: '"7.8. Better — farther in front."' },
  { who: 'Again.', coach: '"8.4. That\'s it."' },
];

export function WelcomeScreen(props: { onGetStarted: () => void }) {
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.hero}>
        <Text style={styles.wordmark}>
          PICKLE<Text style={{ color: color.volt }}>SENSEI</Text>
        </Text>
        <Text style={styles.tagline}>See your game. Fix the right thing.</Text>
      </View>

      <View style={styles.demoCard}>
        <Text
          style={[type.micro, { color: color.volt, marginBottom: space.sm }]}
        >
          PHONE ON THE FENCE · LIVE COURT
        </Text>
        {DEMO_LINES.map(line => (
          <View key={line.coach} style={styles.demoLine}>
            <Text style={[type.caption, { color: '#8B98A5' }]}>{line.who}</Text>
            <Text style={[type.h2, { color: color.onDark }]}>{line.coach}</Text>
          </View>
        ))}
      </View>

      <View style={styles.footer}>
        <Button label="Get Started" onPress={props.onGetStarted} />
        <Text
          style={[
            type.caption,
            { color: color.inkSoft, textAlign: 'center', marginTop: space.md },
          ]}
        >
          Every rep detected, scored, and coached out loud.{'\n'}Your court
          video stays on your phone.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.ink },
  hero: { paddingHorizontal: space.lg, paddingTop: space.xxl },
  wordmark: { ...type.h1, fontSize: 34, letterSpacing: 1, color: color.onDark },
  tagline: { ...type.body, color: '#B7C2CC', marginTop: space.sm },
  demoCard: {
    flex: 1,
    justifyContent: 'center',
    marginHorizontal: space.lg,
  },
  demoLine: {
    borderLeftWidth: 3,
    borderLeftColor: color.court,
    paddingLeft: space.md,
    paddingVertical: space.sm,
    marginBottom: space.md,
    backgroundColor: '#111B2A',
    borderRadius: radius.sm,
  },
  footer: { padding: space.lg, paddingBottom: space.xl },
});
