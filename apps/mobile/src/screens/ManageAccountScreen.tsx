import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
  Card,
  Pill,
  PressableScale,
  ScreenHeader,
  useReducedMotion,
} from '../design/components';
import { Icon } from '../design/icons';
import { useReliableSafeAreaInsets } from '../design/safeArea';
import { color, radius, space, type } from '../design/tokens';
import { useAuthStore, type AuthProvider } from '../auth/authStore';
import { getApiSession } from '../account/apiSession';
import {
  ACCOUNT_DELETION_DETAILS_MAX,
  AccountDeletionError,
  type AccountDeletionReason,
  type AccountDeletionSurvey,
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

/** Exit-survey choices, in display order. Values are the wire vocabulary
 * (deletion.ts ACCOUNT_DELETION_REASONS); "Something else" stays last. */
const DELETION_REASON_OPTIONS: ReadonlyArray<{
  value: AccountDeletionReason;
  label: string;
}> = [
  { value: 'not_using', label: "I don't use it enough" },
  { value: 'not_helpful', label: "It hasn't improved my game" },
  { value: 'scores_inaccurate', label: 'The technique reads felt off' },
  { value: 'technical_issues', label: 'Bugs, crashes, or camera trouble' },
  { value: 'too_expensive', label: "It's too expensive" },
  { value: 'switching', label: "I'm using another app or a coach" },
  { value: 'privacy', label: 'Privacy or data concerns' },
  { value: 'other', label: 'Something else' },
];

type DeleteAccountStep =
  | { phase: 'survey' }
  | { phase: 'review' }
  | { phase: 'requesting' }
  | { phase: 'armed'; challenge: string; secondsLeft: number }
  | { phase: 'deleting'; challenge: string };

/** Content of one sheet step: fades/rises in on mount (200ms ease-out; reduced
 * motion renders at rest) so a step change never just snaps. */
function StepReveal(props: { children: React.ReactNode }) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) {
      progress.setValue(1);
      return;
    }
    Animated.timing(progress, {
      toValue: 1,
      duration: 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [progress, reduced]);
  return (
    <Animated.View
      style={[
        styles.stepReveal,
        {
          opacity: progress,
          transform: [
            {
              translateY: Animated.multiply(Animated.subtract(1, progress), 8),
            },
          ],
        },
      ]}
    >
      {props.children}
    </Animated.View>
  );
}

