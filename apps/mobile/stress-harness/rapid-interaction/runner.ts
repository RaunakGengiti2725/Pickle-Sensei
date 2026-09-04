/**
 * Executes one seeded burst against a mounted host and judges the
 * rapid-interaction invariants. The host owns mounting/navigation; the runner
 * owns the interaction script, the scripted world and the verdict.
 *
 * Invariants (each is a key of BurstRow.invariants):
 *   singleProviderRequest   one native/SDK sign-in call per accepted intent:
 *                           providerCalls == busy rising edges (minus the
 *                           missing-module attempts that never reach native)
 *                           and never two in flight
 *   tapLiveness             a tap on an ENABLED provider button while idle
 *                           always starts exactly one sign-in
 *   singleBootstrapRequest  bootstrapCalls == successful provider results,
 *                           never two in flight
 *   busyMirrorsSpinner      while the screen is mounted: store.busy ⇔ exactly
 *                           one spinner + "Signing in securely…"; both
 *                           provider buttons disabled ⇔ busy
 *   noDuplicateSurface      ≤1 sign-in body, ≤1 busy row, ≤1 error card, and
 *                           the host's own duplicate-route check
 *   errorCardMirrorsStore   error card ⇔ store.error present and not canceled
 *   noOrphanBusy            after the terminal drain: busy=false, no spinner,
 *                           no pending provider/bootstrap promise
 *   sessionLandsOnce        an accepted bootstrap ⇒ canonical session set, the
 *                           vault holds one record iff the server returned a
 *                           session, host landed post-auth; otherwise the
 *                           session is what it was at mount and the vault
 *                           is empty
 *   noSecretInKv            no issued token string ever reaches SQLite kv
 *   navigationSingleEffect  host-specific: every Back/enter intent produced
 *                           exactly one navigation effect
 *   noCrash                 RootErrorBoundary / "Something went wrong" never
 *                           rendered, no op threw
 *   noUnhandledNavAction    React Navigation never reported an action "not
 *                           handled by any navigator" (a GO_BACK dispatched
 *                           from a route already popped; dev-only red box)
 *   noConsoleErrors         no other console.error (act() warnings, state
 *                           updates on unmounted components, …)
 *   noUnhandledRejections   no unhandled promise rejection during the burst
 */
import { NativeModules, Text } from 'react-native';
import type TestRenderer from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { useAuthStore } from '../../src/auth/authStore';
import { BrandSpinner } from '../../src/design/components';
import type { FakeLocalDb } from '../../xc-harness/lifecycle-persistence/fakeLocalDb';
import { describePlan, type BurstPlan, type Op, type Target } from './plan';
import { Observer, ScriptedWorld } from './seams';

export type TapResult = 'pressed' | 'absent' | 'disabled';

const UNHANDLED_NAV_MARKER = 'was not handled by any navigator';

export interface Host {
  readonly name: string;
  /** Mounts the host with the sign-in surface visible and settled. */
  mount(plan: BurstPlan, world: ScriptedWorld): Promise<void>;
  unmount(): void;
  renderer(): TestRenderer.ReactTestRenderer | null;
  /** Presses a control synchronously (the runner wraps the call in act()). */
  tap(target: Target): TapResult;
  signInVisible(): boolean;
  /** True once the host has moved past sign-in for an established session. */
  postAuthLanded(): boolean;
  /** Host-specific navigation ledger for the row. */
  navObserved(): Record<string, unknown>;
  /** Terminal host-specific navigation failures (empty when held). */
  navFailures(): string[];
  /**
   * Called after every act(): returns host-specific failures for this tick,
   * each prefixed with its invariant name (`navigationSingleEffect: …`,
   * `noDuplicateSurface: …`).
   */
  afterAct(): string[];
  keychainRecords(): number;
  db(): FakeLocalDb;
}

