import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { LocalShotRow, PendingCapture } from '../../src/data/repository';
import { useTrainingStore } from '../../src/training/store';

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});

const mockNavigate = jest.fn();
/** The latest focus callback, so a test can re-focus the screen on demand. */
const mockFocus: { current: (() => void | (() => void)) | null } = {
  current: null,
};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn() }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactModule = require('react') as typeof import('react');
    ReactModule.useEffect(() => {
      mockFocus.current = callback;
      return callback();
    }, [callback]);
  },
}));

const mockGetDb = jest.fn(() => ({}));
jest.mock('../../src/data/db', () => ({
  getDb: () => mockGetDb(),
}));

const mockListShots = jest.fn<Promise<LocalShotRow[]>, [unknown, number]>();
const mockListPendingCaptures = jest.fn<
  Promise<PendingCapture[]>,
  [unknown, number]
>();
jest.mock('../../src/data/repository', () => ({
  listShots: (...args: [unknown, number]) => mockListShots(...args),
  listPendingCaptures: (...args: [unknown, number]) =>
    mockListPendingCaptures(...args),
}));

jest.mock('../../src/auth/authStore', () => ({
  useAuthStore: (
    selector: (state: { session: { localOnly: boolean } }) => unknown,
  ) => selector({ session: { localOnly: false } }),
}));

import { LibraryScreen } from '../../src/screens/LibraryScreen';

/**
 * Library Reads tab honesty (MHPL-4). The tab reads two local tables on every
 * focus. A rejected read is a FAILURE the player must be told about — with a
 * retry, exactly like Home ("Your court couldn’t load") and Progress — never
 * painted as a first-run empty library ("Your measured reads, in one place."
 * + "Analyze your first stroke"), which tells a player with scored reads
 * that they have none. Rows that DID load stay on screen; a refresh that
 * fails keeps the previously rendered known-good rows.
 */

const EMPTY_TITLE = 'Your measured reads, in one place.';
const EMPTY_CTA = 'Analyze your first stroke';
const SPINNER = 'Opening your library…';

const readOne: LocalShotRow = {
  id: '11111111-1111-4111-8111-111111111111',
  sessionId: null,
  shotType: 'forehand_drive',
  capturedAt: '2026-08-30T15:04:00.000Z',
  overallScore: 7.25,
  confidence: 0.91,
  resultKind: 'scored',
  source: 'real',
  favorite: false,
};

const readTwo: LocalShotRow = {
  ...readOne,
  id: '22222222-2222-4222-8222-222222222222',
  shotType: 'dink',
  capturedAt: '2026-08-29T09:30:00.000Z',
  overallScore: 6.4,
};

const pendingClip: PendingCapture = {
  id: 'cap-1',
  shotType: 'unrecognized',
  declaredStroke: 'serve',
  uri: 'file:///captures/cap-1.mov',
  capturedAtIso: '2026-08-27T18:00:00.000Z',
  durationMs: 4200,
  fps: 59.94,
  width: 720,
  height: 1280,
  clip: null,
  evidenceStatus: 'valid',
};

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string | number => typeof c !== 'object')
    .join(' ')
    .replace(/\s+/g, ' ');
}

function alerts(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    n => typeof n.type === 'string' && n.props.accessibilityRole === 'alert',
  );
}

function findByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  return node ?? null;
}

// One host View per rendered read row (the composite PressableScale and its
// inner Pressable both carry the label, so composites would double count).
function readRows(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    n =>
      typeof n.type === 'string' &&
      String(n.props.accessibilityLabel ?? '').startsWith('Open ') &&
      String(n.props.accessibilityLabel ?? '').endsWith(' result'),
  );
}

async function settle() {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
}

async function renderLibrary(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<LibraryScreen />);
  });
  await settle();
  return renderer;
}

async function refocus() {
  expect(mockFocus.current).not.toBeNull();
  await act(async () => {
    mockFocus.current!();
  });
  await settle();
}

async function pressRetry(renderer: TestRenderer.ReactTestRenderer) {
  const retry = findByLabel(renderer, 'Try again');
  expect(retry).not.toBeNull();
  await act(async () => {
    retry!.props.onPress();
  });
  await settle();
}

function expectErrorWithRetry(renderer: TestRenderer.ReactTestRenderer) {
  expect(alerts(renderer).length).toBeGreaterThan(0);
  expect(findByLabel(renderer, 'Try again')).not.toBeNull();
  const text = allText(renderer);
  expect(text).not.toContain(SPINNER);
  expect(text).not.toContain(EMPTY_TITLE);
  expect(findByLabel(renderer, EMPTY_CTA)).toBeNull();
}