function ReasonRow(props: {
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
      style={[styles.reasonRow, props.selected && styles.reasonRowSelected]}
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
 * Exit survey, then two-step, server-verified account deletion (App Review
 * 5.1.1(v)). The survey is one optional question — always skippable, so it
 * never stands between a player and deletion — and its answer rides along
 * with step 1 (requestAccountDeletion) so it is stored before the account
 * ceases to exist. Step 1 mints a challenge; step 2 confirms it after a
 * mandatory pause. Nothing is deleted until the second explicit tap succeeds
 * server-side.
 */
function DeleteAccountSheet(props: {
  visible: boolean;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const insets = useReliableSafeAreaInsets();
  const reduced = useReducedMotion();
  const [step, setStep] = useState<DeleteAccountStep>({ phase: 'survey' });
  const [reason, setReason] = useState<AccountDeletionReason | null>(null);
  const [details, setDetails] = useState('');
  const [survey, setSurvey] = useState<AccountDeletionSurvey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const detailsRef = useRef<React.ComponentRef<typeof TextInput>>(null);
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
      stopCountdown();
      setStep({ phase: 'survey' });
      setReason(null);
      setDetails('');
      setSurvey(null);
      setError(null);
      entrance.setValue(0);
    } else if (reduced) {
      entrance.setValue(1);
    } else {
      // The scrim fades (Modal); the sheet itself rises into place.
      Animated.timing(entrance, {
        toValue: 1,
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
    return stopCountdown;
  }, [entrance, props.visible, reduced]);

  const canContinueSurvey = reason !== null || details.trim().length > 0;

  /** Leaves the survey for the confirmation. `answered` false = Skip: nothing
   * is sent. Typed details with no reason picked count as "Something else"
   * rather than being thrown away. */
  const leaveSurvey = (answered: boolean) => {
    Keyboard.dismiss();
    const trimmed = details.trim();
    setSurvey(
      answered && (reason !== null || trimmed.length > 0)
        ? {
            reason: reason ?? 'other',
            details: trimmed.length > 0 ? trimmed : null,
            platform:
              Platform.OS === 'ios' || Platform.OS === 'android'
                ? Platform.OS
                : null,
            appVersion: getRuntimePublicConfig().appVersion,
          }
        : null,
    );
    if (!reduced) {
      LayoutAnimation.configureNext(
        LayoutAnimation.create(
          220,
          LayoutAnimation.Types.easeInEaseOut,
          LayoutAnimation.Properties.opacity,
        ),
      );
    }
    setStep({ phase: 'review' });
  };

  const beginRequest = async () => {
    setError(null);
    setStep({ phase: 'requesting' });
    try {
      const { challenge } = await requestAccountDeletion(
        getApiSession(),
        survey,
      );
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
      setStep({ phase: 'review' });
      setError(
        e instanceof AccountDeletionError
          ? e.message
          : 'The deletion request could not be completed. Nothing was deleted.',
      );
    }
  };

  const confirmDeletion = async (challenge: string) => {
    setError(null);
    setStep({ phase: 'deleting', challenge });
    try {
      await confirmAccountDeletion(getApiSession(), challenge);
      props.onDeleted();
    } catch (e) {
      setStep({ phase: 'armed', challenge, secondsLeft: 0 });
      setError(
        e instanceof AccountDeletionError
          ? e.message
          : 'The deletion could not be completed. Nothing was deleted.',
      );
    }
  };

  const busy = step.phase === 'requesting' || step.phase === 'deleting';
  const surveying = step.phase === 'survey';

  const surveyStep = (
    <StepReveal key="survey">
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.sheetBody}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.surveyHeader}>
          <Text style={[type.micro, { color: color.court }]}>
            BEFORE YOU GO
          </Text>
          <Text style={[type.h1, styles.surveyTitle]}>
            What's making you leave?
          </Text>
          <Text style={[type.body, styles.surveySub]}>
            One tap helps us build a better coach. Nothing you share here stays
            tied to you after deletion.
          </Text>
        </View>
        <View accessibilityRole="radiogroup">
          {DELETION_REASON_OPTIONS.map(option => (
            <ReasonRow
              key={option.value}
              label={option.label}
              selected={reason === option.value}
              onPress={() => {
                setReason(option.value);
                // "Something else" is only useful with words — open the field.
                if (option.value === 'other') detailsRef.current?.focus();
              }}
            />
          ))}
        </View>
        <TextInput
          ref={detailsRef}
          accessibilityLabel="Anything else you want us to know"
          accessibilityHint="Optional"
          multiline
          maxLength={ACCOUNT_DELETION_DETAILS_MAX}
          placeholder={
            reason === 'other'
              ? 'Tell us what happened'
              : 'Anything else you want us to know? (optional)'
          }
          placeholderTextColor={color.inkSoft}
          returnKeyType="done"
          submitBehavior="blurAndSubmit"
          value={details}
          onChangeText={setDetails}
          onFocus={() => {
            // The field is the last thing in the sheet; bring it above the
            // keyboard once the avoiding view has made room.
            setTimeout(
              () => scrollRef.current?.scrollToEnd({ animated: true }),
              80,
            );
          }}
          style={styles.detailsInput}
        />
        <Text style={[type.micro, styles.detailsCounter]}>
          {`${details.length}/${ACCOUNT_DELETION_DETAILS_MAX}`}
        </Text>
      </ScrollView>
      <View style={styles.sheetFooter}>
        <Button
          label="Continue"
          variant="dark"
          disabled={!canContinueSurvey}
          onPress={() => leaveSurvey(true)}
        />
        <PressableScale
          accessibilityLabel="Skip the survey"
          onPress={() => leaveSurvey(false)}
          style={styles.skipLink}
        >
          <Text style={[type.bodyBold, { color: color.inkSoft }]}>Skip</Text>
        </PressableScale>
      </View>
    </StepReveal>
  );

  const confirmStep = (
    <StepReveal key="confirm">
      <ScrollView
        contentContainerStyle={styles.sheetBody}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.sheetIcon}>
          <Icon name="shield" size={22} color={color.bad} />
        </View>
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
      <View style={[styles.sheetFooter, { gap: 10 }]}>
        <Button
          label="Keep my account"
          variant="dark"
          disabled={busy}
          onPress={props.onCancel}
        />
        {step.phase === 'review' || step.phase === 'requesting' ? (
          <Button
            label={
              step.phase === 'requesting' ? 'Requesting…' : 'Continue to delete'
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
          <ActivityIndicator
            color={color.bad}
            style={{ marginTop: space.xs }}
          />
        ) : null}
      </View>
    </StepReveal>
  );

  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="fade"
      onRequestClose={busy ? undefined : props.onCancel}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.modalRoot, { paddingTop: insets.top + space.xl }]}
      >
        <Pressable
          accessibilityLabel="Cancel account deletion"
          onPress={busy ? undefined : props.onCancel}
          style={StyleSheet.absoluteFill}
        />
        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            { paddingBottom: insets.bottom + space.md },
            {
              opacity: entrance,
              transform: [
                {
                  translateY: Animated.multiply(
                    Animated.subtract(1, entrance),
                    32,
                  ),
                },
              ],
            },
          ]}
        >
          <PressableScale
            accessibilityLabel={
              surveying
                ? 'Close and keep my account'
                : 'Close account deletion confirmation'
            }
            containerStyle={styles.sheetCloseContainer}
            disabled={busy}
            onPress={props.onCancel}
            style={styles.sheetClose}
          >
            <Icon name="close" size={20} color={color.ink} />
          </PressableScale>
          {surveying ? surveyStep : confirmStep}
        </Animated.View>
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

      <DeleteAccountSheet
        visible={confirmingDeletion}
        onCancel={() => setConfirmingDeletion(false)}
        onDeleted={() => {
          setConfirmingDeletion(false);
          // The server account is gone; unlike a plain sign-out this also
          // purges the deleted owner's local rows and fully disconnects the
          // provider SDK so nothing can silently restore a dead account.
          void completeAccountDeletion();
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
  // Bottom sheet: the scrim fills the screen; the sheet hugs its content and
  // SHRINKS (never overflows) when the content or the keyboard is taller
  // than the room left under the top inset — the step body scrolls, the
  // footer stays put.
  modalRoot: {
    flex: 1,
    backgroundColor: color.overlayStrong,
    justifyContent: 'flex-end',
  },
  sheet: {
    flexShrink: 1,
    backgroundColor: color.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingTop: space.lg,
    position: 'relative',
  },
  stepReveal: { flexShrink: 1 },
  sheetBody: {
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  sheetFooter: {
    flexShrink: 0,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
  },
  sheetCloseContainer: {
    position: 'absolute',
    right: 14,
    top: 14,
    width: 44,
    zIndex: 2,
  },
  sheetClose: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
  },
  sheetIcon: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: color.badSoft,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginTop: space.lg,
  },
  // Survey title block: kicker → h1 → body sub (the pre-auth/onboarding
  // title rhythm, left-aligned). Right padding keeps it clear of the close
  // button.
  surveyHeader: { paddingRight: 44, marginBottom: space.lg },
  surveyTitle: { color: color.ink, marginTop: space.sm },
  surveySub: { color: color.inkSoft, marginTop: space.sm, maxWidth: 340 },
  // Same input family as onboarding's ChoiceCard/nameInput (elevated
  // surface, hairline border, court fill when selected), sized as a compact
  // single-line row so eight options still read as one quick question.
  reasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    marginBottom: space.sm,
    backgroundColor: color.surfaceElevated,
  },
  reasonRowSelected: {
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
    minHeight: 96,
    textAlignVertical: 'top',
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingTop: 14,
    paddingBottom: 14,
    marginTop: space.sm,
    backgroundColor: color.surfaceElevated,
  },
  detailsCounter: {
    color: color.inkSoft,
    textAlign: 'right',
    marginTop: space.xs,
    fontVariant: ['tabular-nums'],
  },
  skipLink: {
    minHeight: 44,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    marginTop: space.xs,
  },
});
