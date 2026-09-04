import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createTrainingApi } from '../src/training/api';
import { PlanDrillCard, SavedDrillCard } from '../src/training/components';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
} from '../src/training/store';
import type {
  DrillDetail,
  SavedDrill,
  TrainingPlanItem,
} from '../src/training/types';

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

jest.mock('../src/data/db', () => ({
  getDb: jest.fn(() => ({})),
}));

jest.mock('../src/data/repository', () => ({
  listShots: jest.fn(async () => []),
  listPendingCaptures: jest.fn(async () => []),
}));

jest.mock('../src/auth/authStore', () => ({
  useAuthStore: (
    selector: (state: { session: { localOnly: boolean } }) => unknown,
  ) => selector({ session: { localOnly: false } }),
}));

import { LibraryScreen } from '../src/screens/LibraryScreen';

/**
 * ADVERSARIAL PASS 3 / tester #4 — Library saved drills through the REAL
 * training store and REAL API client (only `fetch` is faked). Scenario #3
 * (a saved placeholder whose catalog entry 404s, retried repeatedly) and #4
 * (what the cards render for `saved_at` / `completedAt` strings that pass
 * `isIso` without being ISO 8601). `RECORD:` tests pin observed behaviour
 * at 4d812e1a without endorsing it.
 */

const LOWER_UUID = '0b96363e-4a11-47c5-9d2c-3f5b8e6f2a17';
const GHOST_UUID = 'a2e6f9d0-1111-4222-8333-444455556666';

const ghostSaved = {
  id: GHOST_UUID,
  slug: 'ghost-drill',
  title: 'Ghost Drill',
  description: 'A saved entry whose catalog row no longer exists.',
  coach_name: 'Pickle Sensei Training Library',
  equipment: [],
  difficulty_min: null,
  difficulty_max: null,
  saved_at: '2026-08-30T10:00:00.000Z',
};

const dinkSaved = {
  id: LOWER_UUID,
  slug: 'dink-target-ladder',
  title: 'Dink Target Ladder',
  description: 'Land four consecutive cross-court dinks per kitchen zone.',
  coach_name: 'Pickle Sensei Training Library',
  equipment: ['paddle'],
  difficulty_min: null,
  difficulty_max: null,
  saved_at: '2026-08-30T10:00:00.000Z',
};

function detailPayloadFor(item: typeof dinkSaved) {
  return {
    drill: { ...item, saved: true },
    mappings: [],
    instructionalMedia: [],
  };
}

function response(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => payload,
  } as Response;
}

interface FakeServer {
  saved: Array<typeof dinkSaved>;
  details: Record<string, unknown | 404>;
  calls: string[];
}

function installServer(server: FakeServer) {
  const fetchFn = jest.fn(async (input: string) => {
    const path = input.replace('https://api.pickle.test', '');
    server.calls.push(path);
    if (path === '/v1/me/saved-drills') {
      return response(200, { items: server.saved });
    }
    if (path === '/v1/training-plans/current') {
      return response(200, { plan: null });
    }
    const match = /^\/v1\/catalog\/drills\/([^/?]+)$/.exec(path);
    if (match) {
      const slug = decodeURIComponent(match[1]!);
      const detail = server.details[slug];
      if (detail === undefined || detail === 404) {
        return response(404, {
          error: { code: 'not_found', message: 'Drill not found.' },
        });
      }
      return response(200, detail);
    }
    return response(404, { error: { code: 'not_found', message: 'no route' } });
  });
  configureTrainingStore(
    createTrainingApi({
      baseUrl: 'https://api.pickle.test',
      token: 'signed-token',
      fetchFn: fetchFn as unknown as typeof fetch,
    }),
  );
  return fetchFn;
}

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

function openSavedTab(renderer: TestRenderer.ReactTestRenderer): void {
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
}

async function renderLibrary(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<LibraryScreen />);
  });
  await act(async () => {});
  return renderer;
}

