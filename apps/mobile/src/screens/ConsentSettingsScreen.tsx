import React, { useEffect } from 'react';
import {
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Card, ScreenHeader, SectionTitle } from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import { useAuthStore } from '../auth/authStore';
import { useConsentStore } from '../state/consentStore';
import type { RootStackParams } from '../navigation/params';

/**
 * First-party consent surface. "Analyze my video" and "use my video to
 * improve models" are deliberately separate: analysis is what the product
 * does; model training happens ONLY behind the explicit opt-in below.
 * No dark patterns: the toggle defaults off, both directions use the same
 * neutral copy weight, and failures never pretend the change was saved.
 */

export function ConsentSettingsScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const session = useAuthStore(s => s.session);
  const availability = useConsentStore(s => s.availability);
  const active = useConsentStore(s => s.modelTrainingActive);
  const busy = useConsentStore(s => s.busy);
  const error = useConsentStore(s => s.error);
  const hydrate = useConsentStore(s => s.hydrate);
  const setConsent = useConsentStore(s => s.setModelTrainingConsent);

  useEffect(() => {
    void hydrate();
  }, [hydrate, session]);

  const signedOut = availability === 'signed_out';
  const toggleDisabled = busy || availability !== 'ready';

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
      <StatusBar barStyle="dark-content" />
      <ScreenHeader title="Data & consent" onBack={() => navigation.goBack()} />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[type.body, { color: color.inkSoft }]}>
          Two separate choices. Analyzing your video never opts you into
          anything else.
        </Text>

        <SectionTitle title="Analyze my video" />
        <Card style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={styles.iconWrap}>
              <Icon name="shield" size={20} color={color.court} />
            </View>
            <Text style={[type.h3, { color: color.ink, flex: 1 }]}>
              Part of using Pickle Sensei
            </Text>
          </View>
          <Text style={[type.body, styles.bodyText]}>
            Your clips are analyzed to show you your own results. They stay in
            app-private storage and are never used to train models under this
            setting.
          </Text>
        </Card>

        <SectionTitle title="Improve the models" />
        <Card style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={styles.iconWrap}>
              <Icon name="spark" size={20} color={color.court} />
            </View>
            <Text style={[type.h3, { color: color.ink, flex: 1 }]}>
              Use my video to improve models
            </Text>
            <Switch
              accessibilityLabel="Use my video to improve models"
              accessibilityState={{ disabled: toggleDisabled }}
              disabled={toggleDisabled}
              value={active}
              onValueChange={next => void setConsent(next)}
            />
          </View>
          <Text style={[type.body, styles.bodyText]}>
            Off unless you turn it on. When on, your captured stroke clips may
            be used to improve Pickle Sensei's stroke and scoring models. You
            can turn it off at any time and new training use stops; a record of
            your choice is kept for accountability.
          </Text>
          {signedOut ? (
            <Text style={[type.caption, styles.noteText]}>
              Sign in to change this. Nothing is shared while signed out.
            </Text>
          ) : null}
          {availability === 'unavailable' && error ? (
            <Text style={[type.caption, styles.errorText]}>{error}</Text>
          ) : null}
          {availability === 'ready' && error ? (
            <Text style={[type.caption, styles.errorText]}>{error}</Text>
          ) : null}
        </Card>
      </ScrollView>
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
  card: { padding: space.lg, marginTop: space.sm },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: radius.md,
    backgroundColor: color.courtSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bodyText: { color: color.inkSoft, marginTop: space.md },
  noteText: { color: color.inkSoft, marginTop: space.md },
  errorText: { color: color.bad, marginTop: space.md },
});
