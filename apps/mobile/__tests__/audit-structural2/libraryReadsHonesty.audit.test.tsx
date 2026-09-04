/**
 * Structural audit #2 (pass 1) — Library "Reads" tab honesty.
 *
 * Home and Progress both refuse to substitute empty values when the local
 * database cannot be read ("No empty values were substituted." + Try
 * again). LibraryScreen's focus load instead does `.catch(() => {
 * setShots([]); setCaptures([]); })`, so a SQLite failure paints the
 * first-run empty state ("Your measured reads, in one place." / "Analyze
 * your first stroke") over a library that may hold dozens of reads, with
 * no error copy and no retry control. The second case checks the row
 * renderer against a corrupt `capturedAt` — Home/Progress guard the day
 * key, the Library row calls `new Date(item.capturedAt)` unguarded.
 */
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
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn() }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactModule = require('react') as typeof import('react');
    ReactModule.useEffect(() => callback(), [callback]);
  },
}));

jest.mock('../../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));

jest.mock('../../src/design/BrandNotice', () => ({
  showBrandNotice: jest.fn(),
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
    selector: (state: { session: { localOnly: boolean } | null }) => unknown,
  ) => selector({ session: { localOnly: false } }),
}));

import { LibraryScreen } from '../../src/screens/LibraryScreen';

const readRow: LocalShotRow = {
  id: 'shot-0001',
  sessionId: null,
  shotType: 'third_shot_drop',
  capturedAt: '2026-08-30T14:05:00.000Z',
  overallScore: 7.4,
  confidence: 0.91,
  resultKind: 'scored',
  source: 'camera',
  favorite: false,
};

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(Infinity)
    .filter((c): c is string | number => typeof c !== 'object')
    .join(' ')
    .replace(/\s+/g, ' ');
}

async function renderLibrary() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<LibraryScreen />);
  });
  return renderer;
}

describe('audit: Library Reads tab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListShots.mockResolvedValue([]);
    mockListPendingCaptures.mockResolvedValue([]);
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
      loadSavedDrills: jest.fn(async () => true),
      loadCurrentPlan: jest.fn(async () => true),
      setDrillSaved: jest.fn(async () => true),
      clearMutationError: jest.fn(),
    });
  });

  it('a failed local read is disclosed as an error (like Home/Progress), not painted as a first-run empty library', async () => {
    mockListShots.mockRejectedValue(new Error('sqlite closed'));
    const renderer = await renderLibrary();
    const text = allText(renderer);
    expect(text).not.toContain('Opening your library…');
    // The first-run empty state invites the user to "Analyze your first
    // stroke" — it must not be the surface shown when reads exist but
    // could not be opened.
    expect(text).not.toContain('Your measured reads, in one place.');
    expect(text).not.toContain('Analyze your first stroke');
    // Some honest error disclosure + a retry control must exist instead.
    expect(text).toMatch(/couldn.t (be )?(load|open)|could not be opened/i);
    const retry = renderer.root.findAll(
      n =>
        n.props.accessibilityLabel === 'Try again' &&
        typeof n.props.onPress === 'function',
    );
    expect(retry.length).toBeGreaterThan(0);
    act(() => renderer.unmount());
  });

  it('a read row with a corrupt capturedAt renders no "NaN"/"Invalid Date" text', async () => {
    mockListShots.mockResolvedValue([
      readRow,
      { ...readRow, id: 'shot-corrupt', capturedAt: 'not-a-date' },
    ]);
    const renderer = await renderLibrary();
    const text = allText(renderer);
    expect(text).toContain('2 analyzed reads');
    expect(text).not.toMatch(/NaN/);
    expect(text).not.toMatch(/Invalid Date/i);
    act(() => renderer.unmount());
  });
});
