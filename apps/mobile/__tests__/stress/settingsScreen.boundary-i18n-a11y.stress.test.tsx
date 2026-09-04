import fs from 'node:fs';
import path from 'node:path';
import { Linking } from 'react-native';
import { act } from 'react-test-renderer';

/**
 * STRESS — SettingsScreen × boundary / i18n / a11y.
 *
 * Renders the REAL SettingsScreen inside the real React Navigation tree the
 * app uses (native stack → bottom tabs → Settings), with the real Zustand
 * stores, real access-store refresh path (fake backend through the app's own
 * `configureAccessStore` seam) and real consent hydration (mocked `fetch`).
 * Only native modules (sqlite, StoreKit review, safe-area) and the bundled
 * runtime config are mocked.
 *
 * Every variant is a pure function of its seed (`__harness__/stress/settingsScreen/settingsVariants.ts`).
 *
 *   default            grid (3 font scales × 3 widths × 2 sessions = 18)
 *                      + STRESS_ITER seeded variants (default 24)
 *   STRESS_ITER=200    bigger campaign
 *   STRESS_SEED=12345  replay exactly one seed
 *   STRESS_CAMPAIGN_SEED=n   pick a different seeded campaign
 *   STRESS_ARTIFACT_DIR=dir  write results.json + rendered trees
 *
 * Hard (VERIFIED) invariants per variant — the test fails on any of these:
 *   - the screen mounts on Tabs/Settings and stays mounted through the
 *     interaction script (no crash for any string / numeric / locale input);
 *   - every VoiceOver-reachable pressable has role + non-empty label and a
 *     ≥44pt guaranteed height (full-bleed scrims exempt);
 *   - no rendered text or label leaks `undefined` / `null` / `NaN` /
 *     `[object Object]` for inputs that can reach the screen;
 *   - the avatar initial is a whole grapheme, never a lone surrogate;
 *   - every documented row navigates to its documented route/params, the
 *     legal rows open their URLs, StoreKit review is handed off, and the
 *     two-step sign-out cancel branch never signs out;
 *   - membership / notifications / consent values match the documented
 *     wording for the seeded state (server ledger → "N free ratings left",
 *     `availableToReserve` not `remaining`).
 * Layout ESTIMATES (INFERRED — Jest has no text layout engine) are recorded
 * in the results table as `estimatedClips` and never fail the suite.
 */

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

jest.mock('react-native-safe-area-context', () => {
  const mock = jest.requireActual<{
    default: typeof import('react-native-safe-area-context');
  }>('react-native-safe-area-context/jest/mock');
  return mock.default;
});

const mockRateAppFromSettings = jest.fn(() => Promise.resolve());
jest.mock('../../src/review/appStoreReview', () => ({
  rateAppFromSettings: () => mockRateAppFromSettings(),
}));

const mockRuntime = {
  appVersion: '1.0.0 (1)',
  legalPrivacyUrl: 'https://api.example.test/privacy' as string | null,
  legalTermsUrl: 'https://api.example.test/terms' as string | null,
};
jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: null,
    googleWebClientId: null,
    appVersion: mockRuntime.appVersion,
    legalPrivacyUrl: mockRuntime.legalPrivacyUrl,
    legalTermsUrl: mockRuntime.legalTermsUrl,
  }),
}));

import { formatReminderMinutes } from '../../src/notifications/types';
import { plural } from '../../src/util/plural';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';
import { iterationSeed } from '../../__harness__/stress/settingsScreen/seededRng';
import {
  buildFixture,
  buildVariant,
  gridVariants,
  type SettingsFixture,
  type SettingsVariant,
} from '../../__harness__/stress/settingsScreen/settingsVariants';
import {
  applyEnvironment,
  renderSettings,
  type Harness,
} from '../../__harness__/stress/settingsScreen/settingsHarness';
import {
  auditSettingsTree,
  hostPressables,
  textContent,
} from '../../__harness__/stress/settingsScreen/a11yAudit';
import type { ReactTestInstance } from 'react-test-renderer';

const STRESS_ITER = Number(process.env.STRESS_ITER ?? 24);
const STRESS_SEED = process.env.STRESS_SEED;
const CAMPAIGN_SEED = Number(process.env.STRESS_CAMPAIGN_SEED ?? 20260904);
const ARTIFACT_DIR = process.env.STRESS_ARTIFACT_DIR;
const TREES_TO_KEEP = 6;

