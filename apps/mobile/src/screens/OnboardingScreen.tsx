import React, { useState } from 'react';
import {
  Alert,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { Handedness } from '@pickle/shared-types';
import { Button, PressableScale } from '../design/components';
import { Icon } from '../design/icons';
import { useReliableSafeAreaInsets } from '../design/safeArea';
import { color, radius, space, type } from '../design/tokens';
import { focusForGoal, useAppStore } from '../state/appStore';
import { useAuthStore } from '../auth/authStore';

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
            { backgroundColor: i <= props.step ? color.volt : color.lineDark },
          ]}
        />
      ))}
    </View>
  );
}

/**
 * Scrolls only when the content genuinely overflows. A step that fits stays
 * locked, so short steps can't be nudged around or bounced.
 */
function LockedScroll(props: {
  children: React.ReactNode;
  bottomInset: number;
}) {
  const [viewport, setViewport] = useState(0);
  const [content, setContent] = useState(0);
  const scrollable = viewport > 0 && content > viewport + 1;

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[
        styles.content,
        { paddingBottom: props.bottomInset },
      ]}
      scrollEnabled={scrollable}
      bounces={scrollable}
      alwaysBounceVertical={false}
      showsVerticalScrollIndicator={scrollable}
      onLayout={e => setViewport(e.nativeEvent.layout.height)}
      onContentSizeChange={(_w, h) => setContent(h)}
    >
      {props.children}
    </ScrollView>
  );
}

function ChoiceCard(props: {
  choice: Choice;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <PressableScale
      accessibilityRole="radio"
      accessibilityLabel={props.choice.label}
      accessibilityHint={props.choice.sub}
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      style={[styles.choiceCard, props.selected && styles.choiceCardSelected]}
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
        {props.selected ? (
          <Icon name="check" size={14} color={color.onDark} strokeWidth={2.6} />
        ) : null}
      </View>
    </PressableScale>
  );
}