beforeEach(() => {
  mockNavigate.mockClear();
  mockFocus.current = null;
  mockGetDb.mockReset();
  mockGetDb.mockReturnValue({});
  mockListShots.mockReset();
  mockListPendingCaptures.mockReset();
  mockListShots.mockResolvedValue([readOne, readTwo]);
  mockListPendingCaptures.mockResolvedValue([pendingClip]);
  act(() => {
    useTrainingStore.setState({
      savedStatus: 'ready',
      planStatus: 'ready',
      mutation: 'idle',
      savedDrills: [],
      drillDetails: {},
      currentPlan: null,
      savedError: null,
      planError: null,
      mutationError: null,
      loadSavedDrills: async () => true,
      loadCurrentPlan: async () => true,
    });
  });
});

describe('Library reads honesty · failed local reads', () => {
  it('a failed local read is disclosed as an error, not painted as a first-run empty library', async () => {
    mockListShots.mockRejectedValue(new Error('sqlite closed'));
    mockListPendingCaptures.mockRejectedValue(new Error('sqlite closed'));
    const renderer = await renderLibrary();

    expectErrorWithRetry(renderer);
    expect(allText(renderer)).toContain('couldn’t load');
    expect(readRows(renderer)).toHaveLength(0);

    act(() => renderer.unmount());
  });

  it('a failed local read recovers through its retry and renders the real rows', async () => {
    mockListShots.mockRejectedValueOnce(new Error('sqlite closed'));
    mockListPendingCaptures.mockRejectedValueOnce(new Error('sqlite closed'));
    const renderer = await renderLibrary();
    expectErrorWithRetry(renderer);

    await pressRetry(renderer);

    expect(alerts(renderer)).toHaveLength(0);
    expect(findByLabel(renderer, 'Try again')).toBeNull();
    expect(readRows(renderer)).toHaveLength(2);
    expect(allText(renderer)).toContain('2 analyzed reads · 1 pending clip');
    expect(mockListShots).toHaveBeenCalledTimes(2);
    expect(mockListPendingCaptures).toHaveBeenCalledTimes(2);

    act(() => renderer.unmount());
  });

  it('a partial failure keeps the reads that did load and discloses the part that failed', async () => {
    mockListPendingCaptures.mockRejectedValue(new Error('sqlite closed'));
    const renderer = await renderLibrary();

    // The two reads that loaded are on screen, never behind first-run copy.
    expect(readRows(renderer)).toHaveLength(2);
    expect(findByLabel(renderer, 'Open forehand drive result')).not.toBeNull();
    expect(findByLabel(renderer, 'Open dink result')).not.toBeNull();
    expectErrorWithRetry(renderer);
    const text = allText(renderer);
    expect(text).toContain('2 analyzed reads');
    // No fabricated count for the table that failed.
    expect(text).not.toContain('0 pending clips');

    act(() => renderer.unmount());
  });

  it('a refresh failure on a second focus keeps the previously rendered rows and shows an error with a retry', async () => {
    const renderer = await renderLibrary();
    expect(readRows(renderer)).toHaveLength(2);
    expect(alerts(renderer)).toHaveLength(0);

    mockListShots.mockRejectedValue(new Error('sqlite closed'));
    mockListPendingCaptures.mockRejectedValue(new Error('sqlite closed'));
    await refocus();

    // Known-good rows from a moment ago are never replaced by an empty state.
    expect(readRows(renderer)).toHaveLength(2);
    expect(findByLabel(renderer, 'Open forehand drive result')).not.toBeNull();
    expect(findByLabel(renderer, 'Open dink result')).not.toBeNull();
    expect(allText(renderer)).toContain('Serve · auto capture');
    expectErrorWithRetry(renderer);

    // Retry that succeeds clears the disclosure and shows the fresh rows.
    mockListShots.mockResolvedValue([readOne]);
    mockListPendingCaptures.mockResolvedValue([]);
    await pressRetry(renderer);
    expect(alerts(renderer)).toHaveLength(0);
    expect(readRows(renderer)).toHaveLength(1);
    expect(allText(renderer)).toContain('1 analyzed read · 0 pending clips');

    act(() => renderer.unmount());
  });

  it('a genuinely empty library still shows the first-run copy — the error path never hides it', async () => {
    mockListShots.mockResolvedValue([]);
    mockListPendingCaptures.mockResolvedValue([]);
    const renderer = await renderLibrary();

    expect(alerts(renderer)).toHaveLength(0);
    expect(allText(renderer)).toContain(EMPTY_TITLE);
    expect(findByLabel(renderer, EMPTY_CTA)).not.toBeNull();

    act(() => renderer.unmount());
  });
});
