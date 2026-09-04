import {
  CHOICES,
  PENDING_NOTIFICATIONS_KEY,
  PENDING_PROFILE_KEY,
  STEP_ORDER,
  SIGNED_OUT_DATA_OWNER,
  allText,
  appStateChange,
  assertStageControls,
  capture,
  counters,
  db,
  fetchCalls,
  finishSplash,
  getActiveDataOwner,
  hasPressable,
  isDisabled,
  keychain,
  launchToFirstScreen,
  mountApp,
  nameInput,
  notifeeMock,
  press,
  pressableLabels,
  progressValue,
  resetRuntime,
  settle,
  splashVisible,
  stageOf,
  surfaceStrings,
  typeName,
  unmount,
  type Renderer,
} from '../../test-harness/journeys/appJourneyHarness';
import { act } from 'react-test-renderer';
import {
  JourneyLog,
  appendTableRow,
  forbiddenCopyHits,
} from '../../test-harness/journeys/journeyEvidence';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';
import { useAppStore } from '../../src/state/appStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';

/**
 * First-launch journey, full App tree, real stores, mocked native edges.
 *
 *   cold launch → splash → Welcome → "Start your first read" → 8 onboarding
 *   steps (back navigation, interruptions) → notification choice → SignIn.
 *
 * Every scenario records a step ledger (stage, controls, kv, store state,
 * counters) and a textual screenshot per step; the screenshots of the
 * canonical path are pinned as snapshots. Invariants checked on EVERY step:
 * no skip affordance, only the expected controls for that stage, no network,
 * no OS permission prompt before the user asks for one.
 */

jest.useFakeTimers();

const recordSpy = jest.spyOn(stabilitySlo, 'record');

const CANONICAL_PROFILE = {
  firstName: 'Dana',
  gender: 'female',
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};

const CANONICAL_ANSWERS = {
  gender: 'Female',
  level: '3.5',
  handedness: 'Right-handed',
  goal: 'Third-shot drops',
  problem: 'Control',
} as const;

const scenarioRows: Record<string, unknown>[] = [];

function pendingProfile(): unknown {
  const raw = db.kv.get(PENDING_PROFILE_KEY);
  return raw === undefined ? undefined : JSON.parse(raw);
}

function pendingNotifications(): unknown {
  const raw = db.kv.get(PENDING_NOTIFICATIONS_KEY);
  return raw === undefined ? undefined : JSON.parse(raw);
}

/** Records the step and enforces the cross-cutting invariants. */
function check(log: JourneyLog, renderer: Renderer, action: string) {
  const step = capture(log, renderer, action);
  const stage = assertStageControls(renderer);
  expect(step.stage).toBe(stage);
  expect(forbiddenCopyHits(surfaceStrings(renderer))).toEqual([]);
  expect(fetchCalls).toEqual([]);
  return step;
}

async function startQuestionnaire(log: JourneyLog): Promise<Renderer> {
  const renderer = await launchToFirstScreen();
  check(log, renderer, 'cold launch → first screen');
  expect(stageOf(renderer)).toBe('welcome');
  await press(renderer, 'Start your first read');
  const step = check(log, renderer, 'press Start your first read');
  expect(step.stage).toBe('onboarding:name');
  return renderer;
}

/** Answers steps 1..6 canonically, asserting each step as it goes. */
async function answerThroughProblem(
  log: JourneyLog,
  renderer: Renderer,
  name = ' Dana ',
) {
  expect(isDisabled(renderer, 'Continue')).toBe(true);
  await typeName(renderer, name);
  check(log, renderer, `type name ${JSON.stringify(name)}`);
  expect(isDisabled(renderer, 'Continue')).toBe(false);
  await press(renderer, 'Continue');
  for (const step of [
    'gender',
    'level',
    'handedness',
    'goal',
    'problem',
  ] as const) {
    const s = check(log, renderer, `arrive ${step}`);
    expect(s.stage).toBe(`onboarding:${step}`);
    expect(s.progress).toEqual({
      now: STEP_ORDER.indexOf(step) + 1,
      max: STEP_ORDER.length,
    });
    expect(isDisabled(renderer, 'Continue')).toBe(true);
    await press(renderer, CANONICAL_ANSWERS[step]);
    const selected = check(log, renderer, `select ${CANONICAL_ANSWERS[step]}`);
    const radios = selected.pressables.filter(p => p.role === 'radio');
    expect(radios.filter(p => p.selected).map(p => p.label)).toEqual([
      CANONICAL_ANSWERS[step],
    ]);
    expect(isDisabled(renderer, 'Continue')).toBe(false);
    await press(renderer, 'Continue');
  }
  const reveal = check(log, renderer, 'arrive reveal');
  expect(reveal.stage).toBe('onboarding:reveal');
  expect(reveal.progress).toEqual({ now: 7, max: 8 });
}