export function OnboardingScreen() {
  const insets = useReliableSafeAreaInsets();
  const completeOnboarding = useAppStore(s => s.completeOnboarding);
  const onboardingBusy = useAppStore(s => s.onboardingBusy);
  const onboardingError = useAppStore(s => s.onboardingError);
  const signOut = useAuthStore(s => s.signOut);
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const step = STEPS[stepIndex] ?? 'reveal';
  const goal = answers['goal'] ?? 'all-around';
  const focus = focusForGoal(goal);
  const focusCopy = FOCUS_COPY[focus] ?? FOCUS_COPY['contact_position']!;

  // Selection never auto-advances; the user confirms with Continue so a
  // mis-tap is recoverable and the pace belongs to them.
  const select = (key: string, value: string) => {
    setAnswers(prev => ({ ...prev, [key]: value }));
  };

  const goForward = () => setStepIndex(i => Math.min(i + 1, STEPS.length - 1));
  const goBack = () => setStepIndex(i => Math.max(i - 1, 0));

  // Step one has nothing to go back to inside the flow, so the escape route is
  // out of the account entirely — otherwise the user is stranded here.
  const leaveOnboarding = () => {
    Alert.alert(
      'Leave setup?',
      'You will be returned to the sign-in screen. Your answers so far are not saved.',
      [
        { text: 'Keep setting up', style: 'cancel' },
        {
          text: 'Sign out',
          style: 'destructive',
          onPress: () => void signOut(),
        },
      ],
    );
  };

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="light-content" />
      {/* The inset is padded inside the dark bar so the notch area matches it
          instead of showing a strip of the light body colour. */}
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <View style={styles.headerSide}>
          {stepIndex > 0 ? (
            <PressableScale
              accessibilityLabel="Back"
              accessibilityHint="Return to the previous question"
              hitSlop={12}
              onPress={goBack}
              style={styles.headerButton}
            >
              <Icon name="back" size={20} color={color.onDark} />
            </PressableScale>
          ) : (
            <PressableScale
              accessibilityLabel="Leave setup"
              accessibilityHint="Sign out and return to the sign-in screen"
              hitSlop={12}
              onPress={leaveOnboarding}
              style={styles.headerButton}
            >
              <Icon name="close" size={20} color={color.onDark} />
            </PressableScale>
          )}
        </View>
        <View style={styles.progressWrap}>
          <ProgressBar step={stepIndex} total={STEPS.length} />
        </View>
        <Text style={[type.micro, styles.stepCount]}>
          {stepIndex + 1}/{STEPS.length}
        </Text>
      </View>

      {step !== 'reveal' ? (
        <>
          <LockedScroll key={step} bottomInset={space.lg}>
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
          </LockedScroll>
          <View
            style={[styles.footer, { paddingBottom: insets.bottom + space.md }]}
          >
            <Button
              label="Continue"
              variant="dark"
              disabled={answers[step] === undefined}
              onPress={goForward}
            />
          </View>
        </>
      ) : (
        <>
          <LockedScroll bottomInset={space.lg}>
            <Text style={[type.micro, { color: color.court }]}>
              YOUR STARTING PLAN
            </Text>
            <Text
              style={[type.hero, { color: color.ink, marginTop: space.sm }]}
            >
              One focus.{`\n`}Visible progress.
            </Text>

            <View style={styles.focusCard}>
              <View style={styles.focusTop}>
                <Text style={[type.micro, { color: color.volt }]}>
                  FIRST FOCUS
                </Text>
                <View style={styles.focusNumber}>
                  <Text style={[type.micro, { color: color.onVolt }]}>01</Text>
                </View>
              </View>
              <Text
                style={[type.h1, { color: color.onDark, marginTop: space.xl }]}
              >
                {focusCopy.name}
              </Text>
              <Text
                style={[
                  type.body,
                  { color: color.onDarkMuted, marginTop: space.sm },
                ]}
              >
                {focusCopy.why}
              </Text>
            </View>

            <View style={{ marginTop: space.lg, gap: space.md }}>
              {[
                [
                  '1',
                  'Step into frame — live pose guidance captures the motion automatically.',
                ],
                [
                  '2',
                  'A stroke name and score appear only when a validated model is confident.',
                ],
                [
                  '3',
                  'Reviewed drills follow real scored evidence—not a guessed profile.',
                ],
              ].map(([n, line]) => (
                <View key={n} style={styles.stepRow}>
                  <View style={styles.stepBadge}>
                    <Text style={[type.micro, { color: color.onVolt }]}>
                      {n}
                    </Text>
                  </View>
                  <Text style={[type.body, { color: color.inkSoft, flex: 1 }]}>
                    {line}
                  </Text>
                </View>
              ))}
            </View>

            <View style={styles.accessCard}>
              <View style={styles.accessIcon}>
                <Icon name="crown" size={20} color={color.onVolt} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[type.h3, { color: color.ink }]}>
                  Two ratings are on us.
                </Text>
                <Text style={[type.caption, styles.accessCopy]}>
                  After your second successful, server-accepted Technique Score,
                  Pickle Sensei Pro is required before another rating can start.
                  Unscored attempts do not count. Past results and saved drills
                  stay available; reviewed plans appear only when matching work
                  is published.
                </Text>
                <Text style={[type.micro, styles.accessPrice]}>
                  MONTHLY + ANNUAL · LOCAL STORE PRICING · ELIGIBLE TRIALS ONLY
                </Text>
              </View>
            </View>
          </LockedScroll>
          {/* Pinned so the primary action is reachable without scrolling. */}
          <View
            style={[styles.footer, { paddingBottom: insets.bottom + space.md }]}
          >
            {onboardingError ? (
              <Text style={[type.caption, styles.onboardingError]}>
                {onboardingError}
              </Text>
            ) : null}
            <Button
              label={
                onboardingBusy
                  ? 'Saving your coaching plan…'
                  : 'Start with 2 free ratings'
              }
              variant="dark"
              disabled={onboardingBusy}
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
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    backgroundColor: color.surfaceDark,
    gap: space.md,
  },
  // Every header cell is exactly 44pt tall and centers its content, so the
  // bar, the buttons, and the counter all sit on the same optical axis.
  headerSide: {
    width: 44,
    height: 44,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  progressWrap: { flex: 1, height: 44, justifyContent: 'center' },
  stepCount: {
    color: color.onDarkSubtle,
    width: 44,
    height: 44,
    lineHeight: 44,
    textAlign: 'right',
  },
  headerButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: color.inkElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  progressSegment: { flex: 1, height: 3, borderRadius: 2 },
  content: {
    flexGrow: 1,
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
  },
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    backgroundColor: color.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
  },
  choiceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.lg,
    paddingHorizontal: space.md,
    paddingVertical: 14,
    marginBottom: 10,
    backgroundColor: color.surfaceElevated,
    minHeight: 64,
  },
  choiceCardSelected: {
    borderColor: color.court,
    backgroundColor: color.courtSoft,
  },
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
  focusCard: {
    backgroundColor: color.surfaceDark,
    borderRadius: radius.xl,
    padding: space.lg,
    marginTop: space.lg,
    minHeight: 250,
  },
  focusTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  focusNumber: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: color.volt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  stepBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: color.volt,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  accessCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    padding: space.md,
    marginTop: space.xl,
    borderRadius: radius.lg,
    backgroundColor: color.voltSoft,
    borderColor: color.volt,
    borderWidth: StyleSheet.hairlineWidth,
  },
  accessIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.volt,
  },
  accessCopy: { color: color.inkSoft, marginTop: 4 },
  accessPrice: {
    color: color.courtDeep,
    marginTop: space.sm,
    letterSpacing: 0.45,
  },
  onboardingError: {
    color: color.bad,
    marginBottom: space.sm,
    textAlign: 'center',
  },
});
