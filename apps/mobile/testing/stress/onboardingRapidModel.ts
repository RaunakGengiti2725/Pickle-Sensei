/**
 * stress/scr-onboardingscreen — rapid-interaction lens.
 *
 * A seeded generator + a deterministic ORACLE for the launch flow around
 * `OnboardingScreen` (Welcome → questionnaire → notification choice →
 * sign-in / main app), used by `__tests__/stress/onboardingRapidInteraction*`.
 *
 * The oracle models what the product promises for each USER INTENT (one
 * tap on an enabled control), independent of the implementation:
 *   - every enabled tap changes exactly one thing (one step, one answer,
 *     one dialog, one finish pipeline, one navigation);
 *   - taps on disabled/absent/covered controls change nothing;
 *   - a finish pipeline runs at most once per intent and, once quiescent,
 *     leaves no busy affordance behind;
 *   - the stash/profile written is the profile the user saw when the intent
 *     was issued (`snapshot`) — the oracle also records when answers were
 *     changed mid-flight so a stale write can be reported separately.
 *
 * Nothing here touches React: the generator drives the model to produce a
 * replayable op list from a seed; the executor in the test applies the same
 * ops to the real App and to the model in lock-step and diffs the two.
 */
import type { Profile } from '../../src/state/profile';
import { focusForGoal } from '../../src/state/appStore';
import { randomInt, seededRandom } from '../xcBehavioral/evidence';

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
export type QuestionStep =
  'gender' | 'level' | 'handedness' | 'goal' | 'problem';

/** Choice labels per question step, in on-screen order (mirrors the
 * screen's QUESTIONS table; label → stored value). */
export const CHOICES: Record<QuestionStep, ReadonlyArray<[string, string]>> = {
  gender: [
    ['Female', 'female'],
    ['Male', 'male'],
    ['Non-binary', 'nonbinary'],
    ['Prefer not to say', 'prefer_not_to_say'],
  ],
  level: [
    ['Brand new', 'Beginner'],
    ['2.5', '2.5'],
    ['3.0', '3.0'],
    ['3.5', '3.5'],
    ['4.0', '4.0'],
    ['4.5', '4.5'],
    ['5.0+', '5.0+'],
  ],
  handedness: [
    ['Right-handed', 'right'],
    ['Left-handed', 'left'],
  ],
  goal: [
    ['Dinks', 'dinks'],
    ['Drives', 'drives'],
    ['Third-shot drops', 'drops'],
    ['Serve', 'serve'],
    ['Volleys', 'volleys'],
    ['Footwork', 'footwork'],
    ['All-around', 'all-around'],
  ],
  problem: [
    ['Consistency', 'consistency'],
    ['Control', 'control'],
    ['Power', 'power'],
    ['Contact', 'contact'],
    ['Footwork', 'footwork'],
    ['Placement', 'placement'],
    ['Not sure', 'not sure'],
  ],
};

export const NAME_INPUTS: readonly string[] = [
  'Dana',
  ' Dana ',
  '   ',
  '',
  'Al',
  'Jo-Ann',
  "O'Neil",
  'Æyǒ',
  'Maximilian-Alexander Montgomery III',
  '  Lee',
  '\t',
  'A',
];

export type Mode = 'preauth' | 'account';
export type Stage = 'welcome' | 'onboarding' | 'signin' | 'root';
export type Choice = 'enable' | 'not_now';
export type Gap = 'none' | 'micro' | 'frame' | 'long';
export type Seam = 'permission' | 'notifKv' | 'stash' | 'profileKv';