async function pressTryAgain(renderer: TestRenderer.ReactTestRenderer) {
  const [button] = renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === 'Try again' &&
      typeof node.props.onPress === 'function',
  );
  if (!button) throw new Error('No Try again button');
  await act(async () => {
    button.props.onPress();
  });
  await act(async () => {});
}

const HONEST_COPY = 'Saved entries couldn’t be verified right now.';

describe('scenario 3 — saved placeholder whose catalog entry 404s', () => {
  afterEach(() => {
    act(() => clearTrainingStoreConfiguration());
    mockNavigate.mockClear();
  });

  it('keeps the entry hidden with honest copy; 8 retries never succeed and never render the placeholder', async () => {
    const server: FakeServer = {
      saved: [ghostSaved],
      details: { 'ghost-drill': 404 },
      calls: [],
    };
    installServer(server);
    const renderer = await renderLibrary();
    openSavedTab(renderer);

    let text = renderedText(renderer);
    expect(text).toContain(HONEST_COPY);
    expect(text).toContain('1 saved entry is hidden');
    expect(text).not.toContain('Ghost Drill');
    expect(useTrainingStore.getState().savedStatus).toBe('ready');
    expect(useTrainingStore.getState().savedDrills).toHaveLength(1);
    expect(useTrainingStore.getState().drillDetails).toEqual({});

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await pressTryAgain(renderer);
      text = renderedText(renderer);
      expect(text).toContain(HONEST_COPY);
      expect(text).not.toContain('Ghost Drill');
      expect(text).not.toContain('Training is offline.');
      expect(useTrainingStore.getState().savedStatus).toBe('ready');
    }
    const detailCalls = server.calls.filter(p =>
      p.startsWith('/v1/catalog/drills/'),
    );
    expect(detailCalls).toHaveLength(9);
    expect(detailCalls.every(p => p === '/v1/catalog/drills/ghost-drill')).toBe(
      true,
    );
    expect(server.calls.filter(p => p === '/v1/me/saved-drills')).toHaveLength(
      9,
    );
    act(() => renderer.unmount());
  });

  it('a placeholder slug with URL-hostile characters is encoded and still held honestly', async () => {
    const hostile = { ...ghostSaved, slug: 'ghost/../drill?x=1#f' };
    const server: FakeServer = { saved: [hostile], details: {}, calls: [] };
    installServer(server);
    const renderer = await renderLibrary();
    openSavedTab(renderer);
    expect(renderedText(renderer)).toContain(HONEST_COPY);
    expect(
      server.calls.filter(p => p.startsWith('/v1/catalog/drills/')),
    ).toEqual(['/v1/catalog/drills/ghost%2F..%2Fdrill%3Fx%3D1%23f']);
    act(() => renderer.unmount());
  });

  it('mixed: the loaded entry renders, the ghost stays counted as hidden across retries', async () => {
    const server: FakeServer = {
      saved: [dinkSaved, ghostSaved],
      details: { 'dink-target-ladder': detailPayloadFor(dinkSaved) },
      calls: [],
    };
    installServer(server);
    const renderer = await renderLibrary();
    openSavedTab(renderer);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const text = renderedText(renderer);
      expect(text).toContain('Dink Target Ladder');
      expect(text).not.toContain('Ghost Drill');
      expect(text).toContain('1 additional saved');
      expect(text).toContain('could not be loaded');
      // RECORD: the mixed state offers NO in-place retry; the only reload
      // path is the store action (fired again on screen focus).
      expect(
        renderer.root.findAll(
          node =>
            node.props.accessibilityLabel === 'Try again' &&
            typeof node.props.onPress === 'function',
        ),
      ).toHaveLength(0);
      if (attempt < 2) {
        await act(async () => {
          await useTrainingStore.getState().loadSavedDrills();
        });
      }
    }
    expect(
      server.calls.filter(p => p === '/v1/catalog/drills/ghost-drill'),
    ).toHaveLength(3);
    act(() => renderer.unmount());
  });

  it('RECORD: a detail that loaded once is kept after the catalog later 404s (no eviction on refresh)', async () => {
    const server: FakeServer = {
      saved: [dinkSaved],
      details: { 'dink-target-ladder': detailPayloadFor(dinkSaved) },
      calls: [],
    };
    installServer(server);
    const renderer = await renderLibrary();
    openSavedTab(renderer);
    expect(renderedText(renderer)).toContain('Dink Target Ladder');

    // The catalog row disappears server-side; the saved list still lists it.
    server.details = { 'dink-target-ladder': 404 };
    await act(async () => {
      await useTrainingStore.getState().loadSavedDrills();
    });
    const text = renderedText(renderer);
    // Observed: the stale detail keeps the card visible and the honest
    // "could not be loaded" state never appears for it.
    expect(text).toContain('Dink Target Ladder');
    expect(text).not.toContain(HONEST_COPY);
    expect(
      useTrainingStore.getState().drillDetails['dink-target-ladder'],
    ).toBeDefined();
    act(() => renderer.unmount());
  });

  it('RECORD: while a retry is in flight the honest card is replaced by the loading state', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let firstLoad = true;
    const fetchFn = jest.fn(async (input: string) => {
      if (input.endsWith('/v1/me/saved-drills')) {
        if (!firstLoad) await gate;
        firstLoad = false;
        return response(200, { items: [ghostSaved] });
      }
      if (input.endsWith('/v1/training-plans/current')) {
        return response(200, { plan: null });
      }
      return response(404, { error: { code: 'not_found', message: 'x' } });
    });
    configureTrainingStore(
      createTrainingApi({
        baseUrl: 'https://api.pickle.test',
        token: 'signed-token',
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    );
    const renderer = await renderLibrary();
    openSavedTab(renderer);
    expect(renderedText(renderer)).toContain(HONEST_COPY);
    const [button] = renderer.root.findAll(
      node =>
        node.props.accessibilityLabel === 'Try again' &&
        typeof node.props.onPress === 'function',
    );
    await act(async () => {
      button!.props.onPress();
    });
    expect(renderedText(renderer)).toContain('Loading saved drills…');
    expect(renderedText(renderer)).not.toContain(HONEST_COPY);
    await act(async () => {
      release();
    });
    await act(async () => {});
    expect(renderedText(renderer)).toContain(HONEST_COPY);
    act(() => renderer.unmount());
  });
});