async function walkToNotifications(log: JourneyLog, renderer: Renderer) {
  await answerThroughProblem(log, renderer);
  expect(allText(renderer)).toContain('Built for Dana.');
  await press(renderer, 'Continue');
  const step = check(log, renderer, 'arrive notifications');
  expect(step.stage).toBe('onboarding:notifications');
  expect(step.progress).toEqual({ now: 8, max: 8 });
  expect(notifeeMock.requestPermission).not.toHaveBeenCalled();
}

beforeEach(() => {
  resetRuntime();
  recordSpy.mockClear();
});

afterAll(() => {
  for (const row of scenarioRows) appendTableRow('scenarios', row);
});

describe('first launch → Welcome', () => {
  it('cold start on an empty device hydrates the real stores, paints Welcome under the splash, then clears the splash', async () => {
    const log = new JourneyLog('01-cold-launch');
    const renderer = await mountApp();
    // Hydration: real authStore consulted SQLite kv + Keychain, found nothing.
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(keychain.size).toBe(0);
    const kvReads = db.ledger.filter(s =>
      s.sql.startsWith('SELECT value FROM kv'),
    );
    expect(kvReads.map(s => s.params[0])).toEqual(
      expect.arrayContaining(['auth.session', 'auth.local-mode']),
    );
    expect(splashVisible(renderer)).toBe(true);
    const underSplash = check(log, renderer, 'hydrated, splash overlaid');
    expect(underSplash.stage).toBe('welcome');
    expect(underSplash.screen).toMatchSnapshot('welcome-under-splash');

    await finishSplash(renderer);
    expect(splashVisible(renderer)).toBe(false);
    const welcome = check(log, renderer, 'splash finished');
    expect(welcome.stage).toBe('welcome');
    expect(pressableLabels(renderer)).toEqual([
      'I already have an account',
      'Start your first read',
    ]);
    expect(welcome.screen).toMatchSnapshot('welcome');
    // Nothing was written for a fresh signed-out launch beyond the stores'
    // own bookkeeping — in particular no stash and no reminder preference.
    expect(pendingProfile()).toBeUndefined();
    expect(pendingNotifications()).toBeUndefined();
    expect(notifeeMock.requestPermission).not.toHaveBeenCalled();
    log.finish({ counters: counters(), kv: db.kvSnapshot() });
    scenarioRows.push({
      scenario: log.scenario,
      steps: log.steps.length,
      ...counters(),
    });
  });

  it('splash never clears before hydration is ready, even if the video ends first', async () => {
    const log = new JourneyLog('02-splash-waits-for-hydration');
    const renderer = await mountApp();
    // The fake device hydrates instantly; put the gate back into its
    // not-ready state to observe the ordering contract from the splash side.
    await act(async () => {
      useAppStore.setState({ hydrated: false });
    });
    const video = renderer.root.findAll(
      n => typeof n.type === 'string' && n.props.testID === 'splash-video',
    )[0]!;
    await act(async () => {
      video.props.onEnd();
      jest.advanceTimersByTime(5_000);
    });
    expect(splashVisible(renderer)).toBe(true);
    expect(allText(renderer)).toContain('Getting things ready');
    check(log, renderer, 'video ended, app store not hydrated');
    await act(async () => {
      useAppStore.setState({ hydrated: true });
    });
    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    expect(splashVisible(renderer)).toBe(false);
    expect(stageOf(renderer)).toBe('welcome');
    check(log, renderer, 'hydrated → splash cleared');
    log.finish();
  });
});