export type Op =
  | { kind: 'getStarted'; taps: number }
  | { kind: 'alreadyAccount'; taps: number }
  | { kind: 'signinBack'; taps: number }
  | { kind: 'typeName'; text: string }
  | { kind: 'submitName'; taps: number }
  | { kind: 'continue'; taps: number }
  | { kind: 'back'; taps: number }
  | { kind: 'select'; labels: string[] }
  | { kind: 'finish'; choice: Choice; taps: number }
  | { kind: 'leave'; taps: number }
  | { kind: 'keepSettingUp'; taps: number }
  | { kind: 'signOut'; taps: number }
  | { kind: 'simultaneous'; a: string; b: string }
  | { kind: 'release' }
  | { kind: 'idle'; ms: number };

export interface Faults {
  /** Number of leading stash / canonical-save attempts that reject. */
  saveFailures: number;
  /** The notification-choice kv write rejects (the store swallows it). */
  notifKvFails: boolean;
  permission: 'granted' | 'denied' | 'throws';
  /** Which async seam of the FIRST finish pipeline is held until `release`. */
  hold: Seam | null;
}

export interface PlanStep {
  op: Op;
  gap: Gap;
}

export interface Plan {
  seed: number;
  mode: Mode;
  faults: Faults;
  steps: PlanStep[];
  /** Number of user intents (taps / typed edits) the plan issues. */
  intents: number;
}

export interface Counters {
  permissionRequests: number;
  notifKvWrites: number;
  saveAttempts: number;
  saveOk: number;
  signinMounts: number;
  rootMounts: number;
  signOuts: number;
  finishStarts: number;
  /** Taps that landed on a control while a finish pipeline was in flight. */
  tapsDuringAsync: number;
  backDuringAsync: number;
}

export interface Finishing {
  choice: Choice;
  snapshot: Profile;
  /** Set when an answer changed while this pipeline was in flight. */
  answersChangedInFlight: boolean;
  /** Which seam (if any) still holds this pipeline. */
  heldAt: Seam | null;
  /** Mode of the screen instance that started the pipeline. */
  preAuth: boolean;
}

export interface ModelState {
  /** A session exists → the screen renders in account mode. */
  signedIn: boolean;
  stage: Stage;
  stepIndex: number;
  answers: Record<string, string>;
  confirmingLeave: boolean;
  finishing: Finishing | null;
  notificationChoiceRecorded: boolean;
  storeError: string | null;
  storeBusy: boolean;
  counters: Counters;
  /** Stash / profile actually persisted (last successful write). */
  persistedProfile: Profile | null;
  /** Diagnostics the executor reports but does not fail on. */
  observations: string[];
}

export const SAVE_FAILURE_MESSAGE = 'stress: save rejected';

export function stepOf(state: ModelState): Step {
  return STEPS[state.stepIndex] ?? 'notifications';
}

export function isQuestionStep(step: Step): step is QuestionStep {
  return step in CHOICES;
}

export function stepComplete(state: ModelState): boolean {
  const step = stepOf(state);
  if (step === 'reveal' || step === 'notifications') return true;
  if (step === 'name') return (state.answers['name'] ?? '').trim().length >= 1;
  return state.answers[step] !== undefined;
}

export function answeredProfile(state: ModelState): Profile {
  const firstName = (state.answers['name'] ?? '').trim();
  const goal = state.answers['goal'] ?? 'all-around';
  return {
    firstName: firstName || undefined,
    gender: state.answers['gender'] as Profile['gender'],
    skillLevel: state.answers['level'] ?? '3.0',
    handedness: (state.answers['handedness'] ??
      'right') as Profile['handedness'],
    goal,
    biggestProblem: state.answers['problem'] ?? 'not sure',
    focusCheckpoint: focusForGoal(goal),
  };
}

/** True while the screen's finish buttons must be disabled. */
export function busy(state: ModelState): boolean {
  return state.finishing !== null || state.storeBusy;
}

