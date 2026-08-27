import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Handedness } from '@pickle/shared-types';
import { Button } from '../design/components';
import { color, radius, space, type } from '../design/tokens';
import { focusForGoal, useAppStore } from '../state/appStore';

/**
 * Onboarding (spec p. 5): level → handedness → goal → problem → plan reveal.
 * Seeds coaching language and the personalized starting focus. Answers are
 * setup, not a test — copy stays warm, choices carry context, back is free.
 */

const STEPS = ['level', 'handedness', 'goal', 'problem', 'reveal'] as const;
type Step = (typeof STEPS)[number];

interface Choice {
  value: string;
  label: string;
  sub?: string;
}

const LEVELS: Choice[] = [
  { value: 'Beginner', label: 'Brand new', sub: 'First paddle, first weeks' },
  { value: '2.5', label: '2.5', sub: 'Learning rallies and positioning' },
  { value: '3.0', label: '3.0', sub: 'Consistent recreational play' },
  { value: '3.5', label: '3.5', sub: 'League nights, working on strategy' },
  { value: '4.0', label: '4.0', sub: 'Competitive, controlled pace' },
  { value: '4.5', label: '4.5', sub: 'Tournament regular' },
  { value: '5.0+', label: '5.0+', sub: 'Open play, high level' },
];

const HANDS: Choice[] = [
  { value: 'right', label: 'Right-handed' },
  { value: 'left', label: 'Left-handed' },
];

const GOALS: Choice[] = [
  { value: 'dinks', label: 'Dinks', sub: 'Own the soft game at the kitchen' },
  { value: 'drives', label: 'Drives', sub: 'Clean, repeatable pace' },
  {
    value: 'drops',
    label: 'Third-shot drops',
    sub: 'Get to the net on your terms',
  },
  { value: 'serve', label: 'Serve', sub: 'Start every point ahead' },
  { value: 'volleys', label: 'Volleys', sub: 'Win the fast exchanges' },
  { value: 'footwork', label: 'Footwork', sub: 'Balance and positioning' },
  { value: 'all-around', label: 'All-around', sub: 'Raise the whole game' },
];

const PROBLEMS: Choice[] = [
  {
    value: 'consistency',
    label: 'Consistency',
    sub: 'Great one rally, gone the next',
  },
  { value: 'control', label: 'Control', sub: 'Balls sail or die in the net' },
  { value: 'power', label: 'Power', sub: 'Drives lack punch' },
  { value: 'contact', label: 'Contact', sub: 'Mis-hits, late swings' },
  {
    value: 'footwork',
    label: 'Footwork',
    sub: 'Caught flat or out of position',
  },
  {
    value: 'placement',
    label: 'Placement',
    sub: 'The ball goes where it wants',
  },
  {
    value: 'not sure',
    label: 'Not sure',
    sub: "That's what the analysis is for",
  },
];

const QUESTIONS: Record<
  Exclude<Step, 'reveal'>,
  { title: string; sub: string; choices: Choice[] }
> = {
  level: {
    title: 'Where is your game today?',
    sub: 'Sets coaching language — never used to inflate scores.',
    choices: LEVELS,
  },
  handedness: {
    title: 'Which side is home?',
    sub: 'Mirrors every measurement to your swing.',
    choices: HANDS,
  },
  goal: {
    title: 'What do you want to own?',
    sub: 'Your first training focus starts here.',
    choices: GOALS,
  },
  problem: {
    title: 'What breaks down most?',
    sub: 'Helps prioritize your first fixes.',
    choices: PROBLEMS,
  },
};

const FOCUS_COPY: Record<string, { name: string; why: string }> = {
  contact_position: {
    name: 'Contact Position',
    why: 'Where your paddle meets the ball decides control, power, and everything downstream.',
  },
  preparation: {
    name: 'Preparation',
    why: 'An early unit turn buys time for everything else — most late contact starts here.',
  },
  paddle_set: {
    name: 'Paddle Set',
    why: 'A calm, early paddle set is what makes soft drops repeatable.',
  },
  sequencing: {
    name: 'Sequencing',
    why: 'Legs, hips, shoulders, paddle — in that order. That chain is your serve.',
  },
  face_wrist_stability: {
    name: 'Face & Wrist Stability',
    why: 'Quiet hands win fast exchanges at the net.',
  },
  athletic_base: {
    name: 'Athletic Base',
    why: 'Balance is the platform every shot stands on.',
  },
};

function ProgressBar(props: { step: number; total: number }) {
  return (
    <View style={styles.progressRow}>
      {Array.from({ length: props.total }, (_, i) => (
        <View
          key={i}
          style={[
            styles.progressSegment,
            { backgroundColor: i <= props.step ? color.court : color.line },
          ]}
        />
      ))}
    </View>
  );
}

