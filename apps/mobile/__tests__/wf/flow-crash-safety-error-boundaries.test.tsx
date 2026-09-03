import React from 'react';
import { Linking } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { DrillDetail, SavedDrill } from '../../src/training/types';
import { useTrainingStore } from '../../src/training/store';
import { useConsistencyStore } from '../../src/consistency/store';
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

/**
 * Crash-safety audit — Result and Library failure branches driven through
 * their buttons with react-test-renderer.
 *
 * The Result route is reached from every "open this analysis" tap (Home,
 * Library, Analyze). It reads unvalidated SQLite JSON, so a corrupt row or a
 * failing database must land on the honest "Result missing" state with a
 * working exit — never a thrown render or a spinner that never ends.
 * Library's "Watch reviewed instruction" opens an external URL and must
 * surface failure copy when the OS refuses.
 */

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});

const mockNavigation = {
  navigate: jest.fn(),
  goBack: jest.fn(),
  popToTop: jest.fn(),
  replace: jest.fn(),
};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: { analysisId: 'missing-analysis' } }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactModule = require('react') as typeof import('react');
    ReactModule.useEffect(() => callback(), [callback]);
  },
}));

type DbMode = 'corrupt-record' | 'db-failure' | 'empty';
let mockDbMode: DbMode = 'empty';

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string) {
      if (mockDbMode === 'db-failure') {
        throw new Error('database is locked');
      }
      if (
        mockDbMode === 'corrupt-record' &&
        sql.includes('FROM local_analysis_record')
      ) {
        return { rows: [{ record: '{"id":"missing-analysis",' }] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

jest.mock('../../src/auth/authStore', () => ({
  useAuthStore: (
    selector: (state: { session: { localOnly: boolean } }) => unknown,
  ) => selector({ session: { localOnly: true } }),
}));

const mockShowBrandNotice = jest.fn();
jest.mock('../../src/design/BrandNotice', () => ({
  showBrandNotice: (notice: unknown) => mockShowBrandNotice(notice),
}));

import { ResultScreen } from '../../src/screens/ResultScreen';
import { LibraryScreen } from '../../src/screens/LibraryScreen';

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer.toJSON());
  return out.join(' ').replace(/\s+/g, ' ');
}

function pressByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
): void {
  const targets = renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  expect(targets.length).toBeGreaterThan(0);
  act(() => targets[0]!.props.onPress());
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.restoreAllMocks();
  mockNavigation.navigate.mockClear();
  mockNavigation.goBack.mockClear();
  mockNavigation.popToTop.mockClear();
  mockNavigation.replace.mockClear();
  mockDbMode = 'empty';
  mockShowBrandNotice.mockClear();
  setActiveDataOwner(GUEST_DATA_OWNER);
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
  useConsistencyStore.setState({
    hydrated: true,
    ownerKey: GUEST_DATA_OWNER,
    snapshot: null,
    celebration: null,
    daySecured: null,
    refresh: async () => {},
  });
});

describe('ResultScreen: unreadable evidence never crashes the route', () => {
  it.each<DbMode>(['empty', 'corrupt-record', 'db-failure'])(
    '%s → honest "Result missing" state with a working exit',
    async mode => {
      mockDbMode = mode;
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(<ResultScreen />);
      });
      await flush();

      const text = renderedText(renderer);
      expect(text).toContain('Result missing');
      expect(text).toContain('This analysis is no longer on this device.');
      // The loading caption must not survive a settled failure.
      expect(text).not.toContain('Opening your result…');

      const alerts = renderer.root.findAll(
        node => node.props.accessibilityRole === 'alert',
      );
      expect(alerts.length).toBeGreaterThan(0);

      // The only control on this state leaves the dead route.
      const buttons = renderer.root.findAll(
        node =>
          node.props.accessibilityRole === 'button' &&
          typeof node.props.onPress === 'function',
      );
      expect(buttons).toHaveLength(1);
      act(() => buttons[0]!.props.onPress());
      expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);

      act(() => renderer.unmount());
    },
  );

  it('shows the loading caption first and the Close control pops to top', async () => {
    mockDbMode = 'db-failure';
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<ResultScreen />);
    });
    expect(renderedText(renderer)).toContain('Opening your result…');
    pressByLabel(renderer, 'Close');
    expect(mockNavigation.popToTop).toHaveBeenCalledTimes(1);

    await flush();
    expect(renderedText(renderer)).toContain('Result missing');
    act(() => renderer.unmount());
  });
});

