import React, { useCallback } from 'react';
import {
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
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
  ScreenHeader,
  SectionTitle,
} from '../design/components';
import { Icon, type IconName } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import { useNotificationStore } from '../notifications/notificationStore';
import {
  formatReminderMinutes,
  type NotificationPrefs,
} from '../notifications/types';
import type { RootStackParams } from '../navigation/params';

/**
 * Reminder controls. Everything here is opt-in and reversible:
 *   - nothing is scheduled until the player turns reminders on;
 *   - each reminder type has its own switch;
 *   - a revoked system permission is surfaced with a recovery path,
 *     never silently worked around.
 * Reminders are scheduled on this phone only — no push service exists.
 */

const TIME_PRESETS = [
  { label: 'Morning', minutes: 7 * 60 + 30 },
  { label: 'Midday', minutes: 12 * 60 },
  { label: 'Evening', minutes: 17 * 60 + 30 },
  { label: 'Night', minutes: 19 * 60 + 30 },
] as const;

const TIME_STEP_MINUTES = 30;
const MINUTES_IN_DAY = 24 * 60;

function ReminderRow(props: {
  icon: IconName;
  label: string;
  caption: string;
  value: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  last?: boolean;
}) {
  return (
    <View style={[styles.reminderRow, props.last && styles.reminderRowLast]}>
      <View style={styles.rowIcon}>
        <Icon name={props.icon} size={18} color={color.court} />
      </View>
      <View style={styles.rowCopy}>
        <Text style={[type.bodyBold, { color: color.ink }]}>{props.label}</Text>
        <Text style={[type.caption, styles.rowCaption]}>{props.caption}</Text>
      </View>
      <Switch
        accessibilityLabel={props.label}
        accessibilityState={{ disabled: props.disabled }}
        disabled={props.disabled}
        value={props.value}
        onValueChange={props.onChange}
      />
    </View>
  );
}

