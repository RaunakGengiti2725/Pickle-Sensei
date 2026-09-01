import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
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
} from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import { useAuthStore, type AuthProvider } from '../auth/authStore';
import { getApiSession } from '../account/apiSession';
import {
  AccountDeletionError,
  confirmAccountDeletion,
  requestAccountDeletion,
} from '../account/deletion';
import type { RootStackParams } from '../navigation/params';

const PROVIDER_LABELS: Record<AuthProvider, string> = {
  apple: 'Apple',
  google: 'Google',
  guest: 'Guest',
};

/** Final-confirm hold-off (ms). Must exceed the server's 3s minimum age
 * between delete-request and delete-confirm; also honest UX friction. */
const DELETE_ARM_DELAY_MS = 5_000;

type DeleteAccountStep =
  | { phase: 'review' }
  | { phase: 'requesting' }
  | { phase: 'armed'; challenge: string; secondsLeft: number }
  | { phase: 'deleting'; challenge: string };

/**
 * Two-step, server-verified account deletion (App Review 5.1.1(v)). Step 1
 * mints a challenge; step 2 confirms it after a mandatory pause. Nothing is
 * deleted until the second explicit tap succeeds server-side.
 */
function DeleteAccountSheet(props: {
  visible: boolean;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const [step, setStep] = useState<DeleteAccountStep>({ phase: 'review' });
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const presentationRef = useRef(0);

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
      setStep({ phase: 'review' });
      setError(null);
    }
    return stopCountdown;
  }, [props.visible]);

  const beginRequest = async () => {
    const presentation = presentationRef.current;
    setError(null);
    setStep({ phase: 'requesting' });
    try {
      const { challenge } = await requestAccountDeletion(getApiSession());
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

  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="fade"
      onRequestClose={busy ? undefined : props.onCancel}
    >
      <View style={styles.modalRoot}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel account deletion"
          disabled={busy}
          onPress={busy ? undefined : props.onCancel}
          style={StyleSheet.absoluteFill}
        />
        <View accessibilityViewIsModal style={styles.dialog}>
          <PressableScale
            accessibilityLabel="Close account deletion confirmation"
            containerStyle={styles.dialogCloseContainer}
            disabled={busy}
            onPress={busy ? undefined : props.onCancel}
            style={styles.dialogClose}
          >
            <Icon name="close" size={20} color={color.ink} />
          </PressableScale>
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
          <View style={{ gap: 10, marginTop: space.xl }}>
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
                    : step.secondsLeft > 0
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
          </View>
          {busy ? (
            <ActivityIndicator
              color={color.bad}
              style={{ marginTop: space.md }}
            />
          ) : null}
        </View>
      </View>
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
          void completeAccountDeletion().then(() => {
            const cleanup = useAuthStore.getState().deletionCleanup;
            if (cleanup?.localPurge === 'failed') {
              Alert.alert(
                'Account deleted',
                'Your account and synced data were deleted. Some data saved on this phone could not be removed — delete the app to clear it.',
              );
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
  modalRoot: {
    flex: 1,
    backgroundColor: color.overlayStrong,
    justifyContent: 'center',
    alignItems: 'center',
    padding: space.lg,
  },
  dialog: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: color.surface,
    borderRadius: radius.xl,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.lg,
    position: 'relative',
  },
  dialogCloseContainer: {
    position: 'absolute',
    right: 14,
    top: 14,
    width: 44,
    zIndex: 2,
  },
  dialogClose: {
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
    marginTop: space.xl,
  },
});
