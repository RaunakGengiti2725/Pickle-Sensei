/**
 * H09-01 adversarial attack — are the checkable claims in D-044 true?
 *
 * D-044 makes concrete statements about the tree: which suites reference
 * `continueAsGuest`, that no shipping code navigates to `ResultDetails`,
 * that the deleted adapter suite's behaviours live on in named suites, and
 * that the moved recap types are only consumed by the durable summary. Each
 * `it` re-derives one claim from the files themselves.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const MOBILE_ROOT = join(__dirname, '..', '..');
const REPO_ROOT = join(MOBILE_ROOT, '..', '..');
const CORE_TESTS = join(REPO_ROOT, 'packages', 'audio-coach-core', 'test');

function filesUnder(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const file = join(directory, entry);
    if (statSync(file).isDirectory()) filesUnder(file, out);
    else if (/\.[jt]sx?$/.test(entry)) out.push(file);
  }
  return out;
}

const rel = (file: string) => relative(MOBILE_ROOT, file).split('\\').join('/');
const read = (file: string) => readFileSync(file, 'utf8');

function d044(): string {
  const decisions = read(join(REPO_ROOT, 'docs', 'DECISIONS.md'));
  const start = decisions.indexOf('D-044: Live Court dead paths');
  expect(start).toBeGreaterThan(-1);
  return decisions.slice(start);
}

describe('H09-01 attack: D-044 claims re-derived from the tree', () => {
  it('retired modules are gone in every extension Metro would resolve, and nothing references them', () => {
    const retired = ['liveCourt', 'liveSessionCoach'];
    const present = retired
      .flatMap(name =>
        [
          '.ts',
          '.tsx',
          '.js',
          '.jsx',
          '.ios.ts',
          '.native.ts',
          '/index.ts',
        ].map(ext => `src/flow/${name}${ext}`),
      )
      .filter(path => existsSync(join(MOBILE_ROOT, path)));
    expect(present).toEqual([]);
    const referrers = [
      ...filesUnder(join(MOBILE_ROOT, 'src')),
      ...filesUnder(join(MOBILE_ROOT, '__tests__')),
      join(MOBILE_ROOT, 'App.tsx'),
      join(MOBILE_ROOT, 'index.js'),
    ]
      .map(rel)
      .filter(
        file =>
          file !== '__tests__/liveCourt.test.ts' &&
          !file.startsWith('__tests__/attackH09/'),
      )
      .filter(file =>
        /['"`][^'"`]*\/(liveCourt|liveSessionCoach)['"`]/.test(
          read(join(MOBILE_ROOT, file)),
        ),
      );
    expect(referrers).toEqual([]);
  });

  it('`continueAsGuest` has no shipping caller and exactly the suites D-044 lists reference it', () => {
    const shippingCallers = [
      ...filesUnder(join(MOBILE_ROOT, 'src')),
      join(MOBILE_ROOT, 'App.tsx'),
    ]
      .filter(
        file =>
          rel(file) !== 'src/auth/authStore.ts' &&
          read(file).includes('continueAsGuest'),
      )
      .map(rel);
    expect(shippingCallers).toEqual([]);
    const suites = filesUnder(join(MOBILE_ROOT, '__tests__'))
      .filter(
        file =>
          !rel(file).startsWith('__tests__/attackH09/') &&
          read(file).includes('continueAsGuest'),
      )
      .map(file =>
        rel(file)
          .replace(/^__tests__\//, '')
          .replace(/\.test\.tsx?$/, ''),
      )
      .sort();
    expect(suites).toEqual(
      [
        'authStore',
        'authSessionMigration',
        'authBillingLifecycle',
        'wf/flow-sign-in-auth',
        'wf/flow-sign-in-auth-token-expiry',
        'wf/flow-guest-local-only.stores',
        'wf/flow-launch-onboarding-gate',
      ].sort(),
    );
  });

  it('no shipping code navigates to ResultDetails (registration only)', () => {
    const navigators = filesUnder(join(MOBILE_ROOT, 'src'))
      .filter(file =>
        /navigate\(\s*['"]ResultDetails['"]|(?:navigate|push|replace)\(\s*\{\s*name:\s*['"]ResultDetails['"]/.test(
          read(file),
        ),
      )
      .map(rel);
    expect(navigators).toEqual([]);
    expect(
      read(join(MOBILE_ROOT, 'src/navigation/RootNavigator.tsx')),
    ).toContain('name="ResultDetails"');
  });

  it('the migration targets D-044 names exist and carry the named behaviours', () => {
    const liveSession = read(join(CORE_TESTS, 'liveSession.test.ts'));
    const cueEngine = read(join(CORE_TESTS, 'cueEngine.test.ts'));
    const sessionFlow = read(
      join(MOBILE_ROOT, '__tests__', 'sessionFlow.test.ts'),
    );
    const progression = read(
      join(MOBILE_ROOT, '__tests__', 'gameplayProgression.test.ts'),
    );
    expect(liveSession).toContain('describe("session framing lines"');
    expect(liveSession).toContain(
      'Session over. No swings could be scored this time.',
    );
    expect(liveSession).toMatch(/REPEAT wording/);
    expect(liveSession).toMatch(/personal best/);
    expect(liveSession).toMatch(/coaches the SETUP after a streak/);
    expect(liveSession).toMatch(/deterministic/);
    expect(cueEngine).toMatch(/every non-SILENCE decision carries text/);
    expect(sessionFlow).toContain('DEV_REPLAY_RALLY');
    expect(progression).toMatch(/round-trips every field/);
    expect(progression).toMatch(/rejects foreign or corrupt payloads/);
  });

  it('every behaviour the deleted adapter suite pinned is either migrated or explicitly recorded as retired in D-044', () => {
    const deletedAssertions = [
      'speaks an audible start line immediately',
      'labels the replay start line as a demo',
      'speaks a knee-bend correction (with the score)',
      'never speaks twice for the same event',
      'hands the cue CATEGORY to the voice port',
      'records spoken=false when the port suppresses a cue',
      'stays quiet for pending events and speaks the moment one turns terminal',
      'gives honest feedback for EVERY terminal scenario',
      'escalates to setup guidance after three consecutive unreadable swings',
      'praises clean swings and announces personal bests',
      'muting logs captions without speaking',
      'is caption-only (spoken: false) when the build has no voice',
      'mirrors every cue to the HUD observer',
      'speaks an honest wrap-up with the start→end movement and registers the recap',
      'wraps up honestly when nothing could be scored',
      'produces identical cue sequences for identical sessions',
      'speaks once per engine-closed event across scored, low-confidence and abstained outcomes',
    ];
    const record = d044();
    const migratedOrRetired: Record<string, RegExp> = {
      'speaks an audible start line immediately': /start\/end framing lines/,
      'labels the replay start line as a demo': /start\/end framing lines|demo/,
      'speaks a knee-bend correction (with the score)': /cue selection/,
      'never speaks twice for the same event': /speak-once-per-event/,
      'hands the cue CATEGORY to the voice port':
        /HUD `onCue` mirroring|category/i,
      'records spoken=false when the port suppresses a cue': /`spoken=false`/,
      'stays quiet for pending events and speaks the moment one turns terminal':
        /pending|terminal/,
      'gives honest feedback for EVERY terminal scenario':
        /non-empty text|terminal/,
      'escalates to setup guidance after three consecutive unreadable swings':
        /no-read → setup-guidance escalation/,
      'praises clean swings and announces personal bests':
        /praise\/personal-best thresholds/,
      'muting logs captions without speaking': /muted\/unavailable captions/,
      'is caption-only (spoken: false) when the build has no voice':
        /muted\/unavailable captions/,
      'mirrors every cue to the HUD observer': /HUD `onCue` mirroring/,
      'speaks an honest wrap-up with the start→end movement and registers the recap':
        /completed-recap registry/,
      'wraps up honestly when nothing could be scored':
        /Session over\. No swings could be scored this time\./,
      'produces identical cue sequences for identical sessions': /determinism/,
      'speaks once per engine-closed event across scored, low-confidence and abstained outcomes':
        /speak-once-per-event|`DEV_REPLAY_RALLY` closing exactly three events/,
    };
    const unaccounted = deletedAssertions.filter(title => {
      const pattern = migratedOrRetired[title];
      return pattern === undefined || !pattern.test(record);
    });
    expect(unaccounted).toEqual([]);
  });

  it('the moved LiveCoachCue/LiveCoachRecap types have no consumer left outside the durable summary module', () => {
    const consumers = [
      ...filesUnder(join(MOBILE_ROOT, 'src')),
      ...filesUnder(join(MOBILE_ROOT, '__tests__')),
    ]
      .filter(file => /\bLiveCoach(Cue|Recap)\b/.test(read(file)))
      .map(rel)
      .filter(file => !file.startsWith('__tests__/attackH09/'))
      .sort();
    expect(consumers).toEqual(['src/flow/liveSessionSummary.ts']);
  });
});