interface ResultRow {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  variant: Omit<SettingsVariant, 'seed'>;
  accountName: string | null;
  pressables: number;
  texts: number;
  hardViolations: string[];
  interactionFailures: string[];
  valueMismatches: string[];
  /** INFERRED: heuristic line-count estimates, never a failure by themselves. */
  estimatedClips: string[];
  /** Values the wire parsers reject; rendered here only to document the
   * fallback behaviour (INFERRED unreachable in production). */
  parserProtected: string[];
  unscaledTexts: number;
  uncappedScaledTexts: number;
  refreshAccessCalls: number;
  consentFetchCalls: number;
  durationMs: number;
  error: string | null;
}

function expectedAccountName(f: SettingsFixture): string | null {
  const s = f.session;
  if (s === null) return '—';
  if (s.provider === 'guest')
    return f.profile?.firstName ? f.profile.firstName : 'Guest · this device';
  return s.displayName ?? s.email ?? s.subject;
}

function expectedMembership(f: SettingsFixture): string {
  if (f.session?.localOnly) return 'Sign in first';
  const a = f.access;
  if (!a) return 'Verify access';
  if (a.premium) return 'Pro active';
  if (!a.canStartRating) return 'Upgrade required';
  const n = a.freeRatings.availableToReserve;
  return `${n} free ${plural(n, 'rating')} left`;
}

function expectedNotifications(f: SettingsFixture): string {
  const p = f.notificationPrefs;
  if (!p.enabled) return 'Off';
  if (f.notificationPermission === 'denied') return 'Allow in system settings';
  return p.practiceReminder
    ? `Daily · ${formatReminderMinutes(p.practiceReminderMinutes)}`
    : 'On';
}

function expectedConsent(f: SettingsFixture): string {
  const synced = f.session !== null && !f.session.localOnly;
  if (!synced) return 'Manage';
  switch (f.variant.consent) {
    case 'ready_on':
      return 'Training: contributing';
    case 'ready_off':
      return 'Training: off';
    default:
      return 'Manage';
  }
}

function expectedConsistency(f: SettingsFixture): string {
  const c = f.consistency;
  if (!c) return '—';
  return `${c.currentStreak} day streak · ${c.earned.length} ${plural(c.earned.length, 'badge')}`;
}

function findRow(
  screen: ReactTestInstance,
  label: string,
): ReactTestInstance | null {
  const prefix = `${label}, `;
  return (
    hostPressables(screen).find(
      n =>
        typeof n.props.accessibilityLabel === 'string' &&
        n.props.accessibilityLabel.startsWith(prefix),
    ) ?? null
  );
}

function rowValue(row: ReactTestInstance, label: string): string {
  return String(row.props.accessibilityLabel).slice(label.length + 2);
}

async function press(node: ReactTestInstance): Promise<void> {
  await act(async () => {
    node.props.onClick();
  });
}

function modalDialog(harness: Harness): ReactTestInstance | null {
  return (
    harness.renderer.root.findAll(
      n =>
        typeof n.type === 'string' && n.props.accessibilityViewIsModal === true,
    )[0] ?? null
  );
}

interface RouteExpectation {
  label: string;
  route: string;
  params?: object;
  present: boolean;
}

function routeExpectations(f: SettingsFixture): RouteExpectation[] {
  const localOnly = f.session?.localOnly === true;
  const synced = f.session !== null && !localOnly;
  return [
    { label: 'Connect account', route: 'ConnectAccount', present: localOnly },
    localOnly
      ? { label: 'Pickle Sensei Pro', route: 'ConnectAccount', present: true }
      : {
          label: 'Pickle Sensei Pro',
          route: 'Paywall',
          params: { source: 'settings' },
          present: true,
        },
    { label: 'Consistency', route: 'StreakCalendar', present: true },
    { label: 'Notifications', route: 'NotificationSettings', present: true },
    { label: 'Data & consent', route: 'ConsentSettings', present: true },
    { label: 'Manage account', route: 'ManageAccount', present: synced },
  ];
}

