import React from 'react';
import { Alert, Linking, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { LocalShotRow, PendingCapture } from '../../src/data/repository';
import type {
  DrillDetail,
  InstructionalMedia,
  SavedDrill,
  TrainingPlan,
} from '../../src/training/types';
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
const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactModule = require('react') as typeof import('react');
    ReactModule.useEffect(() => callback(), [callback]);
  },
}));

jest.mock('../../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));

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

const authState: { session: { localOnly: boolean } | null } = {
  session: { localOnly: false },
};
jest.mock('../../src/auth/authStore', () => ({
  useAuthStore: (
    selector: (state: { session: { localOnly: boolean } | null }) => unknown,
  ) => selector(authState),
}));

import {
  LibraryScreen,
  PENDING_SECTION_LABEL,
  PENDING_SECTION_PILL,
} from '../../src/screens/LibraryScreen';

/**
 * Drives the Library tab as a user would: Reads list (loading → rows →
 * Result), pending clips, the empty state's Analyze CTA, the Saved tab's
 * loading / unconfigured / offline / empty / held / verified branches with
 * every retry and navigation control pressed, un-save, and the external
 * video hand-off (always the canonical sourceUrl, never /embed/; failure
 * shows an alert instead of dying silently). Also pins the AGENTS.md saved
 * drills invariant: visibility follows loaded catalog detail, mappings only
 * label the card.
 */

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

const unreadRow: LocalShotRow = {
  ...readRow,
  id: 'shot-0002',
  shotType: 'dink',
  capturedAt: '2026-08-29T09:00:00.000Z',
  overallScore: null,
  resultKind: 'low_confidence',
};

function pendingCapture(overrides: Partial<PendingCapture>): PendingCapture {
  return {
    id: 'cap-1',
    shotType: 'unrecognized',
    declaredStroke: null,
    uri: 'file:///clips/cap-1.mov',
    capturedAtIso: '2026-08-28T10:00:00.000Z',
    durationMs: 4200,
    fps: 60,
    width: 720,
    height: 1280,
    clip: null,
    evidenceStatus: 'valid',
    ...overrides,
  };
}

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

const youtubeMedia: InstructionalMedia = {
  id: '6c8f2a4e-9b31-4f0d-8a57-2e9d4b7c1f03',
  kind: 'embed',
  provider: 'youtube',
  videoId: 'dnk101xyz',
  embedUrl: 'https://www.youtube-nocookie.com/embed/dnk101xyz',
  sourceUrl: 'https://www.youtube.com/watch?v=dnk101xyz',
  creatorName: 'Third Shot Sports',
  licenseName: 'YouTube Terms of Service',
  licenseUrl: 'https://www.youtube.com/t/terms',
  attribution: 'Video by Third Shot Sports on YouTube',
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
  instructionalMedia: [youtubeMedia],
};

const currentPlan: TrainingPlan = {
  id: 'plan-1',
  status: 'active',
  algorithmVersion: 'v1',
  sourceShotId: 'shot-0001',
  shotType: 'third_shot_drop',
  priorityCheckpoint: 'contact_height',
  priorityDirection: 'too_high',
  baselineScore: 6.2,
  baselineCheckpointScore: 48,
  reassessmentShotId: null,
  scoreDelta: null,
  createdAt: '2026-08-30T15:00:00.000Z',
  completedAt: null,
  items: [
    {
      id: 'item-1',
      position: 1,
      kind: 'targeted',
      drill: {
        slug: savedDrill.slug,
        title: savedDrill.title,
        description: savedDrill.description,
        coachName: savedDrill.coachName,
        equipment: savedDrill.equipment,
        saved: true,
      },
      cueText: 'Contact the ball below your waist.',
      targetSets: 3,
      targetRepetitionsPerSet: 10,
      targetDurationSeconds: null,
      restSeconds: 30,
      completion: null,
    },
  ],
};

const loadSavedDrills = jest.fn(async () => true);
const loadCurrentPlan = jest.fn(async () => true);
const setDrillSaved = jest.fn(async () => true);
const clearMutationError = jest.fn();

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(Infinity)
    .filter((c): c is string | number => typeof c !== 'object')
    .join(' ')
    .replace(/\s+/g, ' ');
}

