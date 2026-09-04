/**
 * Executable model of the OnboardingScreen as mounted by the REAL `App` gate
 * (`App.tsx` → `Gate` → `<OnboardingScreen mode="preauth" | account>`), used
 * by the seeded randomized stress suite in
 * `__tests__/stress/scr-onboardingscreen/`.
 *
 * The model is a pure reducer over the screen's public surface (the controls
 * a user can reach: header Back / Leave setup, the name field, the choice
 * cards, Continue, the leave dialog, the two notification buttons, plus the
 * Welcome / Sign-in controls the gate shows around the screen) and the
 * environment a device can be in (SQLite writes failing, the account server
 * failing, the OS permission prompt answer). After every action the suite
 * derives the expected observation from the model and compares it with what
 * the real tree renders and what the real stores persisted.
 *
 * Invariants checked after EVERY action (documented here, enforced in the
 * suite's `compare()`):
 *
 *  I1  Step counter: the progressbar `now` equals the model step (1..8) and
 *      never leaves that range; Continue is rendered on steps 1–7 only.
 *  I2  Gate: Continue is disabled exactly when the step is incomplete (empty
 *      / whitespace-only name, unanswered choice); the keyboard Next key
 *      obeys the same rule.
 *  I3  Choices never auto-advance and exactly the chosen card is selected;
 *      answers survive Back/forward.
 *  I4  Header: step 1 offers "Leave setup" in account mode and a plain
 *      "Back" (to Welcome) in pre-auth mode; steps 2–8 offer "Back". No
 *      "Skip" / guest affordance ever renders (onboarding is required).
 *  I5  Leave dialog: opens only from account step 1, "Keep setting up"
 *      closes it, "Sign out" signs out (Welcome).
 *  I6  Finish guard: while a finish is in flight both notification buttons
 *      are disabled and the primary reads "Finishing setup…"; a second tap
 *      never starts a second save (PUT count / stash write count).
 *  I7  Persistence contract: pre-auth success writes
 *      `onboarding.pending-profile` = {version:1, profile} and
 *      `onboarding.pending-notifications` = {version:1, enabled} and only
 *      THEN hands off to Sign-in; a failed stash write keeps the user on the
 *      notifications step with the error shown and no hand-off. Account
 *      success PUTs `/v1/me/onboarding` (once; twice when the first attempt
 *      failed and identity fields were present) and writes `profile:<owner>`
 *      with the SERVER's checkpoint, then enters the app; a failed save stays
 *      on the step with the error visible.
 *  I8  The notification choice is asked once per screen instance: retries
 *      after a failed save never re-request permission or rewrite the
 *      pending notification choice.
 *  I9  Re-entering onboarding (Welcome → Get started, or after sign-out)
 *      starts a blank questionnaire.
 *  I10 Determinism: replaying the same seed yields an identical trace.
 *
 * Timing convention: a tap only runs the synchronous part of a handler
 * (busy flag, permission prompt request); every store write and server call
 * is real I/O that completes at the next `settle`, under the environment in
 * force at THAT moment. The one value captured at tap time is the permission
 * prompt's answer (the prompt is shown when the request is made).
 */

import { canonicalDataOwner } from '../../src/data/accountScope';
import { focusForGoal } from '../../src/state/profile';
import {
  CANONICAL_ID,
  makePrng,
} from '../../xc-harness/lifecycle-persistence/seeds';

/** Owner the account-mode scenarios sign in as (vault record → refresh). */
export const ACCOUNT_OWNER = canonicalDataOwner(CANONICAL_ID);

export const STEPS = [
  'name',
  'gender',
  'level',
  'handedness',
  'goal',
  'problem',
  'reveal',
  'notifications',
] as const;
export type Step = (typeof STEPS)[number];
export type ChoiceStep = 'gender' | 'level' | 'handedness' | 'goal' | 'problem';

export const CHOICES: Record<
  ChoiceStep,
  readonly { label: string; value: string }[]
