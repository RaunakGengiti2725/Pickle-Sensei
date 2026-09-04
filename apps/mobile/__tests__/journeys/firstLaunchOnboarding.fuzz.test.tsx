import {
  CHOICES,
  PENDING_NOTIFICATIONS_KEY,
  PENDING_PROFILE_KEY,
  STEP_ORDER,
  allText,
  appStateChange,
  assertStageControls,
  capture,
  counters,
  db,
  fetchCalls,
  hasPressable,
  isDisabled,
  keychain,
  launchToFirstScreen,
  nameInput,
  notifeeMock,
  press,
  progressValue,
  resetRuntime,
  stageOf,
  surfaceStringsExcludingEcho,
  typeName,
  unmount,
  type Renderer,
  type Stage,
  type StepName,
} from '../../test-harness/journeys/appJourneyHarness';
import {
  JourneyLog,
  Rng,
  appendTableRow,
  envNumber,
  forbiddenCopyHits,
  heapSample,
} from '../../test-harness/journeys/journeyEvidence';
import { focusForGoal } from '../../src/state/profile';

/**
 * Model-based random walks over the pre-auth journey, full App tree.
 *
 * A tiny reference model of the launch gate + questionnaire predicts the
 * stage, progress, Continue lock, selected card, OS-prompt count and the
 * device stash after every action; the real App must agree after each one.
 * Actions include every control on the current screen, adversarial name
 * input, background/foreground, process death + relaunch, OS permission
 * denied/throwing, and stash write faults.
 *
 * Scale: `JOURNEY_FUZZ_RUNS` walks (default 40), seeds `JOURNEY_FUZZ_SEED`
 * + i (default base 20260904). A failure names its seed and the harness
 * writes the full action list to `<JOURNEY_EVIDENCE_DIR>/fuzz/<seed>/`, so
 * `JOURNEY_FUZZ_SEED=<seed> JOURNEY_FUZZ_RUNS=1` replays it exactly.
 */

jest.useFakeTimers();

const RUNS = envNumber('JOURNEY_FUZZ_RUNS', 40);
const BASE_SEED = envNumber('JOURNEY_FUZZ_SEED', 20260904);
const MAX_ACTIONS = 70;

const NAME_INPUTS = [
  '',
  ' ',
  '   ',
  '\t\n',
  'Dana',
  ' Dana ',
  'Ana-María O’Neil',
  'a',
  'x'.repeat(60),
  '0',
  'Skip',
  '<b>Dana</b>',
];

type ChoiceStep = keyof typeof CHOICES;
const CHOICE_STEPS = Object.keys(CHOICES) as ChoiceStep[];

interface Model {
  stage: Stage;
  stepIndex: number;
  name: string;
  answers: Partial<Record<ChoiceStep, string>>;
  /** 'enable' | 'not_now' once the user has chosen on the final step. */
  notificationChoice: 'enable' | 'not_now' | null;
  osPrompts: number;
  stashProfile: Record<string, string> | null;
  stashNotifications: { version: number; enabled: boolean } | null;
  stashFaultSticky: boolean;
  finished: boolean;
}

function freshModel(): Model {
  return {
    stage: 'welcome',
    stepIndex: 0,
    name: '',
    answers: {},
    notificationChoice: null,
    osPrompts: 0,
    stashProfile: null,
    stashNotifications: null,
    stashFaultSticky: false,
    finished: false,
  };
}

function currentStep(model: Model): StepName {
  return STEP_ORDER[model.stepIndex]!;
}

function modelContinueEnabled(model: Model): boolean {
  const step = currentStep(model);
  if (step === 'name') return model.name.trim().length > 0;
  if (step === 'reveal') return true;
  if (step === 'notifications') return true;
  return model.answers[step as ChoiceStep] !== undefined;
}

function modelProfile(model: Model): Record<string, string> {
  return {
    firstName: model.name.trim(),
    gender: model.answers.gender!,
    skillLevel: model.answers.level!,
    handedness: model.answers.handedness!,
    goal: model.answers.goal!,
    biggestProblem: model.answers.problem!,
    focusCheckpoint: focusForGoal(model.answers.goal!),
  };
}

function readJson(key: string): unknown {
  const raw = db.kv.get(key);
  return raw === undefined ? null : JSON.parse(raw);
}