async function runInteractions(
  harness: Harness,
  fixture: SettingsFixture,
  failures: string[],
): Promise<void> {
  const openUrl = jest
    .spyOn(Linking, 'openURL')
    .mockImplementation(() => Promise.resolve());
  try {
    for (const expectation of routeExpectations(fixture)) {
      const row = findRow(harness.screen(), expectation.label);
      if (!expectation.present) {
        if (row)
          failures.push(
            `row "${expectation.label}" rendered but must be absent for this session`,
          );
        continue;
      }
      if (!row) {
        failures.push(`row "${expectation.label}" missing`);
        continue;
      }
      await press(row);
      await harness.flush();
      const route = harness.currentRoute();
      if (route?.name !== expectation.route) {
        failures.push(
          `"${expectation.label}" navigated to ${route?.name ?? 'nowhere'}, expected ${expectation.route}`,
        );
      } else if (
        expectation.params &&
        JSON.stringify(route.params) !== JSON.stringify(expectation.params)
      ) {
        failures.push(
          `"${expectation.label}" params ${JSON.stringify(route.params)} ≠ ${JSON.stringify(expectation.params)}`,
        );
      }
      await harness.returnToSettings();
      if (harness.currentRoute()?.name !== 'Settings') {
        failures.push(
          `could not return to Settings after "${expectation.label}" (on ${harness.currentRoute()?.name})`,
        );
        return;
      }
    }

    // Legal rows: present exactly when the runtime config carries a URL.
    for (const [label, url] of [
      ['Privacy policy', fixture.legalPrivacyUrl],
      ['Terms of use', fixture.legalTermsUrl],
    ] as const) {
      const row = findRow(harness.screen(), label);
      if (!url) {
        if (row) failures.push(`"${label}" rendered without a configured URL`);
        continue;
      }
      if (!row) {
        failures.push(`"${label}" missing although URL configured`);
        continue;
      }
      openUrl.mockClear();
      await press(row);
      await harness.flush();
      if (!openUrl.mock.calls.some(call => call[0] === url)) {
        failures.push(
          `"${label}" did not open ${url} (calls: ${JSON.stringify(openUrl.mock.calls)})`,
        );
      }
    }

    // StoreKit review hand-off (iOS-only row; Jest runs as iOS).
    const rate = findRow(harness.screen(), 'Rate Pickle Sensei');
    if (!rate) failures.push('"Rate Pickle Sensei" row missing');
    else {
      mockRateAppFromSettings.mockClear();
      await press(rate);
      await harness.flush();
      if (mockRateAppFromSettings.mock.calls.length !== 1) {
        failures.push(
          `rate row called StoreKit ${mockRateAppFromSettings.mock.calls.length}×, expected 1`,
        );
      }
    }

    // Walkthrough replay lands on Home and raises the tour.
    const walkthrough = findRow(harness.screen(), 'App walkthrough');
    if (!walkthrough) failures.push('"App walkthrough" row missing');
    else {
      await press(walkthrough);
      await harness.flush();
      const state = useWalkthroughStore.getState();
      if (harness.currentRoute()?.name !== 'Home') {
        failures.push(
          `walkthrough replay landed on ${harness.currentRoute()?.name}, expected Home`,
        );
      }
      if (!state.visible && !state.queued)
        failures.push('walkthrough replay did not raise the tour');
      useWalkthroughStore.setState({ visible: false, queued: false });
      await harness.returnToSettings();
    }

    // Two-step sign-out: cancel never signs out; confirm signs out once.
    const signOutRow = hostPressables(harness.screen()).find(
      n => n.props.accessibilityLabel === 'Sign out',
    );
    if (!signOutRow) {
      failures.push('"Sign out" row missing');
      return;
    }
    await press(signOutRow);
    let dialog = modalDialog(harness);
    if (!dialog) {
      failures.push('sign-out sheet did not open');
      return;
    }
    const dialogAudit = auditSettingsTree(harness.screen(), {
      fontScale: fixture.variant.fontScale,
      width: fixture.variant.width,
      accountName: null,
    });
    for (const violation of dialogAudit.hardViolations) {
      if (!isParserProtectedViolation(fixture, violation)) {
        failures.push(`sign-out sheet: ${violation}`);
      }
    }
    const keep = hostPressables(dialog).find(
      n => textContent(n) === 'Keep me signed in',
    );
    if (!keep) failures.push('"Keep me signed in" missing from sheet');
    else await press(keep);
    if (modalDialog(harness)) failures.push('sheet still open after cancel');
    if (harness.signOut.mock.calls.length !== 0)
      failures.push('cancel branch signed the user out');

    await press(signOutRow);
    dialog = modalDialog(harness);
    const confirm = dialog
      ? hostPressables(dialog).find(n => textContent(n) === 'Sign out')
      : undefined;
    if (!confirm) failures.push('confirm "Sign out" missing from sheet');
    else await press(confirm);
    await harness.flush();
    if (harness.signOut.mock.calls.length !== 1) {
      failures.push(
        `confirm branch called signOut ${harness.signOut.mock.calls.length}×, expected 1`,
      );
    }
  } finally {
    openUrl.mockRestore();
  }
}

