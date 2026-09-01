import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { PressableScale } from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import { useNotificationStore } from './notificationStore';

/**
 * One-time Home priming card (shown until answered): asks BEFORE the system
 * permission prompt so a "no" here costs nothing, and "Not now" dismisses it
 * forever — reminders stay reachable from Settings. Never re-nags.
 */
export function NotificationPrimingCard() {
  const hydrated = useNotificationStore(s => s.hydrated);
  const prefs = useNotificationStore(s => s.prefs);
  const permission = useNotificationStore(s => s.permission);
  const requestPermissionAndEnable = useNotificationStore(
    s => s.requestPermissionAndEnable,
  );
  const dismissPrompt = useNotificationStore(s => s.dismissPrompt);

  const visible =
    hydrated &&
    !prefs.enabled &&
    !prefs.promptDismissed &&
    permission !== 'denied';
  if (!visible) return null;

  return (
    <View style={styles.card} testID="notification-priming-card">
      <View style={styles.iconWrap}>
        <Icon name="bell" size={20} color={color.court} />
      </View>
      <View style={styles.copy}>
        <Text style={[type.bodyBold, { color: color.ink }]}>
          A nudge on practice days?
        </Text>
        <Text style={[type.caption, styles.caption]}>
          One daily reminder, plus a heads-up before a streak slips. Scheduled
          on this phone only.
        </Text>
        <View style={styles.actions}>
          <PressableScale
            accessibilityLabel="Turn on practice reminders"
            containerStyle={styles.actionSlot}
            onPress={() => void requestPermissionAndEnable()}
            style={[styles.action, styles.actionPrimary]}
          >
            <Text style={[type.caption, styles.actionPrimaryLabel]}>
              Turn on
            </Text>
          </PressableScale>
          <PressableScale
            accessibilityLabel="Not now"
            containerStyle={styles.actionSlot}
            onPress={() => void dismissPrompt()}
            style={styles.action}
          >
            <Text style={[type.caption, styles.actionLabel]}>Not now</Text>
          </PressableScale>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    gap: space.md,
    marginTop: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: color.courtSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: { flex: 1, minWidth: 0 },
  caption: { color: color.inkSoft, marginTop: 3 },
  actions: { flexDirection: 'row', gap: 8, marginTop: space.sm + 2 },
  actionSlot: { flexGrow: 0, alignSelf: 'flex-start', minWidth: 96 },
  action: {
    minHeight: 40,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionPrimary: { backgroundColor: color.ink, borderColor: color.ink },
  actionPrimaryLabel: { color: color.onDark },
  actionLabel: { color: color.inkSoft },
});
