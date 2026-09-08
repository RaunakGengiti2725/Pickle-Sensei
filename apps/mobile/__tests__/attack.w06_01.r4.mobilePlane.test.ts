/**
 * W06-01 ADVERSARY (round 4, candidate devin/pp/w06-01/impl-r4 @ 61206685)
 * — the mobile plane against the canonical definition.
 *
 * The objective promises that mobile, Edge and SQL rank computations can be
 * checked against identical inputs.  On the device two summaries exist for
 * the same evidence: `rankFromFacts` (the shared formula over local history)
 * and `summaryFromServer` (GET /v1/rank rebuilt).  `resolvePlayerRank`
 * swaps between them by evidence count, so any difference between the two
 * for identical inputs is a visible rank-card change without new evidence.
 *
 * Test-only; lives outside the package's write_paths (apps/mobile) because
 * that is where the behaviour under attack lives.
 */
import {
  computePlayerRank,
  SCORING_DEFINITION,
  SCORING_DEFINITION_VERSION,
  type PlayerRankAnalysisInput,
} from '@pickle/shared-types';
import {
  parsePlayerRank,
  rankFromFacts,
  resolvePlayerRank,
  summaryFromServer,
  type ServerPlayerRank,
} from '../src/progress/playerRank';

const AT = '2026-08-01T10:00:00Z';

function scored(id: string, shotType: string, score: number, capturedAt = AT) {
  return {
    id,
    shotType,
    overallScore: score,
    resultKind: 'scored',
    capturedAt,
    source: 'real',
  };
}

/** GET /v1/rank wire shape for exactly the summary the SQL plane holds for
 * `inputs` — built from the shared formula itself, so the two device
 * summaries below start from provably identical evidence. */
function serverPayloadFor(inputs: readonly PlayerRankAnalysisInput[]) {
  const summary = computePlayerRank(inputs);
  if (summary === null) throw new Error('fixture inputs must rank');
  return {
    rank: {
      rating: summary.rating,
      tier: summary.tier,
      techniqueCount: summary.techniqueCount,
      scoredShotCount: summary.scoredAnalysisCount,
      updatedAt: AT,
      techniques: [...summary.techniques]
        // the server view is read in an arbitrary row order; ordering is the
        // consumer's job per the definition (score desc, code-unit shot type)
        .reverse()
        .map(t => ({
          shot_type: t.shotType,
          score: t.score,
          captured_at: t.capturedAt,
          sampled_count: t.sampledCount ?? 1,
        })),
    },
  };
}

describe('W06-01 r4 attack: account and device summaries of identical inputs', () => {
  const inputs = [
    scored('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'Dink', 6),
    scored('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'backhand', 6),
    scored('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', '_lob', 6),
    scored('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', 'drive', 6),
  ];

  it('list techniques in the same order (definition: score desc, UTF-16 code-unit shot type)', () => {
    expect(SCORING_DEFINITION.components.rating.techniqueOrder.keys[1]).toEqual(
      {
        field: 'shotType',
        direction: 'asc',
        collation: 'code-unit',
      },
    );
    const device = rankFromFacts(inputs);
    const server = parsePlayerRank(serverPayloadFor(inputs));
    expect(device).not.toBeNull();
    expect(server).not.toBeNull();
    const account = summaryFromServer(server as ServerPlayerRank);
    expect(account.techniques.map(t => t.shotType)).toEqual(
      (device as NonNullable<typeof device>).techniques.map(t => t.shotType),
    );
  });

  it('carry the definition version so a rank can be traced to its formula', () => {
    const server = parsePlayerRank(serverPayloadFor(inputs));
    const account = summaryFromServer(server as ServerPlayerRank);
    expect(account.definitionVersion).toBe(SCORING_DEFINITION_VERSION);
  });

  it('resolvePlayerRank never swaps between two different renderings of the same evidence', () => {
    const server = parsePlayerRank(
      serverPayloadFor(inputs),
    ) as ServerPlayerRank;
    // Account leads (ties go to the account) …
    const fromAccount = resolvePlayerRank(inputs, server);
    // … one more local analysis and the device leads.
    const fromDevice = resolvePlayerRank(
      [...inputs, scored('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5', 'serve', 6)],
      server,
    );
    expect(fromAccount?.source).toBe('account');
    expect(fromDevice?.source).toBe('device');
    // Same first four techniques, same scores: the order the card shows
    // must not change just because the evidence source flipped.
    expect(
      fromDevice?.summary.techniques.slice(0, 4).map(t => t.shotType),
    ).toEqual(fromAccount?.summary.techniques.map(t => t.shotType));
  });
});