describe('scenario 4 — what the cards render for non-ISO timestamps', () => {
  const savedWith = (savedAt: string): SavedDrill => ({
    id: LOWER_UUID,
    slug: 'dink-target-ladder',
    title: 'Dink Target Ladder',
    description: 'Land four consecutive cross-court dinks per kitchen zone.',
    coachName: 'Pickle Sensei Training Library',
    equipment: ['paddle'],
    difficultyMin: null,
    difficultyMax: null,
    savedAt,
  });

  const detail: DrillDetail = {
    id: LOWER_UUID,
    slug: 'dink-target-ladder',
    title: 'Dink Target Ladder',
    description: 'Land four consecutive cross-court dinks per kitchen zone.',
    coachName: 'Pickle Sensei Training Library',
    equipment: ['paddle'],
    difficultyMin: null,
    difficultyMax: null,
    saved: true,
    mappings: [],
    instructionalMedia: [],
  };

  function renderCard(element: React.ReactElement) {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(element);
    });
    return renderer;
  }

  it.each(['2024', 'Jan 1 2024', '2024-02-30T00:00:00Z'])(
    'SavedDrillCard never renders saved_at (%s) — no date at all, so no nonsense date',
    savedAt => {
      const renderer = renderCard(
        <SavedDrillCard
          drill={savedWith(savedAt)}
          detail={detail}
          busy={false}
          onUnsave={() => {}}
          onOpenMedia={() => {}}
        />,
      );
      const text = renderedText(renderer);
      expect(text).not.toContain(savedAt);
      expect(text).not.toContain('2024');
      expect(text).not.toContain('2023');
      expect(text).toContain('Server catalog');
      act(() => renderer.unmount());
    },
  );

  function planItemCompletedAt(completedAt: string): TrainingPlanItem {
    return {
      id: '4d1e8b2a-7c53-49f6-b0e8-9a2c6d4f1b58',
      position: 1,
      kind: 'targeted',
      drill: {
        slug: 'dink-target-ladder',
        title: 'Dink Target Ladder',
        description:
          'Land four consecutive cross-court dinks per kitchen zone.',
        coachName: 'Pickle Sensei Training Library',
        equipment: ['paddle'],
        saved: false,
      },
      cueText: 'Contact the ball below your waist.',
      targetSets: 3,
      targetRepetitionsPerSet: 10,
      targetDurationSeconds: null,
      restSeconds: 30,
      completion: {
        id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
        completedAt,
        actualRepetitions: 30,
        actualDurationSeconds: null,
        qualifiesForStreak: true,
      },
    };
  }

  it("RECORD: PlanDrillCard renders 'Logged <date>' for completedAt '2024' — a calendar day the server never stated", () => {
    const renderer = renderCard(
      <PlanDrillCard
        item={planItemCompletedAt('2024')}
        detail={detail}
        busy={false}
        onToggleSaved={() => {}}
        onConfirmComplete={() => {}}
        onOpenMedia={() => {}}
      />,
    );
    const text = renderedText(renderer);
    const shown = new Date('2024').toLocaleDateString();
    expect(text).toContain(`Logged ${shown}`);
    // The same string reads as a DIFFERENT calendar day west of UTC.
    expect(
      new Date('2024').toLocaleDateString('en-US', {
        timeZone: 'America/Los_Angeles',
      }),
    ).toBe('12/31/2023');
    expect(
      new Date('2024').toLocaleDateString('en-US', { timeZone: 'UTC' }),
    ).toBe('1/1/2024');
    act(() => renderer.unmount());
  });

  it("RECORD: completedAt '2024-02-30T00:00:00Z' is rendered as March 1st (Date rollover), never rejected", () => {
    const renderer = renderCard(
      <PlanDrillCard
        item={planItemCompletedAt('2024-02-30T00:00:00Z')}
        detail={detail}
        busy={false}
        onToggleSaved={() => {}}
        onConfirmComplete={() => {}}
        onOpenMedia={() => {}}
      />,
    );
    expect(renderedText(renderer)).toContain(
      `Logged ${new Date('2024-02-30T00:00:00Z').toLocaleDateString()}`,
    );
    expect(
      new Date('2024-02-30T00:00:00Z').toLocaleDateString('en-US', {
        timeZone: 'UTC',
      }),
    ).toBe('3/1/2024');
    act(() => renderer.unmount());
  });

  it('an unparseable completedAt cannot reach the card: the plan parser rejects it', async () => {
    const plan = {
      id: LOWER_UUID,
      status: 'active',
      algorithmVersion: 'v1',
      sourceShotId: LOWER_UUID,
      shotType: 'dink',
      priorityCheckpoint: 'contact_height',
      priorityDirection: 'high',
      baselineScore: 50,
      baselineCheckpointScore: null,
      reassessmentShotId: null,
      scoreDelta: null,
      createdAt: '2026-08-30T10:00:00.000Z',
      completedAt: null,
      items: [
        {
          ...planItemCompletedAt('2024-13-45T00:00:00Z'),
          drill: {
            slug: 'dink-target-ladder',
            title: 'Dink Target Ladder',
            description: 'x',
            coachName: 'y',
            equipment: [],
            saved: false,
          },
        },
      ],
    };
    const client = createTrainingApi({
      baseUrl: 'https://api.pickle.test',
      token: 'signed-token',
      fetchFn: jest.fn(async () =>
        response(200, { plan }),
      ) as unknown as typeof fetch,
    });
    await expect(client.getCurrentPlan()).rejects.toMatchObject({
      code: 'training.invalid_response',
    });
  });
});
