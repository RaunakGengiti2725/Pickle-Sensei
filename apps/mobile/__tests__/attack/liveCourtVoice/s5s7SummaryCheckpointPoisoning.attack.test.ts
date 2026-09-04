/**
 * ADVERSARIAL S5 + S7 (mobile-live-court-voice, pass 3) — stored summary
 * rows carrying NON-checkpoint strings into the progression layer.
 *
 * The summary JSON lives in SQLite (`local_session.summary`) and is "parsed
 * strictly" by parseLiveSessionSummaryRecord (liveSessionSummary.ts L78-130)
 * — the ONLY validation boundary between stored bytes and whatever Progress
 * surface consumes buildGameplayProgression. Live Court UI is dormant on
 * 4d812e1a, so the assertions target the parser/progression output itself:
 *   S5: correctionsByCheckpoint {"__proto__":1,"not_a_checkpoint":2} — keys
 *       that are not CheckpointKey must be dropped.
 *   S7: topCorrection that is not a CheckpointKey (arbitrary text, markup,
 *       10k unicode) must never reach a GameplaySessionPoint.
 */
import { CHECKPOINTS } from '@pickle/shared-types';
import type { LiveSessionHistoryRow } from '../../../src/data/repository';
import {
  parseLiveSessionSummaryRecord,
  type LiveSessionSummaryRecordV1,
} from '../../../src/flow/liveSessionSummary';
import { buildGameplayProgression } from '../../../src/progress/gameplayProgression';

const CHECKPOINT_SET: ReadonlySet<string> = new Set(CHECKPOINTS);

function baseRecord(
  overrides: Partial<LiveSessionSummaryRecordV1> = {},
): LiveSessionSummaryRecordV1 {
  return {
    version: 1,
    engineVersion: 'attack-engine',
    source: 'live',
    durationMs: 60_000,
    strokeCount: 6,
    scoredCount: 5,
    noReadCount: 1,
    pendingCount: 0,
    startAverage: 6.0,
    endAverage: 6.4,
    delta: 0.4,
    bestScore: 7.0,
    sessionAverage: 6.2,
    cuesSpoken: 5,
    topCorrection: 'athletic_base',
    correctionsByCheckpoint: { athletic_base: 3 },
    ...overrides,
  };
}

function row(id: string, summary: string): LiveSessionHistoryRow {
  return {
    id,
    startedAt: '2026-09-04T10:00:00.000Z',
    endedAt: '2026-09-04T10:05:00.000Z',
    summary,
  };
}