describe('Welcome → all onboarding steps → notification choice → SignIn', () => {
  it('canonical path: every step in order, "Not now" stashes the profile and lands on SignIn without any OS prompt or network', async () => {
    const log = new JourneyLog('03-canonical-not-now');
    const renderer = await startQuestionnaire(log);
    expect(progressValue(renderer)).toEqual({ now: 1, max: 8 });
    expect(nameInput(renderer)).toEqual({
      value: '',
      placeholder: 'First name',
    });

    // Whitespace-only never unlocks step one.
    await typeName(renderer, '   ');
    expect(isDisabled(renderer, 'Continue')).toBe(true);
    check(log, renderer, 'whitespace name keeps Continue locked');

    await walkToNotifications(log, renderer);
    for (const step of log.steps) {
      if (step.stage.startsWith('onboarding:')) {
        expect(step.screen).toMatchSnapshot(`${step.index}-${step.action}`);
      }
    }
    expect(pendingProfile()).toBeUndefined();
    expect(pendingNotifications()).toBeUndefined();

    await press(renderer, 'Not now');
    const signin = check(log, renderer, 'press Not now');
    expect(signin.stage).toBe('signin');
    expect(signin.screen).toMatchSnapshot('signin');
    expect(notifeeMock.requestPermission).not.toHaveBeenCalled();
    expect(pendingProfile()).toEqual({
      version: 1,
      profile: CANONICAL_PROFILE,
    });
    expect(pendingNotifications()).toEqual({ version: 1, enabled: false });
    // Still signed out: nothing owner-scoped was written and no session exists.
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(useAppStore.getState().profile).toBeNull();
    expect(Object.keys(db.kvSnapshot())).toEqual([
      PENDING_NOTIFICATIONS_KEY,
      PENDING_PROFILE_KEY,
    ]);
    expect(fetchCalls).toEqual([]);
    expect(keychain.size).toBe(0);

    // SignIn's Back returns to Welcome; the stash survives untouched.
    await press(renderer, 'Back');
    const welcome = check(log, renderer, 'SignIn Back → Welcome');
    expect(welcome.stage).toBe('welcome');
    expect(pendingProfile()).toEqual({
      version: 1,
      profile: CANONICAL_PROFILE,
    });
    log.finish({ counters: counters(), kv: db.kvSnapshot() });
    scenarioRows.push({
      scenario: log.scenario,
      steps: log.steps.length,
      ...counters(),
    });
  });

  it('"Turn on reminders" asks the OS exactly once; granted → enabled:true stash, then SignIn', async () => {
    const log = new JourneyLog('04-turn-on-reminders-granted');
    const renderer = await startQuestionnaire(log);
    await walkToNotifications(log, renderer);
    await press(renderer, 'Turn on reminders');
    const signin = check(log, renderer, 'press Turn on reminders (granted)');
    expect(signin.stage).toBe('signin');
    expect(notifeeMock.requestPermission).toHaveBeenCalledTimes(1);
    expect(pendingNotifications()).toEqual({ version: 1, enabled: true });
    expect(pendingProfile()).toEqual({
      version: 1,
      profile: CANONICAL_PROFILE,
    });
    expect(useNotificationStore.getState().permission).toBe('granted');
    // Signed out → nothing may be scheduled yet, whatever the user chose.
    expect(notifeeMock.createTriggerNotification).not.toHaveBeenCalled();
    log.finish({ counters: counters(), kv: db.kvSnapshot() });
    scenarioRows.push({
      scenario: log.scenario,
      steps: log.steps.length,
      ...counters(),
    });
  });

  it('"Turn on reminders" denied by the OS still completes the journey with enabled:false', async () => {
    const log = new JourneyLog('05-turn-on-reminders-denied');
    notifeeMock.requestPermission.mockResolvedValueOnce({
      authorizationStatus: 0,
    });
    const renderer = await startQuestionnaire(log);
    await walkToNotifications(log, renderer);
    await press(renderer, 'Turn on reminders');
    const signin = check(log, renderer, 'press Turn on reminders (denied)');
    expect(signin.stage).toBe('signin');
    expect(notifeeMock.requestPermission).toHaveBeenCalledTimes(1);
    expect(pendingNotifications()).toEqual({ version: 1, enabled: false });
    expect(useNotificationStore.getState().permission).toBe('denied');
    log.finish({ counters: counters(), kv: db.kvSnapshot() });
    scenarioRows.push({
      scenario: log.scenario,
      steps: log.steps.length,
      ...counters(),
    });
  });

  it('"Turn on reminders" when the OS prompt throws still completes the journey with enabled:false', async () => {
    const log = new JourneyLog('06-turn-on-reminders-throws');
    notifeeMock.requestPermission.mockRejectedValueOnce(
      new Error('UNUserNotificationCenter unavailable'),
    );
    const renderer = await startQuestionnaire(log);
    await walkToNotifications(log, renderer);
    await press(renderer, 'Turn on reminders');
    const signin = check(log, renderer, 'press Turn on reminders (throws)');
    expect(signin.stage).toBe('signin');
    expect(pendingNotifications()).toEqual({ version: 1, enabled: false });
    expect(useNotificationStore.getState().permission).toBe('unknown');
    log.finish({ counters: counters(), kv: db.kvSnapshot() });
    scenarioRows.push({
      scenario: log.scenario,
      steps: log.steps.length,
      ...counters(),
    });
  });

  it('while the finish is in flight both notification controls are disabled and read "Finishing setup…"; no double submit', async () => {
    const log = new JourneyLog('07-finish-in-flight');
    const renderer = await startQuestionnaire(log);
    await walkToNotifications(log, renderer);
    db.deferWrites(PENDING_PROFILE_KEY);
    await press(renderer, 'Not now');
    const busy = check(log, renderer, 'Not now pressed, stash write parked');
    expect(busy.stage).toBe('onboarding:notifications');
    expect(db.pendingWriteCount(PENDING_PROFILE_KEY)).toBe(1);
    expect(
      busy.pressables.filter(p => p.label === 'Not now')[0]?.disabled,
    ).toBe(true);
    expect(allText(renderer)).toContain('Finishing setup…');
    expect(hasPressable(renderer, 'Turn on reminders')).toBe(false);
    const finishing = busy.pressables.find(p => p.label === 'Finishing setup…');
    expect(finishing?.disabled).toBe(true);
    expect(busy.screen).toMatchSnapshot('notifications-finishing');
    // A second tap on either control while busy is impossible (disabled).
    await expect(press(renderer, 'Not now')).rejects.toThrow(/disabled/);
    db.releaseWrites(PENDING_PROFILE_KEY);
    await settle();
    const signin = check(log, renderer, 'stash write released');
    expect(signin.stage).toBe('signin');
    expect(
      db.writes().filter(s => s.params[0] === PENDING_PROFILE_KEY),
    ).toHaveLength(1);
    log.finish({ counters: counters(), kv: db.kvSnapshot() });
  });
});