function assertMatchesModel(renderer: Renderer, model: Model, at: string) {
  const stage = stageOf(renderer);
  expect(`${at}: stage=${stage}`).toBe(`${at}: stage=${model.stage}`);
  if (model.stage.startsWith('onboarding:')) {
    expect(progressValue(renderer)).toEqual({
      now: model.stepIndex + 1,
      max: STEP_ORDER.length,
    });
    const step = currentStep(model);
    if (step !== 'notifications') {
      expect(isDisabled(renderer, 'Continue')).toBe(
        !modelContinueEnabled(model),
      );
    }
    if (step === 'name') {
      expect(nameInput(renderer)?.value).toBe(model.name);
    }
    if (CHOICE_STEPS.includes(step as ChoiceStep)) {
      const chosen = model.answers[step as ChoiceStep];
      const label = chosen
        ? CHOICES[step as ChoiceStep].find(c => c.value === chosen)!.label
        : null;
      const selected = renderer.root
        .findAll(
          n =>
            n.props.accessibilityRole === 'radio' &&
            typeof n.props.onPress === 'function' &&
            n.props.accessibilityState?.selected === true,
        )
        .map(n => String(n.props.accessibilityLabel));
      expect([...new Set(selected)]).toEqual(label ? [label] : []);
    }
  }
  expect(notifeeMock.requestPermission).toHaveBeenCalledTimes(model.osPrompts);
  expect(readJson(PENDING_PROFILE_KEY)).toEqual(
    model.stashProfile ? { version: 1, profile: model.stashProfile } : null,
  );
  expect(readJson(PENDING_NOTIFICATIONS_KEY)).toEqual(model.stashNotifications);
  // Cross-cutting invariants (the user's own typed name is not app copy).
  assertStageControls(renderer, model.name);
  expect(
    forbiddenCopyHits(surfaceStringsExcludingEcho(renderer, model.name)),
  ).toEqual([]);
  expect(fetchCalls).toEqual([]);
  expect(keychain.size).toBe(0);
  expect(hasPressable(renderer, 'Skip')).toBe(false);
}

type Action =
  | { kind: 'press'; label: string }
  | { kind: 'type'; text: string }
  | { kind: 'background_foreground' }
  | { kind: 'process_death' }
  | {
      kind: 'finish';
      control: 'Not now' | 'Turn on reminders';
      os: 'granted' | 'denied' | 'throws';
      stashFault: 'none' | 'once' | 'sticky';
    };

function chooseAction(rng: Rng, model: Model): Action {
  if (rng.chance(0.05)) return { kind: 'background_foreground' };
  if (rng.chance(0.02)) return { kind: 'process_death' };
  switch (model.stage) {
    case 'welcome':
      return {
        kind: 'press',
        label: rng.chance(0.85)
          ? 'Start your first read'
          : 'I already have an account',
      };
    case 'signin':
      return { kind: 'press', label: 'Back' };
    default: {
      const step = currentStep(model);
      if (step === 'name') {
        const r = rng.next();
        if (r < 0.55) return { kind: 'type', text: rng.pick(NAME_INPUTS) };
        if (r < 0.9) return { kind: 'press', label: 'Continue' };
        return { kind: 'press', label: 'Back' };
      }
      if (step === 'reveal') {
        return { kind: 'press', label: rng.chance(0.85) ? 'Continue' : 'Back' };
      }
      if (step === 'notifications') {
        if (rng.chance(0.1)) return { kind: 'press', label: 'Back' };
        const stashFault = rng.chance(0.75)
          ? 'none'
          : rng.chance(0.6)
            ? 'once'
            : 'sticky';
        return {
          kind: 'finish',
          control: rng.chance(0.5) ? 'Not now' : 'Turn on reminders',
          os: rng.chance(0.7)
            ? 'granted'
            : rng.chance(0.5)
              ? 'denied'
              : 'throws',
          stashFault,
        };
      }
      const r = rng.next();
      if (r < 0.5)
        return {
          kind: 'press',
          label: rng.pick(CHOICES[step as ChoiceStep]).label,
        };
      if (r < 0.88) return { kind: 'press', label: 'Continue' };
      return { kind: 'press', label: 'Back' };
    }
  }
}

function describeAction(a: Action): string {
  switch (a.kind) {
    case 'press':
      return `press ${a.label}`;
    case 'type':
      return `type ${JSON.stringify(a.text)}`;
    case 'background_foreground':
      return 'background → foreground';
    case 'process_death':
      return 'process death → relaunch';
    case 'finish':
      return `finish ${a.control} os=${a.os} stash=${a.stashFault}`;
  }
}

function relaunchPreservingDevice(): void {
  const kv = new Map(db.kv);
  resetRuntime();
  for (const [k, v] of kv) db.kv.set(k, v);
}

