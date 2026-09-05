import React from 'react';
import { RefreshControl } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  NavigationContainer,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

/**
 * Deterministic replay of the minimized failing sequence found by the seeded
 * randomized campaign (drillLibraryScreen.randomizedSeeded.stress.test.tsx,
 * seed 95 → `mount, settle list, refresh, save(drill), quiesce`; seed 14 is
 * the same race behind a debounced search reload).
 *
 * Race: a catalog GET is in flight (pull-to-refresh or a search/family
 * reload) when the user taps the bookmark. The PUT succeeds and the toast
 * confirms "Saved to your library", but the catalog response — computed by
 * the server BEFORE the PUT — lands afterwards and `setDrills(items)`
 * overwrites the optimistic `saved: true` with the stale `saved: false`.
 * At quiescence the server has the drill saved while the card shows it
 * unsaved. `requestIdRef` only protects list-vs-list ordering, not
 * list-vs-mutation.
 *
 * This suite is EXPECTED TO FAIL on the current screen; it pins the finding.
 */

jest.mock('react-native-safe-area-context', () => {
  const ReactActual = require('react');
  const { View: RNView } = require('react-native');
  const passthrough = (props: { children?: React.ReactNode }) =>
    ReactActual.createElement(RNView, null, props.children);
  return {
    SafeAreaProvider: passthrough,
    SafeAreaView: passthrough,
    SafeAreaInsetsContext: ReactActual.createContext({
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
    }),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 }),
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    },
  };
});

jest.mock('react-native-webview', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockWebView = (props: Record<string, unknown>) =>
    ReactModule.createElement(View, props);
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => ({
    executeSync: () => ({ rows: [] }),
    execute: () => Promise.resolve({ rows: [] }),
    close: () => {},
  }),
}));

import { DrillLibraryScreen } from '../../src/screens/DrillLibraryScreen';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';

const SESSION = {
  apiBaseUrl: 'https://api.stress.test',
  bearerToken: 'stress-bearer-1',
  canonicalAppUserId: '11111111-1111-4111-a111-111111111111',
  provider: 'apple' as const,
};

const DRILL = {
  id: '22222222-2222-4222-a222-222222222222',
  slug: 'drill-9',
  title: 'Third shot drop ladder',
  description: 'Drop reps at the kitchen · 9',
  coach_name: 'Coach Reset',
  equipment: ['paddle'],
  difficulty_min: null,
  difficulty_max: null,
  families: ['drop_reset'],
  validation_state: 'UNVALIDATED',
};

interface Pending {
  kind: 'list' | 'save';
  resolve: (r: Response) => void;
}

/** Server whose list responses are computed at REQUEST time and delivered on demand. */
class Server {
  saved = new Set<string>();
  pending: Pending[] = [];
  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
  fetch = (input: string, init?: { method?: string }): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.pathname === '/v1/catalog/drills') {
      const body = { items: [{ ...DRILL, saved: this.saved.has(DRILL.slug) }] };
      return new Promise<Response>(resolve => {
        this.pending.push({
          kind: 'list',
          resolve: () => resolve(this.json(200, body)),
        });
      });
    }
    if (method === 'PUT' && url.pathname === '/v1/me/saved-drills/drill-9') {
      this.saved.add(DRILL.slug);
      return new Promise<Response>(resolve => {
        this.pending.push({
          kind: 'save',
          resolve: () =>
            resolve(this.json(200, { slug: DRILL.slug, saved: true })),
        });
      });
    }
    throw new Error(`unexpected ${method} ${url.pathname}`);
  };
  async deliverAll() {
    const batch = this.pending.splice(0);
    for (const p of batch) {
      await act(async () => {
        p.resolve(new Response());
      });
    }
  }
}

const navigationRef = createNavigationContainerRef<Record<string, undefined>>();
const Stack = createNativeStackNavigator<Record<string, undefined>>();

function Harness() {
  return (
    <NavigationContainer ref={navigationRef}>
      <Stack.Navigator initialRouteName="DrillLibrary">
        <Stack.Screen name="DrillLibrary" component={DrillLibraryScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

function isPressable(n: TestRenderer.ReactTestInstance): boolean {
  if (typeof n.type === 'string') return false;
  const type = n.type as { displayName?: string; name?: string };
  return (type.displayName ?? type.name) === 'Pressable';
}

describe('DrillLibraryScreen — stale catalog response overwrites an optimistic save', () => {
  const server = new Server();
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
    global.fetch = ((input: string | URL | Request, init?: RequestInit) =>
      server.fetch(String(input), init as { method?: string })) as typeof fetch;
    establishApiSession(SESSION);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    clearApiSession();
    jest.useRealTimers();
  });

  test('bookmark tapped while a refresh is in flight stays saved once both responses land', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Harness />);
    });
    await server.deliverAll(); // initial catalog (saved=false)
    await act(async () => {
      jest.runOnlyPendingTimers();
    });

    const control = renderer.root.findAllByType(RefreshControl)[0]!;
    await act(async () => {
      control.props.onRefresh();
    });
    // The refresh GET is now in flight (server computed saved=false).
    expect(server.pending.map(p => p.kind)).toEqual(['list']);

    const [toggle] = renderer.root.findAll(
      n => n.props.testID === `save-toggle-${DRILL.slug}` && isPressable(n),
    );
    await act(async () => {
      toggle!.props.onPress();
    });
    expect(server.pending.map(p => p.kind)).toEqual(['list', 'save']);
    expect(server.saved.has(DRILL.slug)).toBe(true);

    await server.deliverAll();
    await act(async () => {
      jest.runOnlyPendingTimers();
    });

    const [after] = renderer.root.findAll(
      n => n.props.testID === `save-toggle-${DRILL.slug}` && isPressable(n),
    );
    const rendered = after!.props.accessibilityState?.selected === true;
    const serverSaved = server.saved.has(DRILL.slug);

    await act(async () => {
      jest.runOnlyPendingTimers();
      renderer.unmount();
    });

    expect({ rendered, serverSaved }).toEqual({
      rendered: true,
      serverSaved: true,
    });
  });
});
