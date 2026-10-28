import React, { useCallback, useEffect, useState } from 'react';
import {
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Button,
  Card,
  PressableScale,
  SectionTitle,
} from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import { useAppStore } from '../state/appStore';
import { useAuthStore } from '../auth/authStore';
import { useConsentStore } from '../state/consentStore';
import { useNotificationStore } from '../notifications/notificationStore';
import { formatReminderMinutes } from '../notifications/types';
import { scoringStackStatus } from '../vision/providers';
import { selectMembershipState, useAccessStore } from '../state/accessStore';
import { APP_STORE_SUBSCRIPTIONS_URL } from '../billing/membershipState';
import { getRuntimePublicConfig } from '../config/runtimeConfig';
import { DUPR_ESTIMATE_NOTE } from '../progress/duprEstimate';
import { rateAppFromSettings } from '../review/appStoreReview';
import { useWalkthroughStore } from '../walkthrough/walkthroughStore';
import type { RootStackParams } from '../navigation/params';
import { useTabBarContentInset } from '../navigation/tabBarLayout';
import { useTabScrollDock } from '../navigation/tabBarDock';
import { showBrandNotice } from '../design/BrandNotice';
import {
  OfflineAllocationCard,
  offlineJourneyHasNews,
  useOfflineJourney,
} from '../components/OfflineAllocationCard';

/**
 * SETTINGS — one short list (owner request 2026-09-24; MOBBIN: Monzo, Hers,
 * BeReal settings): who is signed in, membership, reminders and privacy,
 * help and legal, the account. Plain rows without icon tiles; the app
 * version, scoring model and DUPR note sit in a quiet footer.
 */

async function openLegalPage(label: string, url: string): Promise<void> {
  try {
    await Linking.openURL(url);
  } catch {
    showBrandNotice({
      title: `${label} could not be opened`,
      detail: `Your phone could not open the page. You can read it in a browser at ${url}`,
      tone: 'danger',
      eyebrow: 'LINK UNAVAILABLE',
    });
  }
}

async function openSubscriptionManagement(): Promise<void> {
  try {
    await Linking.openURL(APP_STORE_SUBSCRIPTIONS_URL);
  } catch {
    showBrandNotice({
      title: 'Could not open subscriptions',
      detail:
        'Open App Store account settings to manage or cancel your subscription.',
      tone: 'danger',
      eyebrow: 'STORE UNAVAILABLE',
    });
  }
}

async function rateApp(): Promise<void> {
  const outcome = await rateAppFromSettings();
  if (outcome === 'unavailable') {
    showBrandNotice({
      title: 'Rating unavailable right now',
      detail:
        'The App Store rating sheet could not be opened on this device. You can rate Pickle Sensei from its App Store page instead.',
      eyebrow: 'APP STORE',
    });
  }
}

const HANDEDNESS_LABELS: Record<string, string> = {
  right: 'Right-handed',
  left: 'Left-handed',
  ambidextrous: 'Ambidextrous',
};

/** "Beginner · Right-handed" / "Self-rated 3.5 · Left-handed" — the profile
 * facts the player gave at onboarding, in one line; null when none. */