function parserProtectedNotes(
  fixture: SettingsFixture,
  screen: ReactTestInstance,
): string[] {
  const notes: string[] = [];
  const value = (label: string): string | null => {
    const node = findRow(screen, label);
    return node ? rowValue(node, label) : null;
  };
  if (fixture.accessInjectedRaw) {
    notes.push(
      `access ${fixture.variant.access}: rendered ${JSON.stringify(value('Pickle Sensei Pro'))} — unreachable: accessApi.ts parseAccess rejects non-integer/negative/inconsistent ledgers`,
    );
  }
  if (fixture.variant.notifications.startsWith('hostile_')) {
    notes.push(
      `notifications ${fixture.variant.notifications}: rendered ${JSON.stringify(value('Notifications'))} — unreachable: parseNotificationPrefs clamps minutes to [0,1440) integers`,
    );
  }
  if (fixture.variant.consistency.startsWith('hostile_')) {
    notes.push(
      `consistency ${fixture.variant.consistency}: rendered ${JSON.stringify(value('Consistency'))} — unreachable: snapshots come only from buildConsistencySnapshot`,
    );
  }
  return notes;
}

/** Garbage produced by a parser-protected hostile input is documented, not failed. */
function isParserProtectedViolation(
  fixture: SettingsFixture,
  violation: string,
): boolean {
  const hostile =
    fixture.accessInjectedRaw ||
    fixture.variant.notifications.startsWith('hostile_') ||
    fixture.variant.consistency.startsWith('hostile_');
  if (hostile && /leaks a JS value/.test(violation)) return true;
  // OnboardingScreen.tsx trims the name and stores `firstName || undefined`,
  // so a blank guest first name cannot be persisted through the app.
  const guestBlankName =
    fixture.session?.provider === 'guest' &&
    (fixture.variant.profile.firstNameClass === 'whitespace_only' ||
      fixture.variant.profile.firstNameClass === 'empty');
  return guestBlankName && /account name is blank/.test(violation);
}

function variantWithoutSeed(
  variant: SettingsVariant,
): Omit<SettingsVariant, 'seed'> {
  const copy: Partial<SettingsVariant> = { ...variant };
  delete copy.seed;
  return copy as Omit<SettingsVariant, 'seed'>;
}

const keptTrees: { seed: number; tree: unknown }[] = [];

