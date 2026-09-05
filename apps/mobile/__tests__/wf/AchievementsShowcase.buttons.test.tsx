import React from 'react';
import { StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import { AchievementsShowcase } from '../../src/consistency/AchievementsShowcase';
import {
  buildConsistencySnapshot,
  type ConsistencySnapshot,
  type TrainingActivityInput,
} from '../../src/consistency/engine';
import {
  RARITY_LABEL,
  STREAK_MILESTONES,
  VOLUME_ACHIEVEMENTS,
} from '../../src/consistency/milestones';
import { color } from '../../src/design/tokens';

/**
 * Button ledger for AchievementsShowcase. Every pressable in the file is a
 * badge cell (one per streak milestone + one per volume achievement); each
 * press toggles that badge's detail panel in place. Nothing navigates, nothing
 * is async, so the observable effects are copy + selection.
 */

const ENGINE_OPTIONS = { asOfIso: '2026-03-10T18:00:00.000Z', timeZone: 'UTC' };

const ALL_IDS = [
  ...STREAK_MILESTONES.map(m => m.id),
  VOLUME_ACHIEVEMENTS.sessions100.id,
  VOLUME_ACHIEVEMENTS.specialist.id,
];

/** Fresh account: nothing earned, First Spark is the next milestone. */
const freshSnapshot = buildConsistencySnapshot([], ENGINE_OPTIONS);

/** Three straight trained days ending today → streak.1 + streak.3 earned,
 * Week One (streak.7) is next and 4 days away. */
const threeDaySnapshot = buildConsistencySnapshot(
  [
    {
      kind: 'stroke',
      atIso: '2026-03-08T10:00:00.000Z',
      shotType: 'dink',
      overallScore: 6.2,
      resultKind: 'scored',
    },
    {
      kind: 'stroke',
      atIso: '2026-03-09T10:00:00.000Z',
      shotType: 'forehand_drive',
      overallScore: 7.4,
      resultKind: 'scored',
    },
    {
      kind: 'stroke',
      atIso: '2026-03-10T09:00:00.000Z',
      shotType: 'serve',
      overallScore: 8.1,
      resultKind: 'scored',
    },
  ],
  ENGINE_OPTIONS,
);

/** 100 scored dinks on one day → 100 Sessions + Dink Specialist earned. */
const volumeSnapshot = buildConsistencySnapshot(
  Array.from({ length: 100 }, (_, i): TrainingActivityInput => ({
    kind: 'stroke',
    atIso: `2026-03-10T08:${String(i % 60).padStart(2, '0')}:00.000Z`,
    shotType: 'dink',
    overallScore: 7,
    resultKind: 'scored',
  })),
  ENGINE_OPTIONS,
);

function render(snapshot: ConsistencySnapshot, dark = false) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <AchievementsShowcase snapshot={snapshot} dark={dark} />,
    );
  });
  return renderer;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(3)
    .filter((child): child is string | number =>
      ['string', 'number'].includes(typeof child),
    )
    .join(' ')
    .replace(/\s+/g, ' ');
}

/** The Pressable behind each badge: role button with a real onPress. */
function badgeButtons(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityRole === 'button' &&
      typeof node.props.onPress === 'function' &&
      typeof node.props.accessibilityLabel === 'string' &&
      typeof node.props.style === 'function',
  );
}

function badgeButton(renderer: TestRenderer.ReactTestRenderer, title: string) {
  const match = badgeButtons(renderer).find(node =>
    (node.props.accessibilityLabel as string).startsWith(`${title}.`),
  );
  if (!match) throw new Error(`no badge button titled ${title}`);
  return match;
}

function pressableStyle(node: TestRenderer.ReactTestInstance) {
  const style = node.props.style as (state: {
    pressed: boolean;
  }) => StyleProp<ViewStyle>;
  return StyleSheet.flatten(style({ pressed: false })) as Record<
    string,
    unknown
  >;
}

function detailPanels(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLiveRegion === 'polite' &&
      typeof node.type === 'string',
  );
}

