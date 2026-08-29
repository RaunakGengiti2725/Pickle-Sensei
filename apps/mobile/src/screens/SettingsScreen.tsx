import React, { useState } from 'react';
import {
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
  SectionTitle,
} from '../design/components';
import { Icon, type IconName } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import { useAppStore } from '../state/appStore';
import { useAuthStore } from '../auth/authStore';
import { tts } from '../audio/tts';
import { scoringStackStatus } from '../vision/providers';
import { useAccessStore } from '../state/accessStore';
import type { RootStackParams } from '../navigation/params';

function SettingRow(props: {
  icon: IconName;
  label: string;
  value: string;
  last?: boolean;
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
      <Text numberOfLines={2} style={[type.caption, styles.rowValue]}>
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
  const accountLabel =
    session === null
      ? '—'
      : session.provider === 'guest'
        ? 'Guest · this device'
        : (session.displayName ?? session.email ?? session.subject);
  const scoringStack = scoringStackStatus();
  const modelLabel = scoringStack.version;
  const liveCourtLabel = 'Camera runtime unavailable';
  const membershipLabel = access?.premium
    ? 'Pro active'
    : access
      ? access.freeRatings.remaining > 0
        ? `${access.freeRatings.remaining} free rating${
            access.freeRatings.remaining === 1 ? '' : 's'
          } left`
        : 'Upgrade required'
      : 'Verify access';

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
                {accountLabel.charAt(0).toUpperCase()}
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
            {accountLabel}
          </Text>
          <Text
            style={[type.caption, { color: color.onDarkFaint, marginTop: 4 }]}
          >
            {session?.provider === 'guest'
              ? 'Progress stays on this phone until you connect an account.'
              : `${session?.provider ?? ''} account`}
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

        <SectionTitle title="Coaching" />
        <Card style={styles.groupCard}>
          <SettingRow
            icon="volume"
            label="Audio coach"
            value={tts.available() ? 'Balanced voice' : 'On-screen only'}
          />
          <SettingRow
            icon="court"
            label="Live Court cues"
            value={liveCourtLabel}
            last
          />
        </Card>

        <SectionTitle title="Privacy" />
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
          <SettingRow icon="library" label="App version" value="0.1.0" />
          <SettingRow
            icon="spark"
            label="Scoring model"
            value={modelLabel}
            last
          />
        </Card>
        <View style={styles.ratingNote}>
          <Icon name="shield" size={16} color={color.inkSoft} />
          <Text style={[type.caption, { color: color.inkSoft, flex: 1 }]}>
            Technique Score is coaching feedback—not a DUPR or player rating.
          </Text>
        </View>

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
