import { badgeArtFor } from '../../src/consistency/MilestoneBadge';
import {
  STREAK_MILESTONES,
  streakMilestoneById,
  VOLUME_ACHIEVEMENTS,
} from '../../src/consistency/milestones';

/**
 * Reward copy is shown verbatim in the AchievementsShowcase detail panel
 * ("Unlocks: <reward>") and the StreakCelebration ceremony. It must only
 * promise things the app actually grants — badge art, shields, XP,
 * ceremony effects — never features that do not exist (App Review 2.1).
 */

const UNIMPLEMENTED_REWARD_WORDS = /\b(emblem|frame|theme|avatar|title)\b/i;

describe('milestone reward copy', () => {
  const allDefinitions = [
    ...STREAK_MILESTONES,
    ...Object.values(VOLUME_ACHIEVEMENTS),
  ];

  it('never advertises a reward the app does not implement', () => {
    for (const definition of allDefinitions) {
      expect(definition.reward).not.toMatch(UNIMPLEMENTED_REWARD_WORDS);
    }
  });

  it('describes the badge art that streak.14 and streak.30 actually grant', () => {
    expect(badgeArtFor('streak.14').glyph).toBe('paddles');
    expect(streakMilestoneById('streak.14')?.reward).toBe(
      'Rare crossed-paddles badge',
    );

    expect(badgeArtFor('streak.30').glyph).toBe('laurel');
    expect(streakMilestoneById('streak.30')?.reward).toBe('Epic laurel badge');
  });

  it('gives every advertised badge its own artwork', () => {
    for (const definition of allDefinitions) {
      if (/\b(badge|crest)\b/i.test(definition.reward)) {
        expect(badgeArtFor(definition.id)).not.toEqual(badgeArtFor('__none__'));
      }
    }
  });
});
