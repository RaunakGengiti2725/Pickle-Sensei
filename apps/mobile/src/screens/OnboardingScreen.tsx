import React, { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { Handedness } from '@pickle/shared-types';
import { Button, PressableScale } from '../design/components';
import { Icon } from '../design/icons';
import { useReliableSafeAreaInsets } from '../design/safeArea';
import { color, radius, space, type } from '../design/tokens';
import { focusForGoal, useAppStore, type Gender } from '../state/appStore';
import { useAuthStore } from '../auth/authStore';
import {
  type NotificationOnboardingChoice,
  useNotificationStore,
} from '../notifications/notificationStore';

/**
 * Onboarding (spec p. 5): name → gender → level → handedness → goal →
 * problem → plan reveal → notification choice. Seeds coaching language and the personalized
 * starting focus. Answers are setup, not a test — copy stays warm, choices
 * carry context, back is free.
 */

const STEPS = [
  'name',
  'gender',
  'level',
  'handedness',
  'goal',
  'problem',
  'reveal',
  'notifications',
] as const;
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

const GENDERS: Choice[] = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'nonbinary', label: 'Non-binary' },
  { value: 'prefer_not_to_say', label: 'Prefer not to say' },
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

/**
 * The 'name' step is a free-text input, not a choice list, so it carries its
 * own copy record and a custom render branch; every other question stays in
 * the uniform ChoiceCard step machine below.
 */
const NAME_QUESTION = {
  title: 'What should we call you?',
  sub: 'Your coach personalizes every session.',
} as const;

const QUESTIONS: Record<
  Exclude<Step, 'name' | 'reveal' | 'notifications'>,
  { title: string; sub: string; choices: Choice[] }
> = {
  gender: {
    title: 'How do you identify?',
    sub: 'Used to tailor coaching references and demo models.',
    choices: GENDERS,
  },
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

const NOTIFICATION_BENEFITS = [
  {
    icon: 'bell',
    title: 'Practice nudge',
    detail: 'Once a day at 5:30 PM by default',
  },
  {
    icon: 'flame',
    title: 'Streak defense',
    detail: 'Only when a real streak needs attention',
  },
  {
    icon: 'progress',
    title: 'Weekly recap',
    detail: 'A Sunday pointer to your Performance tab',
  },
] as const;

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
    <View
      accessibilityLabel={`Onboarding step ${props.step + 1} of ${props.total}`}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 1, max: props.total, now: props.step + 1 }}
      style={styles.progressRow}
    >
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