function ChoiceCard(props: {
  choice: Choice;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.choice.label}
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.choiceCard,
        props.selected && styles.choiceCardSelected,
        pressed && { transform: [{ scale: 0.99 }] },
      ]}
    >
      <View style={{ flex: 1 }}>
        <Text style={[type.bodyBold, { color: color.ink }]}>
          {props.choice.label}
        </Text>
        {props.choice.sub ? (
          <Text style={[type.caption, { color: color.inkSoft, marginTop: 2 }]}>
            {props.choice.sub}
          </Text>
        ) : null}
      </View>
      <View style={[styles.radio, props.selected && styles.radioSelected]}>
        {props.selected ? <Text style={styles.radioCheck}>✓</Text> : null}
      </View>
    </Pressable>
  );
}

export function OnboardingScreen() {
  const completeOnboarding = useAppStore(s => s.completeOnboarding);
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const step = STEPS[stepIndex] ?? 'reveal';
  const goal = answers['goal'] ?? 'all-around';
  const focus = focusForGoal(goal);
  const focusCopy = FOCUS_COPY[focus] ?? FOCUS_COPY['contact_position']!;

  const select = (key: string, value: string) => {
    setAnswers(prev => ({ ...prev, [key]: value }));
    // Brief beat so the selection state is visible before advancing.
    setTimeout(() => setStepIndex(i => Math.min(i + 1, STEPS.length - 1)), 160);
  };

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        {stepIndex > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={12}
            onPress={() => setStepIndex(i => Math.max(i - 1, 0))}
          >
            <Text style={[type.h2, { color: color.inkSoft }]}>‹</Text>
          </Pressable>
        ) : (
          <View style={{ width: 16 }} />
        )}
        <ProgressBar step={stepIndex} total={STEPS.length} />
      </View>

      {step !== 'reveal' ? (
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <Text style={[type.h1, { color: color.ink }]}>
            {QUESTIONS[step].title}
          </Text>
          <Text
            style={[
              type.body,
              {
                color: color.inkSoft,
                marginTop: space.xs,
                marginBottom: space.lg,
              },
            ]}
          >
            {QUESTIONS[step].sub}
          </Text>
          {QUESTIONS[step].choices.map(choice => (
            <ChoiceCard
              key={choice.value}
              choice={choice}
              selected={answers[step] === choice.value}
              onPress={() => select(step, choice.value)}
            />
          ))}
        </ScrollView>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <Text style={[type.micro, { color: color.court }]}>YOUR PLAN</Text>
          <Text style={[type.h1, { color: color.ink, marginTop: space.xs }]}>
            First focus:{'\n'}
            {focusCopy.name}
          </Text>

          <View style={styles.focusCard}>
            <Text style={[type.body, { color: color.onDark }]}>
              {focusCopy.why}
            </Text>
          </View>

          <View style={{ marginTop: space.lg, gap: space.md }}>
            {[
              [
                '1',
                "Film one stroke — we'll measure it against 11 checkpoints.",
              ],
              ['2', 'Get one fix, why it matters, and the drill for it.'],
              [
                '3',
                'Live Court coaches every rep out loud while you practice.',
              ],
            ].map(([n, line]) => (
              <View key={n} style={styles.stepRow}>
                <View style={styles.stepBadge}>
                  <Text style={[type.micro, { color: color.court }]}>{n}</Text>
                </View>
                <Text style={[type.body, { color: color.inkSoft, flex: 1 }]}>
                  {line}
                </Text>
              </View>
            ))}
          </View>

          <View style={{ marginTop: space.xl }}>
            <Button
              label="Analyze my first shot"
              onPress={() => {
                void completeOnboarding({
                  skillLevel: answers['level'] ?? '3.0',
                  handedness:
                    (answers['handedness'] as Handedness | undefined) ??
                    'right',
                  goal,
                  biggestProblem: answers['problem'] ?? 'not sure',
                  focusCheckpoint: focus,
                });
              }}
            />
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    gap: space.md,
  },
  progressRow: { flex: 1, flexDirection: 'row', gap: 6 },
  progressSegment: { flex: 1, height: 4, borderRadius: 2 },
  content: { padding: space.lg, paddingBottom: space.xxl },
  choiceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: color.line,
    borderRadius: radius.md,
    padding: space.md,
    marginBottom: space.sm,
    backgroundColor: color.surface,
    minHeight: 56,
  },
  choiceCardSelected: { borderColor: color.court, backgroundColor: '#F0FAF6' },
  radio: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: color.line,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: space.md,
  },
  radioSelected: { borderColor: color.court, backgroundColor: color.court },
  radioCheck: { color: color.onDark, fontSize: 13, fontWeight: '700' },
  focusCard: {
    backgroundColor: color.ink,
    borderRadius: radius.lg,
    padding: space.lg,
    marginTop: space.lg,
  },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  stepBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#E7F5EF',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
});