describe('persistence failure at the very end', () => {
  it('stash write fails → error shown, stays on the notification step, no SignIn; retry does NOT re-prompt the OS and then succeeds', async () => {
    const log = new JourneyLog('08-stash-write-fails-then-retry');
    const renderer = await startQuestionnaire(log);
    await walkToNotifications(log, renderer);
    db.failNextWrite(
      PENDING_PROFILE_KEY,
      'SQLITE_FULL: database or disk is full',
    );
    await press(renderer, 'Turn on reminders');
    const failed = check(
      log,
      renderer,
      'Turn on reminders → stash write fails',
    );
    expect(failed.stage).toBe('onboarding:notifications');
    expect(allText(renderer)).toContain(
      'SQLITE_FULL: database or disk is full',
    );
    expect(useAppStore.getState().onboardingError).toBe(
      'SQLITE_FULL: database or disk is full',
    );
    expect(pendingProfile()).toBeUndefined();
    // The OS was asked once and the answer was persisted device-level even
    // though the profile write failed.
    expect(notifeeMock.requestPermission).toHaveBeenCalledTimes(1);
    expect(pendingNotifications()).toEqual({ version: 1, enabled: true });
    expect(isDisabled(renderer, 'Turn on reminders')).toBe(false);
    expect(isDisabled(renderer, 'Not now')).toBe(false);
    expect(failed.screen).toMatchSnapshot('notifications-stash-error');

    // Retry with the OTHER control: the notification choice is already made,
    // so the OS is not asked again and the earlier choice is kept.
    await press(renderer, 'Not now');
    const signin = check(log, renderer, 'retry Not now → succeeds');
    expect(signin.stage).toBe('signin');
    expect(notifeeMock.requestPermission).toHaveBeenCalledTimes(1);
    expect(pendingNotifications()).toEqual({ version: 1, enabled: true });
    expect(pendingProfile()).toEqual({
      version: 1,
      profile: CANONICAL_PROFILE,
    });
    expect(useAppStore.getState().onboardingError).toBeNull();
    log.finish({ counters: counters(), kv: db.kvSnapshot() });
    scenarioRows.push({
      scenario: log.scenario,
      steps: log.steps.length,
      ...counters(),
    });
  });

  it('a persistently failing stash never reaches SignIn, however many times the user retries', async () => {
    const log = new JourneyLog('09-stash-write-fails-persistently');
    const renderer = await startQuestionnaire(log);
    await walkToNotifications(log, renderer);
    db.failWrites(PENDING_PROFILE_KEY);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await press(renderer, 'Not now');
      const step = check(log, renderer, `Not now attempt ${attempt}`);
      expect(step.stage).toBe('onboarding:notifications');
      expect(pendingProfile()).toBeUndefined();
    }
    expect(notifeeMock.requestPermission).not.toHaveBeenCalled();
    // Back still works from here: the user is never trapped.
    await press(renderer, 'Back');
    expect(stageOf(renderer)).toBe('onboarding:reveal');
    check(log, renderer, 'Back from failing notifications step');
    log.finish({ counters: counters(), kv: db.kvSnapshot() });
  });

  it('the notification choice write failing is swallowed: the profile stash still lands and the journey completes', async () => {
    const log = new JourneyLog('10-notification-choice-write-fails');
    const renderer = await startQuestionnaire(log);
    await walkToNotifications(log, renderer);
    db.failNextWrite(PENDING_NOTIFICATIONS_KEY);
    await press(renderer, 'Not now');
    const signin = check(
      log,
      renderer,
      'Not now with failing notification write',
    );
    expect(signin.stage).toBe('signin');
    expect(pendingNotifications()).toBeUndefined();
    expect(pendingProfile()).toEqual({
      version: 1,
      profile: CANONICAL_PROFILE,
    });
    log.finish({ counters: counters(), kv: db.kvSnapshot() });
  });
});

