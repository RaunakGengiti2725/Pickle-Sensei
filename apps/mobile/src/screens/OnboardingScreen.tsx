import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Handedness } from '@pickle/shared-types';
import { Button, Card } from '../design/components';
import { color, space, type } from '../design/tokens';
import { focusForGoal, useAppStore } from '../state/appStore';

/** Onboarding: level → handedness → goal → problem → personalized focus (spec p. 5). */

const STEPS = ['level', 'handedness', 'goal', 'problem', 'reveal'] as const;

const LEVELS = ['Beginner', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0+'];
const GOALS = [
  'dinks',
  'drives',
  'drops',
  'serve',
  'volleys',
  'footwork',
  'all-around',
];
const PROBLEMS = [
  'consistency',
  'control',
  'power',
  'contact',
  'footwork',
  'placement',
  'not sure',
];

function Choice(props: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <View style={{ marginBottom: space.sm }}>
      <Button
        label={props.label}
        variant={props.selected ? 'primary' : 'secondary'}
        onPress={props.onPress}
      />
    </View>
  );
}

export function OnboardingScreen() {
  const completeOnboarding = useAppStore(s => s.completeOnboarding);
  const [step, setStep] = useState<(typeof STEPS)[number]>('level');
  const [level, setLevel] = useState<string | null>(null);
  const [handedness, setHandedness] = useState<Handedness | null>(null);
  const [goal, setGoal] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const next = () => setStep(STEPS[STEPS.indexOf(step) + 1] ?? 'reveal');

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text
        style={[type.micro, { color: color.court, marginBottom: space.sm }]}
      >
        {`STEP ${STEPS.indexOf(step) + 1} OF ${STEPS.length}`}
      </Text>
      {step === 'level' && (
        <View>
          <Text style={[type.h1, styles.question]}>
            Where is your game today?
          </Text>
          {LEVELS.map(l => (
            <Choice
              key={l}
              label={l}
              selected={level === l}
              onPress={() => {
                setLevel(l);
                next();
              }}
            />
          ))}
        </View>
      )}
      {step === 'handedness' && (
        <View>
          <Text style={[type.h1, styles.question]}>Which side is home?</Text>
          {(['right', 'left'] as const).map(h => (
            <Choice
              key={h}
              label={h === 'right' ? 'Right-handed' : 'Left-handed'}
              selected={handedness === h}
              onPress={() => {
                setHandedness(h);
                next();
              }}
            />
          ))}
        </View>
      )}
      {step === 'goal' && (
        <View>
          <Text style={[type.h1, styles.question]}>
            What do you want to own?
          </Text>
          {GOALS.map(g => (
            <Choice
              key={g}
              label={g}
              selected={goal === g}
              onPress={() => {
                setGoal(g);
                next();
              }}
            />
          ))}
        </View>
      )}
      {step === 'problem' && (
        <View>
          <Text style={[type.h1, styles.question]}>What breaks down most?</Text>
          {PROBLEMS.map(p => (
            <Choice
              key={p}
              label={p}
              selected={problem === p}
              onPress={() => {
                setProblem(p);
                next();
              }}
            />
          ))}
        </View>
      )}
      {step === 'reveal' && (
        <View>
          <Text style={[type.h1, styles.question]}>Your first focus</Text>
          <Card>
            <Text style={[type.h2, { color: color.court }]}>
              {focusForGoal(goal ?? 'all-around').replace(/_/g, ' ')}
            </Text>
            <Text
              style={[type.body, { color: color.inkSoft, marginTop: space.sm }]}
            >
              We'll measure it, give you one fix at a time, and coach your reps
              out loud.
            </Text>
          </Card>
          <View style={{ marginTop: space.lg }}>
            <Button
              label="Analyze my first shot"
              onPress={() => {
                void completeOnboarding({
                  skillLevel: level ?? '3.0',
                  handedness: handedness ?? 'right',
                  goal: goal ?? 'all-around',
                  biggestProblem: problem ?? 'not sure',
                  focusCheckpoint: focusForGoal(goal ?? 'all-around'),
                });
              }}
            />
          </View>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: { padding: space.lg, paddingTop: space.xxl },
  question: { color: color.ink, marginBottom: space.lg },
});
