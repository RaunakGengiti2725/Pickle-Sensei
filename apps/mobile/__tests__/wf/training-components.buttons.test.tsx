/**
 * Button ledger for `src/training/components.tsx` (SavedDrillCard +
 * PlanDrillCard). Every pressable rendered by the file is pressed here via
 * `props.onPress()` and its observable effect asserted: the card forwards to
 * the prop handler the parent screen wires (LibraryScreen / ResultScreen ->
 * trainingStore.setDrillSaved / completePlanItem, Linking via openMedia).
 *
 * Pressables (label -> handler):
 *  SavedDrillCard
 *   - "Remove <title> from saved drills" bookmark -> props.onUnsave
 *     (disabled while busy)
 *   - "Watch reviewed instruction for <title>" media row ->
 *     props.onOpenMedia(firstPlayableMedia) (rendered only when playable
 *     media exists)
 *  PlanDrillCard
 *   - "Save <title>" / "Remove <title>" bookmark -> props.onToggleSaved
 *     (disabled while busy)
 *   - "Watch reviewed instruction for <title>" media row ->
 *     props.onOpenMedia(firstPlayableMedia) (conditional)
 *   - "Confirm completion of <title>" / "<title> completion logged" ->
 *     props.onConfirmComplete (disabled when complete, busy, or no
 *     prescription target)
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

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  PlanDrillCard,
  SavedDrillCard,
  firstPlayableMedia,
  prescriptionLabel,
} from '../../src/training/components';
import type {
  DrillCompletion,
  DrillDetail,
  EmbeddedInstructionalMedia,
  HostedInstructionalMedia,
  SavedDrill,
  TrainingPlanItem,
} from '../../src/training/types';

const NOW = new Date('2026-09-01T12:00:00.000Z').getTime();

const embedMedia: EmbeddedInstructionalMedia = {
  id: '0f2b7a1e-1111-4222-8333-444455556666',
  kind: 'embed',
  provider: 'youtube',
  videoId: 'abc123XYZ',
  embedUrl: 'https://www.youtube-nocookie.com/embed/abc123XYZ',
  sourceUrl: 'https://www.youtube.com/watch?v=abc123XYZ',
  creatorName: 'Court Coach',
  licenseName: 'CC BY 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  attribution: 'Court Coach · CC BY 4.0',
};

const expiredHosted: HostedInstructionalMedia = {
  id: '1a2b3c4d-1111-4222-8333-444455556666',
  kind: 'hosted',
  playbackUrl: 'https://media.example.com/expired.m3u8',
  expiresAt: new Date(NOW - 60_000).toISOString(),
  sourceUrl: 'https://media.example.com/expired',
  creatorName: 'Stale Host',
  licenseName: 'Licensed',
  licenseUrl: null,
  attribution: 'Stale Host · Licensed',
};

const liveHosted: HostedInstructionalMedia = {
  ...expiredHosted,
  id: '2a2b3c4d-1111-4222-8333-444455556666',
  playbackUrl: 'https://media.example.com/live.m3u8',
  expiresAt: new Date(NOW + 60 * 60_000).toISOString(),
  creatorName: 'Live Host',
  attribution: 'Live Host · Licensed',
};

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

const detailWithMedia: DrillDetail = {
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
  instructionalMedia: [expiredHosted, embedMedia],
};

const detailWithoutMedia: DrillDetail = {
  ...detailWithMedia,
  instructionalMedia: [],
};

const completion: DrillCompletion = {
  id: 'c0c0c0c0-1111-4222-8333-444455556666',
  completedAt: '2026-08-31T09:30:00.000Z',
  actualRepetitions: 12,
  actualDurationSeconds: null,
  qualifiesForStreak: true,
};

const planItem: TrainingPlanItem = {
  id: 'i1i1i1i1-1111-4222-8333-444455556666',
  position: 2,
  kind: 'targeted',
  drill: {
    slug: savedDrill.slug,
    title: savedDrill.title,
    description: savedDrill.description,
    coachName: savedDrill.coachName,
    equipment: ['paddle'],
    saved: false,
  },
  cueText: 'Soften the grip before contact.',
  targetSets: 3,
  targetRepetitionsPerSet: 12,
  targetDurationSeconds: null,
  restSeconds: 45,
  completion: null,
};

type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

function render(element: React.ReactElement): Renderer {
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function renderedText(renderer: Renderer): string {
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

/**
 * The RN `Pressable` nodes (PressableScale always sets an accessibilityRole
 * on them; the PressableScale wrapper itself carries none).
 */
