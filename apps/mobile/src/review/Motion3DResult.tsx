import React, { useEffect, useState } from 'react';
import { StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { Motion3DAnalysis } from '@pickle/analysis-pipeline';
import { Button, ErrorState, ScreenHeader } from '../design/components';
import { color, space, type } from '../design/tokens';
import {
  captureDataOwnerScope,
  getActiveDataOwner,
  isDataOwnerScopeCurrent,
  SIGNED_OUT_DATA_OWNER,
  subscribeDataOwnerChanges,
} from '../data/accountScope';
import type { RootStackParams } from '../navigation/params';
import { armTryAgain } from '../screens/tryAgainHandoff';
import { Motion3DPlayer } from './Motion3DPlayer';

export function Motion3DResult(props: {
  motion: Motion3DAnalysis;
  videoUri: string;
  onClose: () => void;
}) {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const [scope] = useState(() =>
    getActiveDataOwner() === SIGNED_OUT_DATA_OWNER
      ? null
      : captureDataOwnerScope(),
  );
  const [available, setAvailable] = useState(scope !== null);
  useEffect(
    () =>
      subscribeDataOwnerChanges(() => {
        if (!scope || !isDataOwnerScopeCurrent(scope)) setAvailable(false);
      }),
    [scope],
  );

  if (!available) {
    return (
      <ErrorState
        title="Motion unavailable"
        detail="The account changed. Open this recording from its original account."
        onRetry={props.onClose}
        retryLabel="Go back"
        dark
      />
    );
  }
  return (
    <SafeAreaView
      edges={['top', 'bottom']}
      style={styles.screen}
      testID="motion3d-result"
    >
      <StatusBar barStyle="light-content" />
      <ScreenHeader title="Motion analysis" dark onClose={props.onClose} />
      <View style={styles.player}>
        <Motion3DPlayer
          key={props.motion.record.id}
          artifact={props.motion.artifact}
          artifactJson={props.motion.artifactJson}
          artifactSha256={props.motion.record.artifactSha256}
          videoUri={props.videoUri}
          fill
        />
      </View>
      <View style={styles.footer}>
        <Text style={[type.caption, styles.note]}>
          Development analysis. No rating used.
        </Text>
        <View style={styles.actions}>
          <View style={styles.primary}>
            <Button
              label="Record again"
              icon="camera"
              variant="volt"
              testID="motion3d-record-again"
              onPress={() => {
                if (!scope || !isDataOwnerScopeCurrent(scope)) return;
                armTryAgain({
                  source: 'camera',
                  declaredStroke: props.motion.record.declaredStroke,
                  declaredCanonical: props.motion.record.declaredCanonical,
                  auto: props.motion.record.declaredStroke === null,
                  sessionId: null,
                });
                navigation.navigate('Analyze', { source: 'camera' });
              }}
            />
          </View>
          <View style={styles.secondary}>
            <Button
              label="Done"
              variant="dark"
              testID="motion3d-done"
              onPress={props.onClose}
            />
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surfaceDark },
  player: { flex: 1, minHeight: 0, paddingHorizontal: space.lg },
  footer: {
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    paddingTop: space.sm,
    gap: space.sm,
  },
  note: { color: color.onDarkMuted },
  actions: { flexDirection: 'row', gap: space.sm },
  primary: { flex: 2 },
  secondary: { flex: 1 },
});
