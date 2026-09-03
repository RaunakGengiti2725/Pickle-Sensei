import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  LayoutAnimation,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Button,
  BrandSpinner,
  Card,
  Pill,
  PressableScale,
  ScreenHeader,
  useReducedMotion,
} from '../design/components';
import { Icon } from '../design/icons';
import {
  MascotMoment,
  type MascotPose,
  type MascotTone,
} from '../design/MascotMoment';
import { useReliableSafeAreaInsets } from '../design/safeArea';
import { color, radius, shadow, space, type } from '../design/tokens';
import { showBrandNotice } from '../design/BrandNotice';
import { useAuthStore, type AuthProvider } from '../auth/authStore';
import { getApiSession } from '../account/apiSession';
import {
  ACCOUNT_DELETION_DETAILS_MAX,
  AccountDeletionError,
  type AccountDeletionReason,
  type AccountDeletionSurvey,
  type AccountDeletionWanted,
  confirmAccountDeletion,
  requestAccountDeletion,
} from '../account/deletion';
import { getRuntimePublicConfig } from '../config/runtimeConfig';
import type { RootStackParams } from '../navigation/params';

const PROVIDER_LABELS: Record<AuthProvider, string> = {
  apple: 'Apple',
  google: 'Google',
  guest: 'Guest',
};

/** Final-confirm hold-off (ms). Must exceed the server's 3s minimum age
 * between delete-request and delete-confirm; also honest UX friction. */
const DELETE_ARM_DELAY_MS = 5_000;

/** Exit survey, question 1 — display order; values are the wire vocabulary
 * (deletion.ts ACCOUNT_DELETION_REASONS). "Something else" stays last. */
const DELETION_REASON_OPTIONS: ReadonlyArray<{
  value: AccountDeletionReason;
  label: string;
}> = [
  { value: 'not_using', label: "I don't use it enough" },
  { value: 'not_helpful', label: "It hasn't improved my game" },
  { value: 'scores_inaccurate', label: 'The technique reads felt off' },
  { value: 'technical_issues', label: 'Bugs, crashes, or camera trouble' },
  { value: 'too_expensive', label: "It's too expensive" },
  { value: 'privacy', label: 'Privacy or data concerns' },
  { value: 'other', label: 'Something else' },
];

/** Exit survey, question 2 (deletion.ts ACCOUNT_DELETION_WANTED). */
const DELETION_WANTED_OPTIONS: ReadonlyArray<{
  value: AccountDeletionWanted;
  label: string;
}> = [
  { value: 'accuracy', label: 'More accurate technique reads' },
  { value: 'price', label: 'A lower price or a free tier' },
  { value: 'content', label: 'More drills and coaching guidance' },
  { value: 'stability', label: 'Fewer bugs and smoother capture' },
  { value: 'switched', label: "Nothing — I've found another app or a coach" },
  { value: 'nothing', label: "Nothing — I just don't need it anymore" },
];

const SURVEY_QUESTION_COUNT = 2;

export const DELETION_MASCOT_MOMENTS: Record<
  'why' | 'kept' | 'review',
  {
    pose: MascotPose;
    tone: MascotTone;
    eyebrow: string;
    caption: string;
  }
> = {
  why: {
    pose: 'rest',
    tone: 'warn',
    eyebrow: 'OPTIONAL FEEDBACK',
    caption: 'Pick the closest answer—or skip and continue.',
  },
  kept: {
    pose: 'stretch',
    tone: 'court',
    eyebrow: 'ONE MORE, IF USEFUL',
    caption: 'Add context only if you want to. Deletion stays available.',
  },
  review: {
    pose: 'volley',
    tone: 'danger',
    eyebrow: 'FINAL REVIEW',
    caption: 'Check what will be removed before you decide.',
  },
};

/** The 36 pt header glyph buttons keep their compact look; the slop brings
 * the touch target to the 44 pt minimum without changing the layout. */
const HEADER_BUTTON_HIT_SLOP = 4;

type DeleteAccountStep =
  | { phase: 'why' }
  | { phase: 'kept' }
  | { phase: 'review' }
  | { phase: 'requesting' }
  | { phase: 'armed'; challenge: string; secondsLeft: number }
  | { phase: 'deleting'; challenge: string };

type PageDirection = 'forward' | 'back' | 'none';

/** One page of the dialog: slides in from the side it came from (forward =
 * from the right, back = from the left) with a fade, 220ms ease-out, so a
 * page change never just snaps. Reduced motion renders at rest. */