function pressables(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(n => typeof n.props.onPress === 'function');
}

/**
 * Returns the innermost pressable carrying `label`: the element that both
 * owns the onPress handler and the resolved accessibility props (role,
 * state, disabled) as a screen reader would see them.
 */
function findByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function' &&
      n.props.accessibilityRole !== undefined,
  );
}

function oneByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
): TestRenderer.ReactTestInstance {
  const [node] = findByLabel(renderer, label);
  if (!node) throw new Error(`No pressable labeled ${label}`);
  return node;
}

function firstNode(
  renderer: TestRenderer.ReactTestRenderer,
  predicate: (node: TestRenderer.ReactTestInstance) => boolean,
): TestRenderer.ReactTestInstance {
  const [node] = renderer.root.findAll(predicate);
  if (!node) throw new Error('No node matched');
  return node;
}

async function pressByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const node = oneByLabel(renderer, label);
  await act(async () => {
    node.props.onPress();
  });
  return node;
}

async function renderLibrary() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<LibraryScreen />);
  });
  return renderer;
}

function findTab(renderer: TestRenderer.ReactTestRenderer, title: string) {
  const tabs = renderer.root.findAll(
    node =>
      node.props.accessibilityRole === 'tab' &&
      typeof node.props.onPress === 'function',
  );
  expect(tabs).toHaveLength(2);
  const tab = tabs.find(
    node => node.findAll(child => child.props.children === title).length > 0,
  );
  if (!tab) throw new Error(`No tab titled ${title}`);
  return tab;
}

async function openSavedTab(renderer: TestRenderer.ReactTestRenderer) {
  const saved = findTab(renderer, 'Saved drills');
  expect(saved.props.accessibilityState).toEqual({ selected: false });
  await act(async () => saved.props.onPress());
  expect(findTab(renderer, 'Saved drills').props.accessibilityState).toEqual({
    selected: true,
  });
}