const savedDrill: SavedDrill = {
  id: 'a2e6f9d0-1111-4222-8333-444455556666',
  slug: 'dink-target-ladder',
  title: 'Dink Target Ladder',
  description: 'Land four consecutive cross-court dinks per kitchen zone.',
  coachName: 'Pickle Sensei Training Library',
  equipment: ['paddle', 'balls'],
  difficultyMin: null,
  difficultyMax: null,
  savedAt: '2026-08-30T10:00:00.000Z',
};

const savedDetail: DrillDetail = {
  id: savedDrill.id,
  slug: savedDrill.slug,
  title: savedDrill.title,
  description: savedDrill.description,
  coachName: savedDrill.coachName,
  equipment: ['paddle'],
  difficultyMin: null,
  difficultyMax: null,
  saved: true,
  mappings: [],
  instructionalMedia: [
    {
      kind: 'embed',
      id: 'media-1',
      provider: 'youtube',
      videoId: 'abc123',
      embedUrl: 'https://www.youtube.com/embed/abc123',
      sourceUrl: 'https://www.youtube.com/watch?v=abc123',
      creatorName: 'Coach',
      licenseName: 'YouTube Standard License',
      licenseUrl: null,
      attribution: 'Coach on YouTube',
    },
  ],
};

async function renderLibrarySavedTab(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<LibraryScreen />);
  });
  const tabs = renderer.root.findAll(
    node =>
      node.props.accessibilityRole === 'tab' &&
      typeof node.props.onPress === 'function',
  );
  const saved = tabs.find(
    node =>
      node.findAll(child => child.props.children === 'Saved drills').length > 0,
  );
  expect(saved).toBeDefined();
  act(() => saved!.props.onPress());
  return renderer;
}

describe('LibraryScreen: external video failure branches surface copy', () => {
  beforeEach(() => {
    useTrainingStore.setState({
      savedDrills: [savedDrill],
      drillDetails: { [savedDrill.slug]: savedDetail },
    });
  });

  it('OS refuses the URL (canOpenURL=false) → "Video unavailable" alert, no throw', async () => {
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(false);
    const openUrl = jest.spyOn(Linking, 'openURL').mockResolvedValue();
    const renderer = await renderLibrarySavedTab();
    pressByLabel(
      renderer,
      `Watch reviewed instruction for ${savedDrill.title}`,
    );
    await flush();

    expect(openUrl).not.toHaveBeenCalled();
    expect(mockShowBrandNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Video unavailable',
        detail:
          'This reviewed video could not be opened. Refresh the library and try again.',
      }),
    );
    act(() => renderer.unmount());
  });

  it('openURL rejects → same failure copy, screen stays mounted', async () => {
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
    jest
      .spyOn(Linking, 'openURL')
      .mockRejectedValue(new Error('No handler for URL'));
    const renderer = await renderLibrarySavedTab();
    pressByLabel(
      renderer,
      `Watch reviewed instruction for ${savedDrill.title}`,
    );
    await flush();

    expect(mockShowBrandNotice).toHaveBeenCalledTimes(1);
    expect(mockShowBrandNotice.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ title: 'Video unavailable' }),
    );
    expect(renderedText(renderer)).toContain(savedDrill.title);
    act(() => renderer.unmount());
  });

  it('a successful open uses the canonical watch page, never the raw embed URL', async () => {
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
    const openUrl = jest.spyOn(Linking, 'openURL').mockResolvedValue();
    const renderer = await renderLibrarySavedTab();
    pressByLabel(
      renderer,
      `Watch reviewed instruction for ${savedDrill.title}`,
    );
    await flush();

    expect(openUrl).toHaveBeenCalledWith(
      'https://www.youtube.com/watch?v=abc123',
    );
    expect(mockShowBrandNotice).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});
