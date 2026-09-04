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

const mockGetDb = jest.fn<unknown, []>(() => ({}));
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
 * Adversarial scenarios against the Library Reads tab's local reads. Every
 * scenario drives the screen through the same hooks production uses (focus
 * → listShots + listPendingCaptures) and asserts what a player would SEE:
 * a failure is disclosed with a retry, loaded rows are never hidden, and a
 * stale answer can never overwrite a newer one.
 */

const EMPTY_TITLE = 'Your measured reads, in one place.';
const EMPTY_CTA = 'Analyze your first stroke';
const SPINNER = 'Opening your library…';

const rowA: LocalShotRow = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sessionId: null,
  shotType: 'forehand_drive',
  capturedAt: '2026-08-30T15:04:00.000Z',
  overallScore: 7.25,
  confidence: 0.91,
  resultKind: 'scored',
  source: 'real',
  favorite: false,
};
const rowB: LocalShotRow = {
  ...rowA,
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  shotType: 'dink',
  capturedAt: '2026-08-29T09:30:00.000Z',
  overallScore: 6.4,
};
const rowC: LocalShotRow = {
  ...rowA,
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  shotType: 'serve',
  capturedAt: '2026-08-31T09:30:00.000Z',
  overallScore: 8.1,
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
};
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
function readRowLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(
      n =>
        typeof n.type === 'string' &&
        String(n.props.accessibilityLabel ?? '').startsWith('Open ') &&
        String(n.props.accessibilityLabel ?? '').endsWith(' result'),
    )
    .map(n => String(n.props.accessibilityLabel))
    .sort();
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

function expectDisclosedFailure(renderer: TestRenderer.ReactTestRenderer) {
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
  mockListShots.mockResolvedValue([rowA, rowB]);
  mockListPendingCaptures.mockResolvedValue([]);
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

describe('Library reads · attack scenarios', () => {
  it('S1: both local reads reject on first focus → an error with a retry, never the first-run empty copy', async () => {
    mockListShots.mockRejectedValue(new Error('database is locked'));
    mockListPendingCaptures.mockRejectedValue(new Error('database is locked'));
    const renderer = await renderLibrary();

    expectDisclosedFailure(renderer);
    expect(readRowLabels(renderer)).toEqual([]);

    act(() => renderer.unmount());
  });

  it('S2: getDb() throwing synchronously is disclosed the same way, and the screen stays mounted', async () => {
    mockGetDb.mockImplementation(() => {
      throw new Error('migration failed');
    });
    const renderer = await renderLibrary();

    expectDisclosedFailure(renderer);
    expect(mockListShots).not.toHaveBeenCalled();

    // Recovery: the database comes back, the retry loads the real rows.
    mockGetDb.mockImplementation(() => ({}));
    await act(async () => {
      findByLabel(renderer, 'Try again')!.props.onPress();
    });
    await settle();
    expect(alerts(renderer)).toHaveLength(0);
    expect(readRowLabels(renderer)).toEqual([
      'Open dink result',
      'Open forehand drive result',
    ]);

    act(() => renderer.unmount());
  });

  it('S3: a rejection carrying a non-Error value is still disclosed as a failure', async () => {
    mockListShots.mockRejectedValue('SQLITE_IOERR');
    mockListPendingCaptures.mockRejectedValue(undefined);
    const renderer = await renderLibrary();

    expectDisclosedFailure(renderer);

    act(() => renderer.unmount());
  });

  it('S4: listShots resolves with two rows while listPendingCaptures rejects → the two reads that DID load are not hidden behind a first-run empty state', async () => {
    mockListPendingCaptures.mockRejectedValue(new Error('table missing'));
    const renderer = await renderLibrary();

    expect(readRowLabels(renderer)).toEqual([
      'Open dink result',
      'Open forehand drive result',
    ]);
    expectDisclosedFailure(renderer);
    expect(allText(renderer)).toContain('2 analyzed reads');
    expect(allText(renderer)).not.toContain('0 pending clips');

    // The rows are still real controls that open their Result.
    await act(async () => {
      findByLabel(renderer, 'Open dink result')!.props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith('Result', {
      analysisId: rowB.id,
    });

    act(() => renderer.unmount());
  });

  it('S5: a second focus whose reads reject keeps the rows rendered a moment earlier and adds an error/retry — no empty copy', async () => {
    const renderer = await renderLibrary();
    expect(readRowLabels(renderer)).toEqual([
      'Open dink result',
      'Open forehand drive result',
    ]);

    mockListShots.mockRejectedValue(new Error('database is locked'));
    mockListPendingCaptures.mockRejectedValue(new Error('database is locked'));
    await refocus();

    expect(readRowLabels(renderer)).toEqual([
      'Open dink result',
      'Open forehand drive result',
    ]);
    expectDisclosedFailure(renderer);
    // The count line still describes the rows on screen, not a fake zero.
    expect(allText(renderer)).toContain('2 analyzed reads');

    act(() => renderer.unmount());
  });

  it('S6: a slow first read that answers AFTER a later focus already rendered fresh rows cannot overwrite them', async () => {
    const slow = deferred<LocalShotRow[]>();
    mockListShots.mockReturnValueOnce(slow.promise);
    const renderer = await renderLibrary();
    expect(allText(renderer)).toContain(SPINNER);

    // Second focus answers immediately with the newer truth.
    mockListShots.mockResolvedValue([rowC]);
    await refocus();
    expect(readRowLabels(renderer)).toEqual(['Open serve result']);

    // The stale first answer lands last — it must be ignored.
    await act(async () => {
      slow.resolve([rowA, rowB]);
    });
    await settle();
    expect(readRowLabels(renderer)).toEqual(['Open serve result']);
    expect(alerts(renderer)).toHaveLength(0);

    act(() => renderer.unmount());
  });

  it('S7: a stale rejection landing after a newer successful read does not paint an error over good rows', async () => {
    const slow = deferred<LocalShotRow[]>();
    mockListShots.mockReturnValueOnce(slow.promise);
    const renderer = await renderLibrary();

    mockListShots.mockResolvedValue([rowC]);
    await refocus();
    expect(readRowLabels(renderer)).toEqual(['Open serve result']);

    await act(async () => {
      slow.reject(new Error('database is locked'));
    });
    await settle();
    expect(readRowLabels(renderer)).toEqual(['Open serve result']);
    expect(alerts(renderer)).toHaveLength(0);
    expect(findByLabel(renderer, 'Try again')).toBeNull();

    act(() => renderer.unmount());
  });
});