describe('Library flow · Reads tab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authState.session = { localOnly: false };
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
      loadSavedDrills,
      loadCurrentPlan,
      setDrillSaved,
      clearMutationError,
    });
  });

  it('shows a loading state until local reads resolve, then refreshes training on focus', async () => {
    let resolveShots!: (rows: LocalShotRow[]) => void;
    mockListShots.mockReturnValue(
      new Promise<LocalShotRow[]>(resolve => {
        resolveShots = resolve;
      }),
    );
    const renderer = await renderLibrary();
    expect(allText(renderer)).toContain('Opening your library…');
    expect(loadSavedDrills).toHaveBeenCalledTimes(1);
    expect(loadCurrentPlan).toHaveBeenCalledTimes(1);

    await act(async () => resolveShots([readRow]));
    expect(allText(renderer)).not.toContain('Opening your library…');
    expect(allText(renderer)).toContain('1 analyzed read · 0 pending clips');
    act(() => renderer.unmount());
  });

  it('a failing local read never strands the spinner: it falls to the empty state', async () => {
    mockListShots.mockRejectedValue(new Error('sqlite closed'));
    const renderer = await renderLibrary();
    expect(allText(renderer)).not.toContain('Opening your library…');
    expect(allText(renderer)).toContain('Your measured reads, in one place.');
    act(() => renderer.unmount());
  });

  it('the empty state routes into Analyze with a labeled primary action', async () => {
    const renderer = await renderLibrary();
    const text = allText(renderer);
    expect(text).toContain('Your measured reads, in one place.');
    expect(text).toContain('Unscored captures stay clearly marked.');
    const cta = oneByLabel(renderer, 'Analyze your first stroke');
    expect(cta.props.accessibilityRole).toBe('button');
    expect(cta.props.accessibilityState.disabled).toBeFalsy();
    await pressByLabel(renderer, 'Analyze your first stroke');
    expect(mockNavigate).toHaveBeenCalledWith('Analyze');
    act(() => renderer.unmount());
  });

  it('each read row opens its own Result with the row id, labeling the stroke', async () => {
    mockListShots.mockResolvedValue([readRow, unreadRow]);
    const renderer = await renderLibrary();
    const text = allText(renderer);
    expect(text).toContain('2 analyzed reads · 0 pending clips');
    expect(text).toContain('third shot drop');
    expect(text).toContain('7.4');
    expect(text).toContain('NOT READ');
    // The empty state never coexists with rows.
    expect(text).not.toContain('Your measured reads, in one place.');

    const dropRow = oneByLabel(renderer, 'Open third shot drop result');
    expect(dropRow.props.accessibilityRole).toBe('button');
    await pressByLabel(renderer, 'Open third shot drop result');
    expect(mockNavigate).toHaveBeenLastCalledWith('Result', {
      analysisId: 'shot-0001',
    });
    await pressByLabel(renderer, 'Open dink result');
    expect(mockNavigate).toHaveBeenLastCalledWith('Result', {
      analysisId: 'shot-0002',
    });
    act(() => renderer.unmount());
  });

  it('pending clips render with honest per-evidence copy and no fake score', async () => {
    mockListPendingCaptures.mockResolvedValue([
      pendingCapture({ id: 'cap-1', declaredStroke: 'dink' }),
      pendingCapture({
        id: 'cap-2',
        shotType: 'serve',
        evidenceStatus: 'legacy',
      }),
      pendingCapture({ id: 'cap-3', evidenceStatus: 'corrupt' }),
    ]);
    const renderer = await renderLibrary();
    const text = allText(renderer);
    expect(text).toContain('0 analyzed reads · 3 pending clips');
    expect(text).toContain(PENDING_SECTION_LABEL);
    expect(text).toContain(PENDING_SECTION_PILL);
    expect(text).toContain('Dink · auto capture');
    expect(text).toContain('Clip saved — analysis has not run yet');
    expect(text).toContain('Serve · auto capture');
    expect(text).toContain(
      'Recorded by an older app version — can’t be scored',
    );
    expect(text).toContain('Auto capture');
    expect(text).toContain(
      'Saved evidence could not be verified — can’t be scored',
    );
    expect(text).toContain('4 s clip');
    // Pending clips never claim they can be analyzed from here; the note
    // states the real next step and the Analyze CTA stays reachable so the
    // tab is never a dead end. No Result row exists for an unscored clip.
    expect(text).not.toContain('READY TO ANALYZE');
    expect(text).toContain(
      'Saved clips aren’t scored from the library. Record a new stroke to get a score.',
    );
    expect(text).toContain('Your measured reads, in one place.');
    expect(text).toContain('Analyze your first stroke');
    expect(
      pressables(renderer).filter(n =>
        String(n.props.accessibilityLabel ?? '').startsWith('Open '),
      ),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('exposes the two tabs as a tablist with selected state and switches on press', async () => {
    const renderer = await renderLibrary();
    expect(
      renderer.root.findAll(
        n =>
          n.props.accessibilityRole === 'tablist' && String(n.type) === 'View',
      ),
    ).toHaveLength(1);
    await openSavedTab(renderer);
    expect(allText(renderer)).toContain('Explore the Drill Library');
    await act(async () => findTab(renderer, 'Reads').props.onPress());
    expect(findTab(renderer, 'Reads').props.accessibilityState).toEqual({
      selected: true,
    });
    expect(allText(renderer)).not.toContain('Explore the Drill Library');
    act(() => renderer.unmount());
  });
});

describe('Library flow · Saved drills tab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authState.session = { localOnly: false };
    mockListShots.mockResolvedValue([readRow]);
    mockListPendingCaptures.mockResolvedValue([]);
    useTrainingStore.setState({
      savedStatus: 'ready',
      planStatus: 'ready',
      mutation: 'idle',
      savedDrills: [savedDrill],
      drillDetails: { [savedDrill.slug]: savedDetail },
      currentPlan: null,
      savedError: null,
      planError: null,
      mutationError: null,
      loadSavedDrills,
      loadCurrentPlan,
      setDrillSaved,
      clearMutationError,
    });
  });

  it('Explore always routes to the Drill Library', async () => {
    const renderer = await renderLibrary();
    await openSavedTab(renderer);
    await pressByLabel(renderer, 'Explore the Drill Library');
    expect(mockNavigate).toHaveBeenCalledWith('DrillLibrary');
    act(() => renderer.unmount());
  });

  it('shows the loading state while saved drills load (idle and loading alike)', async () => {
    useTrainingStore.setState({ savedStatus: 'idle' });
    const renderer = await renderLibrary();
    await openSavedTab(renderer);
    expect(allText(renderer)).toContain('Loading saved drills…');
    act(() => useTrainingStore.setState({ savedStatus: 'loading' }));
    expect(allText(renderer)).toContain('Loading saved drills…');
    act(() => useTrainingStore.setState({ savedStatus: 'ready' }));
    expect(allText(renderer)).not.toContain('Loading saved drills…');
    expect(allText(renderer)).toContain('Dink Target Ladder');
    act(() => renderer.unmount());
  });

  it('unconfigured + local-only offers Connect account → ConnectAccount route', async () => {
    authState.session = { localOnly: true };
    useTrainingStore.setState({
      savedStatus: 'unconfigured',
      savedDrills: [],
      savedError: {
        code: 'training.unconfigured',
        message:
          'Connect a synced account to load saved drills and personalized plans.',
        retryable: false,
        status: null,
      },
    });
    const renderer = await renderLibrary();
    await openSavedTab(renderer);
    const text = allText(renderer);
    expect(text).toContain('Saved training needs a synced account.');
    expect(text).toContain('Connect a synced account to load saved drills');
    await pressByLabel(renderer, 'Connect account');
    expect(mockNavigate).toHaveBeenCalledWith('ConnectAccount');
    act(() => renderer.unmount());
  });

  it('unconfigured on a synced session states the cause without a misleading CTA', async () => {
    useTrainingStore.setState({
      savedStatus: 'unconfigured',
      savedDrills: [],
      savedError: null,
    });
    const renderer = await renderLibrary();
    await openSavedTab(renderer);
    expect(allText(renderer)).toContain(
      'The app has no authenticated training API connection in this build.',
    );
    expect(findByLabel(renderer, 'Connect account')).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('offline: honest copy + Try again re-runs the saved-drills load', async () => {
    useTrainingStore.setState({
      savedStatus: 'error',
      savedDrills: [],
      savedError: {
        code: 'training.unavailable',
        message:
          'Training is temporarily offline. Your existing reads are still safe.',
        retryable: true,
        status: null,
      },
    });
    const renderer = await renderLibrary();
    await openSavedTab(renderer);
    const text = allText(renderer);
    expect(text).toContain('Training is offline.');
    expect(text).toContain('Your existing reads are still safe.');
    loadSavedDrills.mockClear();
    await pressByLabel(renderer, 'Try again');
    expect(loadSavedDrills).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('empty saved list explains itself and keeps the Drill Library reachable', async () => {
    useTrainingStore.setState({ savedDrills: [], drillDetails: {} });
    const renderer = await renderLibrary();
    await openSavedTab(renderer);
    expect(allText(renderer)).toContain('No saved drills yet.');
    expect(findByLabel(renderer, 'Explore the Drill Library')).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('AGENTS invariant: a loaded entry renders with mappings: [] (label only), held entries retry', async () => {
    const renderer = await renderLibrary();
    await openSavedTab(renderer);
    let text = allText(renderer);
    expect(text).toContain('Dink Target Ladder');
    expect(text).toContain('Server catalog');
    expect(text).toContain('1 saved');
    expect(text).not.toContain('Reviewed prescription');

    // Same entry, detail fetch failed: held with honest copy and retry.
    act(() => useTrainingStore.setState({ drillDetails: {} }));
    text = allText(renderer);
    expect(text).toContain('Saved entries couldn’t be verified right now.');
    expect(text).toContain('1 saved entry is hidden');
    expect(text).not.toContain('Dink Target Ladder');
    loadSavedDrills.mockClear();
    await pressByLabel(renderer, 'Try again');
    expect(loadSavedDrills).toHaveBeenCalledTimes(1);

    // Detail arrives on retry: card comes back without a remount.
    act(() =>
      useTrainingStore.setState({
        drillDetails: { [savedDrill.slug]: savedDetail },
      }),
    );
    expect(allText(renderer)).toContain('Dink Target Ladder');
    act(() => renderer.unmount());
  });

  it('un-save calls the store with saved=false and is disabled while any mutation runs', async () => {
    const renderer = await renderLibrary();
    await openSavedTab(renderer);
    const label = 'Remove Dink Target Ladder from saved drills';
    const unsave = oneByLabel(renderer, label);
    expect(unsave.props.accessibilityRole).toBe('button');
    expect(unsave.props.disabled).toBe(false);
    await pressByLabel(renderer, label);
    expect(setDrillSaved).toHaveBeenCalledWith('dink-target-ladder', false);

    act(() =>
      useTrainingStore.setState({ mutation: 'saving:dink-target-ladder' }),
    );
    const busy = oneByLabel(renderer, label);
    expect(busy.props.disabled).toBe(true);
    expect(busy.props.accessibilityState.disabled).toBe(true);
    act(() => renderer.unmount());
  });

  it('a mutation error is a labelled button the user can dismiss', async () => {
    useTrainingStore.setState({
      mutationError: {
        code: 'training.request_failed',
        message: 'The training request could not be completed.',
        retryable: false,
        status: 500,
      },
    });
    const renderer = await renderLibrary();
    await openSavedTab(renderer);
    const alert = firstNode(
      renderer,
      n =>
        n.props.accessibilityRole === 'button' &&
        n.props.accessibilityLabel ===
          'The training request could not be completed.' &&
        typeof n.props.onPress === 'function',
    );
    expect(alert).toBeDefined();
    expect(alert.props.accessibilityHint).toBe('Dismisses this message');
    expect(allText(renderer)).toContain(
      'The training request could not be completed.',
    );
    expect(allText(renderer)).toContain('DISMISS');
    await act(async () => alert.props.onPress());
    expect(clearMutationError).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('video hand-off opens the canonical watch page (never /embed/) and alerts on failure', async () => {
    const canOpen = jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
    const openUrl = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const renderer = await renderLibrary();
    await openSavedTab(renderer);
    const label = 'Watch reviewed instruction for Dink Target Ladder';
    const row = oneByLabel(renderer, label);
    expect(row.props.accessibilityHint).toBe(youtubeMedia.attribution);

    await pressByLabel(renderer, label);
    expect(canOpen).toHaveBeenCalledWith(youtubeMedia.sourceUrl);
    expect(openUrl).toHaveBeenCalledWith(youtubeMedia.sourceUrl);
    for (const call of openUrl.mock.calls) {
      expect(String(call[0])).not.toContain('/embed/');
    }
    expect(alert).not.toHaveBeenCalled();

    // Failure branch: no handler → honest alert, no crash.
    canOpen.mockResolvedValue(false);
    openUrl.mockClear();
    await pressByLabel(renderer, label);
    expect(openUrl).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(
      'Video unavailable',
      'This reviewed video could not be opened. Refresh the library and try again.',
    );

    // openURL itself rejecting is also caught.
    canOpen.mockResolvedValue(true);
    openUrl.mockRejectedValue(new Error('no handler'));
    alert.mockClear();
    await pressByLabel(renderer, label);
    expect(alert).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
    canOpen.mockRestore();
    openUrl.mockRestore();
    alert.mockRestore();
  });

  it('a saved drill without a playable video says so instead of faking one', async () => {
    useTrainingStore.setState({
      drillDetails: {
        [savedDrill.slug]: { ...savedDetail, instructionalMedia: [] },
      },
    });
    const renderer = await renderLibrary();
    await openSavedTab(renderer);
    expect(allText(renderer)).toContain(
      'No rights-cleared coaching video is published for this drill yet.',
    );
    expect(
      findByLabel(
        renderer,
        'Watch reviewed instruction for Dink Target Ladder',
      ),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('the current plan card opens the Result that produced the plan', async () => {
    useTrainingStore.setState({ currentPlan });
    const renderer = await renderLibrary();
    await openSavedTab(renderer);
    const text = allText(renderer);
    expect(text).toContain('CURRENT PLAN');
    expect(text).toContain('0/1 DONE');
    expect(text).toContain('third shot drop');
    await pressByLabel(renderer, 'Open your current personalized plan');
    expect(mockNavigate).toHaveBeenCalledWith('Result', {
      analysisId: 'shot-0001',
    });

    // Plan not loaded (or none) → no card, no dead link.
    act(() =>
      useTrainingStore.setState({ planStatus: 'error', currentPlan: null }),
    );
    expect(
      findByLabel(renderer, 'Open your current personalized plan'),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });
});
