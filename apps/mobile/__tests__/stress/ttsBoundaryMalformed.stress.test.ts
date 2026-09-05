/**
 * Boundary / malformed-input stress campaign for `src/audio/tts.ts`.
 *
 * Seeded and replayable: every iteration derives its seed from
 * (STRESS_SEED, index); `runIteration(seed)` reproduces any row on its own.
 *
 *   STRESS_ITER=3000 STRESS_SEED=20260905 STRESS_OUT=/tmp/tts-stress.json \
 *     npx jest --ci --silent __tests__/stress/ttsBoundaryMalformed
 *
 * Default iteration count is small so the suite stays fast in CI; the full
 * campaign is opt-in through STRESS_ITER. Results are written as a JSON table
 * (seed → outcome) when STRESS_OUT is set.
 *
 * Invariants that HOLD are asserted strictly. Invariants that are KNOWN
 * BROKEN on the current implementation (I5 availability contract, I6 native
 * exception containment) are pinned with `test.failing` so the suite is green
 * today and turns red the moment the wrapper is fixed — flip those to `test`
 * and add I5/I6 to HELD_INVARIANTS at that point.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PAYLOAD_CATEGORIES } from '../../__harness__/ttsStress/payloads';
import {
  INVARIANTS,
  NATIVE_VARIANTS,
  NativeBridgeError,
  installVariant,
  minimizeSeed,
  resetInstalledVariants,
  runCampaign,
  runIteration,
  type InvariantId,
} from '../../__harness__/ttsStress/runner';
import { deriveSeed } from '../../__harness__/ttsStress/rng';

const ITERATIONS = Math.max(1, Number(process.env.STRESS_ITER ?? '300') || 300);
const CAMPAIGN_SEED = Number(process.env.STRESS_SEED ?? '20260905') || 20260905;
const OUT = process.env.STRESS_OUT;

const HELD_INVARIANTS: readonly InvariantId[] = [
  'I1-absent-engine-noop',
  'I2-healthy-never-throws',
  'I3-forward-identity',
  'I4-available-boolean',
  'I7-no-prototype-pollution',
  'I8-no-input-mutation',
  'I9-no-console-noise',
  'I10-rate-sane',
  'I11-late-registration-consistent',
];

const KNOWN_BROKEN_INVARIANTS: readonly InvariantId[] = [
  'I5-availability-contract',
  'I6-native-exception-contained',
];

// The campaign needs generous time at STRESS_ITER >= 3000 (megabyte payloads).
jest.setTimeout(Math.max(30_000, ITERATIONS * 60));

afterAll(() => {
  resetInstalledVariants();
});

describe(`tts boundary/malformed stress campaign (seed=${CAMPAIGN_SEED}, iterations=${ITERATIONS})`, () => {
  test('every HELD invariant holds for every seed; BROKEN rows are explained only by the known-broken invariants', () => {
    const started = Date.now();
    const { summary, rows } = runCampaign({
      campaignSeed: CAMPAIGN_SEED,
      iterations: ITERATIONS,
    });
    const elapsedMs = Date.now() - started;

    if (OUT) {
      const minimized = summary.brokenSeeds
        .slice(0, 200)
        .map(b => minimizeSeed(b.seed));
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(
        OUT,
        JSON.stringify(
          {
            unit: 'apps/mobile/src/audio/tts.ts',
            lens: 'boundary-malformed',
            gitSha: process.env.STRESS_GIT_SHA ?? null,
            generatedAt: new Date().toISOString(),
            node: process.version,
            elapsedMs,
            invariants: INVARIANTS,
            heldInvariants: HELD_INVARIANTS,
            knownBrokenInvariants: KNOWN_BROKEN_INVARIANTS,
            summary,
            minimized,
            rows,
          },
          null,
          1,
        ),
      );
    }

    expect(summary.executed).toBe(ITERATIONS);
    expect(summary.held + summary.broken).toBe(ITERATIONS);

    for (const id of HELD_INVARIANTS) {
      expect({
        invariant: id,
        violations: summary.byInvariant[id] ?? 0,
      }).toEqual({
        invariant: id,
        violations: 0,
      });
    }
    for (const row of rows) {
      if (row.outcome === 'BROKEN') {
        const unexplained = row.violated.filter(
          v => !KNOWN_BROKEN_INVARIANTS.includes(v),
        );
        expect({ seed: row.seed, variant: row.variant, unexplained }).toEqual({
          seed: row.seed,
          variant: row.variant,
          unexplained: [],
        });
      }
    }

    // Coverage: at the default size every variant and every payload category
    // must have been exercised at least once, otherwise the campaign is not
    // testing what it claims.
    if (ITERATIONS >= 300) {
      for (const variant of NATIVE_VARIANTS) {
        expect({
          variant,
          executed: summary.byVariant[variant]?.executed ?? 0,
        }).not.toEqual({ variant, executed: 0 });
      }
      for (const category of PAYLOAD_CATEGORIES) {
        expect({
          category,
          speaks: summary.byCategory[category]?.speaks ?? 0,
        }).not.toEqual({ category, speaks: 0 });
      }
      // Oversize payloads must actually have crossed the 64 KiB line.
      expect(summary.maxTextUtf8Bytes).toBeGreaterThanOrEqual(64 * 1024);
    }
  });

  test('a seed replays to an identical row (determinism)', () => {
    const sample = Math.min(ITERATIONS, 40);
    for (let i = 0; i < sample; i += 1) {
      const seed = deriveSeed(CAMPAIGN_SEED, i);
      const first = runIteration(seed, i);
      resetInstalledVariants();
      const second = runIteration(seed, i);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    }
  });
});

describe('minimal reproductions of the known-broken invariants (test.failing: green while broken, red when fixed)', () => {
  test.failing(
    'I6 — a native speak() that throws is contained by tts.speak (variant throwing-speak)',
    () => {
      const { tts } = installVariant('throwing-speak');
      expect(() => tts.speak('Paddle up')).not.toThrow();
    },
  );

  test.failing(
    'I6 — a native stop() that throws is contained by tts.stop (variant throwing-stop)',
    () => {
      const { tts } = installVariant('throwing-stop');
      expect(() => tts.stop()).not.toThrow();
    },
  );

  test.failing(
    'I5 — available()===true implies speak() does not throw a JS TypeError (variant speak-non-function)',
    () => {
      const { tts } = installVariant('speak-non-function');
      expect(tts.available()).toBe(true);
      expect(() => tts.speak('Paddle up')).not.toThrow();
    },
  );

  test.failing(
    'I5 — available()===false implies speak() is a no-op (variant stop-only)',
    () => {
      const { tts } = installVariant('stop-only');
      expect(tts.available()).toBe(false);
      expect(() => tts.speak('Paddle up')).not.toThrow();
    },
  );

  test('what actually happens today (characterization, so the failure mode is on record)', () => {
    const throwing = installVariant('throwing-speak');
    expect(() => throwing.tts.speak('Paddle up')).toThrow(NativeBridgeError);

    const nonFn = installVariant('speak-non-function');
    expect(nonFn.tts.available()).toBe(true);
    expect(() => nonFn.tts.speak('Paddle up')).toThrow(TypeError);

    const stopOnly = installVariant('stop-only');
    expect(stopOnly.tts.available()).toBe(false);
    expect(() => stopOnly.tts.speak('Paddle up')).toThrow(TypeError);
    expect(() => stopOnly.tts.stop()).not.toThrow();
  });
});

describe('deterministic boundary probes (no RNG)', () => {
  test('absent engine: available()===false and 1000 rapid speak/stop cues are silent no-ops', () => {
    const { tts } = installVariant('absent-undefined');
    expect(tts.available()).toBe(false);
    for (let i = 0; i < 1000; i += 1) {
      expect(() => tts.speak(`cue ${i}`)).not.toThrow();
      expect(() => tts.stop()).not.toThrow();
    }
  });

  test('healthy engine: a 1 MiB cue, a lone surrogate, a null byte and an NFD cue are forwarded by reference with rate 0.5', () => {
    const { tts, recorder } = installVariant('healthy');
    const inputs = [
      'x'.repeat(1024 * 1024),
      'Paddle \ud83c up',
      'Paddle\u0000up',
      'Cafe\u0301',
      '',
      '   ',
    ];
    for (const text of inputs) tts.speak(text);
    expect(recorder.calls.map(c => c.method)).toEqual(
      inputs.map(() => 'speak'),
    );
    recorder.calls.forEach((call, i) => {
      expect(Object.is(call.args[0], inputs[i])).toBe(true);
      expect(call.args[1]).toBe(0.5);
    });
  });

  test('healthy engine: 500 interleaved speak/stop cues preserve order and count (rapid cues / interruption)', () => {
    const { tts, recorder } = installVariant('healthy');
    const expected: string[] = [];
    for (let i = 0; i < 500; i += 1) {
      if (i % 3 === 2) {
        tts.stop();
        expected.push('stop');
      } else {
        tts.speak(`cue ${i}`);
        expected.push('speak');
      }
    }
    expect(recorder.calls.map(c => c.method)).toEqual(expected);
  });

  test('prototype-pollution payloads leave Object.prototype untouched', () => {
    const { tts } = installVariant('healthy');
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const speak = tts.speak as (text: unknown) => void;
    speak(JSON.parse('{"__proto__":{"polluted":"tts"}}'));
    speak(JSON.parse('{"constructor":{"prototype":{"polluted":"tts"}}}'));
    speak('__proto__');
    speak({ ['__proto__']: { polluted: 'tts' } });
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
  });
});