function PageReveal(props: {
  direction: PageDirection;
  children: React.ReactNode;
}) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const offset =
    props.direction === 'forward' ? 24 : props.direction === 'back' ? -24 : 0;
  useEffect(() => {
    if (reduced) {
      progress.setValue(1);
      return;
    }
    Animated.timing(progress, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [progress, reduced]);
  return (
    <Animated.View
      style={[
        styles.page,
        {
          opacity: progress,
          transform: [
            {
              translateX: Animated.multiply(
                Animated.subtract(1, progress),
                offset,
              ),
            },
          ],
        },
      ]}
    >
      {props.children}
    </Animated.View>
  );
}

/** Dialog chrome: back (when there is somewhere to go back to), the
 * "QUESTION n OF 2" marker with a two-segment progress bar while the survey
 * runs, and close — the same three-slot header the stepper references use. */
function DialogHeader(props: {
  question: number | null;
  onBack?: () => void;
  onClose: () => void;
  closeLabel: string;
  disabled?: boolean;
}) {
  const answered = props.question ?? 0;
  return (
    <View style={styles.header}>
      <View style={styles.headerSlot}>
        {props.onBack ? (
          <PressableScale
            accessibilityLabel="Back to the previous question"
            disabled={props.disabled}
            hitSlop={HEADER_BUTTON_HIT_SLOP}
            onPress={props.onBack}
            style={styles.headerButton}
          >
            <Icon name="back" size={18} color={color.ink} />
          </PressableScale>
        ) : null}
      </View>
      {props.question !== null ? (
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={`Question ${props.question} of ${SURVEY_QUESTION_COUNT}`}
          style={styles.progressWrap}
        >
          <Text style={[type.micro, { color: color.inkSoft }]}>
            {`QUESTION ${props.question} OF ${SURVEY_QUESTION_COUNT}`}
          </Text>
          <View style={styles.progressTrack}>
            {Array.from({ length: SURVEY_QUESTION_COUNT }, (_, index) => (
              <View
                key={index}
                style={[
                  styles.progressSegment,
                  index < answered && styles.progressSegmentDone,
                ]}
              />
            ))}
          </View>
        </View>
      ) : (
        <View style={styles.progressWrap} />
      )}
      <View style={[styles.headerSlot, { alignItems: 'flex-end' }]}>
        <PressableScale
          accessibilityLabel={props.closeLabel}
          disabled={props.disabled}
          hitSlop={HEADER_BUTTON_HIT_SLOP}
          onPress={props.onClose}
          style={styles.headerButton}
        >
          <Icon name="close" size={18} color={color.ink} />
        </PressableScale>
      </View>
    </View>
  );
}

function ChoiceRow(props: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <PressableScale
      accessibilityRole="radio"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      style={[styles.choiceRow, props.selected && styles.choiceRowSelected]}
    >
      <Text style={[type.body, { color: color.ink, flex: 1 }]}>
        {props.label}
      </Text>
      <View style={[styles.radio, props.selected && styles.radioSelected]}>
        {props.selected ? (
          <Icon name="check" size={13} color={color.onDark} strokeWidth={2.6} />
        ) : null}
      </View>
    </PressableScale>
  );
}

/**
 * Centered pop-up: a two-question exit survey, then the two-step,
 * server-verified account deletion (App Review 5.1.1(v)).
 *
 * Question 1 asks why, question 2 what would have kept them (+ an optional
 * comment). Both are skippable — the survey never stands between a player
 * and deletion — and whatever was answered rides along with step 1
 * (requestAccountDeletion) so it is stored before the account ceases to
 * exist. Step 1 mints a challenge; step 2 confirms it after a mandatory
 * pause. Nothing is deleted until the second explicit tap succeeds
 * server-side.
 */