function pressables(renderer: Renderer): Instance[] {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'function' &&
      node.type.name === 'Pressable' &&
      typeof node.props.onPress === 'function' &&
      typeof node.props.accessibilityRole === 'string',
  );
}

function byLabel(renderer: Renderer, label: string): Instance {
  const matches = pressables(renderer).filter(
    node => node.props.accessibilityLabel === label,
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function flattenStyle(style: unknown): Record<string, unknown> {
  if (typeof style === 'function') {
    return flattenStyle(
      (style as (state: { pressed: boolean }) => unknown)({ pressed: false }),
    );
  }
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (acc, entry) => ({ ...acc, ...flattenStyle(entry) }),
      {},
    );
  }
  return style && typeof style === 'object'
    ? (style as Record<string, unknown>)
    : {};
}

function pressablesLedger(renderer: Renderer): string[] {
  return pressables(renderer).map(
    node => `${node.props.accessibilityLabel} -> onPress`,
  );
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('helpers', () => {
  it('prescriptionLabel renders reps, then seconds, else null', () => {
    expect(prescriptionLabel(planItem)).toBe('3 × 12 reps');
    expect(
      prescriptionLabel({
        ...planItem,
        targetRepetitionsPerSet: null,
        targetDurationSeconds: 40,
      }),
    ).toBe('3 × 40 sec');
    expect(prescriptionLabel({ ...planItem, targetSets: null })).toBeNull();
    expect(
      prescriptionLabel({
        ...planItem,
        targetRepetitionsPerSet: null,
        targetDurationSeconds: null,
      }),
    ).toBeNull();
  });

  it('firstPlayableMedia skips expired hosted media and tolerates no detail', () => {
    expect(firstPlayableMedia(undefined, NOW)).toBeNull();
    expect(firstPlayableMedia(detailWithoutMedia, NOW)).toBeNull();
    expect(firstPlayableMedia(detailWithMedia, NOW)).toBe(embedMedia);
    expect(
      firstPlayableMedia(
        { ...detailWithMedia, instructionalMedia: [liveHosted, embedMedia] },
        NOW,
      ),
    ).toBe(liveHosted);
    expect(
      firstPlayableMedia(
        { ...detailWithMedia, instructionalMedia: [expiredHosted] },
        NOW,
      ),
    ).toBeNull();
  });
});

describe('SavedDrillCard', () => {
  function renderSaved(
    overrides: Partial<React.ComponentProps<typeof SavedDrillCard>> = {},
  ) {
    const onUnsave = jest.fn();
    const onOpenMedia = jest.fn();
    const renderer = render(
      <SavedDrillCard
        drill={savedDrill}
        detail={detailWithMedia}
        busy={false}
        onUnsave={onUnsave}
        onOpenMedia={onOpenMedia}
        {...overrides}
      />,
    );
    return { renderer, onUnsave, onOpenMedia };
  }

  it('exposes exactly the ledgered pressables, each a labelled 44pt+ button', () => {
    const { renderer } = renderSaved();
    expect(pressablesLedger(renderer)).toEqual([
      'Remove Dink Target Ladder from saved drills -> onPress',
      'Watch reviewed instruction for Dink Target Ladder -> onPress',
    ]);
    for (const node of pressables(renderer)) {
      expect(node.props.accessibilityRole).toBe('button');
      expect(node.props.accessibilityState.disabled).toBeFalsy();
    }
    const bookmark = flattenStyle(
      byLabel(renderer, 'Remove Dink Target Ladder from saved drills').props
        .style,
    );
    expect(bookmark.width).toBe(44);
    expect(bookmark.height).toBe(44);
    const media = flattenStyle(
      byLabel(renderer, 'Watch reviewed instruction for Dink Target Ladder')
        .props.style,
    );
    expect(media.minHeight).toBeGreaterThanOrEqual(44);
    act(() => renderer.unmount());
  });

  it('bookmark -> onUnsave, once per press', () => {
    const { renderer, onUnsave, onOpenMedia } = renderSaved();
    act(() =>
      byLabel(
        renderer,
        'Remove Dink Target Ladder from saved drills',
      ).props.onPress(),
    );
    expect(onUnsave).toHaveBeenCalledTimes(1);
    expect(onOpenMedia).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('bookmark is disabled while the parent mutation is pending', () => {
    const { renderer } = renderSaved({ busy: true });
    const bookmark = byLabel(
      renderer,
      'Remove Dink Target Ladder from saved drills',
    );
    expect(bookmark.props.disabled).toBe(true);
    expect(bookmark.props.accessibilityState.disabled).toBe(true);
    // The media row is not a mutation; it stays available.
    expect(
      byLabel(renderer, 'Watch reviewed instruction for Dink Target Ladder')
        .props.disabled,
    ).toBeFalsy();
    act(() => renderer.unmount());
  });

  it('media row -> onOpenMedia with the first PLAYABLE media (expired hosted skipped)', () => {
    const { renderer, onOpenMedia, onUnsave } = renderSaved();
    const row = byLabel(
      renderer,
      'Watch reviewed instruction for Dink Target Ladder',
    );
    expect(row.props.accessibilityHint).toBe(embedMedia.attribution);
    act(() => row.props.onPress());
    expect(onOpenMedia).toHaveBeenCalledTimes(1);
    expect(onOpenMedia).toHaveBeenCalledWith(embedMedia);
    expect(onUnsave).not.toHaveBeenCalled();
    expect(renderedText(renderer)).toContain('Court Coach · CC BY 4.0');
    expect(renderedText(renderer)).toContain('Server catalog');
    act(() => renderer.unmount());
  });

  it('media row hands over live hosted media when it is first', () => {
    const { renderer, onOpenMedia } = renderSaved({
      detail: {
        ...detailWithMedia,
        instructionalMedia: [liveHosted, embedMedia],
      },
    });
    act(() =>
      byLabel(
        renderer,
        'Watch reviewed instruction for Dink Target Ladder',
      ).props.onPress(),
    );
    expect(onOpenMedia).toHaveBeenCalledWith(liveHosted);
    act(() => renderer.unmount());
  });

  it('without playable media: no media row, honest copy, bookmark still works', () => {
    const { renderer, onUnsave } = renderSaved({ detail: detailWithoutMedia });
    expect(pressablesLedger(renderer)).toEqual([
      'Remove Dink Target Ladder from saved drills -> onPress',
    ]);
    expect(renderedText(renderer)).toContain(
      'No rights-cleared coaching video is published for this drill yet.',
    );
    act(() =>
      byLabel(
        renderer,
        'Remove Dink Target Ladder from saved drills',
      ).props.onPress(),
    );
    expect(onUnsave).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('without detail: honest unverified copy, labels provenance as catalog', () => {
    const { renderer } = renderSaved({ detail: undefined });
    const text = renderedText(renderer);
    expect(text).toContain('Video availability could not be verified.');
    expect(text).toContain('Server catalog');
    expect(pressablesLedger(renderer)).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('labels a coach-reviewed detail as a reviewed prescription', () => {
    const { renderer } = renderSaved({
      detail: {
        ...detailWithMedia,
        mappings: [
          {
            checkpoint: 'contact_point',
            shotType: 'dink',
            planRole: 'targeted',
            faultDirections: ['late'],
            cueText: 'Meet the ball early.',
            targetSets: 3,
            targetRepetitionsPerSet: 10,
            targetDurationSeconds: null,
            restSeconds: 30,
          },
        ],
      },
    });
    expect(renderedText(renderer)).toContain('Reviewed prescription');
    act(() => renderer.unmount());
  });
});

describe('PlanDrillCard', () => {
  function renderPlan(
    overrides: Partial<React.ComponentProps<typeof PlanDrillCard>> = {},
  ) {
    const onToggleSaved = jest.fn();
    const onConfirmComplete = jest.fn();
    const onOpenMedia = jest.fn();
    const renderer = render(
      <PlanDrillCard
        item={planItem}
        detail={detailWithMedia}
        busy={false}
        onToggleSaved={onToggleSaved}
        onConfirmComplete={onConfirmComplete}
        onOpenMedia={onOpenMedia}
        {...overrides}
      />,
    );
    return { renderer, onToggleSaved, onConfirmComplete, onOpenMedia };
  }

  it('exposes exactly the ledgered pressables with roles, labels and hit targets', () => {
    const { renderer } = renderPlan();
    expect(pressablesLedger(renderer)).toEqual([
      'Save Dink Target Ladder -> onPress',
      'Watch reviewed instruction for Dink Target Ladder -> onPress',
      'Confirm completion of Dink Target Ladder -> onPress',
    ]);
    for (const node of pressables(renderer)) {
      expect(node.props.accessibilityRole).toBe('button');
      expect(node.props.disabled).toBeFalsy();
    }
    const bookmark = flattenStyle(
      byLabel(renderer, 'Save Dink Target Ladder').props.style,
    );
    expect(bookmark.width).toBe(44);
    expect(bookmark.height).toBe(44);
    const confirm = flattenStyle(
      byLabel(renderer, 'Confirm completion of Dink Target Ladder').props.style,
    );
    expect(confirm.minHeight).toBeGreaterThanOrEqual(44);
    const text = renderedText(renderer);
    expect(text).toContain('TARGETED');
    expect(text).toContain('0 2');
    expect(text).toContain('Soften the grip before contact.');
    expect(text).toContain('3 × 12 reps');
    expect(text).toContain('45 s rest');
    expect(text).toContain('I completed 3 × 12 reps');
    expect(text).toContain('Tap only after doing the prescribed work.');
    act(() => renderer.unmount());
  });

  it('bookmark -> onToggleSaved (save), label flips to Remove once saved', () => {
    const { renderer, onToggleSaved, onConfirmComplete } = renderPlan();
    act(() => byLabel(renderer, 'Save Dink Target Ladder').props.onPress());
    expect(onToggleSaved).toHaveBeenCalledTimes(1);
    expect(onConfirmComplete).not.toHaveBeenCalled();

    act(() =>
      renderer.update(
        <PlanDrillCard
          item={{ ...planItem, drill: { ...planItem.drill!, saved: true } }}
          detail={detailWithMedia}
          busy={false}
          onToggleSaved={onToggleSaved}
          onConfirmComplete={onConfirmComplete}
          onOpenMedia={jest.fn()}
        />,
      ),
    );
    act(() => byLabel(renderer, 'Remove Dink Target Ladder').props.onPress());
    expect(onToggleSaved).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });

  it('media row -> onOpenMedia with the first playable media', () => {
    const { renderer, onOpenMedia, onToggleSaved, onConfirmComplete } =
      renderPlan();
    const row = byLabel(
      renderer,
      'Watch reviewed instruction for Dink Target Ladder',
    );
    expect(row.props.accessibilityHint).toBe(embedMedia.attribution);
    act(() => row.props.onPress());
    expect(onOpenMedia).toHaveBeenCalledTimes(1);
    expect(onOpenMedia).toHaveBeenCalledWith(embedMedia);
    expect(onToggleSaved).not.toHaveBeenCalled();
    expect(onConfirmComplete).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('omits the media row when no playable media exists', () => {
    const { renderer } = renderPlan({ detail: detailWithoutMedia });
    expect(pressablesLedger(renderer)).toEqual([
      'Save Dink Target Ladder -> onPress',
      'Confirm completion of Dink Target Ladder -> onPress',
    ]);
    act(() => renderer.unmount());
  });

  it('confirm completion -> onConfirmComplete', () => {
    const { renderer, onConfirmComplete, onToggleSaved } = renderPlan();
    act(() =>
      byLabel(
        renderer,
        'Confirm completion of Dink Target Ladder',
      ).props.onPress(),
    );
    expect(onConfirmComplete).toHaveBeenCalledTimes(1);
    expect(onToggleSaved).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('busy: bookmark and confirm are disabled, media row stays live', () => {
    const { renderer } = renderPlan({ busy: true });
    const bookmark = byLabel(renderer, 'Save Dink Target Ladder');
    expect(bookmark.props.disabled).toBe(true);
    expect(bookmark.props.accessibilityState.disabled).toBe(true);
    const confirm = byLabel(
      renderer,
      'Confirm completion of Dink Target Ladder',
    );
    expect(confirm.props.disabled).toBe(true);
    expect(confirm.props.accessibilityState.disabled).toBe(true);
    expect(
      byLabel(renderer, 'Watch reviewed instruction for Dink Target Ladder')
        .props.disabled,
    ).toBeFalsy();
    act(() => renderer.unmount());
  });

  it('completed: confirm becomes a disabled logged state with streak copy and date', () => {
    const { renderer } = renderPlan({
      item: { ...planItem, completion },
    });
    const logged = byLabel(renderer, 'Dink Target Ladder completion logged');
    expect(logged.props.disabled).toBe(true);
    expect(logged.props.accessibilityState.disabled).toBe(true);
    const text = renderedText(renderer);
    expect(text).toContain('Completed · streak credit earned');
    expect(text).toContain(
      `Logged ${new Date(completion.completedAt).toLocaleDateString()}`,
    );
    expect(text).not.toContain('Tap only after');
    act(() => renderer.unmount());
  });

  it('completed without streak credit: honest "Completion logged" copy', () => {
    const { renderer } = renderPlan({
      item: {
        ...planItem,
        completion: { ...completion, qualifiesForStreak: false },
      },
    });
    expect(renderedText(renderer)).toContain('Completion logged');
    expect(renderedText(renderer)).not.toContain('streak credit');
    act(() => renderer.unmount());
  });

  it('no prescription target: no completion control is rendered and the copy explains why', () => {
    const { renderer } = renderPlan({
      item: { ...planItem, targetSets: null },
    });
    expect(
      pressables(renderer).filter(node =>
        String(node.props.accessibilityLabel).startsWith(
          'Confirm completion of',
        ),
      ),
    ).toHaveLength(0);
    const text = renderedText(renderer);
    expect(text).not.toContain('I completed');
    expect(text).not.toContain('Tap only after doing the prescribed work.');
    expect(text).toContain('—');
    expect(text).toContain(
      'No sets, reps, or time were prescribed for this drill',
    );
    act(() => renderer.unmount());
  });

  it('renders nothing (no throw) for a plan item without a drill', () => {
    const { renderer } = renderPlan({
      item: { ...planItem, kind: 'reassessment', drill: null },
    });
    expect(renderer.toJSON()).toBeNull();
    act(() => renderer.unmount());
  });

  it('warm-up kind and null cue/rest render without optional rows', () => {
    const { renderer } = renderPlan({
      item: {
        ...planItem,
        kind: 'warmup',
        position: 1,
        cueText: null,
        restSeconds: null,
        targetRepetitionsPerSet: null,
        targetDurationSeconds: 40,
      },
    });
    const text = renderedText(renderer);
    expect(text).toContain('WARM-UP');
    expect(text).toContain('0 1');
    expect(text).toContain('3 × 40 sec');
    expect(text).not.toContain('rest');
    expect(text).not.toContain('Soften the grip');
    act(() => renderer.unmount());
  });
});