export interface BurstRow {
  suite: string;
  seed: number;
  plan: string;
  inputs: BurstPlan;
  observed: Record<string, unknown>;
  invariants: Record<string, boolean>;
  ok: boolean;
  failed: string[];
  failures: string[];
  durationMs: number;
}

type ReactTestInstance = TestRenderer.ReactTestInstance;

export function controls(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
): ReactTestInstance[] {
  return renderer.root.findAll(
    node =>
      node.props['accessibilityLabel'] === label &&
      typeof node.props['onPress'] === 'function' &&
      node.props['accessibilityState'] !== undefined,
  );
}

export function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props['children'])
    .flat()
    .filter((child): child is string => typeof child === 'string')
    .join(' ');
}

const LABEL: Record<Exclude<Target, 'enter'>, string> = {
  apple: 'Continue with Apple',
  google: 'Continue with Google',
  back: 'Back',
  dismiss: 'Dismiss sign-in error',
};

export function labelFor(target: Exclude<Target, 'enter'>): string {
  return LABEL[target];
}

/** Presses a labelled control found in the renderer; shared by both hosts. */
export function tapLabelled(
  renderer: TestRenderer.ReactTestRenderer | null,
  target: Exclude<Target, 'enter'>,
): TapResult {
  if (!renderer) return 'absent';
  const found = controls(renderer, LABEL[target]);
  const node = found[0];
  if (!node) return 'absent';
  if (node.props['disabled'] === true) return 'disabled';
  (node.props['onPress'] as () => void)();
  return 'pressed';
}

interface Ledger {
  risingEdges: number;
  fallingEdges: number;
  missingModuleAttempts: number;
  taps: { op: number; target: Target; result: TapResult }[];
  livenessFailures: string[];
  continuousFailures: string[];
  opsExecuted: number;
  threw: string | null;
}