export function initialState(mode: Mode): ModelState {
  return {
    signedIn: mode === 'account',
    stage: mode === 'preauth' ? 'welcome' : 'onboarding',
    stepIndex: 0,
    answers: {},
    confirmingLeave: false,
    finishing: null,
    notificationChoiceRecorded: false,
    storeError: null,
    storeBusy: false,
    counters: {
      permissionRequests: 0,
      notifKvWrites: 0,
      saveAttempts: 0,
      saveOk: 0,
      signinMounts: 0,
      rootMounts: 0,
      signOuts: 0,
      finishStarts: 0,
      tapsDuringAsync: 0,
      backDuringAsync: 0,
    },
    persistedProfile: null,
    observations: [],
  };
}

function resetScreen(state: ModelState) {
  state.stepIndex = 0;
  state.answers = {};
  state.confirmingLeave = false;
  state.notificationChoiceRecorded = false;
}

/** The outcome of ONE tap on the control with `label`, as the product
 * promises it: 'applied' (one effect), 'blocked' (disabled or covered by
 * the dialog) or 'absent' (no such control on screen). */
export type TapOutcome = 'applied' | 'blocked' | 'absent';

export class OnboardingModel {
  readonly state: ModelState;
  constructor(
    readonly mode: Mode,
    readonly faults: Faults,
  ) {
    this.state = initialState(mode);
  }

  /** The mode the mounted screen is in right now (sign-out flips it). */
  screenMode(): Mode {
    return this.state.signedIn ? 'account' : 'preauth';
  }

  private modalUp(): boolean {
    return this.state.stage === 'onboarding' && this.state.confirmingLeave;
  }

  /** Signing out drops the session: the Gate falls back to Welcome. */
  signOutNow() {
    const s = this.state;
    s.confirmingLeave = false;
    s.counters.signOuts += 1;
    s.signedIn = false;
    s.stage = 'welcome';
  }

  /** Whether a finger could land on `label` right now, without applying. */
  probe(label: string): TapOutcome {
    const clone = new OnboardingModel(this.mode, this.faults);
    Object.assign(clone.state, JSON.parse(JSON.stringify(this.state)));
    return clone.tap(label);
  }

  /** One tap on `label`. Mirrors what a user can reach on the real tree:
   * the label must be rendered, enabled and not covered by the dialog. */
  tap(label: string): TapOutcome {
    const s = this.state;
    switch (s.stage) {
      case 'welcome':
        if (label === 'Start your first read') {
          s.stage = 'onboarding';
          resetScreen(s);
          return 'applied';
        }
        if (label === 'I already have an account') {
          s.stage = 'signin';
          s.counters.signinMounts += 1;
          return 'applied';
        }
        return 'absent';
      case 'signin':
        if (label === 'Back') {
          s.stage = 'welcome';
          return 'applied';
        }
        return 'absent';
      case 'root':
        return 'absent';
      case 'onboarding':
        break;
    }
    const step = stepOf(s);
    if (s.finishing) s.counters.tapsDuringAsync += 1;
    if (this.modalUp()) {
      if (label === 'Keep setting up') {
        s.confirmingLeave = false;
        return 'applied';
      }
      if (label === 'Sign out') {
        this.signOutNow();
        return 'applied';
      }
      // Everything under the dialog is covered.
      return 'blocked';
    }
    if (label === 'Back') {
      if (s.stepIndex > 0) {
        s.stepIndex -= 1;
        if (s.finishing) s.counters.backDuringAsync += 1;
        return 'applied';
      }
      if (!s.signedIn) {
        s.stage = 'welcome';
        return 'applied';
      }
      return 'absent';
    }
    if (label === 'Leave setup') {
      if (s.signedIn && s.stepIndex === 0) {
        s.confirmingLeave = true;
        return 'applied';
      }
      return 'absent';
    }
    if (label === 'Continue') {
      if (step === 'notifications') return 'absent';
      if (!stepComplete(s)) return 'blocked';
      s.stepIndex += 1;
      return 'applied';
    }
    if (label === 'Turn on reminders' || label === 'Not now') {
      if (step !== 'notifications') return 'absent';
      if (busy(s)) return label === 'Not now' ? 'blocked' : 'absent';
      this.startFinish(label === 'Not now' ? 'not_now' : 'enable');
      return 'applied';
    }
    if (isQuestionStep(step)) {
      const match = CHOICES[step].find(([l]) => l === label);
      if (match) {
        s.answers[step] = match[1];
        if (s.finishing) s.finishing.answersChangedInFlight = true;
        return 'applied';
      }
    }
    return 'absent';
  }

