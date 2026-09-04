import {
  stageAfterGetStarted,
  stageAfterOnboarding,
  stageWhenLeavingOnboarding,
} from '../../src/flow/launchGate';
import type { PreAuthStage } from '../../src/flow/launchGate';

/**
 * Mutation pins for src/flow/launchGate.ts (harness:
 * tools/mutation/launch-gate/mutants.mjs).
 *
 * The existing `stageAfterGetStarted.length === 0` pin does NOT catch a
 * defaulted parameter — `function f(alreadyOnboarded = false)` still reports
 * `length 0` (ECMAScript counts parameters before the first default) while
 * happily routing a caller that passes `true` to sign-in. Mutant
 * `LG06-device-history-default-arg` survived the full suite on 4d812e1a for
 * exactly that reason. These pins call every stage function WITH inputs a
 * regressed caller might pass and require the answer to be unchanged: the
 * gate has no input that can flip it.
 */

type AnyInputStage = (...args: unknown[]) => PreAuthStage;

const HOSTILE_INPUTS: unknown[] = [
  true,
  false,
  1,
  0,
  'signin',
  'onboarding',
  'welcome',
  { alreadyOnboarded: true },
  { hasProfile: true, skip: true },
  [true],
  null,
  undefined,
  () => 'signin',
];

const asAnyInput = (fn: () => PreAuthStage): AnyInputStage =>
  fn as unknown as AnyInputStage;

describe('launchGate — no input can change the route', () => {
  it('stageAfterGetStarted ignores every argument (defaulted params included)', () => {
    const fn = asAnyInput(stageAfterGetStarted);
    for (const input of HOSTILE_INPUTS) {
      expect(fn(input)).toBe('onboarding');
      expect(fn(input, input)).toBe('onboarding');
    }
    expect(fn(...HOSTILE_INPUTS)).toBe('onboarding');
  });

  it('stageAfterOnboarding ignores every argument', () => {
    const fn = asAnyInput(stageAfterOnboarding);
    for (const input of HOSTILE_INPUTS) {
      expect(fn(input)).toBe('signin');
    }
    expect(fn(...HOSTILE_INPUTS)).toBe('signin');
  });

  it('stageWhenLeavingOnboarding ignores every argument', () => {
    const fn = asAnyInput(stageWhenLeavingOnboarding);
    for (const input of HOSTILE_INPUTS) {
      expect(fn(input)).toBe('welcome');
    }
    expect(fn(...HOSTILE_INPUTS)).toBe('welcome');
  });

  it('none of the stage functions declares a parameter or reads `arguments`', () => {
    // `length` misses defaulted/rest parameters, so also pin the compiled
    // source: no formal parameter list and no `arguments` access. Babel
    // downlevels `(x = false)` to an `arguments[0]` read, so both shapes of
    // a smuggled input are caught.
    for (const fn of [
      stageAfterGetStarted,
      stageAfterOnboarding,
      stageWhenLeavingOnboarding,
    ]) {
      expect(fn.length).toBe(0);
      const source = fn.toString();
      expect(source).toMatch(/^function\s+\w+\s*\(\s*\)/);
      expect(source).not.toMatch(/\barguments\b/);
    }
  });

  it('sign-in is reachable through the gate ONLY by finishing onboarding', () => {
    const outcomes: Record<string, PreAuthStage> = {
      afterGetStarted: stageAfterGetStarted(),
      afterOnboarding: stageAfterOnboarding(),
      whenLeavingOnboarding: stageWhenLeavingOnboarding(),
    };
    const routesToSignIn = Object.entries(outcomes)
      .filter(([, stage]) => stage === 'signin')
      .map(([name]) => name);
    expect(routesToSignIn).toEqual(['afterOnboarding']);
    // And the flow is a straight line: Welcome → onboarding → sign-in, with
    // the only backward edge landing on Welcome.
    expect(outcomes.afterGetStarted).toBe('onboarding');
    expect(outcomes.whenLeavingOnboarding).toBe('welcome');
  });
});