describe('back navigation', () => {
  it('step one Back returns to Welcome with no dialog; Start again begins a fresh questionnaire', async () => {
    const log = new JourneyLog('11-step-one-back');
    const renderer = await startQuestionnaire(log);
    const back = renderer.root.findAll(
      n =>
        n.props.accessibilityLabel === 'Back' &&
        typeof n.props.onPress === 'function',
    );
    expect(back.length).toBeGreaterThan(0);
    expect(
      back.some(
        n => n.props.accessibilityHint === 'Return to the welcome screen',
      ),
    ).toBe(true);
    await typeName(renderer, 'Dana');
    await press(renderer, 'Back');
    const welcome = check(log, renderer, 'step one Back');
    expect(welcome.stage).toBe('welcome');
    expect(allText(renderer)).not.toContain('Leave setup');
    expect(allText(renderer)).not.toContain('Sign out');
    await press(renderer, 'Start your first read');
    const fresh = check(log, renderer, 'Start again');
    expect(fresh.stage).toBe('onboarding:name');
    expect(nameInput(renderer)?.value).toBe('');
    expect(isDisabled(renderer, 'Continue')).toBe(true);
    expect(pendingProfile()).toBeUndefined();
    log.finish({ counters: counters(), kv: db.kvSnapshot() });
  });

  it('Back from every later step returns exactly one step with the earlier answers preserved and Continue still unlocked', async () => {
    const log = new JourneyLog('12-back-through-every-step');
    const renderer = await startQuestionnaire(log);
    await walkToNotifications(log, renderer);
    // notifications → reveal → problem → goal → handedness → level → gender → name
    const expected: (typeof STEP_ORDER)[number][] = [
      'reveal',
      'problem',
      'goal',
      'handedness',
      'level',
      'gender',
      'name',
    ];
    for (const step of expected) {
      await press(renderer, 'Back');
      const s = check(log, renderer, `Back → ${step}`);
      expect(s.stage).toBe(`onboarding:${step}`);
      expect(s.progress).toEqual({ now: STEP_ORDER.indexOf(step) + 1, max: 8 });
      expect(isDisabled(renderer, 'Continue')).toBe(false);
      if (step in CANONICAL_ANSWERS) {
        const answer =
          CANONICAL_ANSWERS[step as keyof typeof CANONICAL_ANSWERS];
        const selected = s.pressables.filter(
          p => p.role === 'radio' && p.selected,
        );
        expect(selected.map(p => p.label)).toEqual([answer]);
      }
      if (step === 'name') expect(nameInput(renderer)?.value).toBe(' Dana ');
    }
    // One more Back from step one leaves to Welcome (never SignIn).
    await press(renderer, 'Back');
    expect(check(log, renderer, 'Back → Welcome').stage).toBe('welcome');
    expect(pendingProfile()).toBeUndefined();
    expect(notifeeMock.requestPermission).not.toHaveBeenCalled();
    log.finish({ counters: counters(), kv: db.kvSnapshot() });
  });

  it('changing an earlier answer after going back is what gets stashed (newest intent wins)', async () => {
    const log = new JourneyLog('13-change-answer-after-back');
    const renderer = await startQuestionnaire(log);
    await walkToNotifications(log, renderer);
    await press(renderer, 'Back'); // reveal
    await press(renderer, 'Back'); // problem
    await press(renderer, 'Back'); // goal
    expect(stageOf(renderer)).toBe('onboarding:goal');
    await press(renderer, 'Dinks');
    const changed = check(log, renderer, 'change goal to Dinks');
    expect(
      changed.pressables.filter(p => p.selected).map(p => p.label),
    ).toEqual(['Dinks']);
    await press(renderer, 'Continue');
    expect(stageOf(renderer)).toBe('onboarding:problem');
    await press(renderer, 'Continue');
    expect(stageOf(renderer)).toBe('onboarding:reveal');
    check(log, renderer, 'reveal after goal change');
    await press(renderer, 'Continue');
    await press(renderer, 'Not now');
    expect(stageOf(renderer)).toBe('signin');
    const stash = pendingProfile() as { profile: Record<string, string> };
    expect(stash.profile.goal).toBe('dinks');
    expect(stash.profile.focusCheckpoint).not.toBe(
      CANONICAL_PROFILE.focusCheckpoint,
    );
    check(log, renderer, 'signin with changed goal');
    log.finish({ counters: counters(), kv: db.kvSnapshot(), stash });
  });
});