  typeName(text: string): TapOutcome {
    const s = this.state;
    if (s.stage !== 'onboarding' || stepOf(s) !== 'name' || this.modalUp())
      return 'absent';
    s.answers['name'] = text;
    if (s.finishing) s.finishing.answersChangedInFlight = true;
    return 'applied';
  }

  submitName(): TapOutcome {
    const s = this.state;
    if (s.stage !== 'onboarding' || stepOf(s) !== 'name' || this.modalUp())
      return 'absent';
    if (!stepComplete(s)) return 'blocked';
    s.stepIndex += 1;
    return 'applied';
  }

  private startFinish(choice: Choice) {
    const s = this.state;
    s.counters.finishStarts += 1;
    const firstPipeline = s.counters.finishStarts === 1;
    s.finishing = {
      choice,
      snapshot: answeredProfile(s),
      answersChangedInFlight: false,
      heldAt: firstPipeline ? this.faults.hold : null,
      preAuth: !s.signedIn,
    };
    // A held permission prompt only exists for the "enable" choice; a held
    // notification write only exists while the choice is still unrecorded.
    if (
      s.finishing.heldAt === 'permission' &&
      (choice !== 'enable' || s.notificationChoiceRecorded)
    ) {
      s.finishing.heldAt = null;
    }
    if (s.finishing.heldAt === 'notifKv' && s.notificationChoiceRecorded) {
      s.finishing.heldAt = null;
    }
    if (s.finishing.heldAt === 'profileKv' && !s.signedIn) {
      s.finishing.heldAt = 'stash';
    }
    if (s.finishing.heldAt === 'stash' && s.signedIn) {
      s.finishing.heldAt = 'profileKv';
    }
    s.finishing.preAuth = !s.signedIn;
    // The store call clears the previous save error the moment it is
    // reached: synchronously when no notification round-trip precedes it.
    if (s.notificationChoiceRecorded) s.storeError = null;
  }

  /** The held seam is released; the pipeline completes at the next settle. */
  release() {
    if (this.state.finishing) this.state.finishing.heldAt = null;
  }

