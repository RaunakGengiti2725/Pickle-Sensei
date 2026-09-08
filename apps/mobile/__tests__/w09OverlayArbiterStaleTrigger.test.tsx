/**
 * W09-04 adversarial suite — stale focus trigger.
 *
 * The arbiter remembers the control that opened a ceremony and calls
 * `findNodeHandle(trigger)` on dismissal to hand VoiceOver focus back. This
 * suite keeps React Native's REAL `findNodeHandle` (no host-tag shim) and
 * unmounts the trigger before the ceremony is dismissed — the shape of every
 * content swap that unmounts RootNavigator while a replayed tour is open
 * (App.tsx `content`: implicit sign-out on a refused refresh token, re-auth,
 * owner re-hydration) after which the device-level tour re-presents.
 */
import React from 'react';
import {
  AccessibilityInfo,
  AppState,
  View,
  type HostInstance,
} from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('react-native-safe-area-context', () => {
  const ReactActual = jest.requireActual<typeof React>('react');
  const Native =
    jest.requireActual<typeof import('react-native')>('react-native');
  const passthrough = ({ children }: { children: React.ReactNode }) =>
    ReactActual.createElement(Native.View, null, children);
  return {
    SafeAreaProvider: passthrough,
    SafeAreaView: passthrough,
    SafeAreaInsetsContext: ReactActual.createContext(null),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});
jest.mock('react-native-linear-gradient', () => {
  const ReactActual = jest.requireActual<typeof React>('react');
  const Native =
    jest.requireActual<typeof import('react-native')>('react-native');
  const Gradient = ({ children }: { children?: React.ReactNode }) =>
    ReactActual.createElement(Native.View, null, children);
  return { __esModule: true, default: Gradient };
});

const mockKv = new Map<string, string>();
jest.mock('../src/data/db', () => ({ getDb: () => ({}) }));
jest.mock('../src/data/repository', () => ({
  getKv: async (_db: unknown, key: string) => mockKv.get(key) ?? null,
  setKv: async (_db: unknown, key: string, value: string) => {
    mockKv.set(key, value);
  },
  listActivityShots: async () => [],
}));

import { CeremonyHost } from '../src/flow/CeremonyHost';
import { openCeremonyFrom } from '../src/flow/ceremonyRequest';
import { FirstRunWalkthrough } from '../src/walkthrough/FirstRunWalkthrough';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import {
  useWalkthroughStore,
  WALKTHROUGH_KV_KEY,
  WALKTHROUGH_SEEN_VALUE,
} from '../src/walkthrough/walkthroughStore';
import { registerWalkthroughMeasurer } from '../src/walkthrough/targets';

const OWNER = '11111111-1111-4111-8111-111111111111';

let renderer: TestRenderer.ReactTestRenderer | undefined;
let unregister: Array<() => void>;

/** A Settings-style row that replays the walkthrough on behalf of itself
 * (SettingsScreen.tsx: `openCeremonyFrom(walkthroughRow.current, replay)`). */
function ReplayTrigger() {
  const row = React.useRef<HostInstance>(null);
  return (
    <View
      ref={row}
      accessibilityLabel="App walkthrough, Replay"
      testID="replay-trigger"
      onClick={() =>
        openCeremonyFrom(row.current, () =>
          useWalkthroughStore.getState().replay(),
        )
      }
    />
  );
}

/** App.tsx shape: the signed-in content (RootNavigator, which owns the
 * Settings row) is swapped out when the session goes away and back in when
 * it returns; the global CeremonyHost outlives both. */
function Shell(props: { ownerKey: string; signedIn: boolean }) {
  return (
    <>
      {props.signedIn ? <ReplayTrigger /> : null}
      <CeremonyHost ownerKey={props.ownerKey}>
        <FirstRunWalkthrough />
      </CeremonyHost>
    </>
  );
}

async function mount(element: React.ReactElement) {
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
}

async function update(element: React.ReactElement) {
  await act(async () => renderer!.update(element));
}

function overlays() {
  return renderer!.root.findAll(
    node =>
      typeof node.type === 'string' && node.props.testID === 'ceremony-overlay',
  );
}

async function press(testID: string) {
  const target = renderer!.root.findAll(
    node => node.props.testID === testID && node.props.onPress,
  )[0]!;
  expect(target).toBeDefined();
  await act(async () => target.props.onPress());
}

async function replayFromTrigger() {
  const trigger = renderer!.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.testID === 'replay-trigger' &&
      typeof node.props.onClick === 'function',
  )[0]!;
  expect(trigger).toBeDefined();
  await act(async () => trigger.props.onClick());
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-09-06T22:00:00Z') });
  mockKv.clear();
  mockKv.set(WALKTHROUGH_KV_KEY, WALKTHROUGH_SEEN_VALUE);
  setActiveDataOwner(OWNER);
  useWalkthroughStore.setState({
    visible: false,
    queued: false,
    request: null,
  });
  AppState.currentState = 'active';
  unregister = ['coach-fab', 'rank-banner', 'tab-library', 'tab-progress'].map(
    key =>
      registerWalkthroughMeasurer(
        key as Parameters<typeof registerWalkthroughMeasurer>[0],
        async () => ({ x: 20, y: 300, width: 200, height: 48 }),
      ),
  );
  jest
    .spyOn(AccessibilityInfo, 'announceForAccessibility')
    .mockImplementation(() => {});
  jest
    .spyOn(AccessibilityInfo, 'setAccessibilityFocus')
    .mockImplementation(() => {});
});

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
  unregister.forEach(fn => fn());
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('attack: focus trigger unmounted before the ceremony is dismissed', () => {
  it('sign-out swaps the signed-in content away while the replayed tour is open; after sign-in the tour returns and Skip must not throw', async () => {
    await mount(<Shell ownerKey={OWNER} signedIn />);
    await replayFromTrigger();
    expect(overlays()).toHaveLength(1);

    // Refused refresh token / re-auth: session gone, RootNavigator (and the
    // Settings row) unmounts, the device-level tour request stays raised.
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await update(<Shell ownerKey={SIGNED_OUT_DATA_OWNER} signedIn={false} />);
    expect(overlays()).toHaveLength(0);
    expect(useWalkthroughStore.getState().visible).toBe(true);

    setActiveDataOwner(OWNER);
    await update(<Shell ownerKey={OWNER} signedIn />);
    expect(overlays()).toHaveLength(1);

    await press('walkthrough-skip');
    expect(overlays()).toHaveLength(0);
    expect(useWalkthroughStore.getState().visible).toBe(false);
  });

  it('the trigger unmounts while the tour stays presented (no owner change); Skip must not throw', async () => {
    await mount(<Shell ownerKey={OWNER} signedIn />);
    await replayFromTrigger();
    expect(overlays()).toHaveLength(1);

    await update(<Shell ownerKey={OWNER} signedIn={false} />);
    expect(overlays()).toHaveLength(1);

    await press('walkthrough-skip');
    expect(overlays()).toHaveLength(0);
    expect(useWalkthroughStore.getState().visible).toBe(false);
  });
});