describe('interruption mid-questionnaire', () => {
  it('backgrounding and returning at step 4 keeps the step and every answer; telemetry records a clean session end; still no network', async () => {
    const log = new JourneyLog('14-background-foreground-mid-questionnaire');
    const renderer = await startQuestionnaire(log);
    await typeName(renderer, 'Dana');
    await press(renderer, 'Continue');
    await press(renderer, 'Female');
    await press(renderer, 'Continue');
    await press(renderer, '3.5');
    await press(renderer, 'Continue');
    expect(stageOf(renderer)).toBe('onboarding:handedness');
    await press(renderer, 'Left-handed');
    const before = check(log, renderer, 'at handedness, Left-handed selected');
    await appStateChange('background');
    expect(recordSpy).toHaveBeenCalledWith({ kind: 'session_ended_clean' });
    const inBackground = check(log, renderer, 'backgrounded');
    expect(inBackground.stage).toBe(before.stage);
    await appStateChange('active');
    const after = check(log, renderer, 'foregrounded');
    expect(after.stage).toBe('onboarding:handedness');
    expect(after.progress).toEqual({ now: 4, max: 8 });
    expect(after.pressables).toEqual(before.pressables);
    // Foreground re-checks permission state but must not PROMPT.
    expect(notifeeMock.requestPermission).not.toHaveBeenCalled();
    expect(notifeeMock.getNotificationSettings).toHaveBeenCalled();
    expect(pendingProfile()).toBeUndefined();
    // Carry on to the end: the pre-background answers are what get stashed.
    await press(renderer, 'Continue');
    await press(renderer, 'Serve');
    await press(renderer, 'Continue');
    await press(renderer, 'Power');
    await press(renderer, 'Continue');
    await press(renderer, 'Continue');
    await press(renderer, 'Not now');
    expect(stageOf(renderer)).toBe('signin');
    expect(pendingProfile()).toEqual({
      version: 1,
      profile: {
        firstName: 'Dana',
        gender: 'female',
        skillLevel: '3.5',
        handedness: 'left',
        goal: 'serve',
        biggestProblem: 'power',
        focusCheckpoint: expect.any(String),
      },
    });
    log.finish({ counters: counters(), kv: db.kvSnapshot() });
  });

  it('process death at step 5 (unmount) persists nothing; the relaunch starts over at Welcome with an empty questionnaire', async () => {
    const log = new JourneyLog('15-process-death-mid-questionnaire');
    const renderer = await startQuestionnaire(log);
    await typeName(renderer, 'Dana');
    await press(renderer, 'Continue');
    await press(renderer, 'Male');
    await press(renderer, 'Continue');
    await press(renderer, '4.0');
    await press(renderer, 'Continue');
    await press(renderer, 'Right-handed');
    await press(renderer, 'Continue');
    expect(stageOf(renderer)).toBe('onboarding:goal');
    check(log, renderer, 'at goal step');
    const kvBeforeKill = db.kvSnapshot();
    unmount(renderer);
    // Nothing about the half-finished questionnaire reached the device.
    expect(db.kvSnapshot()).toEqual(kvBeforeKill);
    expect(pendingProfile()).toBeUndefined();

    // Relaunch (same device kv, same Keychain).
    resetStoresOnly();
    const relaunch = await launchToFirstScreen();
    const welcome = check(log, relaunch, 'relaunch after kill');
    expect(welcome.stage).toBe('welcome');
    await press(relaunch, 'Start your first read');
    const fresh = check(log, relaunch, 'Start after relaunch');
    expect(fresh.stage).toBe('onboarding:name');
    expect(nameInput(relaunch)?.value).toBe('');
    log.finish({ counters: counters(), kv: db.kvSnapshot() });
  });

  it('a completed questionnaire survives process death: the stash is still there for the first account that signs in', async () => {
    const log = new JourneyLog('16-process-death-after-finish');
    const renderer = await startQuestionnaire(log);
    await walkToNotifications(log, renderer);
    await press(renderer, 'Not now');
    expect(stageOf(renderer)).toBe('signin');
    unmount(renderer);
    resetStoresOnly();
    const relaunch = await launchToFirstScreen();
    // Signed-out relaunch: back at Welcome (there is no session), the stash
    // is untouched by hydration, and the primary CTA re-enters the
    // questionnaire (no device-history short-circuit).
    expect(check(log, relaunch, 'relaunch after finishing').stage).toBe(
      'welcome',
    );
    expect(pendingProfile()).toEqual({
      version: 1,
      profile: CANONICAL_PROFILE,
    });
    expect(pendingNotifications()).toEqual({ version: 1, enabled: false });
    await press(relaunch, 'Start your first read');
    expect(check(log, relaunch, 'Start again after finishing').stage).toBe(
      'onboarding:name',
    );
    log.finish({ counters: counters(), kv: db.kvSnapshot() });
  });
});