/** Applies the action to the real App and to the model; returns the renderer. */
async function apply(
  renderer: Renderer,
  model: Model,
  action: Action,
): Promise<Renderer> {
  switch (action.kind) {
    case 'background_foreground':
      await appStateChange('background');
      await appStateChange('active');
      return renderer;
    case 'process_death': {
      unmount(renderer);
      relaunchPreservingDevice();
      const fresh = await launchToFirstScreen();
      const { stashProfile, stashNotifications } = model;
      Object.assign(model, freshModel(), { stashProfile, stashNotifications });
      return fresh;
    }
    case 'type': {
      await typeName(renderer, action.text);
      model.name = action.text;
      return renderer;
    }
    case 'press': {
      const { label } = action;
      if (model.stage === 'welcome') {
        await press(renderer, label);
        if (label === 'Start your first read') {
          model.stage = 'onboarding:name';
          model.stepIndex = 0;
          model.name = '';
          model.answers = {};
          model.notificationChoice = null;
        } else {
          model.stage = 'signin';
        }
        return renderer;
      }
      if (model.stage === 'signin') {
        await press(renderer, label);
        model.stage = 'welcome';
        return renderer;
      }
      const step = currentStep(model);
      if (label === 'Back') {
        await press(renderer, label);
        if (model.stepIndex === 0) {
          model.stage = 'welcome';
        } else {
          model.stepIndex -= 1;
          model.stage = `onboarding:${currentStep(model)}`;
        }
        return renderer;
      }
      if (label === 'Continue') {
        if (!modelContinueEnabled(model)) {
          await expect(press(renderer, label)).rejects.toThrow(/disabled/);
          return renderer;
        }
        await press(renderer, label);
        model.stepIndex += 1;
        model.stage = `onboarding:${currentStep(model)}`;
        return renderer;
      }
      // A choice card.
      const choice = CHOICES[step as ChoiceStep].find(c => c.label === label)!;
      await press(renderer, label);
      model.answers[step as ChoiceStep] = choice.value;
      return renderer;
    }
    case 'finish': {
      if (action.os === 'denied') {
        notifeeMock.requestPermission.mockResolvedValueOnce({
          authorizationStatus: 0,
        });
      } else if (action.os === 'throws') {
        notifeeMock.requestPermission.mockRejectedValueOnce(
          new Error('injected'),
        );
      }
      // Fault table semantics mirror the harness: a one-shot fault replaces
      // (and un-sticks) a sticky one; a sticky fault keeps failing until
      // replaced; no new fault leaves the previous sticky one in force.
      const attemptFails =
        action.stashFault !== 'none' || model.stashFaultSticky;
      if (action.stashFault === 'once') {
        db.failNextWrite(PENDING_PROFILE_KEY);
        model.stashFaultSticky = false;
      }
      if (action.stashFault === 'sticky') {
        db.failWrites(PENDING_PROFILE_KEY);
        model.stashFaultSticky = true;
      }
      await press(renderer, action.control);
      // Notification choice is decided once per questionnaire visit; only
      // the first decision may prompt the OS.
      let enabled = model.stashNotifications?.enabled ?? false;
      if (model.notificationChoice === null) {
        model.notificationChoice =
          action.control === 'Turn on reminders' ? 'enable' : 'not_now';
        if (model.notificationChoice === 'enable') {
          model.osPrompts += 1;
          enabled = action.os === 'granted';
        } else {
          enabled = false;
        }
        model.stashNotifications = { version: 1, enabled };
      }
      if (!attemptFails) {
        model.stashProfile = modelProfile(model);
        model.stage = 'signin';
        model.finished = true;
      }
      // else: stays on notifications with the error card visible.
      return renderer;
    }
  }
}

beforeEach(() => {
  resetRuntime();
});

const runRows: Record<string, unknown>[] = [];

afterAll(() => {
  for (const row of runRows) appendTableRow('fuzz-runs', row);
});

describe(`model-based random walks (${RUNS} runs, base seed ${BASE_SEED})`, () => {
  const seeds = Array.from({ length: RUNS }, (_, i) => BASE_SEED + i);
  it.each(seeds)(
    'seed %i: the App agrees with the model after every action',
    async seed => {
      const rng = new Rng(seed);
      const log = new JourneyLog(`fuzz/${seed}`, 'last');
      const model = freshModel();
      const actions: string[] = [];
      let renderer = await launchToFirstScreen();
      try {
        assertMatchesModel(renderer, model, 'launch');
        capture(log, renderer, 'launch');
        for (let i = 0; i < MAX_ACTIONS && !model.finished; i += 1) {
          const action = chooseAction(rng, model);
          actions.push(describeAction(action));
          renderer = await apply(renderer, model, action);
          capture(log, renderer, describeAction(action));
          assertMatchesModel(
            renderer,
            model,
            `#${i} ${describeAction(action)}`,
          );
          if (
            model.stashFaultSticky &&
            model.stage === 'onboarding:notifications'
          ) {
            expect(allText(renderer)).toContain('disk I/O error (injected)');
          }
        }
        // Whatever happened, never a skip, never network, never a prompt
        // without an explicit "Turn on reminders".
        const finalStage = stageOf(renderer);
        log.finish({
          seed,
          actions,
          finalStage,
          finished: model.finished,
          model,
          counters: counters(),
          kv: db.kvSnapshot(),
        });
        const row = {
          seed,
          actions: actions.length,
          finished: model.finished,
          finalStage,
          ...counters(),
        };
        // Heap after everything from this walk is torn down; a steady climb
        // across seeds would point at a retention problem in App or harness.
        unmount(renderer);
        runRows.push({ ...row, ...heapSample() });
      } catch (error) {
        log.finish({
          seed,
          actions,
          failed: true,
          model,
          counters: counters(),
          kv: db.kvSnapshot(),
        });
        runRows.push({
          seed,
          actions: actions.length,
          failed: true,
          ...counters(),
        });
        throw new Error(
          `seed ${seed} failed after ${actions.length} actions: ${actions.join(' | ')}\n${String(
            error instanceof Error ? (error.stack ?? error.message) : error,
          )}`,
        );
      }
    },
  );
});
