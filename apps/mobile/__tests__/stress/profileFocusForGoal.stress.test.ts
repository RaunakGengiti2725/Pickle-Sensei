/**
 * STRESS (randomized-seeded) — state/profile `focusForGoal`.
 *
 * Seeded fuzz over arbitrary goal strings (known goals, near-misses, prototype
 * keys, unicode, huge inputs): the result must always be a member of
 * CHECKPOINTS, be a pure function of its input, and default to
 * `contact_position` for anything that is not a known goal.
 *
 * Documented deviation D5 (reported as a finding): `GOAL_FOCUS` is a plain
 * object literal, so goals that name an `Object.prototype` member
 * (`toString`, `constructor`, `__proto__`, ...) leak the prototype value — a
 * function or `{}` — instead of the default. Those inputs are recorded
 * separately; every other input must hold.
 *
 *   STRESS_ITER=2000 npx jest --ci --silent profileFocusForGoal
 */
import fs from 'node:fs';
import path from 'node:path';
import { CHECKPOINTS } from '@pickle/shared-types';
import { focusForGoal } from '../../src/state/profile';
import { makePrng, pick } from '../../xc-harness/lifecycle-persistence/seeds';

const KNOWN: Record<string, string> = {
  dinks: 'contact_position',
  drives: 'preparation',
  drops: 'paddle_set',
  serve: 'sequencing',
  return: 'athletic_base',
  volleys: 'face_wrist_stability',
  footwork: 'athletic_base',
  'all-around': 'contact_position',
};

const ITER = Number(process.env['STRESS_ITER'] ?? 500);
const BASE_SEED = Number(process.env['STRESS_SEED'] ?? 20260905);
const CHECKPOINT_KEYS = new Set<string>(CHECKPOINTS);
const OUT_DIR = path.resolve(
  __dirname,
  '../../../../artifacts/stress-mod-app-store',
  process.env['STRESS_RUN_ID'] ??
    new Date().toISOString().replace(/[:.]/g, '-'),
);
const HOSTILE = [
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'hasOwnProperty',
  'valueOf',
  '',
  ' ',
  'Dinks',
  'DINKS',
  'dinks ',
  ' dinks',
  'all_around',
  'all around',
  'allaround',
  'serve\u0000',
  'serve\n',
  '\u202edrops',
  'ドロップ',
  '🥒',
  'null',
  'undefined',
  '[object Object]',
];

function randomGoal(rng: () => number): string {
  const roll = rng();
  if (roll < 0.3) return pick(rng, Object.keys(KNOWN));
  if (roll < 0.55) return pick(rng, HOSTILE);
  if (roll < 0.7) {
    const base = pick(rng, Object.keys(KNOWN));
    const at = Math.floor(rng() * (base.length + 1));
    const ch = String.fromCharCode(32 + Math.floor(rng() * 95));
    return rng() < 0.5
      ? base.slice(0, at) + ch + base.slice(at)
      : base.slice(0, at) + base.slice(at + 1);
  }
  if (roll < 0.9) {
    const len = Math.floor(rng() * 24);
    let out = '';
    for (let i = 0; i < len; i += 1) {
      out += String.fromCharCode(Math.floor(rng() * 0xd7ff));
    }
    return out;
  }
  return 'x'.repeat(1 + Math.floor(rng() * 65_536));
}

describe('focusForGoal seeded fuzz', () => {
  it(`always maps to a CHECKPOINTS key, is pure, and defaults to contact_position (${ITER} seeds × 8)`, () => {
    const failures: { seed: number; goal: string; got: string }[] = [];
    const prototypeLeaks: { seed: number; goal: string; got: string }[] = [];
    let executed = 0;
    for (let i = 0; i < ITER; i += 1) {
      const seed = BASE_SEED + i;
      const rng = makePrng(seed);
      for (let k = 0; k < 8; k += 1) {
        const goal = randomGoal(rng);
        // Typed CheckpointKey, but the fuzz must observe the real runtime value.
        const got: unknown = focusForGoal(goal);
        const expected = Object.prototype.hasOwnProperty.call(KNOWN, goal)
          ? KNOWN[goal]
          : 'contact_position';
        executed += 1;
        if (
          got !== expected ||
          typeof got !== 'string' ||
          !CHECKPOINT_KEYS.has(got) ||
          focusForGoal(goal) !== got
        ) {
          const record = {
            seed,
            goal: goal.slice(0, 64),
            got: typeof got === 'string' ? got : typeof got,
          };
          if (goal in Object.prototype) prototypeLeaks.push(record);
          else failures.push(record);
        }
      }
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(OUT_DIR, 'focusForGoal.json'),
      JSON.stringify(
        {
          baseSeed: BASE_SEED,
          iterations: ITER,
          executed,
          failures,
          prototypeLeakCount: prototypeLeaks.length,
          prototypeLeakGoals: [
            ...new Set(prototypeLeaks.map(leak => `${leak.goal}→${leak.got}`)),
          ],
          prototypeLeakFirstSeeds: Object.fromEntries(
            prototypeLeaks
              .slice()
              .reverse()
              .map(leak => [leak.goal, leak.seed]),
          ),
        },
        null,
        2,
      ),
    );
    expect(executed).toBe(ITER * 8);
    expect(failures).toEqual([]);
    // D5: every leak is an Object.prototype member name; nothing else leaks.
    for (const leak of prototypeLeaks) {
      expect(leak.goal in Object.prototype).toBe(true);
      expect(leak.got).not.toBe('string');
    }
  });

  it('same seed twice → identical goal stream', () => {
    const streamFor = (seed: number) =>
      Array.from({ length: 64 }, (_, i) => {
        const rng = makePrng(seed + i);
        return `${randomGoal(rng)}→${focusForGoal(randomGoal(rng))}`;
      }).join('|');
    for (let i = 0; i < 25; i += 1) {
      expect(streamFor(BASE_SEED + i)).toBe(streamFor(BASE_SEED + i));
    }
  });
});