describe('returning player and sign-in surface', () => {
  it('"I already have an account" goes straight to SignIn, writes nothing, prompts nothing; Back returns to Welcome', async () => {
    const log = new JourneyLog('17-returning-player');
    const renderer = await launchToFirstScreen();
    const kvBefore = db.kvSnapshot();
    await press(renderer, 'I already have an account');
    const signin = check(log, renderer, 'press I already have an account');
    expect(signin.stage).toBe('signin');
    expect(db.kvSnapshot()).toEqual(kvBefore);
    expect(notifeeMock.requestPermission).not.toHaveBeenCalled();
    await press(renderer, 'Back');
    expect(check(log, renderer, 'Back').stage).toBe('welcome');
    log.finish({ counters: counters(), kv: db.kvSnapshot() });
  });

  it('SignIn: "Continue with Apple" without the native module shows an error card, keeps the stash, and never touches the network', async () => {
    const log = new JourneyLog('18-signin-apple-not-configured');
    const renderer = await startQuestionnaire(log);
    await walkToNotifications(log, renderer);
    await press(renderer, 'Not now');
    expect(stageOf(renderer)).toBe('signin');
    await press(renderer, 'Continue with Apple');
    const errored = check(
      log,
      renderer,
      'Continue with Apple (no native module)',
    );
    expect(errored.stage).toBe('signin');
    expect(allText(renderer)).toContain(
      'Native Apple sign-in module is missing from this build.',
    );
    expect(hasPressable(renderer, 'Dismiss sign-in error')).toBe(true);
    expect(fetchCalls).toEqual([]);
    expect(pendingProfile()).toEqual({
      version: 1,
      profile: CANONICAL_PROFILE,
    });
    await press(renderer, 'Dismiss sign-in error');
    expect(allText(renderer)).not.toContain('Native Apple sign-in module');
    check(log, renderer, 'dismissed error');
    log.finish({ counters: counters(), kv: db.kvSnapshot() });
  });
});