export function playerFactsLine(
  profile: { skillLevel?: string; handedness?: string } | null,
): string | null {
  const parts: string[] = [];
  const level = profile?.skillLevel?.trim();
  if (level) {
    parts.push(
      /^\d/.test(level)
        ? `Self-rated ${level}`
        : `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
    );
  }
  const hand = profile?.handedness
    ? HANDEDNESS_LABELS[profile.handedness]
    : undefined;
  if (hand) parts.push(hand);
  return parts.length ? parts.join(' · ') : null;
}

function SettingRow(props: {
  label: string;
  value: string;
  last?: boolean;
  /** Values that are already sentence-cased opt out of auto-capitalize. */
  preserveCase?: boolean;
  onPress?: () => void;
}) {
  const content = (
    <>
      <Text style={[type.body, styles.rowLabel]}>{props.label}</Text>
      <Text
        numberOfLines={2}
        style={[
          type.caption,
          styles.rowValue,
          props.preserveCase && { textTransform: 'none' },
        ]}
      >
        {props.value}
      </Text>
      {props.onPress ? (
        <Icon name="chevron" size={16} color={color.inkSoft} />
      ) : null}
    </>
  );

  if (props.onPress) {
    return (
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`${props.label}, ${props.value}`}
        onPress={props.onPress}
        style={[styles.row, props.last && styles.rowLast]}
      >
        {content}
      </PressableScale>
    );
  }

  return (
    <View style={[styles.row, props.last && styles.rowLast]}>{content}</View>
  );
}

function SignOutSheet(props: {
  visible: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="fade"
      onRequestClose={props.onCancel}
    >
      <View style={styles.modalRoot}>
        <Pressable
          accessibilityLabel="Cancel sign out"
          onPress={props.onCancel}
          style={StyleSheet.absoluteFill}
        />
        <View accessibilityViewIsModal style={styles.signOutDialog}>
          <PressableScale
            accessibilityLabel="Close sign out confirmation"
            containerStyle={styles.dialogCloseContainer}
            onPress={props.onCancel}
            style={styles.dialogClose}
          >
            <Icon name="close" size={20} color={color.ink} />
          </PressableScale>
          <View style={styles.sheetIcon}>
            <Icon name="person" size={22} color={color.bad} />
          </View>
          <Text
            style={[
              type.h1,
              { color: color.ink, textAlign: 'center', marginTop: space.lg },
            ]}
          >
            Sign out of Pickle Sensei?
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
            Your on-device reads remain private and intact. Synced progress will
            be available after you sign in again.
          </Text>
          <View style={{ gap: 10, marginTop: space.xl }}>
            <Button
              label="Keep me signed in"
              variant="dark"
              onPress={props.onCancel}
            />
            <Button
              label="Sign out"
              variant="danger"
              onPress={props.onConfirm}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function SettingsScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const tabBarInset = useTabBarContentInset();
  const tabBarDock = useTabScrollDock('Settings');
  const profile = useAppStore(s => s.profile);
  const session = useAuthStore(s => s.session);
  const signOut = useAuthStore(s => s.signOut);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const membership = selectMembershipState(useAccessStore());
  const refreshAccess = useAccessStore(s => s.refreshAccess);
  const consentAvailability = useConsentStore(s => s.availability);
  const modelTrainingActive = useConsentStore(s => s.modelTrainingActive);
  const hydrateConsent = useConsentStore(s => s.hydrate);
  const notificationPrefs = useNotificationStore(s => s.prefs);
  const notificationPermission = useNotificationStore(s => s.permission);
  const { appVersion, legalPrivacyUrl, legalTermsUrl } =
    getRuntimePublicConfig();

  // The consent value must reflect the server ledger, never a hard-coded
  // claim; re-hydrate whenever the signed-in session changes.
  useEffect(() => {
    void hydrateConsent();
  }, [hydrateConsent, session]);

  // The membership row states the server's free-rating ledger, which moves
  // every time a scored analysis syncs. Re-read it on every visit instead of
  // showing the snapshot the rating flow loaded when it first opened; the
  // previous value stays on screen until the fresh one lands. Guests have no
  // server account to ask, and an in-flight load is not duplicated.
  const syncedAccount = session !== null && !session.localOnly;
  useFocusEffect(
    useCallback(() => {
      if (!syncedAccount || useAccessStore.getState().status === 'loading') {
        return;
      }
      void refreshAccess();
    }, [refreshAccess, syncedAccount]),
  );

  const offlineJourney = useOfflineJourney();

  const accountLabel =
    session === null
      ? '—'
      : session.provider === 'guest'
        ? 'Local · this device'
        : (session.displayName ?? session.email ?? session.subject);
  // Guests with an onboarding first name are greeted by name; the guest
  // provider label moves down to the caption line.
  const isGuest = session?.provider === 'guest';
  const accountName =
    isGuest && profile?.firstName ? profile.firstName : accountLabel;
  const accountCaption =
    session === null
      ? 'Signed out'
      : isGuest
        ? profile?.firstName
          ? 'Local · this device'
          : 'Progress stays on this phone until you connect an account.'
        : `Signed in with ${
            session.provider === 'apple'
              ? 'Apple'
              : session.provider === 'google'
                ? 'Google'
                : session.provider
          }`;
  const playerFacts = playerFactsLine(profile);
  const consentValue =
    consentAvailability !== 'ready'
      ? 'Manage'
      : modelTrainingActive
        ? 'Training: contributing'
        : 'Training: off';
  // "Left" means ratings the server will still let this account START —
  // availableToReserve, not remaining: a scored analysis whose permit is
  // still syncing has already spent its rating even though `remaining`
  // only drops once the shot lands. This keeps the row in agreement with
  // the rating gate (canStartRating).
  const membershipLabel = membership.label;
  const notificationsValue = !notificationPrefs.enabled
    ? 'Off'
    : notificationPermission === 'denied'
      ? 'Allow in system settings'
      : notificationPrefs.practiceReminder
        ? `Daily · ${formatReminderMinutes(
            notificationPrefs.practiceReminderMinutes,
          )}`
        : 'On';

  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      <StatusBar barStyle="dark-content" />
      <ScrollView
        {...tabBarDock}
        contentContainerStyle={[styles.content, { paddingBottom: tabBarInset }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[type.hero, { color: color.ink }]}>Settings</Text>
        <Text style={[type.body, styles.subtitle]}>
          Your account, reminders and privacy.
        </Text>

        <Card style={styles.accountCard} testID="settings-account">
          <View style={styles.avatar}>
            <Text style={[type.h3, { color: color.ink }]}>
              {accountName.charAt(0).toUpperCase()}
            </Text>
          </View>
          <View style={styles.flex}>
            <Text style={[type.h3, { color: color.ink }]}>{accountName}</Text>
            <Text style={[type.caption, styles.accountCaption]}>
              {accountCaption}
            </Text>
            {playerFacts ? (
              <Text
                style={[type.caption, styles.accountCaption]}
                testID="settings-player-facts"
              >
                {playerFacts}
              </Text>
            ) : null}
          </View>
        </Card>

        <SectionTitle title="Membership" />
        <Card style={styles.groupCard}>
          {session?.localOnly ? (
            <SettingRow
              label="Connect account"
              value="For ratings"
              onPress={() => navigation.navigate('ConnectAccount')}
            />
          ) : null}
          <SettingRow
            label="Pickle Sensei Pro"
            value={session?.localOnly ? 'Sign in first' : membershipLabel}
            preserveCase
            onPress={() =>
              session?.localOnly
                ? navigation.navigate('ConnectAccount')
                : navigation.navigate('Paywall', { source: 'settings' })
            }
            last={session?.localOnly || !membership.manageSubscription}
          />
          {!session?.localOnly && membership.manageSubscription ? (
            <SettingRow
              label="Manage subscription"
              value="App Store"
              preserveCase
              onPress={() => void openSubscriptionManagement()}
              last
            />
          ) : null}
        </Card>
        {syncedAccount &&
        offlineJourney &&
        offlineJourneyHasNews(offlineJourney) ? (
          <OfflineAllocationCard
            state={offlineJourney}
            style={styles.offlineCard}
          />
        ) : null}

        <SectionTitle title="Reminders & privacy" />
        <Card style={styles.groupCard}>
          <SettingRow
            label="Notifications"
            value={notificationsValue}
            preserveCase
            onPress={() => navigation.navigate('NotificationSettings')}
          />
          <SettingRow
            label="Data & consent"
            value={consentValue}
            preserveCase
            onPress={() => navigation.navigate('ConsentSettings')}
            last
          />
        </Card>

        <SectionTitle title="About" />
        <Card style={styles.groupCard}>
          {/* StoreKit review, on demand (iOS only — Play review isn't wired).
              With the numeric app id configured this deep-links straight to
              the write-review page and permanently ends the per-analysis
              rating asks; until then it raises the OS-throttled in-app
              sheet. */}
          {Platform.OS === 'ios' ? (
            <SettingRow
              label="Rate Pickle Sensei"
              value="App Store"
              preserveCase
              onPress={() => void rateApp()}
            />
          ) : null}
          {/* Replays the first-run tour on demand; the device's one-time
              record is untouched, so this never re-arms the auto-show. The
              tour spotlights Home-screen elements, so land on Home first —
              the overlay's measurement retries cover the tab transition. */}
          <SettingRow
            label="App walkthrough"
            value="Replay"
            preserveCase
            onPress={() => {
              navigation.navigate('Tabs', { screen: 'Home' });
              useWalkthroughStore.getState().replay();
            }}
            last={!legalPrivacyUrl && !legalTermsUrl}
          />
          {legalPrivacyUrl ? (
            <SettingRow
              label="Privacy policy"
              value="View"
              onPress={() =>
                void openLegalPage('Privacy policy', legalPrivacyUrl)
              }
              last={!legalTermsUrl}
            />
          ) : null}
          {legalTermsUrl ? (
            <SettingRow
              label="Terms of use"
              value="View"
              onPress={() => void openLegalPage('Terms of use', legalTermsUrl)}
              last
            />
          ) : null}
        </Card>

        {/* Server-account management (incl. two-step deletion, App Review
            5.1.1(v), on the ManageAccount screen). Guests have no server
            account — their data never leaves the phone, so the row only
            renders for synced sessions. */}
        <SectionTitle title="Account" />
        <Card style={styles.groupCard}>
          {session && !session.localOnly ? (
            <SettingRow
              label="Manage account"
              value="Details"
              preserveCase
              onPress={() => navigation.navigate('ManageAccount')}
            />
          ) : null}
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Sign out"
            onPress={() => setConfirmingSignOut(true)}
            style={[styles.row, styles.rowLast]}
          >
            <Text style={[type.body, styles.signOutLabel]}>Sign out</Text>
          </PressableScale>
        </Card>

        <View style={styles.footer}>
          <Text
            style={[type.caption, styles.footerText]}
            testID="settings-app-version"
          >
            {`Pickle Sensei ${appVersion} · Scoring model ${
              scoringStackStatus().version
            }`}
          </Text>
          <Text
            style={[type.caption, styles.footerText]}
            testID="settings-dupr-note"
          >
            {DUPR_ESTIMATE_NOTE}
          </Text>
        </View>
      </ScrollView>

      <SignOutSheet
        visible={confirmingSignOut}
        onCancel={() => setConfirmingSignOut(false)}
        onConfirm={() => {
          setConfirmingSignOut(false);
          void signOut();
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  screen: { flex: 1, backgroundColor: color.surface },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
  },
  subtitle: { color: color.inkSoft, marginTop: space.sm, maxWidth: 340 },
  accountCard: {
    marginTop: space.xl,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  accountCaption: { color: color.inkSoft, marginTop: 2 },
  groupCard: { paddingHorizontal: space.md, paddingVertical: 0 },
  offlineCard: { marginTop: space.sm },
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.line,
  },
  rowLast: { borderBottomWidth: 0 },
  rowLabel: { color: color.ink, flex: 1 },
  rowValue: {
    color: color.inkSoft,
    textTransform: 'capitalize',
    textAlign: 'right',
    maxWidth: 150,
  },
  signOutLabel: { color: color.bad, flex: 1 },
  footer: {
    gap: space.sm,
    marginTop: space.lg,
    paddingHorizontal: space.sm,
  },
  footerText: { color: color.inkSoft },
  modalRoot: {
    flex: 1,
    backgroundColor: color.overlayStrong,
    justifyContent: 'center',
    alignItems: 'center',
    padding: space.lg,
  },
  signOutDialog: {
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