> = {
  gender: [
    { value: 'female', label: 'Female' },
    { value: 'male', label: 'Male' },
    { value: 'nonbinary', label: 'Non-binary' },
    { value: 'prefer_not_to_say', label: 'Prefer not to say' },
  ],
  level: [
    { value: 'Beginner', label: 'Brand new' },
    { value: '2.5', label: '2.5' },
    { value: '3.0', label: '3.0' },
    { value: '3.5', label: '3.5' },
    { value: '4.0', label: '4.0' },
    { value: '4.5', label: '4.5' },
    { value: '5.0+', label: '5.0+' },
  ],
  handedness: [
    { value: 'right', label: 'Right-handed' },
    { value: 'left', label: 'Left-handed' },
  ],
  goal: [
    { value: 'dinks', label: 'Dinks' },
    { value: 'drives', label: 'Drives' },
    { value: 'drops', label: 'Third-shot drops' },
    { value: 'serve', label: 'Serve' },
    { value: 'volleys', label: 'Volleys' },
    { value: 'footwork', label: 'Footwork' },
    { value: 'all-around', label: 'All-around' },
  ],
  problem: [
    { value: 'consistency', label: 'Consistency' },
    { value: 'control', label: 'Control' },
    { value: 'power', label: 'Power' },
    { value: 'contact', label: 'Contact' },
    { value: 'footwork', label: 'Footwork' },
    { value: 'placement', label: 'Placement' },
    { value: 'not sure', label: 'Not sure' },
  ],
};

export const ALL_CHOICE_LABELS: readonly string[] = Array.from(
  new Set(
    (Object.keys(CHOICES) as ChoiceStep[]).flatMap(step =>
      CHOICES[step].map(choice => choice.label),
    ),
  ),
);

/** Names typed into the field: legal, boundary and near-legal inputs. The
 * native `maxLength={40}` stops longer text on device, so nothing generated
 * here exceeds 40 characters. */
export const NAME_INPUTS: readonly string[] = [
  '',
  ' ',
  '   ',
  '\n',
  '\t ',
  'D',
  'Dana',
  ' Dana ',
  'Mary Ann',
  'José',
  'Zoë-Marie',
  "O'Brien",
  '李',
  '🙂',
  'Anne 🙂',
  'a'.repeat(40),
  ' '.repeat(39) + 'x',
  'x' + ' '.repeat(39),
  '<b>Dana</b>',
  'Robert"); DROP TABLE kv;--',
];

/** The server's answer to `PUT /v1/me/onboarding` in account mode. Fixed to
 * a value the client mapping never produces for most goals so "server
 * checkpoint wins" is observable. */
export const SERVER_RECOMMENDED_CHECKPOINT = 'sequencing';
export const SERVER_FAILURE_MESSAGE = 'Simulated account server failure.';
export const NETWORK_FAILURE_MESSAGE =
  'Your coaching profile could not be securely saved. Check your connection and try again.';

export type Mode = 'account' | 'preauth';
export type ServerMode = 'ok' | 'error-500' | 'network';
export type Permission = 'granted' | 'denied';
export type NotificationChoice = 'enable' | 'not_now';

export interface Env {
  dbWriteFails: boolean;
  server: ServerMode;
  permission: Permission;
}

export type Action =
  | { kind: 'typeName'; text: string }
  | { kind: 'submitName' }
  | { kind: 'pressChoice'; label: string }
  | { kind: 'pressContinue' }
  | { kind: 'pressBack' }
  | { kind: 'pressDialog'; label: 'Keep setting up' | 'Sign out' }
  | { kind: 'pressFinish'; choice: NotificationChoice; taps: 1 | 2 }
  | { kind: 'pressGetStarted' }
  | { kind: 'settle' }
  | { kind: 'setDbWrite'; fails: boolean }
  | { kind: 'setServer'; mode: ServerMode }
  | { kind: 'setPermission'; state: Permission };