async function runVariant(variant: SettingsVariant): Promise<ResultRow> {
  const started = Date.now();
  const fixture = buildFixture(variant);
  mockRuntime.appVersion = fixture.appVersion;
  mockRuntime.legalPrivacyUrl = fixture.legalPrivacyUrl;
  mockRuntime.legalTermsUrl = fixture.legalTermsUrl;
  const env = applyEnvironment({
    width: variant.width,
    fontScale: variant.fontScale,
    rtl: variant.rtl,
    timeZone: variant.timeZone,
  });
  const accountName = expectedAccountName(fixture);
  const row: ResultRow = {
    seed: variant.seed,
    outcome: 'HELD',
    variant: variantWithoutSeed(variant),
    accountName,
    pressables: 0,
    texts: 0,
    hardViolations: [],
    interactionFailures: [],
    valueMismatches: [],
    estimatedClips: [],
    parserProtected: [],
    unscaledTexts: 0,
    uncappedScaledTexts: 0,
    refreshAccessCalls: 0,
    consentFetchCalls: 0,
    durationMs: 0,
    error: null,
  };
  let harness: Harness | null = null;
  try {
    harness = await renderSettings(fixture);
    if (harness.currentRoute()?.name !== 'Settings') {
      row.interactionFailures.push(
        `initial route ${harness.currentRoute()?.name}, expected Settings`,
      );
    }
    const screen = harness.screen();
    const audit = auditSettingsTree(screen, {
      fontScale: variant.fontScale,
      width: variant.width,
      accountName,
    });
    row.pressables = audit.pressables.length;
    row.texts = audit.texts.length;
    row.estimatedClips = audit.estimatedClips;
    row.unscaledTexts = audit.unscaledTextCount;
    row.uncappedScaledTexts = audit.uncappedScaledTextCount;
    row.parserProtected = parserProtectedNotes(fixture, screen);
    row.hardViolations = audit.hardViolations.filter(
      v => !isParserProtectedViolation(fixture, v),
    );

    const checks: [string, string][] = [
      ['Pickle Sensei Pro', expectedMembership(fixture)],
      ['Notifications', expectedNotifications(fixture)],
      ['Data & consent', expectedConsent(fixture)],
      ['Consistency', expectedConsistency(fixture)],
    ];
    for (const [label, expected] of checks) {
      const node = findRow(screen, label);
      const actual = node ? rowValue(node, label) : null;
      if (actual !== expected) {
        row.valueMismatches.push(
          `${label}: rendered ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
        );
      }
    }
    const nameNode = screen.findAll(
      n =>
        n.props.numberOfLines === 1 &&
        typeof n.type !== 'string' &&
        textContent(n) === accountName,
    );
    if (accountName !== null && nameNode.length === 0) {
      row.valueMismatches.push(
        `account name ${JSON.stringify(accountName)} not rendered verbatim`,
      );
    }

    await runInteractions(harness, fixture, row.interactionFailures);
    row.refreshAccessCalls = harness.refreshAccessCalls();
    row.consentFetchCalls = harness.consentFetchCalls();
    const synced = fixture.session !== null && !fixture.session.localOnly;
    if (synced && row.refreshAccessCalls < 1) {
      row.interactionFailures.push(
        'synced session never refreshed access on focus',
      );
    }
    if (!synced && row.refreshAccessCalls !== 0) {
      row.interactionFailures.push(
        `local-only/signed-out session refreshed access ${row.refreshAccessCalls}×`,
      );
    }
    if (synced && row.consentFetchCalls < 1) {
      row.interactionFailures.push('synced session never hydrated consent');
    }
    if (!synced && row.consentFetchCalls !== 0) {
      row.interactionFailures.push(
        `local-only/signed-out session fetched consent ${row.consentFetchCalls}×`,
      );
    }
  } catch (error) {
    row.error =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
  } finally {
    row.durationMs = Date.now() - started;
    row.outcome =
      row.error ||
      row.hardViolations.length ||
      row.interactionFailures.length ||
      row.valueMismatches.length
        ? 'BROKEN'
        : 'HELD';
    if (
      harness &&
      ARTIFACT_DIR &&
      (row.outcome === 'BROKEN' || keptTrees.length < TREES_TO_KEEP)
    ) {
      keptTrees.push({ seed: variant.seed, tree: harness.renderer.toJSON() });
    }
    harness?.unmount();
    env.restore();
  }
  return row;
}

const variants: SettingsVariant[] = STRESS_SEED
  ? [buildVariant(Number(STRESS_SEED))]
  : [
      ...gridVariants(),
      ...Array.from({ length: STRESS_ITER }, (_, i) =>
        buildVariant(iterationSeed(CAMPAIGN_SEED, i)),
      ),
    ];

const results: ResultRow[] = [];

afterAll(() => {
  if (!ARTIFACT_DIR) return;
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const summary = {
    campaignSeed: CAMPAIGN_SEED,
    stressIter: STRESS_ITER,
    replaySeed: STRESS_SEED ?? null,
    executed: results.length,
    held: results.filter(r => r.outcome === 'HELD').length,
    broken: results.filter(r => r.outcome === 'BROKEN').length,
    brokenSeeds: results.filter(r => r.outcome === 'BROKEN').map(r => r.seed),
    coverage: {
      locales: [...new Set(results.map(r => r.variant.locale))].sort(),
      timeZones: [...new Set(results.map(r => r.variant.timeZone))].sort(),
      fontScales: [...new Set(results.map(r => r.variant.fontScale))].sort(),
      widths: [...new Set(results.map(r => r.variant.width))].sort(),
      displayNameClasses: [
        ...new Set(results.map(r => r.variant.session.displayNameClass)),
      ].sort(),
      firstNameClasses: [
        ...new Set(results.map(r => r.variant.profile.firstNameClass)),
      ].sort(),
      accessCases: [...new Set(results.map(r => r.variant.access))].sort(),
      notificationCases: [
        ...new Set(results.map(r => r.variant.notifications)),
      ].sort(),
    },
    estimatedClipCount: results.filter(r => r.estimatedClips.length > 0).length,
    results,
  };
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, 'results.json'),
    JSON.stringify(summary, null, 2),
  );
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, 'trees.json'),
    JSON.stringify(keptTrees, null, 2),
  );
});

describe('SettingsScreen stress — boundary / i18n / a11y (real navigator + stores)', () => {
  test.each(variants.map(v => [v.seed, v] as const))(
    'seed %i holds every invariant',
    async (_seed, variant) => {
      const row = await runVariant(variant);
      results.push(row);
      expect(row.error).toBeNull();
      expect(row.hardViolations).toEqual([]);
      expect(row.valueMismatches).toEqual([]);
      expect(row.interactionFailures).toEqual([]);
    },
  );
});