/** Wall time even under fake timers (`performance` is left unfaked). */
function wallClock(): number {
  return performance.now();
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

function continuousCheck(host: Host, ledger: Ledger, opIndex: number): void {
  const renderer = host.renderer();
  if (!renderer) return;
  const failures: string[] = [];
  const state = useAuthStore.getState();
  const text = allText(renderer);
  if (text.includes('Something went wrong')) {
    failures.push('noCrash: RootErrorBoundary fallback rendered');
  }
  const bodies = renderer.root.findAll(
    node =>
      typeof node.type === 'string' && node.props['testID'] === 'sign-in-body',
  ).length;
  if (bodies > 1) failures.push(`noDuplicateSurface: ${bodies} sign-in bodies`);
  failures.push(...host.afterAct());
  if (host.signInVisible()) {
    const spinners = renderer.root.findAllByType(BrandSpinner).length;
    const busyCopy = text.includes('Signing in securely…');
    if (state.busy !== (spinners === 1 && busyCopy) || spinners > 1) {
      failures.push(
        `busyMirrorsSpinner: busy=${state.busy} spinners=${spinners} copy=${busyCopy}`,
      );
    }
    for (const target of ['apple', 'google'] as const) {
      const found = controls(renderer, LABEL[target]);
      if (target === 'google' && found.length !== 1) {
        failures.push(`noDuplicateSurface: ${found.length} Google buttons`);
      }
      for (const node of found) {
        const disabled = node.props['disabled'] === true;
        const a11y =
          (node.props['accessibilityState'] as { disabled?: boolean })
            .disabled === true;
        if (disabled !== state.busy || a11y !== state.busy) {
          failures.push(
            `busyMirrorsSpinner: ${target} disabled=${disabled} a11y=${a11y} busy=${state.busy}`,
          );
        }
      }
    }
    const errorCards = controls(renderer, LABEL.dismiss).length;
    const expectCard = Boolean(
      state.error && state.error.code !== 'auth.canceled',
    );
    if (errorCards > 1) {
      failures.push(`noDuplicateSurface: ${errorCards} error cards`);
    }
    if ((errorCards === 1) !== expectCard) {
      failures.push(
        `errorCardMirrorsStore: cards=${errorCards} error=${state.error?.code ?? null}`,
      );
    }
  }
  for (const failure of failures) {
    ledger.continuousFailures.push(`op#${opIndex} ${failure}`);
  }
}

async function performTaps(
  host: Host,
  world: ScriptedWorld,
  ledger: Ledger,
  opIndex: number,
  targets: Target[],
): Promise<void> {
  const busyBefore = useAuthStore.getState().busy;
  const edgesBefore = ledger.risingEdges;
  const missingBefore = ledger.missingModuleAttempts;
  const results: TapResult[] = [];
  const natives = NativeModules as { PickleAuth?: unknown };
  await act(async () => {
    for (const target of targets) {
      const nothingPressedYet = !results.includes('pressed');
      if (
        target === 'apple' &&
        world.nextProviderOutcome() === 'missing-module' &&
        !busyBefore &&
        nothingPressedYet
      ) {
        // The build lacks the native module for THIS attempt only; the
        // store must fail fast (busy true→false in one tick) without a call.
        world.skipProviderOutcome();
        const module = natives.PickleAuth;
        delete natives.PickleAuth;
        const result = host.tap(target);
        natives.PickleAuth = module;
        results.push(result);
        ledger.taps.push({ op: opIndex, target, result });
        if (result === 'pressed') ledger.missingModuleAttempts += 1;
        continue;
      }
      const result = host.tap(target);
      results.push(result);
      ledger.taps.push({ op: opIndex, target, result });
    }
  });
  const providerPresses = targets.filter(
    (target, index) =>
      (target === 'apple' || target === 'google') &&
      results[index] === 'pressed',
  ).length;
  const providerPressed = providerPresses > 0;
  const edges = ledger.risingEdges - edgesBefore;
  // A missing-module attempt fails synchronously (busy true→false in the same
  // tick), so a later press in the same tick legitimately starts one more.
  const missingInAct = ledger.missingModuleAttempts - missingBefore;
  const expectedEdges =
    missingInAct + (providerPresses - missingInAct > 0 ? 1 : 0);
  if (providerPressed && !busyBefore && edges !== expectedEdges) {
    ledger.livenessFailures.push(
      `op#${opIndex} ${targets.join('+')} → ${edges} sign-in starts (expected ${expectedEdges})`,
    );
  }
  if (!providerPressed && edges !== 0) {
    ledger.livenessFailures.push(
      `op#${opIndex} ${targets.join('+')} → ${edges} sign-in starts without a provider press`,
    );
  }
  if (busyBefore && edges !== 0) {
    ledger.livenessFailures.push(
      `op#${opIndex} ${targets.join('+')} started ${edges} sign-ins while already busy`,
    );
  }
}

async function performOp(
  host: Host,
  world: ScriptedWorld,
  ledger: Ledger,
  opIndex: number,
  op: Op,
): Promise<void> {
  switch (op.kind) {
    case 'tap': {
      const targets: Target[] = [];
      for (let i = 0; i < op.times; i += 1) targets.push(op.target);
      await performTaps(host, world, ledger, opIndex, targets);
      return;
    }
    case 'simul':
      await performTaps(host, world, ledger, opIndex, op.targets);
      return;
    case 'resolve-provider':
      await act(async () => {
        world.resolveProvider();
        await Promise.resolve();
      });
      return;
    case 'resolve-bootstrap':
      await act(async () => {
        world.resolveBootstrap();
        await Promise.resolve();
      });
      return;
    case 'advance':
      await advance(op.ms);
      return;
    case 'spam-nav':
      for (let i = 0; i < op.times; i += 1) {
        const target: Target = host.signInVisible() ? 'back' : 'enter';
        await performTaps(host, world, ledger, opIndex, [target]);
        continuousCheck(host, ledger, opIndex);
      }
  }
}

export async function runBurst(
  suite: string,
  plan: BurstPlan,
  host: Host,
  observer: Observer,
): Promise<BurstRow> {
  const startedWall = wallClock();
  const t0 = Date.now();
  const world = new ScriptedWorld(
    plan.providerOutcomes,
    plan.bootstrapOutcomes,
    plan.latency,
    () => Date.now() - t0,
  );
  const ledger: Ledger = {
    risingEdges: 0,
    fallingEdges: 0,
    missingModuleAttempts: 0,
    taps: [],
    livenessFailures: [],
    continuousFailures: [],
    opsExecuted: 0,
    threw: null,
  };
  observer.begin();
  const unsubscribe = useAuthStore.subscribe((next, prev) => {
    if (!prev.busy && next.busy) ledger.risingEdges += 1;
    if (prev.busy && !next.busy) ledger.fallingEdges += 1;
  });

  let initialProvider: string | null = null;
  try {
    await host.mount(plan, world);
    initialProvider = useAuthStore.getState().session?.provider ?? null;
    continuousCheck(host, ledger, -1);
    for (const [index, op] of plan.ops.entries()) {
      await performOp(host, world, ledger, index, op);
      ledger.opsExecuted += 1;
      continuousCheck(host, ledger, index);
    }
    // Terminal drain: every pending promise settles, timers get 30s.
    await act(async () => {
      world.drain();
      await Promise.resolve();
    });
    await advance(30_000);
    // A second drain covers a bootstrap issued by the first drain's provider
    // resolution.
    await act(async () => {
      world.drain();
      await Promise.resolve();
    });
    await advance(1_000);
    continuousCheck(host, ledger, plan.ops.length);
  } catch (error) {
    ledger.threw =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
  }
  unsubscribe();

  const state = useAuthStore.getState();
  const renderer = host.renderer();
  const text = renderer ? allText(renderer) : '';
  const spinners = renderer
    ? renderer.root.findAllByType(BrandSpinner).length
    : 0;
  const observed = observer.snapshot();
  const kvValues = [...host.db().kv.values()].join('\n');
  const leakedSecrets = world.issuedSecrets.filter(secret =>
    kvValues.includes(secret),
  );
  const sessionExpected = world.acceptedBootstraps() > 0;
  const vaultExpected = world.sessionBootstraps() > 0 ? 1 : 0;
  const keychainRecords = host.keychainRecords();

  const failures: string[] = [];
  const invariants: Record<string, boolean> = {};
  const judge = (name: string, held: boolean, detail: string) => {
    invariants[name] = invariants[name] === false ? false : held;
    if (!held) failures.push(`${name}: ${detail}`);
  };

  const expectedProviderCalls =
    ledger.risingEdges - ledger.missingModuleAttempts;
  judge(
    'singleProviderRequest',
    world.providerCalls.length === expectedProviderCalls &&
      world.maxProviderInflight <= 1,
    `providerCalls=${world.providerCalls.length} risingEdges=${ledger.risingEdges} missingModule=${ledger.missingModuleAttempts} maxInflight=${world.maxProviderInflight}`,
  );
  judge(
    'tapLiveness',
    ledger.livenessFailures.length === 0,
    ledger.livenessFailures.join('; '),
  );
  judge(
    'singleBootstrapRequest',
    world.bootstrapCalls.length === world.successfulProviderCalls() &&
      world.maxBootstrapInflight <= 1,
    `bootstrapCalls=${world.bootstrapCalls.length} providerSuccesses=${world.successfulProviderCalls()} maxInflight=${world.maxBootstrapInflight}`,
  );
  const continuousByName = new Map<string, string[]>();
  for (const failure of ledger.continuousFailures) {
    const name = failure.replace(/^op#-?\d+ /, '').split(':')[0] ?? failure;
    const slot = continuousByName.get(name) ?? [];
    slot.push(failure);
    continuousByName.set(name, slot);
  }
  for (const name of [
    'busyMirrorsSpinner',
    'noDuplicateSurface',
    'errorCardMirrorsStore',
    'navigationSingleEffect',
    'noCrash',
  ]) {
    const list = continuousByName.get(name) ?? [];
    judge(name, list.length === 0, list.slice(0, 3).join('; '));
  }
  judge(
    'noCrash',
    ledger.threw === null && !text.includes('Something went wrong'),
    ledger.threw ?? 'error boundary rendered at end',
  );
  judge(
    'noOrphanBusy',
    !state.busy &&
      spinners === 0 &&
      world.pendingProviderCount === 0 &&
      world.pendingBootstrapCount === 0 &&
      ledger.risingEdges === ledger.fallingEdges,
    `busy=${state.busy} spinners=${spinners} pendingProvider=${world.pendingProviderCount} pendingBootstrap=${world.pendingBootstrapCount} edges=${ledger.risingEdges}/${ledger.fallingEdges}`,
  );
  judge(
    'sessionLandsOnce',
    sessionExpected
      ? Boolean(state.session) &&
          state.session?.provider !== 'guest' &&
          keychainRecords === vaultExpected &&
          host.postAuthLanded()
      : (state.session?.provider ?? null) === initialProvider &&
          keychainRecords === 0,
    `sessionExpected=${sessionExpected} session=${state.session?.provider ?? null} initial=${initialProvider} keychain=${keychainRecords}/${vaultExpected} landed=${host.postAuthLanded()}`,
  );
  judge(
    'noSecretInKv',
    leakedSecrets.length === 0,
    `leaked=${leakedSecrets.length}`,
  );
  const navFailures = host.navFailures();
  judge(
    'navigationSingleEffect',
    navFailures.length === 0,
    navFailures.slice(0, 3).join('; '),
  );
  const unhandledNav = observed.consoleErrors.filter(message =>
    message.includes(UNHANDLED_NAV_MARKER),
  );
  const otherErrors = observed.consoleErrors.filter(
    message => !message.includes(UNHANDLED_NAV_MARKER),
  );
  judge(
    'noUnhandledNavAction',
    unhandledNav.length === 0,
    `${unhandledNav.length}× ${unhandledNav[0]?.split('\n')[0] ?? ''}`,
  );
  judge(
    'noConsoleErrors',
    otherErrors.length === 0,
    otherErrors.slice(0, 3).join(' | '),
  );
  judge(
    'noUnhandledRejections',
    observed.unhandledRejections.length === 0,
    observed.unhandledRejections.slice(0, 3).join(' | '),
  );

  const failed = Object.entries(invariants)
    .filter(([, held]) => !held)
    .map(([name]) => name);
  return {
    suite,
    seed: plan.seed,
    plan: describePlan(plan),
    inputs: plan,
    observed: {
      opsExecuted: ledger.opsExecuted,
      taps: ledger.taps.length,
      pressed: ledger.taps.filter(tap => tap.result === 'pressed').length,
      disabledTaps: ledger.taps.filter(tap => tap.result === 'disabled').length,
      absentTaps: ledger.taps.filter(tap => tap.result === 'absent').length,
      busyRisingEdges: ledger.risingEdges,
      providerCalls: world.providerCalls,
      bootstrapCalls: world.bootstrapCalls,
      otherRequests: world.otherRequests,
      finalSession: state.session?.provider ?? null,
      finalError: state.error?.code ?? null,
      finalBusy: state.busy,
      finalText: text.slice(0, 300),
      keychainRecords,
      nav: host.navObserved(),
      consoleWarnings: observed.consoleWarnings.slice(0, 5),
      consoleErrors: observed.consoleErrors.slice(0, 5),
    },
    invariants,
    ok: failed.length === 0,
    failed,
    failures,
    durationMs: Math.round(wallClock() - startedWall),
  };
}