describe('no skip affordance and copy compliance across the whole pre-auth surface', () => {
  it('every stage: no "skip"/"Leave setup"/dialog, only the expected controls, no forbidden copy — exhaustive over all choice cards', async () => {
    const log = new JourneyLog('19-exhaustive-choices-no-skip');
    const renderer = await startQuestionnaire(log);
    await typeName(renderer, 'Ana-María O’Neil');
    await press(renderer, 'Continue');
    for (const step of [
      'gender',
      'level',
      'handedness',
      'goal',
      'problem',
    ] as const) {
      expect(stageOf(renderer)).toBe(`onboarding:${step}`);
      for (const choice of CHOICES[step]) {
        await press(renderer, choice.label);
        const s = check(log, renderer, `${step}: ${choice.label}`);
        expect(s.pressables.filter(p => p.selected).map(p => p.label)).toEqual([
          choice.label,
        ]);
      }
      await press(renderer, 'Continue');
    }
    expect(stageOf(renderer)).toBe('onboarding:reveal');
    expect(allText(renderer)).toContain('Built for Ana-María O’Neil.');
    check(log, renderer, 'reveal');
    await press(renderer, 'Continue');
    check(log, renderer, 'notifications');
    await press(renderer, 'Not now');
    check(log, renderer, 'signin');
    const stash = pendingProfile() as { profile: Record<string, string> };
    expect(stash.profile).toEqual({
      firstName: 'Ana-María O’Neil',
      gender: 'prefer_not_to_say',
      skillLevel: '5.0+',
      handedness: 'left',
      goal: 'all-around',
      biggestProblem: 'not sure',
      focusCheckpoint: expect.any(String),
    });
    // Matrix: every recorded stage × its control set.
    const matrix = log.steps.map(s => ({
      index: s.index,
      action: s.action,
      stage: s.stage,
      controls: s.pressables.map(
        p => `${p.role}:${p.label}${p.disabled ? '(disabled)' : ''}`,
      ),
    }));
    log.finish({ counters: counters(), kv: db.kvSnapshot(), matrix });
    scenarioRows.push({
      scenario: log.scenario,
      steps: log.steps.length,
      ...counters(),
    });
  });
});

/** Relaunch helper: stores as a fresh process would have them; device kv +
 * Keychain are deliberately KEPT. */
function resetStoresOnly() {
  const kv = new Map(db.kv);
  const keychainEntries = new Map(keychain);
  resetRuntime();
  for (const [k, v] of kv) db.kv.set(k, v);
  for (const [k, v] of keychainEntries) keychain.set(k, v);
}