export type ScreenKind = 'onboarding' | 'welcome' | 'signin' | 'root';

export interface ModelProfile {
  firstName?: string;
  gender?: string;
  skillLevel: string;
  handedness: string;
  goal: string;
  biggestProblem: string;
  focusCheckpoint: string;
}

interface PendingFinish {
  /** Screen instance that started the save. */
  instance: number;
  mode: Mode;
  choice: NotificationChoice;
  /** Whether this finish is the one that records the notification choice. */
  recordsChoice: boolean;
  /** OS answer captured when the prompt was requested (at the tap). */
  permission: Permission;
  profile: ModelProfile;
  /** Account owner signed out while the save was in flight. */
  detached: boolean;
}

export interface Model {
  mode: Mode;
  screen: ScreenKind;
  /** Bumped every time an OnboardingScreen instance mounts. */
  instance: number;
  stepIndex: number;
  name: string;
  answers: Partial<Record<ChoiceStep, string>>;
  dialogOpen: boolean;
  notificationChoice: NotificationChoice | null;
  /** Finishes whose async work has not settled yet (oldest first). */
  pending: PendingFinish[];
  /** Sign-out in flight (store hydrate for the signed-out owner pending). */
  signOutPending: boolean;
  env: Env;
  storeError: string | null;
  /** World (persisted / counted) state. */
  permissionRequests: number;
  putCalls: number;
  logoutCalls: number;
  pendingProfileKv: ModelProfile | null;
  pendingNotificationKv: { version: 1; enabled: boolean } | null;
  accountProfileKv: ModelProfile | null;
  accountPrefsKv: { enabled: boolean; promptDismissed: boolean } | null;
}

export interface Scenario {
  seed: number;
  mode: Mode;
  env: Env;
  actions: Action[];
}

export function initialModel(mode: Mode, env: Env): Model {
  return {
    mode,
    screen: 'onboarding',
    instance: 1,
    stepIndex: 0,
    name: '',
    answers: {},
    dialogOpen: false,
    notificationChoice: null,
    pending: [],
    signOutPending: false,
    env: { ...env },
    storeError: null,
    permissionRequests: 0,
    putCalls: 0,
    logoutCalls: 0,
    pendingProfileKv: null,
    pendingNotificationKv: null,
    accountProfileKv: null,
    accountPrefsKv: null,
  };
}

export function currentStep(model: Model): Step {
  return STEPS[model.stepIndex] ?? 'notifications';
}

export function trimmedName(model: Model): string {
  return model.name.trim();
}

export function stepComplete(model: Model): boolean {
  const step = currentStep(model);
  if (step === 'reveal' || step === 'notifications') return true;
  if (step === 'name') return trimmedName(model).length >= 1;
  return model.answers[step] !== undefined;
}

export function modelProfile(model: Model): ModelProfile {
  const firstName = trimmedName(model);
  const goal = model.answers.goal ?? 'all-around';
  return {
    ...(firstName ? { firstName } : {}),
    ...(model.answers.gender ? { gender: model.answers.gender } : {}),
    skillLevel: model.answers.level ?? '3.0',
    handedness: model.answers.handedness ?? 'right',
    goal,
    biggestProblem: model.answers.problem ?? 'not sure',
    focusCheckpoint: focusForGoal(goal),
  };
}

export function busy(model: Model): boolean {
  return model.pending.some(p => !p.detached);
}

function mountFreshScreen(model: Model, mode: Mode): void {
  model.mode = mode;
  model.screen = 'onboarding';
  model.instance += 1;
  model.stepIndex = 0;
  model.name = '';
  model.answers = {};
  model.dialogOpen = false;
  model.notificationChoice = null;
}

/**
 * Applies one action to the model, mirroring the synchronous part of the
 * real handlers. Asynchronous consequences (store writes, server calls,
 * hand-offs) are applied by `settle`.
 */
