import React, { useEffect, useState } from 'react';
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
import { useNavigation } from '@react-navigation/native';
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
import { useConsistencyStore } from '../consistency/store';
import { plural } from '../util/plural';
import { scoringStackStatus } from '../vision/providers';
import { useAccessStore } from '../state/accessStore';
import { getRuntimePublicConfig } from '../config/runtimeConfig';
import { rateAppFromSettings } from '../review/appStoreReview';
import type { RootStackParams } from '../navigation/params';

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
        <Icon name={props.icon} size={18} color={color.court} />
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
  const profile = useAppStore(s => s.profile);
  const session = useAuthStore(s => s.session);
  const signOut = useAuthStore(s => s.signOut);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const access = useAccessStore(s => s.canonicalAccess);
  const consentAvailability = useConsentStore(s => s.availability);
  const modelTrainingActive = useConsentStore(s => s.modelTrainingActive);
  const hydrateConsent = useConsentStore(s => s.hydrate);
  const notificationPrefs = useNotificationStore(s => s.prefs);
  const notificationPermission = useNotificationStore(s => s.permission);
  const consistency = useConsistencyStore(s => s.snapshot);
  const { legalPrivacyUrl, legalTermsUrl } = getRuntimePublicConfig();

  // The consent value must reflect the server ledger, never a hard-coded
  // claim; re-hydrate whenever the signed-in session changes.
  useEffect(() => {
    void hydrateConsent();
  }, [hydrateConsent, session]);

  const accountLabel =
    session === null
      ? '—'
      : session.provider === 'guest'
        ? 'Guest · this device'
        : (session.displayName ?? session.email ?? session.subject);
  // Guests with an onboarding first name are greeted by name; the guest
  // provider label moves down to the caption line.
  const isGuest = session?.provider === 'guest';
  const accountName =
    isGuest && profile?.firstName ? profile.firstName : accountLabel;
  const accountCaption = isGuest
    ? profile?.firstName
      ? 'Guest · this device'
      : 'Progress stays on this phone until you connect an account.'
    : `${session?.provider ?? ''} account`;
  const scoringStack = scoringStackStatus();
  const modelLabel = scoringStack.version;
  const consentValue =
    consentAvailability !== 'ready'
      ? 'Manage'
      : modelTrainingActive
        ? 'Training: contributing'
        : 'Training: off';
  const membershipLabel = access?.premium
    ? 'Pro active'
    : access
      ? access.freeRatings.remaining > 0
        ? `${access.freeRatings.remaining} free rating${
            access.freeRatings.remaining === 1 ? '' : 's'
          } left`
        : 'Upgrade required'
      : 'Verify access';
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
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[type.hero, { color: color.ink }]}>Settings</Text>
        <Text
          style={[type.body, { color: color.inkSoft, marginTop: space.sm }]}
        >
          Your player profile, coaching preferences, and privacy controls.
        </Text>

        <Card tone="dark" style={styles.accountCard}>
          <View style={styles.accountTop}>
            <View style={styles.avatar}>
              <Text style={[type.h2, { color: color.onVolt }]}>
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
              tone={session === null ? 'neutral' : 'volt'}
            />
          </View>
          <Text
            numberOfLines={1}
            style={[type.h2, { color: color.onDark, marginTop: space.lg }]}
          >
            {accountName}
          </Text>
          <Text
            style={[type.caption, { color: color.onDarkFaint, marginTop: 4 }]}
          >
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
            onPress={() =>
              session?.localOnly
                ? navigation.navigate('ConnectAccount')
                : navigation.navigate('Paywall', { source: 'settings' })
            }
            last
          />
        </Card>

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
          />
          <SettingRow
            icon="flame"
            label="Consistency"
            value={
              consistency
                ? `${consistency.currentStreak} day streak · ${
                    consistency.earned.length
                  } ${plural(consistency.earned.length, 'badge')}`
                : '—'
            }
            onPress={() => navigation.navigate('StreakCalendar')}
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
        <View style={styles.privacyCard}>
          <View style={styles.privacyHeader}>
            <View style={styles.privacyIcon}>
              <Icon name="shield" size={22} color={color.volt} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[type.h3, { color: color.onDark }]}>
                Private by default
              </Text>
              <Text
                style={[
                  type.caption,
                  { color: color.onDarkSubtle, marginTop: 3 },
                ]}
              >
                Current capture behavior, reported without assumptions.
              </Text>
            </View>
          </View>
          <View style={styles.privacyRows}>
            <View style={styles.privacyRow}>
              <Text style={[type.caption, { color: color.onDarkSubtle }]}>
                Captured clips
              </Text>
              <Text style={[type.bodyBold, { color: color.onDark }]}>
                App-private storage
              </Text>
            </View>
            <View style={styles.privacyRow}>
              <Text style={[type.caption, { color: color.onDarkSubtle }]}>
                Cloud video upload
              </Text>
              <Text style={[type.bodyBold, { color: color.onDark }]}>
                Not configured
              </Text>
            </View>
          </View>
        </View>

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
              onPress={() => void rateAppFromSettings()}
            />
          ) : null}
          <SettingRow
            icon="library"
            label="App version"
            value={getRuntimePublicConfig().appVersion}
          />
          <SettingRow
            icon="spark"
            label="Scoring model"
            value={modelLabel}
            last={!legalPrivacyUrl && !legalTermsUrl}
          />
          {legalPrivacyUrl ? (
            <SettingRow
              icon="shield"
              label="Privacy policy"
              value="View"
              onPress={() => void Linking.openURL(legalPrivacyUrl)}
              last={!legalTermsUrl}
            />
          ) : null}
          {legalTermsUrl ? (
            <SettingRow
              icon="library"
              label="Terms of use"
              value="View"
              onPress={() => void Linking.openURL(legalTermsUrl)}
              last
            />
          ) : null}
        </Card>
        <View style={styles.ratingNote}>
          <Icon name="shield" size={16} color={color.inkSoft} />
          <Text style={[type.caption, { color: color.inkSoft, flex: 1 }]}>
            Technique Score is coaching feedback—not a DUPR or player rating.
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
    paddingBottom: space.xl,
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
    borderRadius: 27,
    backgroundColor: color.volt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  groupCard: { paddingHorizontal: space.md, paddingVertical: 2 },
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
    borderRadius: 18,
    backgroundColor: color.courtSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowValue: {
    color: color.inkSoft,
    textTransform: 'capitalize',
    textAlign: 'right',
    maxWidth: 130,
  },
  privacyCard: {
    // The white consent Card above has no bottom margin of its own, so the
    // dark panel needs explicit top spacing or the two visually fuse.
    marginTop: space.md,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceDark,
    padding: space.lg,
  },
  privacyHeader: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  privacyIcon: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: color.inkElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  privacyRows: {
    marginTop: space.lg,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.lineDark,
  },
  privacyRow: {
    minHeight: 45,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
