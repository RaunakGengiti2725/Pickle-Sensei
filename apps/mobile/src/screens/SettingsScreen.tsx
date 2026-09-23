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
  Pill,
  PressableScale,
  SectionTitle,
} from '../design/components';
import { Icon, type IconName } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import { useAppStore, type Gender } from '../state/appStore';
import { useAuthStore } from '../auth/authStore';
import { useConsentStore } from '../state/consentStore';
import { useNotificationStore } from '../notifications/notificationStore';
import { formatReminderMinutes } from '../notifications/types';
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
  useOfflineJourney,
} from '../components/OfflineAllocationCard';

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

const GENDER_LABELS: Record<Gender, string> = {
  female: 'Female',
  male: 'Male',
  nonbinary: 'Non-binary',
  prefer_not_to_say: 'Prefer not to say',
};

function SettingRow(props: {
  icon: IconName;
  label: string;
  value: string;
  last?: boolean;
  /** Values that are already sentence-cased opt out of auto-capitalize. */
  preserveCase?: boolean;
  onPress?: () => void;
}) {
  const content = (
    <>
      <View style={styles.rowIcon}>
        <Icon name={props.icon} size={18} color={color.inkSoft} />
      </View>
      <Text style={[type.body, { color: color.ink, flex: 1 }]}>
        {props.label}
      </Text>
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
        <Icon name="arrow" size={17} color={color.inkSoft} />
      ) : null}
    </>
  );

  if (props.onPress) {
    return (
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`${props.label}, ${props.value}`}
        onPress={props.onPress}
        style={[styles.row, props.last && { borderBottomWidth: 0 }]}
      >
        {content}
      </PressableScale>
    );
  }

  return (
    <View style={[styles.row, props.last && { borderBottomWidth: 0 }]}>
      {content}
    </View>
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
            Your reads stay on this device.
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
  const { legalPrivacyUrl, legalTermsUrl } = getRuntimePublicConfig();

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
  const accountCaption = isGuest
    ? profile?.firstName
      ? 'Local · this device'
      : 'Progress stays on this phone until you connect an account.'
    : `${session?.provider ?? ''} account`;
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

        <Card tone="soft" style={styles.accountCard}>
          <View style={styles.accountTop}>
            <View style={styles.avatar}>
              <Text style={[type.h2, { color: color.ink }]}>
                {accountName.charAt(0).toUpperCase()}
              </Text>
            </View>
            <Pill
              label={
                session === null
                  ? 'SIGNED OUT'
                  : session.provider === 'guest'
                    ? 'LOCAL'
                    : 'SYNCED'
              }
              tone="neutral"
            />
          </View>
          <Text
            numberOfLines={1}
            style={[type.h2, { color: color.ink, marginTop: space.lg }]}
          >
            {accountName}
          </Text>
          <Text style={[type.caption, { color: color.inkSoft, marginTop: 4 }]}>
            {accountCaption}
          </Text>
        </Card>

        <SectionTitle title="Membership" />
        <Card style={styles.groupCard}>
          {session?.localOnly ? (
            <SettingRow
              icon="person"
              label="Connect account"
              value="For ratings"
              onPress={() => navigation.navigate('ConnectAccount')}
            />
          ) : null}
          <SettingRow
            icon="crown"
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
              icon="shield"
              label="Manage subscription"
              value="App Store"
              preserveCase
              onPress={() => void openSubscriptionManagement()}
              last
            />
          ) : null}
        </Card>
        {syncedAccount && offlineJourney ? (
          <OfflineAllocationCard
            state={offlineJourney}
            style={styles.offlineCard}
          />
        ) : null}

        <SectionTitle title="Player" />
        <Card style={styles.groupCard}>
          <SettingRow
            icon="person"
            label="Name"
            value={profile?.firstName ?? '—'}
            preserveCase
          />
          <SettingRow
            icon="person"
            label="Gender"
            value={profile?.gender ? GENDER_LABELS[profile.gender] : '—'}
            preserveCase
          />
          <SettingRow
            icon="progress"
            label="Playing level"
            value={profile?.skillLevel ?? '—'}
          />
          <SettingRow
            icon="person"
            label="Hitting hand"
            value={profile?.handedness ?? '—'}
          />
          <SettingRow
            icon="spark"
            label="Current focus"
            value={(profile?.focusCheckpoint ?? '—').replace(/_/g, ' ')}
            last
          />
        </Card>

        <SectionTitle title="Reminders" />
        <Card style={styles.groupCard}>
          <SettingRow
            icon="bell"
            label="Notifications"
            value={notificationsValue}
            preserveCase
            onPress={() => navigation.navigate('NotificationSettings')}
            last
          />
        </Card>

        <SectionTitle title="Privacy" />
        <Card style={styles.groupCard}>
          <SettingRow
            icon="shield"
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
              icon="star"
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
            icon="court"
            label="App walkthrough"
            value="Replay"
            preserveCase
            onPress={() => {
              navigation.navigate('Tabs', { screen: 'Home' });
              useWalkthroughStore.getState().replay();
            }}
          />
          <SettingRow
            icon="library"
            label="App version"
            value={getRuntimePublicConfig().appVersion}
            last={!legalPrivacyUrl && !legalTermsUrl}
          />
          {legalPrivacyUrl ? (
            <SettingRow
              icon="shield"
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
              icon="library"
              label="Terms of use"
              value="View"
              onPress={() => void openLegalPage('Terms of use', legalTermsUrl)}
              last
            />
          ) : null}
        </Card>
        <View style={styles.ratingNote}>
          <Icon name="shield" size={16} color={color.inkSoft} />
          <Text
            style={[type.caption, { color: color.inkSoft, flex: 1 }]}
            testID="settings-dupr-note"
          >
            {DUPR_ESTIMATE_NOTE}
          </Text>
        </View>

        {/* Server-account management (incl. two-step deletion, App Review
            5.1.1(v), now on the ManageAccount screen). Guests have no server
            account — their data never leaves the phone, so the row only
            renders for synced sessions. */}
        {session && !session.localOnly ? (
          <>
            <SectionTitle title="Account" />
            <Card style={styles.groupCard}>
              <SettingRow
                icon="person"
                label="Manage account"
                value="Details"
                preserveCase
                onPress={() => navigation.navigate('ManageAccount')}
                last
              />
            </Card>
          </>
        ) : null}

        <PressableScale
          accessibilityLabel="Sign out"
          onPress={() => setConfirmingSignOut(true)}
          style={styles.signOutRow}
        >
          <Text style={[type.bodyBold, { color: color.bad }]}>Sign out</Text>
          <Icon name="arrow" size={18} color={color.bad} />
        </PressableScale>
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
  screen: { flex: 1, backgroundColor: color.surface },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
  },
  accountCard: { minHeight: 190, marginTop: space.xl },
  accountTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  avatar: {
    width: 54,
    height: 54,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  groupCard: { paddingHorizontal: space.md, paddingVertical: 2 },
  offlineCard: { marginTop: space.sm },
  row: {
    minHeight: 66,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.line,
  },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: color.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowValue: {
    color: color.inkSoft,
    textTransform: 'capitalize',
    textAlign: 'right',
    maxWidth: 130,
  },
  ratingNote: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.sm,
    marginTop: space.md,
  },
  signOutRow: {
    minHeight: 64,
    paddingHorizontal: space.md,
    marginTop: space.xl,
    borderRadius: radius.lg,
    backgroundColor: color.badSoft,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
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