export function applyAction(model: Model, action: Action): void {
  switch (action.kind) {
    case 'setDbWrite':
      model.env.dbWriteFails = action.fails;
      return;
    case 'setServer':
      model.env.server = action.mode;
      return;
    case 'setPermission':
      model.env.permission = action.state;
      return;
    case 'settle':
      settle(model);
      return;
    case 'pressGetStarted':
      if (model.screen === 'welcome' && !model.signOutPending) {
        mountFreshScreen(model, 'preauth');
      }
      return;
    default:
      break;
  }

  if (model.screen === 'signin') {
    if (action.kind === 'pressBack') model.screen = 'welcome';
    return;
  }
  if (model.screen !== 'onboarding') return;

  const step = currentStep(model);
  if (model.dialogOpen) {
    if (action.kind === 'pressDialog') {
      model.dialogOpen = false;
      if (action.label === 'Sign out') {
        model.screen = 'welcome';
        model.signOutPending = true;
        model.storeError = null;
        for (const p of model.pending) p.detached = true;
      }
    }
    return;
  }

  switch (action.kind) {
    case 'typeName':
      if (step === 'name') model.name = action.text;
      return;
    case 'submitName':
      if (step === 'name' && stepComplete(model)) model.stepIndex += 1;
      return;
    case 'pressChoice': {
      if (step === 'name' || step === 'reveal' || step === 'notifications') {
        return;
      }
      const choice = CHOICES[step].find(c => c.label === action.label);
      if (choice) model.answers[step] = choice.value;
      return;
    }
    case 'pressContinue':
      if (step !== 'notifications' && stepComplete(model)) {
        model.stepIndex = Math.min(model.stepIndex + 1, STEPS.length - 1);
      }
      return;
    case 'pressBack':
      if (model.stepIndex > 0) {
        model.stepIndex -= 1;
      } else if (model.mode === 'preauth') {
        model.screen = 'welcome';
      } else {
        model.dialogOpen = true;
      }
      return;
    case 'pressDialog':
      return;
    case 'pressFinish': {
      if (step !== 'notifications') return;
      if (busy(model)) return;
      // The first tap starts the save; the second lands on a disabled
      // button (React committed the busy state between the two events).
      model.pending.push({
        instance: model.instance,
        mode: model.mode,
        choice: action.choice,
        recordsChoice: model.notificationChoice === null,
        permission: model.env.permission,
        profile: modelProfile(model),
        detached: false,
      });
      model.storeError = null;
      return;
    }
    default:
      return;
  }
}

function settle(model: Model): void {
  const pendings = model.pending;
  model.pending = [];
  for (const pending of pendings) {
    const env = model.env;
    if (pending.recordsChoice) {
      if (pending.choice === 'enable') model.permissionRequests += 1;
      const enabled =
        pending.choice === 'enable' && pending.permission === 'granted';
      if (pending.mode === 'preauth') {
        if (!env.dbWriteFails) {
          model.pendingNotificationKv = { version: 1, enabled };
        }
      } else if (pending.detached && pending.choice === 'enable') {
        // The permission prompt was awaited before the owner was read; by
        // then the account had signed out, so the choice goes to the
        // signed-out stash instead of the account's prefs.
        if (!env.dbWriteFails) {
          model.pendingNotificationKv = { version: 1, enabled };
        }
      } else if (!env.dbWriteFails) {
        model.accountPrefsKv = { enabled, promptDismissed: true };
      }
      if (
        !pending.detached &&
        model.screen === 'onboarding' &&
        model.instance === pending.instance
      ) {
        model.notificationChoice = pending.choice;
      }
    }

    if (pending.mode === 'preauth') {
      if (env.dbWriteFails) {
        model.storeError = `SQLITE_IOERR (simulated) writing kv onboarding.pending-profile`;
      } else {
        model.pendingProfileKv = pending.profile;
        model.storeError = null;
        // onFinished() is the Gate's setPreAuthStage('signin'): it fires
        // even if this screen instance is gone.
        model.screen = 'signin';
      }
    } else {
      const saved = env.server === 'ok';
      model.putCalls += saved ? 1 : 2;
      let error: string | null = null;
      if (!saved) {
        error =
          env.server === 'error-500'
            ? SERVER_FAILURE_MESSAGE
            : NETWORK_FAILURE_MESSAGE;
      } else if (env.dbWriteFails) {
        error = `SQLITE_IOERR (simulated) writing kv profile:${ACCOUNT_OWNER}`;
      } else {
        model.accountProfileKv = {
          ...pending.profile,
          focusCheckpoint: SERVER_RECOMMENDED_CHECKPOINT,
        };
      }
      if (pending.detached) {
        // Store updates are owner-guarded; the signed-out hydrate cleared
        // the busy flag and any error.
        model.storeError = null;
      } else if (error) {
        model.storeError = error;
      } else {
        model.storeError = null;
        model.screen = 'root';
      }
    }
  }
  if (model.signOutPending) {
    model.signOutPending = false;
    model.logoutCalls += 1;
    model.storeError = null;
  }
}