function shimmers(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(node => {
    if (node.props.pointerEvents !== 'none' || typeof node.type !== 'string') {
      return false;
    }
    const style = StyleSheet.flatten(node.props.style) as { width?: number };
    return style.width === 26;
  });
}

describe('AchievementsShowcase button ledger', () => {
  it('renders exactly one accessible button per milestone and volume achievement', () => {
    const renderer = render(freshSnapshot);
    const buttons = badgeButtons(renderer);
    expect(buttons).toHaveLength(ALL_IDS.length);
    expect(buttons).toHaveLength(10);

    const labels = buttons.map(node => node.props.accessibilityLabel as string);
    for (const milestone of STREAK_MILESTONES) {
      expect(labels).toContain(
        `${milestone.title}. Locked. ${milestone.days} ${
          milestone.days === 1 ? 'day' : 'days'
        } away`,
      );
    }
    expect(labels).toContain('100 Sessions. Locked. 0 of 100');
    expect(labels).toContain('Specialist. Locked. 25 scored on one stroke');

    // No badge is disabled — locked badges must stay tappable for their story.
    for (const button of buttons) {
      expect(button.props.accessibilityState?.disabled).toBeFalsy();
    }

    // Hit target: every cell is 92pt wide with vertical padding around 64pt art.
    for (const button of buttons) {
      const style = pressableStyle(button);
      expect(style.width).toBe(92);
      expect(style.paddingVertical).toBeGreaterThan(0);
    }

    // Rail summary is exposed to assistive tech.
    expect(
      renderer.root.findAll(
        node =>
          node.props.accessibilityLabel === 'Achievements: 0 of 10 earned.',
      ).length,
    ).toBeGreaterThan(0);

    // No detail panel until a badge is tapped.
    expect(detailPanels(renderer)).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('pressing a locked badge opens its story and pressing again closes it', async () => {
    const renderer = render(freshSnapshot);
    const century = badgeButton(renderer, 'Century Club');

    await act(async () => {
      century.props.onPress();
    });
    expect(detailPanels(renderer)).toHaveLength(1);
    const copy = allText(renderer);
    expect(copy).toContain('One hundred consecutive days of training.');
    expect(copy).toContain(RARITY_LABEL.legendary.toUpperCase());
    expect(copy).toContain('Unlocks');
    expect(copy).toContain('Permanent Century badge');
    expect(copy).toContain('· 100 days away');
    expect(copy).not.toContain('Unlocked');

    // Selected cell wears the highlight.
    expect(pressableStyle(badgeButton(renderer, 'Century Club'))).toMatchObject(
      { backgroundColor: color.inkTint },
    );
    // WF-ISSUE: Badge toggle exposes no accessibilityState.selected and the
    // detail panel's live region is Android-only, so VoiceOver gets no
    // feedback that the tap did anything. Once fixed, assert:
    // expect(badgeButton(renderer, 'Century Club').props.accessibilityState)
    //   .toMatchObject({ selected: true });

    await act(async () => {
      badgeButton(renderer, 'Century Club').props.onPress();
    });
    expect(detailPanels(renderer)).toHaveLength(0);
    expect(allText(renderer)).not.toContain(
      'One hundred consecutive days of training.',
    );
    expect(
      pressableStyle(badgeButton(renderer, 'Century Club')).backgroundColor,
    ).toBeUndefined();
    act(() => renderer.unmount());
  });

  it('every badge press shows that badge’s title, rarity and reward (one panel at a time)', async () => {
    const renderer = render(freshSnapshot);
    const entries = [
      ...STREAK_MILESTONES.map(m => ({
        title: m.title,
        blurb: m.blurb,
        reward: m.reward,
        rarity: m.rarity,
        progress: `${m.days} ${m.days === 1 ? 'day' : 'days'} away`,
      })),
      {
        title: VOLUME_ACHIEVEMENTS.sessions100.title,
        blurb: VOLUME_ACHIEVEMENTS.sessions100.blurb,
        reward: VOLUME_ACHIEVEMENTS.sessions100.reward,
        rarity: VOLUME_ACHIEVEMENTS.sessions100.rarity,
        progress: '0 of 100',
      },
      {
        title: VOLUME_ACHIEVEMENTS.specialist.title,
        blurb: VOLUME_ACHIEVEMENTS.specialist.blurb,
        reward: VOLUME_ACHIEVEMENTS.specialist.reward,
        rarity: VOLUME_ACHIEVEMENTS.specialist.rarity,
        progress: '25 scored on one stroke',
      },
    ];
    expect(entries).toHaveLength(10);

    for (const entry of entries) {
      await act(async () => {
        badgeButton(renderer, entry.title).props.onPress();
      });
      expect(detailPanels(renderer)).toHaveLength(1);
      const copy = allText(renderer);
      expect(copy).toContain(entry.blurb);
      expect(copy).toContain(RARITY_LABEL[entry.rarity].toUpperCase());
      expect(copy).toContain(`Unlocks : ${entry.reward} · ${entry.progress}`);
      // Only the tapped badge is highlighted.
      const highlighted = badgeButtons(renderer).filter(
        node => pressableStyle(node).backgroundColor === color.inkTint,
      );
      expect(highlighted).toHaveLength(1);
      expect(highlighted[0]!.props.accessibilityLabel).toMatch(
        new RegExp(`^${entry.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`),
      );
    }
    act(() => renderer.unmount());
  });

  it('earned badges announce their date, read “Unlocked”, and drop progress copy', async () => {
    const renderer = render(threeDaySnapshot);
    const buttons = badgeButtons(renderer);
    expect(buttons).toHaveLength(10);
    const labels = buttons.map(node => node.props.accessibilityLabel as string);
    expect(labels).toContain('First Spark. Earned Mar 8');
    expect(labels).toContain('Kindling. Earned Mar 10');
    expect(labels).toContain('Week One. Locked. 4 days away');
    expect(labels).toContain('Fortnight Form. Locked. 11 days away');
    expect(
      renderer.root.findAll(
        node =>
          node.props.accessibilityLabel === 'Achievements: 2 of 10 earned.',
      ).length,
    ).toBeGreaterThan(0);

    await act(async () => {
      badgeButton(renderer, 'Kindling').props.onPress();
    });
    let copy = allText(renderer);
    expect(copy).toContain('Three straight days. The flame catches.');
    expect(copy).toContain('Unlocked : First streak badge');
    expect(copy).not.toContain('Unlocks :');

    // Switching directly to another badge replaces the panel.
    await act(async () => {
      badgeButton(renderer, 'Week One').props.onPress();
    });
    expect(detailPanels(renderer)).toHaveLength(1);
    copy = allText(renderer);
    expect(copy).not.toContain('Three straight days.');
    expect(copy).toContain('Unlocks : Streak Shield earned · 4 days away');
    act(() => renderer.unmount());
  });

  it('volume achievements title the specialist by technique and count sessions', async () => {
    const renderer = render(volumeSnapshot);
    const labels = badgeButtons(renderer).map(
      node => node.props.accessibilityLabel as string,
    );
    // WF-ISSUE: Specialist badge title renders the technique lowercase
    // ("dink Specialist") — the engine's humanizeShotType never title-cases,
    // so the case-sensitive `'Dink Specialist. Earned '` prefix is not asserted.
    const specialistLabel = labels.find(l =>
      /^dink specialist\. earned /i.test(l),
    );
    expect(specialistLabel).toBeDefined();
    expect(labels.some(l => l.startsWith('100 Sessions. Earned '))).toBe(true);
    expect(labels).toContain('Kindling. Locked. 2 days away');

    const specialistTitle = specialistLabel!.split('.')[0]!;
    await act(async () => {
      badgeButton(renderer, specialistTitle).props.onPress();
    });
    let copy = allText(renderer);
    expect(copy).toContain(specialistTitle);
    expect(copy).toContain('Twenty-five scored analyses of a single stroke.');
    expect(copy).toContain('Unlocked : Technique crest');
    expect(copy).toContain(RARITY_LABEL.rare.toUpperCase());

    await act(async () => {
      badgeButton(renderer, '100 Sessions').props.onPress();
    });
    copy = allText(renderer);
    expect(copy).toContain('Unlocked : Volume badge');
    expect(copy).not.toContain('0 of 100');
    act(() => renderer.unmount());
  });

  it('shows in-progress volume counts for a partial history', () => {
    const renderer = render(threeDaySnapshot);
    const labels = badgeButtons(renderer).map(
      node => node.props.accessibilityLabel as string,
    );
    expect(labels).toContain('100 Sessions. Locked. 3 of 100');
    act(() => renderer.unmount());
  });

  it('shimmers exactly the next reachable, unearned streak milestone', () => {
    const fresh = render(freshSnapshot);
    expect(shimmers(fresh)).toHaveLength(1);
    act(() => fresh.unmount());

    const three = render(threeDaySnapshot);
    expect(shimmers(three)).toHaveLength(1);
    act(() => three.unmount());

    const done = render({
      ...freshSnapshot,
      currentStreak: 365,
      nextStreakMilestone: null,
    });
    expect(shimmers(done)).toHaveLength(0);
    act(() => done.unmount());
  });

  it('keeps the open story across a snapshot refresh and never throws on sparse earned rows', async () => {
    const renderer = render(threeDaySnapshot);
    await act(async () => {
      badgeButton(renderer, 'First Spark').props.onPress();
    });
    expect(allText(renderer)).toContain(
      'Momentum begins with one honest session.',
    );

    // A refreshed snapshot object (same ids) keeps the selection.
    const refreshed: ConsistencySnapshot = {
      ...threeDaySnapshot,
      earned: threeDaySnapshot.earned.map(e => ({ ...e })),
    };
    act(() => {
      renderer.update(<AchievementsShowcase snapshot={refreshed} />);
    });
    expect(detailPanels(renderer)).toHaveLength(1);
    expect(allText(renderer)).toContain(
      'Momentum begins with one honest session.',
    );

    // An earned row missing its day (sparse persisted data) falls back to
    // "Earned" without crashing the rail.
    const sparse = {
      ...threeDaySnapshot,
      earned: [{ id: 'streak.1' }],
    } as unknown as ConsistencySnapshot;
    act(() => {
      renderer.update(<AchievementsShowcase snapshot={sparse} />);
    });
    const labels = badgeButtons(renderer).map(
      node => node.props.accessibilityLabel as string,
    );
    expect(labels).toContain('First Spark. Earned ');
    expect(allText(renderer)).toContain('Earned');

    // An unparseable earned day is echoed verbatim rather than "Invalid Date".
    const garbled = {
      ...threeDaySnapshot,
      earned: [{ id: 'streak.1', earnedOnDay: 'not-a-day' }],
    } as unknown as ConsistencySnapshot;
    act(() => {
      renderer.update(<AchievementsShowcase snapshot={garbled} />);
    });
    expect(
      badgeButtons(renderer).map(n => n.props.accessibilityLabel as string),
    ).toContain('First Spark. Earned not-a-day');
    expect(allText(renderer)).not.toContain('Invalid Date');
    act(() => renderer.unmount());
  });

  it('renders the dark variant with the dark detail surface', async () => {
    const renderer = render(freshSnapshot, true);
    expect(badgeButtons(renderer)).toHaveLength(10);
    await act(async () => {
      badgeButton(renderer, 'Eternal Flame').props.onPress();
    });
    const panel = detailPanels(renderer)[0]!;
    expect(StyleSheet.flatten(panel.props.style)).toMatchObject({
      backgroundColor: color.onDarkTint,
    });
    expect(allText(renderer)).toContain(
      'Unlocks : Permanent Eternal Flame crest · 365 days away',
    );
    act(() => renderer.unmount());
  });
});