export function OnboardingScreen(props: {
  /**
   * 'account' (default): the signed-in flow — answers save to the active
   * owner (server-synced for canonical accounts) and the only way out short
   * of finishing is signing out. 'preauth': the questionnaire runs BEFORE
   * the login flow — answers are stashed device-level for adoption after
   * sign-in, completion hands off through onFinished, and step one's back
   * control returns to the screen the questionnaire was entered from.
   *
   * There is deliberately NO way to skip the questionnaire in either mode:
   * the app is personalized from these answers, so every path a player can
   * take leads back here until they have finished it once.
   */
  mode?: 'account' | 'preauth';
  /** Pre-auth only: called after the answers were durably stashed. */
  onFinished?: () => void;
  /** Pre-auth only: step one's back control — returns to Welcome. */
  onBack?: () => void;
}) {
  const preAuth = props.mode === 'preauth';
  const insets = useReliableSafeAreaInsets();
  const completeOnboarding = useAppStore(s => s.completeOnboarding);
  const completePreAuthOnboarding = useAppStore(
    s => s.completePreAuthOnboarding,
  );
  const onboardingBusy = useAppStore(s => s.onboardingBusy);
  const onboardingError = useAppStore(s => s.onboardingError);
  const signOut = useAuthStore(s => s.signOut);
  const completeNotificationOnboarding = useNotificationStore(
    s => s.completeOnboardingStep,
  );
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [notificationChoice, setNotificationChoice] =
    useState<NotificationOnboardingChoice | null>(null);

  const step = STEPS[stepIndex] ?? 'notifications';
  const firstName = (answers['name'] ?? '').trim();
  const goal = answers['goal'] ?? 'all-around';
  const focus = focusForGoal(goal);
  const focusCopy = FOCUS_COPY[focus] ?? FOCUS_COPY['contact_position']!;
  const answeredProfile = {
    firstName: firstName || undefined,
    gender: answers['gender'] as Gender | undefined,
    skillLevel: answers['level'] ?? '3.0',
    handedness: (answers['handedness'] as Handedness | undefined) ?? 'right',
    goal,
    biggestProblem: answers['problem'] ?? 'not sure',
    focusCheckpoint: focus,
  };
  const stepComplete =
    step === 'reveal' || step === 'notifications'
      ? true
      : step === 'name'
        ? firstName.length >= 1
        : answers[step] !== undefined;

  // Selection never auto-advances; the user confirms with Continue so a
  // mis-tap is recoverable and the pace belongs to them.
  const select = (key: string, value: string) => {
    setAnswers(prev => ({ ...prev, [key]: value }));
  };

  const goForward = () => setStepIndex(i => Math.min(i + 1, STEPS.length - 1));
  const goBack = () => setStepIndex(i => Math.max(i - 1, 0));

  const finishOnboarding = async (choice: NotificationOnboardingChoice) => {
    if (notificationBusy || onboardingBusy) return;
    setNotificationBusy(true);
    try {
      if (!notificationChoice) {
        await completeNotificationOnboarding(choice);
        setNotificationChoice(choice);
      }
      if (preAuth) {
        const ok = await completePreAuthOnboarding(answeredProfile);
        if (ok) props.onFinished?.();
        return;
      }
      await completeOnboarding(answeredProfile);
    } finally {
      setNotificationBusy(false);
    }
  };

  // Step one has nothing to go back to inside the flow. Pre-auth, back simply
  // returns to the screen the player came from (Welcome) — nothing has been
  // answered yet and no confirmation is needed. In-account the only way out
  // is signing out of the account itself — otherwise the user is stranded
  // here. Neither path skips the questionnaire: it is required.
  const leaveOnboarding = () => {
    if (preAuth) {
      props.onBack?.();
      return;
    }
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
          ) : preAuth ? (
            <PressableScale
              accessibilityLabel="Back"
              accessibilityHint="Return to the welcome screen"
              hitSlop={12}
              onPress={leaveOnboarding}
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

      {step !== 'reveal' && step !== 'notifications' ? (
        // 'padding' keeps the pinned Continue footer above the iOS keyboard
        // while the name step's text field is focused; Android resizes the
        // window itself.
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <LockedScroll key={step} bottomInset={space.lg}>
            <Text style={[type.micro, { color: color.court }]}>
              PLAYER SETUP
            </Text>
            <Text style={[type.hero, styles.stepTitle]}>
              {step === 'name' ? NAME_QUESTION.title : QUESTIONS[step].title}
            </Text>
            <Text style={[type.body, styles.stepSub]}>
              {step === 'name' ? NAME_QUESTION.sub : QUESTIONS[step].sub}
            </Text>
            {step === 'name' ? (
              <TextInput
                accessibilityLabel="First name"
                autoFocus
                autoCapitalize="words"
                autoComplete="given-name"
                textContentType="givenName"
                autoCorrect={false}
                returnKeyType="next"
                maxLength={40}
                placeholder="First name"
                placeholderTextColor={color.inkSoft}
                value={answers['name'] ?? ''}
                onChangeText={text => select('name', text)}
                // The keyboard's Next key mirrors the Continue button, but
                // never past an empty name.
                onSubmitEditing={() => {
                  if (firstName.length >= 1) goForward();
                }}
                style={styles.nameInput}
              />
            ) : (
              QUESTIONS[step].choices.map(choice => (
                <ChoiceCard
                  key={choice.value}
                  choice={choice}
                  selected={answers[step] === choice.value}
                  onPress={() => select(step, choice.value)}
                />
              ))
            )}
          </LockedScroll>
          <View
            style={[styles.footer, { paddingBottom: insets.bottom + space.md }]}
          >
            <Button
              label="Continue"
              variant="dark"
              disabled={!stepComplete}
              onPress={goForward}
            />
          </View>
        </KeyboardAvoidingView>
      ) : step === 'reveal' ? (
        <>
          <LockedScroll bottomInset={space.lg}>
            <Text style={[type.micro, { color: color.court }]}>
              YOUR STARTING PLAN
            </Text>
            <Text style={[type.hero, styles.stepTitle]}>
              One focus.{`\n`}Visible progress.
            </Text>
            {firstName ? (
              <Text
                style={[
                  type.body,
                  { color: color.inkSoft, marginTop: space.sm },
                ]}
              >
                Built for {firstName}.
              </Text>
            ) : null}

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
            <Button label="Continue" variant="dark" onPress={goForward} />
          </View>
        </>
      ) : (
        <>
          <LockedScroll key="notifications" bottomInset={space.lg}>
            <Text style={[type.micro, { color: color.court }]}>
              STAY IN RHYTHM
            </Text>
            <Text style={[type.hero, styles.stepTitle]}>Stay match-ready.</Text>
            <Text style={[type.body, styles.notificationIntro]}>
              Get a useful nudge when it can help—never a stream of noise.
            </Text>

            <View style={styles.notificationPreview}>
              <View style={styles.notificationPreviewHeader}>
                <View style={styles.notificationPreviewIcon}>
                  <Icon name="bell" size={20} color={color.onVolt} />
                </View>
                <View style={styles.notificationPreviewHeading}>
                  <Text style={[type.micro, styles.notificationPreviewApp]}>
                    PICKLE SENSEI
                  </Text>
                  <Text style={[type.caption, styles.notificationPreviewTime]}>
                    PRACTICE REMINDER · 5:30 PM
                  </Text>
                </View>
              </View>
              <Text style={[type.h3, styles.notificationPreviewTitle]}>
                Ready for a few clean reps?
              </Text>
              <Text style={[type.caption, styles.notificationPreviewBody]}>
                A short court session today keeps your training plan moving.
              </Text>
            </View>

            <View style={styles.notificationBenefits}>
              {NOTIFICATION_BENEFITS.map(benefit => (
                <View key={benefit.title} style={styles.notificationBenefit}>
                  <View style={styles.notificationBenefitIcon}>
                    <Icon name={benefit.icon} size={18} color={color.court} />
                  </View>
                  <View style={styles.notificationBenefitCopy}>
                    <Text style={[type.bodyBold, { color: color.ink }]}>
                      {benefit.title}
                    </Text>
                    <Text style={[type.caption, { color: color.inkSoft }]}>
                      {benefit.detail}
                    </Text>
                  </View>
                </View>
              ))}
            </View>

            <View style={styles.notificationPrivacy}>
              <Icon name="shield" size={17} color={color.inkSoft} />
              <Text style={[type.caption, styles.notificationPrivacyCopy]}>
                Scheduled on this phone. Lock-screen copy never includes your
                name, scores, or clips.
              </Text>
            </View>
          </LockedScroll>
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
                notificationBusy || onboardingBusy
                  ? 'Finishing setup…'
                  : 'Turn on reminders'
              }
              variant="dark"
              disabled={notificationBusy || onboardingBusy}
              onPress={() => void finishOnboarding('enable')}
            />
            <PressableScale
              accessibilityLabel="Not now"
              accessibilityHint="Finish setup without enabling reminders"
              accessibilityRole="button"
              disabled={notificationBusy || onboardingBusy}
              onPress={() => void finishOnboarding('not_now')}
              style={styles.notificationSkip}
            >
              <Text style={[type.bodyBold, styles.notificationSkipLabel]}>
                Not now
              </Text>
            </PressableScale>
            <Text style={[type.caption, styles.notificationFooterNote]}>
              Change this anytime in Settings.
            </Text>
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
  // One title block for every onboarding step (questions, reveal,
  // notifications): micro kicker → hero title → body sub, same position.
  stepTitle: { color: color.ink, marginTop: space.sm },
  stepSub: {
    color: color.inkSoft,
    marginTop: space.sm,
    maxWidth: 340,
    marginBottom: space.lg,
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
  // Text-entry sibling of choiceCard: same surface, border, and radius so
  // the name step reads as part of the same family of inputs.
  nameInput: {
    ...type.h2,
    color: color.ink,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.lg,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    backgroundColor: color.surfaceElevated,
    minHeight: 56,
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
  notificationIntro: {
    color: color.inkSoft,
    marginTop: space.sm,
    maxWidth: 340,
  },
  notificationPreview: {
    marginTop: space.xl,
    padding: space.lg,
    borderRadius: radius.xl,
    backgroundColor: color.surfaceDark,
  },
  notificationPreviewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  notificationPreviewIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.volt,
  },
  notificationPreviewHeading: { flex: 1, minWidth: 0 },
  notificationPreviewApp: { color: color.onDark },
  notificationPreviewTime: {
    color: color.onDarkSubtle,
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  notificationPreviewTitle: { color: color.onDark, marginTop: space.lg },
  notificationPreviewBody: { color: color.onDarkMuted, marginTop: 4 },
  notificationBenefits: { marginTop: space.lg, gap: 10 },
  notificationBenefit: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    backgroundColor: color.surfaceElevated,
  },
  notificationBenefitIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.courtSoft,
  },
  notificationBenefitCopy: { flex: 1, minWidth: 0 },
  notificationPrivacy: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    marginTop: space.lg,
    paddingHorizontal: space.sm,
  },
  notificationPrivacyCopy: { color: color.inkSoft, flex: 1 },
  notificationSkip: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.xs,
  },
  notificationSkipLabel: { color: color.inkSoft },
  notificationFooterNote: {
    color: color.inkSoft,
    textAlign: 'center',
    marginTop: 2,
  },
  onboardingError: {
    color: color.bad,
    marginBottom: space.sm,
    textAlign: 'center',
  },
});