// ─── Generator ───────────────────────────────────────────────────────────────

function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('pick from empty list');
  return item;
}

function randomAny(rng: () => number): Action {
  const kinds: Action['kind'][] = [
    'typeName',
    'submitName',
    'pressChoice',
    'pressContinue',
    'pressBack',
    'pressDialog',
    'pressFinish',
    'pressGetStarted',
    'settle',
    'setDbWrite',
    'setServer',
    'setPermission',
  ];
  switch (pick(rng, kinds)) {
    case 'typeName':
      return { kind: 'typeName', text: pick(rng, NAME_INPUTS) };
    case 'submitName':
      return { kind: 'submitName' };
    case 'pressChoice':
      return { kind: 'pressChoice', label: pick(rng, ALL_CHOICE_LABELS) };
    case 'pressContinue':
      return { kind: 'pressContinue' };
    case 'pressBack':
      return { kind: 'pressBack' };
    case 'pressDialog':
      return {
        kind: 'pressDialog',
        label: rng() < 0.5 ? 'Keep setting up' : 'Sign out',
      };
    case 'pressFinish':
      return {
        kind: 'pressFinish',
        choice: rng() < 0.5 ? 'enable' : 'not_now',
        taps: rng() < 0.3 ? 2 : 1,
      };
    case 'pressGetStarted':
      return { kind: 'pressGetStarted' };
    case 'settle':
      return { kind: 'settle' };
    case 'setDbWrite':
      return { kind: 'setDbWrite', fails: rng() < 0.5 };
    case 'setServer':
      return {
        kind: 'setServer',
        mode: pick(rng, ['ok', 'ok', 'error-500', 'network'] as const),
      };
    case 'setPermission':
      return {
        kind: 'setPermission',
        state: rng() < 0.5 ? 'granted' : 'denied',
      };
  }
}

/** An action that is legal (has an effect) in the model's current state.
 * `forward` is the per-scenario chance of preferring progress (Continue /
 * finish) whenever the current step is complete, so a share of the seeds
 * reaches the reveal/notification/hand-off states deep in the flow. */