export function NotificationSettingsScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const prefs = useNotificationStore(s => s.prefs);
  const permission = useNotificationStore(s => s.permission);
  const setPrefs = useNotificationStore(s => s.setPrefs);
  const refreshPermission = useNotificationStore(s => s.refreshPermission);
  const requestPermissionAndEnable = useNotificationStore(
    s => s.requestPermissionAndEnable,
  );

  // Returning from the system settings sheet must re-read the permission,
  // otherwise the recovery banner would report a stale state.
  useFocusEffect(
    useCallback(() => {
      void refreshPermission();
    }, [refreshPermission]),
  );

  const permissionDenied = permission === 'denied';
  const active = prefs.enabled && !permissionDenied;

  const patch = (change: Partial<Omit<NotificationPrefs, 'version'>>) =>
    void setPrefs(change);

  const stepReminderTime = (direction: -1 | 1) => {
    const next =
      (prefs.practiceReminderMinutes +
        direction * TIME_STEP_MINUTES +
        MINUTES_IN_DAY) %
      MINUTES_IN_DAY;
    patch({ practiceReminderMinutes: next });
  };

  const openSystemSettings = () => {
    const { getScheduler } =
      require('../notifications/service') as typeof import('../notifications/service');
    void getScheduler().openSystemSettings();
  };

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
      <StatusBar barStyle="dark-content" />
      <ScreenHeader title="Notifications" onBack={() => navigation.goBack()} />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[type.body, { color: color.inkSoft }]}>
          Reminders are scheduled on this phone. Nothing about your play leaves
          the device to send one.
        </Text>

        {permissionDenied ? (
          <Card style={styles.deniedCard}>
            <View style={styles.deniedHeader}>
              <View style={styles.deniedIcon}>
                <Icon name="bell" size={20} color={color.warn} />
              </View>
              <Text style={[type.h3, styles.deniedTitle]}>
                Notifications are off in system settings
              </Text>
            </View>
            <Text style={[type.body, styles.deniedBody]}>
              Pickle Sensei can’t deliver reminders until notifications are
              allowed for the app.
            </Text>
            <View style={styles.deniedAction}>
              <Button
                label="Open system settings"
                variant="secondary"
                onPress={openSystemSettings}
              />
            </View>
          </Card>
        ) : null}

        {!prefs.enabled ? (
          <Card tone="dark" style={styles.enableCard}>
            <View style={styles.enableIcon}>
              <Icon name="bell" size={24} color={color.volt} />
            </View>
            <Text style={[type.h2, styles.enableTitle]}>Stay match-ready.</Text>
            <View style={styles.enableBenefits}>
              <Text style={[type.body, styles.enableBenefit]}>
                · A daily nudge at a time you pick
              </Text>
              <Text style={[type.body, styles.enableBenefit]}>
                · A heads-up before an active streak slips
              </Text>
              <Text style={[type.body, styles.enableBenefit]}>
                · A Sunday recap of your week on court
              </Text>
            </View>
            <View style={styles.enableAction}>
              <Button
                label="Turn on reminders"
                variant="volt"
                onPress={() => void requestPermissionAndEnable()}
              />
            </View>
            <Text style={[type.caption, styles.enableFootnote]}>
              Off by default. You can change or disable any of it here, anytime.
            </Text>
          </Card>
        ) : (
          <>
            <SectionTitle title="Reminders" />
            <Card style={styles.groupCard}>
              <ReminderRow
                icon="bell"
                label="All reminders"
                caption={
                  active
                    ? 'Scheduled from your real practice history'
                    : 'Paused until notifications are allowed'
                }
                value={prefs.enabled}
                onChange={next => patch({ enabled: next })}
                last
              />
            </Card>

            <SectionTitle title="Daily practice" />
            <Card style={styles.groupCard}>
              <ReminderRow
                icon="camera"
                label="Practice nudge"
                caption="One line a day inviting a scored read"
                value={prefs.practiceReminder}
                onChange={next => patch({ practiceReminder: next })}
              />
              <View style={styles.timeBlock}>
                <View style={styles.timeHeader}>
                  <Text style={[type.caption, { color: color.inkSoft }]}>
                    Reminder time
                  </Text>
                  <Text
                    accessibilityLabel={`Reminder time ${formatReminderMinutes(
                      prefs.practiceReminderMinutes,
                    )}`}
                    style={[type.h3, styles.timeValue]}
                  >
                    {formatReminderMinutes(prefs.practiceReminderMinutes)}
                  </Text>
                </View>
                <View style={styles.timePresets}>
                  {TIME_PRESETS.map(preset => {
                    const selected =
                      prefs.practiceReminderMinutes === preset.minutes;
                    return (
                      <PressableScale
                        key={preset.label}
                        accessibilityLabel={`${
                          preset.label
                        }, ${formatReminderMinutes(preset.minutes)}`}
                        accessibilityState={{ selected }}
                        containerStyle={styles.timePresetSlot}
                        disabled={!prefs.practiceReminder}
                        onPress={() =>
                          patch({ practiceReminderMinutes: preset.minutes })
                        }
                        style={[
                          styles.timePreset,
                          selected && styles.timePresetSelected,
                        ]}
                      >
                        <Text
                          style={[
                            type.caption,
                            selected
                              ? styles.timePresetLabelSelected
                              : styles.timePresetLabel,
                          ]}
                        >
                          {preset.label}
                        </Text>
                      </PressableScale>
                    );
                  })}
                </View>
                <View style={styles.timeStepper}>
                  <PressableScale
                    accessibilityLabel="Reminder 30 minutes earlier"
                    disabled={!prefs.practiceReminder}
                    onPress={() => stepReminderTime(-1)}
                    containerStyle={styles.timeStepSlot}
                    style={styles.timeStepButton}
                  >
                    <Text style={[type.h3, styles.timeStepGlyph]}>−30m</Text>
                  </PressableScale>
                  <PressableScale
                    accessibilityLabel="Reminder 30 minutes later"
                    disabled={!prefs.practiceReminder}
                    onPress={() => stepReminderTime(1)}
                    containerStyle={styles.timeStepSlot}
                    style={styles.timeStepButton}
                  >
                    <Text style={[type.h3, styles.timeStepGlyph]}>+30m</Text>
                  </PressableScale>
                </View>
              </View>
            </Card>

            <SectionTitle title="Momentum" />
            <Card style={styles.groupCard}>
              <ReminderRow
                icon="flame"
                label="Streak defense"
                caption="7:30 PM on days an active streak has no capture yet"
                value={prefs.streakDefense}
                onChange={next => patch({ streakDefense: next })}
              />
              <ReminderRow
                icon="progress"
                label="Weekly recap"
                caption="Sundays at 6:00 PM, pointing at your Progress tab"
                value={prefs.weeklyRecap}
                onChange={next => patch({ weeklyRecap: next })}
              />
              <ReminderRow
                icon="spark"
                label="Welcome back"
                caption="After 3, 7, and 14 days away — never while you’re active"
                value={prefs.comeback}
                onChange={next => patch({ comeback: next })}
                last
              />
            </Card>
          </>
        )}

        <View style={styles.privacyNote}>
          <Icon name="shield" size={16} color={color.inkSoft} />
          <Text style={[type.caption, styles.privacyNoteCopy]}>
            Reminder copy never includes your name, scores, or clips — it is
            written for a lock screen.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xxl,
  },
  deniedCard: {
    marginTop: space.lg,
    padding: space.lg,
    backgroundColor: color.warnSoft,
  },
  deniedHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  deniedIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: color.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deniedTitle: { color: color.warn, flex: 1 },
  deniedBody: { color: color.ink, marginTop: space.sm },
  deniedAction: { marginTop: space.md },
  enableCard: { marginTop: space.lg, padding: space.lg },
  enableIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: color.onDarkTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  enableTitle: { color: color.onDark, marginTop: space.md },
  enableBenefits: { marginTop: space.sm, gap: 4 },
  enableBenefit: { color: color.onDarkMuted },
  enableAction: { marginTop: space.lg },
  enableFootnote: {
    color: color.onDarkFaint,
    marginTop: space.sm,
    textAlign: 'center',
  },
  groupCard: { paddingHorizontal: space.md, paddingVertical: 2 },
  reminderRow: {
    minHeight: 66,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.line,
  },
  reminderRowLast: { borderBottomWidth: 0 },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: color.courtSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowCopy: { flex: 1, minWidth: 0 },
  rowCaption: { color: color.inkSoft, marginTop: 2 },
  timeBlock: {
    paddingVertical: space.md,
    borderBottomWidth: 0,
  },
  timeHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  timeValue: { color: color.court, fontVariant: ['tabular-nums'] },
  timePresets: { flexDirection: 'row', gap: 8, marginTop: space.sm },
  timePresetSlot: { flex: 1 },
  timePreset: {
    minHeight: 44,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timePresetSelected: {
    backgroundColor: color.ink,
    borderColor: color.ink,
  },
  timePresetLabel: { color: color.inkSoft },
  timePresetLabelSelected: { color: color.onDark },
  timeStepper: { flexDirection: 'row', gap: 8, marginTop: space.sm },
  timeStepSlot: { flex: 1 },
  timeStepButton: {
    minHeight: 44,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timeStepGlyph: { color: color.ink },
  privacyNote: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.sm,
    marginTop: space.lg,
  },
  privacyNoteCopy: { color: color.inkSoft, flex: 1 },
});