function DeleteAccountDialog(props: {
  visible: boolean;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const insets = useReliableSafeAreaInsets();
  const reduced = useReducedMotion();
  const [step, setStep] = useState<DeleteAccountStep>({ phase: 'why' });
  const [reason, setReason] = useState<AccountDeletionReason | null>(null);
  const [wanted, setWanted] = useState<AccountDeletionWanted | null>(null);
  const [details, setDetails] = useState('');
  const [survey, setSurvey] = useState<AccountDeletionSurvey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Bumped every time the dialog closes: an async step that started in an
  // earlier presentation must not mutate the state of a later (or closed)
  // one, so every continuation checks it before touching state.
  const presentationRef = useRef(0);
  const directionRef = useRef<PageDirection>('none');
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const entrance = useRef(new Animated.Value(0)).current;

  const stopCountdown = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    if (!props.visible) {
      presentationRef.current += 1;
      stopCountdown();
      setStep({ phase: 'why' });
      setReason(null);
      setWanted(null);
      setDetails('');
      setSurvey(null);
      setError(null);
      directionRef.current = 'none';
      entrance.setValue(0);
    } else if (reduced) {
      entrance.setValue(1);
    } else {
      // The scrim fades (Modal); the card itself settles in from 96%.
      Animated.timing(entrance, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
    return stopCountdown;
  }, [entrance, props.visible, reduced]);

  /** Page change with motion: the card re-lays out smoothly (LayoutAnimation)
   * while the new page slides in from the side it came from. */
  const goTo = (next: DeleteAccountStep, direction: PageDirection) => {
    Keyboard.dismiss();
    directionRef.current = direction;
    if (!reduced) {
      LayoutAnimation.configureNext(
        LayoutAnimation.create(
          220,
          LayoutAnimation.Types.easeInEaseOut,
          LayoutAnimation.Properties.opacity,
        ),
      );
    }
    setStep(next);
  };

  const buildSurvey = (
    keptAnswer: AccountDeletionWanted | null,
    comment: string,
  ): AccountDeletionSurvey | null => {
    if (reason === null) return null;
    const trimmed = comment.trim();
    return {
      reason,
      wanted: keptAnswer,
      details: trimmed.length > 0 ? trimmed : null,
      platform:
        Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : null,
      appVersion: getRuntimePublicConfig().appVersion,
    };
  };

  /** Question 1 → question 2 (needs a reason). */
  const nextQuestion = () => goTo({ phase: 'kept' }, 'forward');
  /** Skip on question 1 = skip the whole survey: nothing is sent. */
  const skipSurvey = () => {
    setSurvey(null);
    goTo({ phase: 'review' }, 'forward');
  };
  /** Question 2 answered (an option, a comment, or both). */
  const finishSurvey = () => {
    setSurvey(buildSurvey(wanted, details));
    goTo({ phase: 'review' }, 'forward');
  };
  /** Skip on question 2 keeps question 1's answer and records nothing else. */
  const skipQuestionTwo = () => {
    setSurvey(buildSurvey(null, ''));
    goTo({ phase: 'review' }, 'forward');
  };

  const beginRequest = async () => {
    const presentation = presentationRef.current;
    setError(null);
    setStep({ phase: 'requesting' });
    try {
      const { challenge } = await requestAccountDeletion(
        getApiSession(),
        survey,
      );
      if (presentation !== presentationRef.current) return;
      const secondsLeft = Math.ceil(DELETE_ARM_DELAY_MS / 1000);
      setStep({ phase: 'armed', challenge, secondsLeft });
      timerRef.current = setInterval(() => {
        setStep(current => {
          if (current.phase !== 'armed') return current;
          if (current.secondsLeft <= 1) {
            stopCountdown();
            return { ...current, secondsLeft: 0 };
          }
          return { ...current, secondsLeft: current.secondsLeft - 1 };
        });
      }, 1_000);
    } catch (e) {
      if (presentation !== presentationRef.current) return;
      setStep({ phase: 'review' });
      setError(
        e instanceof AccountDeletionError
          ? e.message
          : 'The deletion request could not be completed. Nothing was deleted.',
      );
    }
  };

  const confirmDeletion = async (challenge: string) => {
    const presentation = presentationRef.current;
    setError(null);
    setStep({ phase: 'deleting', challenge });
    try {
      await confirmAccountDeletion(getApiSession(), challenge);
      props.onDeleted();
    } catch (e) {
      if (presentation !== presentationRef.current) return;
      const canRetrySameChallenge =
        e instanceof AccountDeletionError ? e.retryable : true;
      setStep(
        canRetrySameChallenge
          ? { phase: 'armed', challenge, secondsLeft: 0 }
          : { phase: 'review' },
      );
      setError(
        e instanceof AccountDeletionError
          ? e.message
          : 'The deletion could not be completed. Nothing was deleted.',
      );
    }
  };

  const busy = step.phase === 'requesting' || step.phase === 'deleting';
  const scrollDetailsIntoView = () => {
    // The comment field is the last thing on the page; bring it above the
    // keyboard once the avoiding view has made room.
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
  };

  let header: React.ReactNode;
  let page: React.ReactNode;
  if (step.phase === 'why') {
    header = (
      <DialogHeader
        question={1}
        onClose={props.onCancel}
        closeLabel="Close and keep my account"
      />
    );
    page = (
      <PageReveal key="why" direction={directionRef.current}>
        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={[type.h1, styles.title]}>What's making you leave?</Text>
          <Text style={[type.body, styles.sub]}>
            Pick the closest one. Nothing you share here stays tied to you after
            deletion.
          </Text>
          <MascotMoment
            compact
            {...DELETION_MASCOT_MOMENTS.why}
            accessibilityLabel={`Pickle Sensei mascot. ${DELETION_MASCOT_MOMENTS.why.caption}`}
            testID="deletion-mascot-why"
            style={styles.dialogMascot}
          />
          <View accessibilityRole="radiogroup">
            {DELETION_REASON_OPTIONS.map(option => (
              <ChoiceRow
                key={option.value}
                label={option.label}
                selected={reason === option.value}
                onPress={() => setReason(option.value)}
              />
            ))}
          </View>
        </ScrollView>
        <View style={styles.footer}>
          <Button
            label="Next"
            variant="dark"
            disabled={reason === null}
            onPress={nextQuestion}
          />
          <PressableScale
            accessibilityLabel="Skip the survey"
            onPress={skipSurvey}
            style={styles.textLink}
          >
            <Text style={[type.bodyBold, { color: color.inkSoft }]}>
              Skip the survey
            </Text>
          </PressableScale>
        </View>
      </PageReveal>
    );
  } else if (step.phase === 'kept') {
    header = (
      <DialogHeader
        question={2}
        onBack={() => goTo({ phase: 'why' }, 'back')}
        onClose={props.onCancel}
        closeLabel="Close and keep my account"
      />
    );
    page = (
      <PageReveal key="kept" direction={directionRef.current}>
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={[type.h1, styles.title]}>What would have kept you?</Text>
          <Text style={[type.body, styles.sub]}>
            Pick one, and add anything you want us to know.
          </Text>
          <MascotMoment
            compact
            {...DELETION_MASCOT_MOMENTS.kept}
            accessibilityLabel={`Pickle Sensei mascot. ${DELETION_MASCOT_MOMENTS.kept.caption}`}
            testID="deletion-mascot-kept"
            style={styles.dialogMascot}
          />
          <View accessibilityRole="radiogroup">
            {DELETION_WANTED_OPTIONS.map(option => (
              <ChoiceRow
                key={option.value}
                label={option.label}
                selected={wanted === option.value}
                onPress={() => setWanted(option.value)}
              />
            ))}
          </View>
          <TextInput
            accessibilityLabel="Anything else you want us to know"
            accessibilityHint="Optional"
            multiline
            maxLength={ACCOUNT_DELETION_DETAILS_MAX}
            placeholder={
              reason === 'other'
                ? 'Tell us what happened'
                : 'Anything else? (optional)'
            }
            placeholderTextColor={color.inkSoft}
            returnKeyType="done"
            submitBehavior="blurAndSubmit"
            value={details}
            onChangeText={setDetails}
            onFocus={scrollDetailsIntoView}
            style={styles.detailsInput}
          />
          <Text style={[type.micro, styles.detailsCounter]}>
            {`${details.length}/${ACCOUNT_DELETION_DETAILS_MAX}`}
          </Text>
        </ScrollView>
        <View style={styles.footer}>
          <Button
            label="Continue"
            variant="dark"
            disabled={wanted === null && details.trim().length === 0}
            onPress={finishSurvey}
          />
          <PressableScale
            accessibilityLabel="Skip this question"
            onPress={skipQuestionTwo}
            style={styles.textLink}
          >
            <Text style={[type.bodyBold, { color: color.inkSoft }]}>
              Skip this question
            </Text>
          </PressableScale>
        </View>
      </PageReveal>
    );
  } else {
    header = (
      <DialogHeader
        question={null}
        onClose={props.onCancel}
        closeLabel="Close account deletion confirmation"
        disabled={busy}
      />
    );
    page = (
      <PageReveal key="confirm" direction={directionRef.current}>
        <ScrollView
          contentContainerStyle={styles.body}
          showsVerticalScrollIndicator={false}
        >
          <MascotMoment
            compact
            {...DELETION_MASCOT_MOMENTS.review}
            accessibilityLabel={`Pickle Sensei mascot. ${DELETION_MASCOT_MOMENTS.review.caption}`}
            testID="deletion-mascot-review"
          />
          <Text
            style={[
              type.h1,
              { color: color.ink, textAlign: 'center', marginTop: space.lg },
            ]}
          >
            Delete your account?
          </Text>
          <Text
            style={[
              type.body,
              {
                color: color.inkSoft,
                textAlign: 'center',
                marginTop: space.sm,
              },
            ]}
          >
            This permanently deletes your account and all synced data — your
            profile, analysis history, progress, and membership records. This
            cannot be undone. Clips saved on this phone stay on this phone until
            you delete the app.
          </Text>
          {error ? (
            <Text
              style={[
                type.caption,
                {
                  color: color.bad,
                  textAlign: 'center',
                  marginTop: space.md,
                },
              ]}
            >
              {error}
            </Text>
          ) : null}
        </ScrollView>
        <View style={[styles.footer, { gap: 10 }]}>
          <Button
            label="Keep my account"
            variant="dark"
            disabled={busy}
            onPress={props.onCancel}
          />
          {step.phase === 'review' || step.phase === 'requesting' ? (
            <Button
              label={
                step.phase === 'requesting'
                  ? 'Requesting…'
                  : 'Continue to delete'
              }
              variant="danger"
              disabled={busy}
              onPress={() => void beginRequest()}
            />
          ) : (
            <Button
              label={
                step.phase === 'deleting'
                  ? 'Deleting…'
                  : step.phase === 'armed' && step.secondsLeft > 0
                    ? `Permanently delete (${step.secondsLeft})`
                    : 'Permanently delete'
              }
              variant="danger"
              disabled={
                step.phase === 'deleting' ||
                (step.phase === 'armed' && step.secondsLeft > 0)
              }
              onPress={() => {
                if (step.phase === 'armed') {
                  void confirmDeletion(step.challenge);
                }
              }}
            />
          )}
          {busy ? (
            <BrandSpinner
              color={color.bad}
              trackColor={color.line}
              style={{ marginTop: space.xs }}
            />
          ) : null}
        </View>
      </PageReveal>
    );
  }

  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="fade"
      onRequestClose={busy ? undefined : props.onCancel}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.modalRoot}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel account deletion"
          disabled={busy}
          onPress={busy ? undefined : props.onCancel}
          style={StyleSheet.absoluteFill}
        />
        <View
          pointerEvents="box-none"
          style={[
            styles.modalFrame,
            {
              paddingTop: insets.top + space.md,
              paddingBottom: insets.bottom + space.md,
            },
          ]}
        >
          <Animated.View
            accessibilityViewIsModal
            style={[
              styles.card,
              {
                opacity: entrance,
                transform: [
                  {
                    scale: Animated.add(
                      0.96,
                      Animated.multiply(entrance, 0.04),
                    ),
                  },
                ],
              },
            ]}
          >
            {header}
            {page}
          </Animated.View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function DetailRow(props: { label: string; value: string; last?: boolean }) {
  return (
    <View style={[styles.detailRow, props.last && { borderBottomWidth: 0 }]}>
      <Text style={[type.caption, { color: color.inkSoft }]}>
        {props.label}
      </Text>
      <Text numberOfLines={1} style={[type.bodyBold, styles.detailValue]}>
        {props.value}
      </Text>
    </View>
  );
}

/**
 * Synced-account management. Deletion lives at the bottom of this screen as
 * a quiet text link (still one obvious hop from Settings — App Review
 * 5.1.1(v) requires in-app deletion to stay findable) rather than a red row
 * on the Settings root.
 */
export function ManageAccountScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const session = useAuthStore(s => s.session);
  const completeAccountDeletion = useAuthStore(s => s.completeAccountDeletion);
  const [confirmingDeletion, setConfirmingDeletion] = useState(false);

  const providerLabel = session ? PROVIDER_LABELS[session.provider] : '—';

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
      <StatusBar barStyle="dark-content" />
      <ScreenHeader title="Manage account" onBack={() => navigation.goBack()} />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Card style={styles.detailsCard}>
          <View style={styles.detailsHeader}>
            <View style={styles.iconWrap}>
              <Icon name="person" size={20} color={color.court} />
            </View>
            <Text style={[type.h3, { color: color.ink, flex: 1 }]}>
              Account details
            </Text>
            <Pill
              label={session && !session.localOnly ? 'SYNCED' : 'LOCAL'}
              tone="volt"
            />
          </View>
          <View style={styles.detailRows}>
            <DetailRow label="Name" value={session?.displayName ?? '—'} />
            <DetailRow label="Email" value={session?.email ?? '—'} />
            <DetailRow label="Signed in with" value={providerLabel} last />
          </View>
        </Card>

        <Text style={[type.caption, styles.syncNote]}>
          Your profile, analysis history, and progress sync to this account.
          Signing out from Settings keeps that data; it will be waiting the next
          time you sign in.
        </Text>

        {session && !session.localOnly ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Delete account"
            onPress={() => setConfirmingDeletion(true)}
            style={styles.deleteLink}
          >
            <Text style={[type.caption, { color: color.bad }]}>
              Delete account
            </Text>
          </PressableScale>
        ) : null}
      </ScrollView>

      <DeleteAccountDialog
        visible={confirmingDeletion}
        onCancel={() => setConfirmingDeletion(false)}
        onDeleted={() => {
          setConfirmingDeletion(false);
          // The server account is gone; unlike a plain sign-out this also
          // purges the deleted owner's local rows and fully disconnects the
          // provider SDK so nothing can silently restore a dead account.
          void completeAccountDeletion().then(() => {
            const cleanup = useAuthStore.getState().deletionCleanup;
            if (cleanup?.localPurge === 'failed') {
              showBrandNotice({
                title: 'Account deleted',
                detail:
                  'Your account and synced data were deleted. Some data saved on this phone could not be removed — delete the app to clear it.',
                tone: 'danger',
                eyebrow: 'LOCAL CLEANUP NEEDED',
              });
            }
          });
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: {
    paddingHorizontal: space.xl,
    paddingTop: space.md,
    paddingBottom: space.xxl,
  },
  detailsCard: { padding: space.lg },
  detailsHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: radius.md,
    backgroundColor: color.courtSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailRows: {
    marginTop: space.lg,
    paddingTop: space.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
  },
  detailRow: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.line,
  },
  detailValue: { color: color.ink, flexShrink: 1, textAlign: 'right' },
  syncNote: { color: color.inkSoft, marginTop: space.md },
  deleteLink: {
    minHeight: 44,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    marginTop: space.xxl,
  },
  // Centered pop-up. The scrim fills the screen; the frame keeps the card
  // inside the safe areas (the keyboard-avoiding view owns paddingBottom,
  // so the insets live here). The card hugs its content and SHRINKS — never
  // overflows — when a page or the keyboard is taller than the room left:
  // the page body scrolls, the header and footer stay put.
  modalRoot: { flex: 1, backgroundColor: color.overlayStrong },
  modalFrame: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: space.md,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    flexShrink: 1,
    backgroundColor: color.surface,
    borderRadius: radius.xl,
    paddingTop: space.md,
    paddingBottom: space.md,
    ...shadow.floating,
  },
  page: { flexShrink: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    minHeight: 36,
  },
  headerSlot: { width: 36, justifyContent: 'center' },
  headerButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
  },
  progressWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.sm,
  },
  progressTrack: {
    flexDirection: 'row',
    gap: space.xs,
    width: '100%',
    maxWidth: 132,
    marginTop: 6,
  },
  progressSegment: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.line,
  },
  progressSegmentDone: { backgroundColor: color.court },
  body: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
  },
  footer: {
    flexShrink: 0,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
  },
  title: { color: color.ink },
  sub: { color: color.inkSoft, marginTop: space.sm, marginBottom: space.md },
  dialogMascot: { marginBottom: space.md },
  // Same input family as onboarding's ChoiceCard/nameInput (elevated
  // surface, hairline border, court fill when selected), sized as a compact
  // single-line row so a question reads as one quick pick.
  choiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    marginBottom: 6,
    backgroundColor: color.surfaceElevated,
  },
  choiceRowSelected: {
    borderColor: color.court,
    backgroundColor: color.courtSoft,
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: color.line,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: space.md,
  },
  radioSelected: { borderColor: color.court, backgroundColor: color.court },
  detailsInput: {
    ...type.body,
    color: color.ink,
    minHeight: 76,
    textAlignVertical: 'top',
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingTop: 12,
    paddingBottom: 12,
    marginTop: 6,
    backgroundColor: color.surfaceElevated,
  },
  detailsCounter: {
    color: color.inkSoft,
    textAlign: 'right',
    marginTop: space.xs,
    fontVariant: ['tabular-nums'],
  },
  textLink: {
    minHeight: 44,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    marginTop: space.xs,
  },
});