function randomLegal(rng: () => number, model: Model, forward: number): Action {
  if (busy(model)) {
    const r = rng();
    if (r < 0.55) return { kind: 'settle' };
    if (r < 0.7) {
      return {
        kind: 'pressFinish',
        choice: rng() < 0.5 ? 'enable' : 'not_now',
        taps: 1,
      };
    }
    if (r < 0.85) return { kind: 'pressBack' };
    return randomAny(rng);
  }
  if (model.signOutPending) return { kind: 'settle' };
  switch (model.screen) {
    case 'welcome':
      return { kind: 'pressGetStarted' };
    case 'signin':
      return rng() < 0.7 ? { kind: 'pressBack' } : randomAny(rng);
    case 'root':
      return randomAny(rng);
    case 'onboarding':
      break;
  }
  if (model.dialogOpen) {
    return {
      kind: 'pressDialog',
      label: rng() < 0.6 ? 'Keep setting up' : 'Sign out',
    };
  }
  const step = currentStep(model);
  if (forward > 0 && stepComplete(model) && rng() < forward) {
    return step === 'notifications'
      ? {
          kind: 'pressFinish',
          choice: rng() < 0.5 ? 'enable' : 'not_now',
          taps: 1,
        }
      : { kind: 'pressContinue' };
  }
  const r = rng();
  switch (step) {
    case 'name':
      if (r < 0.45) return { kind: 'typeName', text: pick(rng, NAME_INPUTS) };
      if (r < 0.75) return { kind: 'pressContinue' };
      if (r < 0.9) return { kind: 'submitName' };
      return { kind: 'pressBack' };
    case 'reveal':
      return r < 0.75 ? { kind: 'pressContinue' } : { kind: 'pressBack' };
    case 'notifications': {
      if (r < 0.6) {
        return {
          kind: 'pressFinish',
          choice: rng() < 0.5 ? 'enable' : 'not_now',
          taps: rng() < 0.3 ? 2 : 1,
        };
      }
      if (r < 0.75) return { kind: 'pressBack' };
      if (r < 0.85) return { kind: 'setDbWrite', fails: rng() < 0.5 };
      if (r < 0.95) {
        return {
          kind: 'setServer',
          mode: pick(rng, ['ok', 'error-500', 'network'] as const),
        };
      }
      return {
        kind: 'setPermission',
        state: rng() < 0.5 ? 'granted' : 'denied',
      };
    }
    default: {
      if (r < 0.5) {
        return { kind: 'pressChoice', label: pick(rng, CHOICES[step]).label };
      }
      if (r < 0.85) return { kind: 'pressContinue' };
      return { kind: 'pressBack' };
    }
  }
}

export const MIN_SEQUENCE_LENGTH = 5;
export const MAX_SEQUENCE_LENGTH = 60;

/** Deterministic scenario for a seed: mode, starting environment and a
 * 5–60 action sequence (≈75 % legal-for-current-state, ≈25 % arbitrary;
 * a third of the seeds are "wanderers" with no forward bias, the rest lean
 * towards progress so the deep states are exercised). */
export function generateScenario(seed: number): Scenario {
  const rng = makePrng(seed);
  const mode: Mode = rng() < 0.5 ? 'account' : 'preauth';
  const env: Env = {
    dbWriteFails: rng() < 0.12,
    server: pick(rng, ['ok', 'ok', 'ok', 'error-500', 'network'] as const),
    permission: rng() < 0.7 ? 'granted' : 'denied',
  };
  const length =
    MIN_SEQUENCE_LENGTH +
    Math.floor(rng() * (MAX_SEQUENCE_LENGTH - MIN_SEQUENCE_LENGTH + 1));
  const forward = pick(rng, [0, 0.35, 0.6] as const);
  const model = initialModel(mode, env);
  const actions: Action[] = [];
  for (let i = 0; i < length; i += 1) {
    const action =
      rng() < 0.75 ? randomLegal(rng, model, forward) : randomAny(rng);
    actions.push(action);
    applyAction(model, action);
  }
  return { seed, mode, env, actions };
}

export function describeAction(action: Action): string {
  switch (action.kind) {
    case 'typeName':
      return `typeName(${JSON.stringify(action.text)})`;
    case 'pressChoice':
      return `pressChoice(${action.label})`;
    case 'pressDialog':
      return `pressDialog(${action.label})`;
    case 'pressFinish':
      return `pressFinish(${action.choice}, taps=${action.taps})`;
    case 'setDbWrite':
      return `setDbWrite(fails=${action.fails})`;
    case 'setServer':
      return `setServer(${action.mode})`;
    case 'setPermission':
      return `setPermission(${action.state})`;
    default:
      return action.kind;
  }
}