describe('ADVERSARIAL S5: correctionsByCheckpoint with __proto__ / unknown keys', () => {
  // Built as a raw string: an object-literal `__proto__: 1` would set the
  // prototype instead of producing the JSON key. Stored rows are bytes.
  const poisoned = JSON.stringify(baseRecord()).replace(
    /"correctionsByCheckpoint":\{[^}]*\}/,
    '"correctionsByCheckpoint":{"__proto__":1,"not_a_checkpoint":2,"athletic_base":3,"constructor":4,"toString":5,"":6,"🥒":7}',
  );

  it('precondition: the stored bytes really carry the __proto__ key', () => {
    expect(poisoned).toContain('"__proto__":1');
    const raw = JSON.parse(poisoned) as { correctionsByCheckpoint: object };
    expect(
      Object.prototype.hasOwnProperty.call(
        raw.correctionsByCheckpoint,
        '__proto__',
      ),
    ).toBe(true);
  });

  it('parser keeps only canonical CheckpointKey entries', () => {
    const parsed = parseLiveSessionSummaryRecord(poisoned);
    expect(parsed).not.toBeNull();
    const keys = Object.keys(parsed!.correctionsByCheckpoint);
    expect(keys.every(key => CHECKPOINT_SET.has(key))).toBe(true);
    expect(parsed!.correctionsByCheckpoint).toEqual({ athletic_base: 3 });
  });

  it('the parsed object owns no "__proto__" data property and its prototype is untouched', () => {
    const parsed = parseLiveSessionSummaryRecord(poisoned)!;
    const corrections = parsed.correctionsByCheckpoint;
    expect(Object.prototype.hasOwnProperty.call(corrections, '__proto__')).toBe(
      false,
    );
    expect(Object.getPrototypeOf(corrections)).toBe(Object.prototype);
    // Global prototype must not have been polluted by the parse.
    expect(({} as Record<string, unknown>).not_a_checkpoint).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('a JSON `__proto__` object value cannot pollute Object.prototype through the parser', () => {
    const attack =
      '{"version":1,"source":"live","correctionsByCheckpoint":{"__proto__":{"polluted":"yes"}},"strokeCount":1}';
    const parsed = parseLiveSessionSummaryRecord(attack);
    expect(parsed).not.toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(parsed!.correctionsByCheckpoint).toEqual({});
  });

  it('huge key sets (10k unknown keys) are all dropped, not passed to the UI', () => {
    const corrections: Record<string, number> = {};
    for (let i = 0; i < 10_000; i += 1) corrections[`junk_${i}`] = i;
    corrections.contact_position = 2;
    const parsed = parseLiveSessionSummaryRecord(
      JSON.stringify(baseRecord({ correctionsByCheckpoint: corrections })),
    )!;
    expect(Object.keys(parsed.correctionsByCheckpoint)).toEqual([
      'contact_position',
    ]);
  });

  it('EVIDENCE: today the parser forwards every string key with a safe-integer value', () => {
    const parsed = parseLiveSessionSummaryRecord(poisoned)!;
    // Passes on 4d812e1a — observed shape for the finding.
    expect(Object.keys(parsed.correctionsByCheckpoint).sort()).toEqual(
      [
        '',
        'athletic_base',
        'constructor',
        'not_a_checkpoint',
        'toString',
        '__proto__',
        '🥒',
      ].sort(),
    );
    expect(
      Object.prototype.hasOwnProperty.call(
        parsed.correctionsByCheckpoint,
        '__proto__',
      ),
    ).toBe(true);
    // Reading `.__proto__` on the parsed map now yields the stored number,
    // not the prototype — any consumer walking keys sees a bogus checkpoint.
    expect(
      (parsed.correctionsByCheckpoint as Record<string, unknown>).__proto__,
    ).toBe(1);
  });
});

describe('ADVERSARIAL S7: topCorrection that is not a checkpoint', () => {
  const arbitrary = [
    'not_a_checkpoint',
    '<script>alert(1)</script>',
    'Your form is terrible — quit now',
    '🥒'.repeat(10_000),
    '',
    ' athletic_base',
    'ATHLETIC_BASE',
    '__proto__',
  ];

  it.each(arbitrary.map(text => [text.slice(0, 30), text]))(
    'parser nulls a non-checkpoint topCorrection (%s)',
    (_label, text) => {
      const parsed = parseLiveSessionSummaryRecord(
        JSON.stringify(baseRecord({ topCorrection: text })),
      );
      expect(parsed).not.toBeNull();
      expect(parsed!.topCorrection).toBeNull();
    },
  );

  it('parser preserves a canonical topCorrection', () => {
    for (const key of CHECKPOINTS) {
      const parsed = parseLiveSessionSummaryRecord(
        JSON.stringify(baseRecord({ topCorrection: key })),
      );
      expect(parsed!.topCorrection).toBe(key);
    }
  });

  it('buildGameplayProgression never exposes an arbitrary stored topCorrection string', () => {
    const rows = arbitrary.map((text, i) =>
      row(`s${i}`, JSON.stringify(baseRecord({ topCorrection: text }))),
    );
    const progression = buildGameplayProgression(rows);
    expect(progression.sessions).toHaveLength(rows.length);
    for (const session of progression.sessions) {
      expect(
        session.topCorrection === null ||
          CHECKPOINT_SET.has(session.topCorrection),
      ).toBe(true);
    }
  });

  it('EVIDENCE: today the stored text is forwarded verbatim to the session point', () => {
    const text = '<script>alert(1)</script>';
    const progression = buildGameplayProgression([
      row('s0', JSON.stringify(baseRecord({ topCorrection: text }))),
    ]);
    // Passes on 4d812e1a — observed shape for the finding.
    expect(progression.sessions[0]?.topCorrection).toBe(text);
  });
});