  /** Everything that was in flight and not held settles. */
  settle() {
    const s = this.state;
    const f = s.finishing;
    if (!f) return;
    if (f.heldAt) {
      // Held inside the store call: the previous error is already cleared.
      if (f.heldAt === 'stash' || f.heldAt === 'profileKv') s.storeError = null;
      return;
    }
    if (!s.notificationChoiceRecorded) {
      if (f.choice === 'enable') s.counters.permissionRequests += 1;
      s.counters.notifKvWrites += 1;
      s.notificationChoiceRecorded = true;
    }
    s.counters.saveAttempts += 1;
    const fails = s.counters.saveAttempts <= this.faults.saveFailures;
    if (fails) {
      s.storeError = SAVE_FAILURE_MESSAGE;
      s.finishing = null;
      return;
    }
    s.storeError = null;
    s.counters.saveOk += 1;
    s.persistedProfile = f.snapshot;
    if (f.answersChangedInFlight) {
      s.observations.push(
        'answers changed while finishing: stale snapshot persisted',
      );
    }
    s.finishing = null;
    if (f.preAuth) {
      if (s.stage !== 'signin') s.counters.signinMounts += 1;
      s.stage = 'signin';
    } else {
      s.stage = 'root';
      s.counters.rootMounts += 1;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Seeded plan generator                                                */
/* ------------------------------------------------------------------ */

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

function burst(random: () => number): number {
  // 1 tap 45%, double 30%, triple 17%, 4–6 taps 8%.
  const r = random();
  if (r < 0.45) return 1;
  if (r < 0.75) return 2;
  if (r < 0.92) return 3;
  return randomInt(random, 4, 6);
}

function gap(random: () => number): Gap {
  const r = random();
  if (r < 0.3) return 'none';
  if (r < 0.7) return 'micro';
  if (r < 0.9) return 'frame';
  return 'long';
}

function faultsFor(random: () => number): Faults {
  const holdRoll = random();
  const hold: Seam | null =
    holdRoll < 0.55
      ? null
      : holdRoll < 0.7
        ? 'permission'
        : holdRoll < 0.8
          ? 'notifKv'
          : holdRoll < 0.92
            ? 'stash'
            : 'profileKv';
  const permRoll = random();
  return {
    saveFailures: random() < 0.25 ? randomInt(random, 1, 2) : 0,
    notifKvFails: random() < 0.12,
    permission:
      permRoll < 0.7 ? 'granted' : permRoll < 0.9 ? 'denied' : 'throws',
    hold,
  };
}

export interface PlanOptions {
  /**
   * Also emit both finish controls ("Turn on reminders" + "Not now") in ONE
   * dispatch tick. React Native's single-responder touch system delivers one
   * `onPress` per gesture and React flushes each discrete event before the
   * next, so this pair is not reachable from the touchscreen; it probes the
   * closure-based busy guard directly (see STRESS_SAME_TICK in the suite).
   */
  sameTickFinish: boolean;
}

export function generatePlan(
  seed: number,
  options: PlanOptions = { sameTickFinish: false },
): Plan {
  const random = seededRandom(seed);
  const mode: Mode = random() < 0.7 ? 'preauth' : 'account';
  const faults = faultsFor(random);
  const model = new OnboardingModel(mode, faults);
  const steps: PlanStep[] = [];
  let intents = 0;
  // Most seeds push forward to the notification step so the async finish
  // and its races are exercised; the rest wander (spam navigation, restart
  // the questionnaire from Welcome, re-answer).
  const driveToFinish = random() < 0.85;
  const target = driveToFinish
    ? randomInt(random, 24, 60)
    : randomInt(random, 14, 40);
  // Probability of a Back op on a question/reveal step.
  const pBack = driveToFinish ? 0.08 : 0.2;

  const push = (op: Op, g: Gap = gap(random)) => {
    steps.push({ op, gap: g });
    apply(model, op);
  };
  // Back while a pipeline is in flight stays INSIDE the screen: leaving it
  // (unmount mid-flight) is a different lens; capping the burst keeps the
  // oracle exact. Forward-driving seeds mostly single-tap Back so a burst
  // does not fall all the way out to Welcome.
  const backOp = (): Op => {
    const s = model.state;
    const taps = driveToFinish && random() < 0.7 ? 1 : burst(random);
    if (!s.finishing) return { kind: 'back', taps };
    if (s.stepIndex === 0) return { kind: 'continue', taps };
    return { kind: 'back', taps: Math.min(taps, s.stepIndex) };
  };
  const nameText = (): string =>
    driveToFinish && random() < 0.7
      ? pick(
          random,
          NAME_INPUTS.filter(t => t.trim().length > 0),
        )
      : pick(random, NAME_INPUTS);

  let guard = 0;
  while (steps.length < target && guard < 400) {
    guard += 1;
    const s = model.state;
    if (s.stage === 'root') break;
    if (s.stage === 'signin' && s.counters.saveOk > 0) {
      // Finished: a little post-finish spam then stop.
      if (random() < 0.5) push({ kind: 'signinBack', taps: burst(random) });
      break;
    }
    // Release a held pipeline eventually (always before the plan ends).
    if (s.finishing?.heldAt && random() < 0.3) {
      push({ kind: 'release' });
      continue;
    }
    const r = random();
    switch (s.stage) {
      case 'welcome':
        if (r < (driveToFinish ? 0.85 : 0.6)) {
          push({ kind: 'getStarted', taps: burst(random) });
        } else push({ kind: 'alreadyAccount', taps: burst(random) });
        continue;
      case 'signin':
        push({ kind: 'signinBack', taps: burst(random) });
        continue;
      case 'onboarding':
        break;
    }
    if (s.confirmingLeave) {
      // Signing out re-hydrates the stores: the Gate paints a loading state
      // for a tick, so these always settle before the next op.
      if (r < 0.6) push({ kind: 'keepSettingUp', taps: burst(random) });
      else if (r < 0.9) push({ kind: 'signOut', taps: burst(random) }, 'micro');
      else {
        push(
          { kind: 'simultaneous', a: 'Keep setting up', b: 'Sign out' },
          'micro',
        );
      }
      continue;
    }
    const step = stepOf(s);
    const inFlight = s.finishing !== null;
    if (step === 'name') {
      const named = stepComplete(s);
      if (r < (named ? 0.2 : 0.55))
        push({ kind: 'typeName', text: nameText() });
      else if (r < 0.65) push({ kind: 'submitName', taps: burst(random) });
      else if (r < (driveToFinish ? 0.92 : 0.8) || inFlight) {
        push({ kind: 'continue', taps: burst(random) });
      } else if (model.screenMode() === 'preauth') {
        push({ kind: 'back', taps: burst(random) });
      } else push({ kind: 'leave', taps: burst(random) });
      continue;
    }
    if (isQuestionStep(step)) {
      const labels = CHOICES[step].map(([l]) => l);
      const answered = s.answers[step] !== undefined;
      if (r < (answered ? 0.25 : 0.55)) {
        // Rapid re-selection storm: 1–4 different choices, last wins.
        const n = randomInt(random, 1, 4);
        const picked: string[] = [];
        for (let i = 0; i < n; i += 1) picked.push(pick(random, labels));
        push({ kind: 'select', labels: picked });
      } else if (r < 0.9 - pBack)
        push({ kind: 'continue', taps: burst(random) });
      else if (r < 0.9) push(backOp());
      else {
        // Simultaneous choice + Continue in one frame.
        push({ kind: 'simultaneous', a: pick(random, labels), b: 'Continue' });
      }
      continue;
    }
    if (step === 'reveal') {
      if (r < 0.9 - pBack) push({ kind: 'continue', taps: burst(random) });
      else if (r < 0.9) push(backOp());
      else push({ kind: 'simultaneous', a: 'Back', b: 'Continue' });
      continue;
    }
    // notifications
    if (inFlight) {
      if (r < 0.35) push(backOp());
      else if (r < 0.6) {
        push({
          kind: 'finish',
          choice: pick(random, ['enable', 'not_now']),
          taps: burst(random),
        });
      } else if (r < 0.8) push({ kind: 'idle', ms: randomInt(random, 1, 600) });
      else push({ kind: 'release' });
      continue;
    }
    if (!driveToFinish && r < 0.5) {
      push({ kind: 'back', taps: burst(random) });
      continue;
    }
    if (r < 0.12) {
      if (options.sameTickFinish) {
        push({ kind: 'simultaneous', a: 'Turn on reminders', b: 'Not now' });
      } else {
        push({ kind: 'finish', choice: 'enable', taps: 1 }, 'none');
        push({ kind: 'finish', choice: 'not_now', taps: 1 });
      }
    } else if (r < 0.2) push(backOp());
    else {
      push({
        kind: 'finish',
        choice: random() < 0.5 ? 'enable' : 'not_now',
        taps: burst(random),
      });
    }
  }
  if (model.state.finishing?.heldAt) push({ kind: 'release' }, 'micro');
  // Always end quiescent so the executor can compare final side effects.
  if (steps[steps.length - 1]?.gap === 'none')
    steps[steps.length - 1]!.gap = 'micro';

  for (const { op } of steps) intents += intentsOf(op);
  return { seed, mode, faults, steps, intents };
}

export function intentsOf(op: Op): number {
  switch (op.kind) {
    case 'typeName':
      return 1;
    case 'select':
      return op.labels.length;
    case 'simultaneous':
      return 2;
    case 'release':
    case 'idle':
      return 0;
    default:
      return op.taps;
  }
}

/** Applies an op to the model with the SAME semantics the executor uses on
 * the real tree: sequential taps re-resolve the control each time; a
 * "simultaneous" pair fires both handlers the user saw in one frame; a
 * settle happens after every op whose gap is not 'none'. */
export function apply(model: OnboardingModel, op: Op): TapOutcome[] {
  const outcomes: TapOutcome[] = [];
  switch (op.kind) {
    case 'getStarted':
      for (let i = 0; i < op.taps; i += 1)
        outcomes.push(model.tap('Start your first read'));
      break;
    case 'alreadyAccount':
      for (let i = 0; i < op.taps; i += 1)
        outcomes.push(model.tap('I already have an account'));
      break;
    case 'signinBack':
    case 'back':
      for (let i = 0; i < op.taps; i += 1) outcomes.push(model.tap('Back'));
      break;
    case 'typeName':
      outcomes.push(model.typeName(op.text));
      break;
    case 'submitName':
      for (let i = 0; i < op.taps; i += 1) outcomes.push(model.submitName());
      break;
    case 'continue':
      for (let i = 0; i < op.taps; i += 1) outcomes.push(model.tap('Continue'));
      break;
    case 'select':
      for (const label of op.labels) outcomes.push(model.tap(label));
      break;
    case 'finish':
      for (let i = 0; i < op.taps; i += 1) {
        outcomes.push(
          model.tap(op.choice === 'enable' ? 'Turn on reminders' : 'Not now'),
        );
      }
      break;
    case 'leave':
      for (let i = 0; i < op.taps; i += 1)
        outcomes.push(model.tap('Leave setup'));
      break;
    case 'keepSettingUp':
      for (let i = 0; i < op.taps; i += 1)
        outcomes.push(model.tap('Keep setting up'));
      break;
    case 'signOut':
      for (let i = 0; i < op.taps; i += 1) outcomes.push(model.tap('Sign out'));
      break;
    case 'simultaneous': {
      // Both touches land iff their control was reachable when the frame
      // started; the product promise is still one effect per control,
      // applied in order — the second touch cannot start what the first
      // already started (e.g. a second finish pipeline).
      const reachA = model.probe(op.a);
      const reachB = model.probe(op.b);
      if (reachA === 'applied') model.tap(op.a);
      if (reachB === 'applied') {
        const applied = model.tap(op.b) === 'applied';
        // "Keep setting up" closed the dialog first, but the Sign out touch
        // was confirmed by the user in the same frame: it still signs out.
        if (!applied && op.b === 'Sign out') model.signOutNow();
      }
      outcomes.push(reachA, reachB);
      break;
    }
    case 'release':
      model.release();
      break;
    case 'idle':
      break;
  }
  return outcomes;
}

/** Seeds for the campaign: one pinned seed (`STRESS_SEED`, replay) or
 * `STRESS_ITER` deterministic seeds (default small so the suite stays fast). */
export function stressSeeds(
  env: Record<string, string | undefined>,
  scenario: string,
  defaultIterations: number,
): number[] {
  const pinned = env['STRESS_SEED'];
  if (pinned !== undefined && pinned !== '') {
    return pinned.split(',').map(s => Number(s.trim()) >>> 0);
  }
  const scale = Number(env['STRESS_ITER'] ?? String(defaultIterations));
  let hash = 2166136261;
  for (const ch of scenario) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const seeds: number[] = [];
  for (let i = 0; i < scale; i += 1) seeds.push((hash + i * 7919) >>> 0);
  return seeds;
}
