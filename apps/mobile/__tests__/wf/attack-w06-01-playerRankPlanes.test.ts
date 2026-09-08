/**
 * W06-01 ADVERSARY — mobile plane (candidate devin/pp/w06-01/impl-r2 @
 * 9c47cf07).  The shipping app resolves the rank it SHOWS from two planes:
 * the device (`rankFromFacts` → shared `computePlayerRank`) and the account
 * (`summaryFromServer` over GET /v1/rank).  The canonical definition promises
 * that identical inputs produce comparable, version-tagged summaries on every
 * plane.  A failing test is a confirmed break; a passing one is an attack
 * that did not break anything.  Nothing here modifies the candidate.
 */
import type { RealAnalysisFact } from '../../src/data/repository';
import {
  rankFromFacts,
  resolvePlayerRank,
  summaryFromServer,
  type ServerPlayerRank,
} from '../../src/progress/playerRank';
import { SCORING_DEFINITION_VERSION } from '@pickle/shared-types';

const AT = '2026-08-01T10:00:00.000Z';

function fact(
  id: string,
  shotType: string,
  overallScore: number,
  capturedAt: string = AT,
): RealAnalysisFact {
  return {
    id,
    shotType,
    capturedAt,
    overallScore,
    confidence: 0.9,
    resultKind: 'scored',
    scoringModelVersion: 'sm-v1',
    shotConfigVersion: `${shotType}@1`,
    sessionId: null,
    priorityCheckpoint: null,
    checkpointScores: {},
  };
}

const FACTS = [
  fact('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'backhand', 6),
  fact('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Dink', 6),
  fact('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '_serve', 6),
];

/** The saved account rank the server holds for exactly the same three rows
 * (rating/tier/counts as SQL recompute_player_rank produces). */
const ACCOUNT: ServerPlayerRank = {
  rating: 6,
  tier: 'gold',
  techniqueCount: 3,
  scoredShotCount: 3,
  updatedAt: '2026-08-01T10:00:01.000Z',
  techniques: [
    { shotType: 'backhand', score: 6, capturedAt: AT, sampledCount: 1 },
    { shotType: 'Dink', score: 6, capturedAt: AT, sampledCount: 1 },
    { shotType: '_serve', score: 6, capturedAt: AT, sampledCount: 1 },
  ],
};

describe('W06-01 attack: mobile plane comparability', () => {
  it('the device summary carries the pinned definition version', () => {
    expect(rankFromFacts(FACTS)?.definitionVersion).toBe(
      SCORING_DEFINITION_VERSION,
    );
  });

  it('the summary the app shows after a reinstall (account plane) carries the same definition version', () => {
    // Equal evidence counts → the account copy wins (durable copy).  The
    // rank the user sees must be tagged with the definition it was computed
    // under, exactly like the device copy — otherwise the two planes are not
    // comparable and a definition bump on the server is invisible.
    const resolved = resolvePlayerRank(FACTS, ACCOUNT);
    expect(resolved?.source).toBe('account');
    expect(resolved?.summary.definitionVersion).toBe(
      SCORING_DEFINITION_VERSION,
    );
  });

  it('account and device summaries of identical inputs are identical', () => {
    const device = rankFromFacts(FACTS);
    const account = summaryFromServer(ACCOUNT);
    expect(account).toEqual(device);
  });

  it('equal-score techniques keep one order whichever plane produced them', () => {
    const device = rankFromFacts(FACTS)?.techniques.map(t => t.shotType);
    const account = summaryFromServer(ACCOUNT).techniques.map(t => t.shotType);
    // GET /v1/rank sorts by UTF-16 code units (`a.shot_type < b.shot_type`).
    const edgeOrder = [...ACCOUNT.techniques]
      .map(t => t.shotType)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(device).toEqual(edgeOrder);
    expect(account).toEqual(edgeOrder);
  });
});
