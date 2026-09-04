/**
 * xc/screen-ux-a11y-i18n-4 — cross-screen accessibility + copy-policy matrix.
 *
 * Renders SettingsScreen, ManageAccountScreen, ConsentSettingsScreen,
 * NotificationSettingsScreen, PaywallScreen and DrillLibraryScreen in every
 * reachable state the stores/props allow under jest (idle, loading, error,
 * empty, busy, dialog open, armed, denied permission, unavailable store, …)
 * and walks the HOST tree (the native views RN emits) collecting one row per
 * interactive/semantic node. Rules applied to every row:
 *
 *   A1 every pressable has an accessible name (label or visible text);
 *   A2 every pressable carries an accessibility role;
 *   A3 disabled pressables expose accessibilityState.disabled === true;
 *   A4 spinners/progress indicators are labelled;
 *   A5 text inputs are labelled;
 *   A6 switches expose a boolean checked state;
 *   A7 pressables with a numeric height/width below 44pt must make up the
 *      difference with hitSlop (Apple HIG 44×44);
 *   A8 error states expose role=alert or a live region; loading states expose
 *      a live region or a labelled progressbar; toasts are live regions;
 *   A9 destructive dialogs are accessibilityViewIsModal;
 *   C1 rendered copy (text + labels) contains none of the forbidden terms from
 *      docs/APP_STORE_SUBMISSION.md §1.4/§1.5 (Android, Google Play, guest
 *      mode, Live Court, competitors, accuracy %, superlatives, AI-coach
 *      equivalence). "DUPR" is collected separately: the dossier's 5.2.1 row
 *      knowingly ships the in-app "DUPR-style estimate" wording and tracks
 *      the rename as optional (§176), so hits are reported, not asserted.
 *
 * Defects the audit reproduced on the baseline are pinned in KNOWN_DEFECTS
 * (file:line each). The matrix stays green while they are present so the
 * suite can be integrated as-is, and the ledger test fails the moment one of
 * them is fixed (remove the entry) or a new one appears (investigate).
 *
 * Nothing here is VoiceOver/device evidence — it is the static semantic
 * contract the native accessibility tree is built from. The full matrix
 * (per screen × state × node) is written to
 * artifacts/xc-screen-ux-a11y-i18n-4/screen-a11y-matrix.json.
 */
import React from 'react';
import {
  Linking,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
} from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const fs = require('fs') as {
  mkdirSync: (dir: string, opts: { recursive: boolean }) => void;
  writeFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

jest.mock('../../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));
jest.mock('../../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));
const mockListScoredCheckpointFacts = jest.fn<Promise<unknown[]>, [unknown]>();
jest.mock('../../../src/data/repository', () => ({
  listScoredCheckpointFacts: (...args: [unknown]) =>
    mockListScoredCheckpointFacts(...args),
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => insets,
    initialWindowMetrics: { insets },
  };
});
jest.mock('react-native-webview', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockWebView = (props: Record<string, unknown>) =>
    ReactModule.createElement(View, props);
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});
jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock('react-native-svg', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
  };
});
const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
  useFocusEffect: (effect: () => void) => {
    const ReactModule = jest.requireActual<typeof import('react')>('react');
    ReactModule.useEffect(() => {
      effect();
    }, [effect]);
  },
}));
jest.mock('../../../src/review/appStoreReview', () => ({
  rateAppFromSettings: () => Promise.resolve(),
}));
jest.mock('../../../src/walkthrough/walkthroughStore', () => ({
  useWalkthroughStore: { getState: () => ({ replay: jest.fn() }) },
}));
jest.mock('../../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: null,
    googleWebClientId: null,
    appVersion: '1.0.0 (1)',
    legalPrivacyUrl: 'https://api.example.test/privacy',
    legalTermsUrl: 'https://api.example.test/terms',
  }),
}));
const mockOpenSystemSettings = jest.fn(() => Promise.resolve());
jest.mock('../../../src/notifications/service', () => ({
  getScheduler: () => ({ openSystemSettings: mockOpenSystemSettings }),
}));
const mockRequestAccountDeletion = jest.fn<
  Promise<{ challenge: string; expiresAt: string }>,
  unknown[]
>();
const mockConfirmAccountDeletion = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../../../src/account/deletion', () => {
  const actual = jest.requireActual<
    typeof import('../../../src/account/deletion')
  >('../../../src/account/deletion');
  return {
    ...actual,
    requestAccountDeletion: (...args: unknown[]) =>
      mockRequestAccountDeletion(...args),
    confirmAccountDeletion: (...args: unknown[]) =>
      mockConfirmAccountDeletion(...args),
  };
});
const mockListCatalogDrills = jest.fn<Promise<CatalogDrill[]>, [unknown]>();
const mockSaveDrill = jest.fn<Promise<void>, [string]>();
const mockUnsaveDrill = jest.fn<Promise<void>, [string]>();
const mockGetDrill = jest.fn<Promise<DrillDetail>, [string]>();
jest.mock('../../../src/training/api', () => ({
  createTrainingApi: () => ({
    listCatalogDrills: mockListCatalogDrills,
    saveDrill: mockSaveDrill,
    unsaveDrill: mockUnsaveDrill,
    getDrill: mockGetDrill,
  }),
}));

import type { CatalogDrill } from '../../../src/training/api';
import {
  TrainingError,
  type DrillDetail,
  type InstructionalMedia,
} from '../../../src/training/types';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
  StorePlans,
} from '../../../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../../src/state/accessStore';
import { useAuthStore, type AuthSession } from '../../../src/auth/authStore';
import { useAppStore } from '../../../src/state/appStore';
import { useConsentStore } from '../../../src/state/consentStore';
import { useNotificationStore } from '../../../src/notifications/notificationStore';
import { DEFAULT_NOTIFICATION_PREFS } from '../../../src/notifications/types';
import { useConsistencyStore } from '../../../src/consistency/store';
import { AccountDeletionError } from '../../../src/account/deletion';
import { SettingsScreen } from '../../../src/screens/SettingsScreen';
import { ManageAccountScreen } from '../../../src/screens/ManageAccountScreen';
import { ConsentSettingsScreen } from '../../../src/screens/ConsentSettingsScreen';
import { NotificationSettingsScreen } from '../../../src/screens/NotificationSettingsScreen';
import { PaywallScreen } from '../../../src/screens/PaywallScreen';
import { DrillLibraryScreen } from '../../../src/screens/DrillLibraryScreen';

const ARTIFACT_DIR =
  process.env.XC_ARTIFACT_DIR ??
  path.resolve(__dirname, '../../../../../artifacts/xc-screen-ux-a11y-i18n-4');

// ---------------------------------------------------------------------------
// Tree inspection
// ---------------------------------------------------------------------------

type Node = TestRenderer.ReactTestInstance;
type Renderer = TestRenderer.ReactTestRenderer;

interface NodeRow {
  screen: string;
  state: string;
  kind: 'pressable' | 'textinput' | 'switch' | 'progressbar' | 'alert' | 'live';
  name: string | null;
  role: string | null;
  disabled: boolean | null;
  selected: boolean | null;
  checked: boolean | null;
  liveRegion: string | null;
  height: number | null;
  width: number | null;
  hitSlop: number | null;
  testID: string | null;
  issues: string[];
}

interface StateRow {
  screen: string;
  state: string;
  pressables: number;
  modalViews: number;
  liveRegions: number;
  alerts: number;
  textLength: number;
  fontScalingDisabled: number;
  adjustsFontSizeToFit: number;
  numberOfLinesClamped: number;
  policyHits: string[];
  duprHits: string[];
  issues: string[];
  knownDefects: string[];
}

const nodeRows: NodeRow[] = [];
const stateRows: StateRow[] = [];

/**
 * Baseline defects (commit 4d812e1a) with the exact rule + location. Each id
 * is matched against the issues the audit produces; see the ledger test.
 */
const KNOWN_DEFECTS: ReadonlyArray<{
  id: string;
  where: string;
  match: (screen: string, state: string, issue: string) => boolean;
}> = [
  {
    id: 'settings-signout-scrim-no-role',
    where: 'src/screens/SettingsScreen.tsx:138-142',
    match: (screen, _state, issue) =>
      screen === 'SettingsScreen' &&
      issue === 'A2 pressable without accessibilityRole — Cancel sign out',
  },
  {
    id: 'manage-account-busy-spinner-unlabelled',
    where: 'src/screens/ManageAccountScreen.tsx:741-747',
    match: (screen, _state, issue) =>
      screen === 'ManageAccountScreen' &&
      issue === 'A4 busy state has no labelled progressbar',
  },
  {
    id: 'manage-account-deletion-error-not-announced',
    where: 'src/screens/ManageAccountScreen.tsx:687-699',
    match: (screen, _state, issue) =>
      screen === 'ManageAccountScreen' &&
      issue === 'A8 error text without alert role or live region',
  },
  {
    id: 'consent-error-not-announced',
    where: 'src/screens/ConsentSettingsScreen.tsx:123-139',
    match: (screen, _state, issue) =>
      screen === 'ConsentSettingsScreen' &&
      issue === 'A8 error text without alert role or live region',
  },
];

const observedDefects = new Map<string, Set<string>>();

function recordIssue(screen: string, state: string, issue: string) {
  const known = KNOWN_DEFECTS.find(d => d.match(screen, state, issue));
  if (!known) return false;
  const set = observedDefects.get(known.id) ?? new Set<string>();
  set.add(`${screen}/${state}`);
  observedDefects.set(known.id, set);
  return true;
}

const hostNodes = (r: Renderer) =>
  r.root.findAll(n => typeof n.type === 'string');

function descendantText(node: Node): string {
  return node
    .findAll(n => String(n.type) === 'Text' || n.type === Text)
    .flatMap(n => {
      const c = n.props.children;
      return Array.isArray(c) ? c : [c];
    })
    .filter((c): c is string => typeof c === 'string')
    .join(' ')
    .trim();
}

function allRenderedText(r: Renderer): string {
  const texts = r.root
    .findAllByType(Text)
    .flatMap(n => {
      const c = n.props.children;
      return Array.isArray(c) ? c : [c];
    })
    .filter((c): c is string => typeof c === 'string');
  const labels = hostNodes(r)
    .map(n => n.props.accessibilityLabel)
    .filter((l): l is string => typeof l === 'string');
  const hints = hostNodes(r)
    .map(n => n.props.accessibilityHint)
    .filter((l): l is string => typeof l === 'string');
  return [...texts, ...labels, ...hints].join('\n');
}

function numericDimension(style: unknown, key: 'height' | 'width') {
  const flat = StyleSheet.flatten(style as never) as
    Record<string, unknown> | undefined;
  const v = flat?.[key];
  const min = flat?.[key === 'height' ? 'minHeight' : 'minWidth'];
  const candidates = [v, min].filter((x): x is number => typeof x === 'number');
  return candidates.length ? Math.max(...candidates) : null;
}

function slopOf(hitSlop: unknown): number {
  if (typeof hitSlop === 'number') return hitSlop;
  if (hitSlop && typeof hitSlop === 'object') {
    const h = hitSlop as Record<string, number | undefined>;
    return Math.min(h.top ?? 0, h.bottom ?? 0);
  }
  return 0;
}

const FORBIDDEN_COPY: ReadonlyArray<readonly [string, RegExp]> = [
  ['android', /\bandroid\b/i],
  ['google play', /google\s*play/i],
  ['guest mode', /guest\s*mode/i],
  ['live court', /live\s*court/i],
  ['competitor', /swing\s*vision|pb\s*vision|selkirk|joola/i],
  ['accuracy %', /\d+(\.\d+)?\s*%\s*(accura|precis|correct)/i],
  ['accuracy claim', /\b\d{2,3}\s*%\s*(of the time|of shots)/i],
  [
    'superlative',
    /\b(the best|#\s?1|number one|most accurate|world[- ]class|industry[- ]leading|unbeatable|revolutionary)\b/i,
  ],
  [
    'ai coach equivalence',
    /\b(replaces? (a |your )?coach|as good as a coach|ai coach)\b/i,
  ],
];
const DUPR = /\bDUPR\b/;

function audit(r: Renderer, screen: string, state: string) {
  const issues: string[] = [];
  const rows: NodeRow[] = [];
  const hosts = hostNodes(r);

  for (const n of hosts) {
    const p = n.props;
    const role: string | null = p.accessibilityRole ?? null;
    const label: string | null =
      typeof p.accessibilityLabel === 'string' ? p.accessibilityLabel : null;
    const st = p.accessibilityState ?? {};
    const base = {
      screen,
      state,
      name: label,
      role,
      disabled: typeof st.disabled === 'boolean' ? st.disabled : null,
      selected: typeof st.selected === 'boolean' ? st.selected : null,
      checked: typeof st.checked === 'boolean' ? st.checked : null,
      liveRegion: p.accessibilityLiveRegion ?? null,
      height: numericDimension(p.style, 'height'),
      width: numericDimension(p.style, 'width'),
      hitSlop: p.hitSlop === undefined ? null : slopOf(p.hitSlop),
      testID: p.testID ?? null,
    };

    if (typeof p.onClick === 'function') {
      const nodeIssues: string[] = [];
      const name = label ?? descendantText(n) ?? '';
      if (!name.trim()) nodeIssues.push('A1 pressable without accessible name');
      if (!role) nodeIssues.push('A2 pressable without accessibilityRole');
      // RN Pressable/Touchable merge `disabled` into accessibilityState; a
      // pressable that has `disabled` truthy on the host must announce it.
      if (p.disabled === true && st.disabled !== true) {
        nodeIssues.push('A3 disabled pressable not announced disabled');
      }
      if (role === 'switch' && typeof st.checked !== 'boolean') {
        nodeIssues.push('A6 switch without boolean checked state');
      }
      const h = base.height;
      const w = base.width;
      const slop = base.hitSlop ?? 0;
      if (h !== null && h + 2 * slop < 44) {
        nodeIssues.push(`A7 effective height ${h + 2 * slop}pt < 44pt`);
      }
      if (w !== null && w + 2 * slop < 44) {
        nodeIssues.push(`A7 effective width ${w + 2 * slop}pt < 44pt`);
      }
      rows.push({
        ...base,
        kind: role === 'switch' ? 'switch' : 'pressable',
        name: name || null,
        issues: nodeIssues,
      });
      continue;
    }
    if (String(n.type) === 'TextInput' || n.type === TextInput) {
      const nodeIssues: string[] = [];
      if (!label) nodeIssues.push('A5 text input without accessibilityLabel');
      rows.push({ ...base, kind: 'textinput', issues: nodeIssues });
      continue;
    }
    if (role === 'progressbar') {
      const nodeIssues: string[] = [];
      if (!label) nodeIssues.push('A4 progressbar without label');
      rows.push({ ...base, kind: 'progressbar', issues: nodeIssues });
      continue;
    }
    if (role === 'alert') {
      rows.push({
        ...base,
        kind: 'alert',
        name: label ?? descendantText(n),
        issues: [],
      });
      continue;
    }
    if (p.accessibilityLiveRegion) {
      rows.push({
        ...base,
        kind: 'live',
        name: label ?? descendantText(n),
        issues: [],
      });
    }
  }

  const rendered = allRenderedText(r);
  const policyHits: string[] = [];
  for (const [name, re] of FORBIDDEN_COPY) {
    const m = rendered.match(re);
    if (m) policyHits.push(`${name}: "${m[0]}"`);
  }
  const duprHits = rendered
    .split('\n')
    .filter(line => DUPR.test(line))
    .map(line => line.trim().slice(0, 140));

  const textNodes = r.root.findAllByType(Text);
  const stateRow: StateRow = {
    screen,
    state,
    pressables: rows.filter(x => x.kind === 'pressable' || x.kind === 'switch')
      .length,
    // A native RN <Modal> is its own presented view controller on iOS (VoiceOver
    // focus is trapped natively); accessibilityViewIsModal covers in-tree
    // dialogs. Either satisfies A9.
    modalViews:
      hosts.filter(n => n.props.accessibilityViewIsModal === true).length +
      r.root.findAllByType(Modal).filter(m => m.props.visible === true).length,
    liveRegions: hosts.filter(n => n.props.accessibilityLiveRegion).length,
    alerts: hosts.filter(n => n.props.accessibilityRole === 'alert').length,
    textLength: rendered.length,
    fontScalingDisabled: textNodes.filter(
      n => n.props.allowFontScaling === false,
    ).length,
    adjustsFontSizeToFit: textNodes.filter(n => n.props.adjustsFontSizeToFit)
      .length,
    numberOfLinesClamped: textNodes.filter(
      n => typeof n.props.numberOfLines === 'number',
    ).length,
    policyHits,
    duprHits,
    issues,
    knownDefects: [],
  };
  const known: string[] = [];
  const push = (issue: string) => {
    if (recordIssue(screen, state, issue)) known.push(issue);
    else issues.push(issue);
  };
  for (const row of rows) {
    for (const issue of row.issues) {
      push(`${issue} — ${row.name ?? row.testID ?? row.kind}`);
    }
  }
  for (const h of policyHits) push(`C1 ${h}`);
  nodeRows.push(...rows);
  stateRows.push({ ...stateRow, knownDefects: known });
  return { rows, stateRow, rendered, push };
}

function press(r: Renderer, label: string) {
  const node = hostNodes(r).find(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onClick === 'function',
  );
  if (!node) throw new Error(`no host pressable labelled ${label}`);
  return act(async () => {
    node.props.onClick();
  });
}

function pressTestId(r: Renderer, testID: string) {
  const node = hostNodes(r).find(
    n => n.props.testID === testID && typeof n.props.onClick === 'function',
  );
  if (!node) throw new Error(`no host pressable ${testID}`);
  return act(async () => {
    node.props.onClick();
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function unmount(r: Renderer) {
  act(() => {
    r.unmount();
  });
}

function expectClean(stateRow: StateRow) {
  expect(stateRow.issues).toEqual([]);
}

afterAll(() => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const perScreen = stateRows.reduce<
    Record<string, { states: number; pressables: number; issues: number }>
  >((acc, s) => {
    const cur = acc[s.screen] ?? { states: 0, pressables: 0, issues: 0 };
    cur.states += 1;
    cur.pressables += s.pressables;
    cur.issues += s.issues.length;
    acc[s.screen] = cur;
    return acc;
  }, {});
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, 'screen-a11y-matrix.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        platform: Platform.OS,
        states: stateRows.length,
        nodes: nodeRows.length,
        issues: stateRows.flatMap(s =>
          s.issues.map(i => `${s.screen}/${s.state}: ${i}`),
        ),
        knownDefects: KNOWN_DEFECTS.map(d => ({
          id: d.id,
          where: d.where,
          observedIn: [...(observedDefects.get(d.id) ?? [])],
        })),
        duprHits: stateRows
          .filter(s => s.duprHits.length)
          .map(s => ({ screen: s.screen, state: s.state, lines: s.duprHits })),
        perScreen,
        stateRows,
        nodeRows,
      },
      null,
      2,
    ),
  );
});

beforeAll(() => {
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const appleSession: AuthSession = {
  provider: 'apple',
  subject: '11111111-1111-4111-8111-111111111111',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  localOnly: false,
  displayName: 'Sam Rivera',
  email: 'sam@example.com',
};

const premiumAccess: CanonicalAccessState = {
  premium: true,
  entitlements: ['pickle_sensei_pro'],
  freeRatings: {
    limit: 2,
    used: 2,
    reserved: 0,
    remaining: 0,
    availableToReserve: 0,
  },
  canStartRating: true,
  paywallRequired: false,
};
const freeAccess: CanonicalAccessState = {
  ...premiumAccess,
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used: 1,
    reserved: 0,
    remaining: 1,
    availableToReserve: 1,
  },
};

function seedSettingsStores(session: AuthSession | null) {
  act(() => {
    useAuthStore.setState({
      hydrated: true,
      session,
      busy: false,
      error: null,
      signOut: jest.fn(() => Promise.resolve()),
      completeAccountDeletion: jest.fn(() => Promise.resolve()),
    });
    useAppStore.setState({
      hydrated: true,
      profile: {
        firstName: 'Sam',
        gender: 'male',
        skillLevel: 'intermediate',
        handedness: 'right',
        focusCheckpoint: 'contact_point',
      } as never,
    });
    useConsentStore.setState({
      availability: 'ready',
      modelTrainingActive: false,
      busy: false,
      error: null,
      hydrate: jest.fn(() => Promise.resolve()),
      setModelTrainingConsent: jest.fn(() => Promise.resolve()),
    });
    useNotificationStore.setState({
      hydrated: true,
      prefs: { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
      permission: 'granted',
      persistFailed: false,
      scheduleFailed: false,
      setPrefs: jest.fn(() => Promise.resolve()),
      refreshPermission: jest.fn(() => Promise.resolve()),
      requestPermissionAndEnable: jest.fn(() => Promise.resolve(true)),
    });
    useConsistencyStore.setState({ snapshot: null });
    useAccessStore.setState({ canonicalAccess: null });
  });
}

function render(element: React.ReactElement): Renderer {
  let r!: Renderer;
  act(() => {
    r = TestRenderer.create(element);
  });
  return r;
}

// ---------------------------------------------------------------------------
// SettingsScreen
// ---------------------------------------------------------------------------

describe('SettingsScreen matrix', () => {
  const cases: Array<
    [string, AuthSession | null, CanonicalAccessState | null]
  > = [
    ['apple-synced-free', appleSession, freeAccess],
    ['apple-synced-premium', appleSession, premiumAccess],
    [
      'google-synced-null-access',
      { ...appleSession, provider: 'google', displayName: 'Alex Chen' },
      null,
    ],
    [
      'apple-local-only',
      { ...appleSession, localOnly: true, canonicalAppUserId: null },
      null,
    ],
    ['signed-out', null, null],
  ];

  it.each(cases)(
    '%s: labelled controls, no forbidden copy',
    async (state, session, access) => {
      seedSettingsStores(session);
      act(() => {
        useAccessStore.setState({ canonicalAccess: access });
      });
      const r = render(<SettingsScreen />);
      await flush();
      const { stateRow, rendered } = audit(r, 'SettingsScreen', state);
      expectClean(stateRow);
      // No provider-specific store copy on iOS, ever.
      expect(rendered).not.toMatch(/google play/i);
      if (session) {
        // Signed-in users must always reach sign-out with a labelled control.
        expect(
          hostNodes(r).some(n => n.props.accessibilityLabel === 'Sign out'),
        ).toBe(true);
      }
      unmount(r);
    },
  );

  it('sign-out sheet: modal, labelled confirm + cancel, nothing fires on cancel', async () => {
    seedSettingsStores(appleSession);
    const signOut = jest.fn(() => Promise.resolve());
    act(() => {
      useAuthStore.setState({ signOut });
    });
    const r = render(<SettingsScreen />);
    await flush();
    await press(r, 'Sign out');
    const { stateRow, rows } = audit(r, 'SettingsScreen', 'sign-out-sheet');
    expectClean(stateRow);
    expect(stateRow.modalViews).toBeGreaterThanOrEqual(1);
    const labels = rows.map(x => x.name);
    expect(labels).toEqual(
      expect.arrayContaining([
        'Keep me signed in',
        'Sign out',
        'Cancel sign out',
      ]),
    );
    await press(r, 'Keep me signed in');
    expect(signOut).not.toHaveBeenCalled();
    await press(r, 'Sign out');
    await press(r, 'Cancel sign out');
    expect(signOut).not.toHaveBeenCalled();
    unmount(r);
  });
});

// ---------------------------------------------------------------------------
// ManageAccountScreen
// ---------------------------------------------------------------------------

describe('ManageAccountScreen matrix', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockRequestAccountDeletion.mockReset();
    mockConfirmAccountDeletion.mockReset();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  async function openReview(r: Renderer) {
    await press(r, 'Delete account');
    await press(r, 'Skip the survey');
  }

  it('idle: every row labelled; delete entry point is a labelled button', async () => {
    seedSettingsStores(appleSession);
    const r = render(<ManageAccountScreen />);
    await flush();
    const { stateRow, rows } = audit(r, 'ManageAccountScreen', 'idle');
    expectClean(stateRow);
    const del = rows.find(x => x.name === 'Delete account');
    expect(del?.role).toBe('button');
    unmount(r);
  });

  it('local-only session: idle rows still labelled', async () => {
    seedSettingsStores({
      ...appleSession,
      localOnly: true,
      canonicalAppUserId: null,
    });
    const r = render(<ManageAccountScreen />);
    await flush();
    expectClean(audit(r, 'ManageAccountScreen', 'idle-local-only').stateRow);
    unmount(r);
  });

  it('survey → review → armed → deleting → failed: each phase modal + labelled', async () => {
    seedSettingsStores(appleSession);
    let resolveRequest!: (v: { challenge: string; expiresAt: string }) => void;
    mockRequestAccountDeletion.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveRequest = resolve;
        }),
    );
    let rejectConfirm!: (e: unknown) => void;
    mockConfirmAccountDeletion.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectConfirm = reject;
        }),
    );
    const r = render(<ManageAccountScreen />);
    await flush();

    await press(r, 'Delete account');
    let a = audit(r, 'ManageAccountScreen', 'dialog-why');
    expectClean(a.stateRow);
    expect(a.stateRow.modalViews).toBeGreaterThanOrEqual(1);

    await press(r, "It's too expensive");
    await press(r, 'Next');
    a = audit(r, 'ManageAccountScreen', 'dialog-survey-2');
    expectClean(a.stateRow);

    await press(r, 'Skip this question');
    a = audit(r, 'ManageAccountScreen', 'dialog-review');
    expectClean(a.stateRow);
    expect(a.rows.map(x => x.name)).toEqual(
      expect.arrayContaining(['Keep my account', 'Continue to delete']),
    );

    await press(r, 'Continue to delete');
    a = audit(r, 'ManageAccountScreen', 'dialog-requesting');
    expectClean(a.stateRow);
    const requesting = a.rows.find(x => x.name === 'Requesting…');
    expect(requesting?.disabled).toBe(true);
    expect(
      a.rows.find(x => x.name === 'Cancel account deletion')?.disabled,
    ).toBe(true);
    if (!a.rows.some(x => x.kind === 'progressbar' && x.name)) {
      a.push('A4 busy state has no labelled progressbar');
    }
    expectClean(a.stateRow);

    await act(async () => {
      resolveRequest({
        challenge: 'c-1',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    });
    await flush();
    a = audit(r, 'ManageAccountScreen', 'dialog-armed-countdown');
    expectClean(a.stateRow);
    const counting = a.rows.find(x =>
      String(x.name).startsWith('Permanently delete ('),
    );
    expect(counting?.disabled).toBe(true);

    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    a = audit(r, 'ManageAccountScreen', 'dialog-armed-ready');
    expectClean(a.stateRow);
    const ready = a.rows.find(x => x.name === 'Permanently delete');
    expect(ready?.disabled).toBe(false);
    expect(ready?.role).toBe('button');

    await press(r, 'Permanently delete');
    a = audit(r, 'ManageAccountScreen', 'dialog-deleting');
    expect(a.rows.find(x => x.name === 'Deleting…')?.disabled).toBe(true);
    expect(a.rows.find(x => x.name === 'Keep my account')?.disabled).toBe(true);
    if (!a.rows.some(x => x.kind === 'progressbar' && x.name)) {
      a.push('A4 busy state has no labelled progressbar');
    }
    expectClean(a.stateRow);

    await act(async () => {
      rejectConfirm(
        new AccountDeletionError(
          'deletion.unavailable',
          'Account deletion is temporarily unavailable. Nothing was deleted.',
          true,
        ),
      );
    });
    await flush();
    a = audit(r, 'ManageAccountScreen', 'dialog-confirm-failed');
    expect(a.rendered).toMatch(/Nothing was deleted/);
    if (a.stateRow.alerts + a.stateRow.liveRegions === 0) {
      a.push('A8 error text without alert role or live region');
    }
    expectClean(a.stateRow);
    // Honest retry: the armed confirm is offered again, account intact.
    expect(a.rows.find(x => x.name === 'Permanently delete')?.disabled).toBe(
      false,
    );
    expect(useAuthStore.getState().session).not.toBeNull();
    unmount(r);
  });

  it('request failure: alert semantics, retry path, account intact', async () => {
    seedSettingsStores(appleSession);
    mockRequestAccountDeletion.mockRejectedValue(
      new AccountDeletionError(
        'deletion.session_expired',
        'Your session has expired. Sign in again to delete your account.',
        false,
      ),
    );
    const r = render(<ManageAccountScreen />);
    await flush();
    await openReview(r);
    await press(r, 'Continue to delete');
    await flush();
    const a = audit(r, 'ManageAccountScreen', 'dialog-request-failed');
    expect(a.rendered).toMatch(/session has expired/);
    if (a.stateRow.alerts + a.stateRow.liveRegions === 0) {
      a.push('A8 error text without alert role or live region');
    }
    expectClean(a.stateRow);
    expect(mockConfirmAccountDeletion).not.toHaveBeenCalled();
    expect(useAuthStore.getState().session).not.toBeNull();
    unmount(r);
  });
});

// ---------------------------------------------------------------------------
// ConsentSettingsScreen
// ---------------------------------------------------------------------------

describe('ConsentSettingsScreen matrix', () => {
  const states: Array<
    [string, Partial<ReturnType<typeof useConsentStore.getState>>]
  > = [
    ['loading', { availability: 'loading' }],
    ['signed-out', { availability: 'signed_out' }],
    ['unavailable', { availability: 'unavailable' }],
    ['ready-off', { availability: 'ready', modelTrainingActive: false }],
    ['ready-on', { availability: 'ready', modelTrainingActive: true }],
    ['busy', { availability: 'ready', busy: true }],
    [
      'error',
      {
        availability: 'ready',
        error: 'Could not update your consent. Nothing changed.',
      },
    ],
  ];

  it.each(states)('%s', async (state, patch) => {
    seedSettingsStores(appleSession);
    act(() => {
      useConsentStore.setState(patch);
    });
    const r = render(<ConsentSettingsScreen />);
    await flush();
    const a = audit(r, 'ConsentSettingsScreen', state);
    if (
      (state === 'error' || state === 'unavailable') &&
      a.stateRow.alerts + a.stateRow.liveRegions === 0
    ) {
      a.push('A8 error text without alert role or live region');
    }
    expectClean(a.stateRow);
    const toggle = a.rows.find(x => x.kind === 'switch');
    if (state === 'ready-on') expect(toggle?.checked).toBe(true);
    if (state === 'ready-off') expect(toggle?.checked).toBe(false);
    if (state === 'signed-out' || state === 'busy' || state === 'loading') {
      // A disabled switch must be announced disabled, not silently inert.
      if (toggle) expect(toggle.disabled).toBe(true);
    }
    if (state === 'loading') {
      expect(a.stateRow.liveRegions + a.stateRow.alerts).toBeGreaterThanOrEqual(
        1,
      );
    }
    if (state === 'unavailable') {
      expect(a.rows.some(x => x.name === 'Try again')).toBe(true);
    }
    unmount(r);
  });
});

// ---------------------------------------------------------------------------
// NotificationSettingsScreen
// ---------------------------------------------------------------------------

describe('NotificationSettingsScreen matrix', () => {
  type NotifPatch = Partial<ReturnType<typeof useNotificationStore.getState>>;
  const states: Array<[string, NotifPatch]> = [
    ['not-hydrated', { hydrated: false }],
    [
      'granted-enabled',
      {
        prefs: { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
        permission: 'granted',
      },
    ],
    [
      'granted-enabled-reminder-off',
      {
        prefs: {
          ...DEFAULT_NOTIFICATION_PREFS,
          enabled: true,
          practiceReminder: false,
        },
        permission: 'granted',
      },
    ],
    [
      'denied',
      {
        prefs: { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
        permission: 'denied',
      },
    ],
    [
      'unknown-enabled',
      {
        prefs: { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
        permission: 'unknown',
      },
    ],
    [
      'disabled',
      {
        prefs: { ...DEFAULT_NOTIFICATION_PREFS, enabled: false },
        permission: 'granted',
      },
    ],
    [
      'persist-failed',
      {
        prefs: { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
        permission: 'granted',
        persistFailed: true,
      },
    ],
    [
      'schedule-failed',
      {
        prefs: { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
        permission: 'granted',
        scheduleFailed: true,
      },
    ],
  ];

  it.each(states)('%s', async (state, patch) => {
    seedSettingsStores(appleSession);
    act(() => {
      useNotificationStore.setState(patch);
    });
    const r = render(<NotificationSettingsScreen />);
    await flush();
    const a = audit(r, 'NotificationSettingsScreen', state);
    expectClean(a.stateRow);
    if (state === 'persist-failed' || state === 'schedule-failed') {
      expect(a.stateRow.alerts).toBeGreaterThanOrEqual(1);
    }
    if (state === 'denied') {
      expect(a.rows.some(x => x.name === 'Open system settings')).toBe(true);
      mockOpenSystemSettings.mockRejectedValueOnce(new Error('no settings'));
      await press(r, 'Open system settings');
      await flush();
      const after = audit(
        r,
        'NotificationSettingsScreen',
        'denied-settings-open-failed',
      );
      expectClean(after.stateRow);
      expect(after.stateRow.alerts).toBeGreaterThanOrEqual(1);
    }
    if (state === 'granted-enabled') {
      const presets = a.rows.filter(x =>
        /^(Morning|Midday|Evening|Night|Early|Late|Lunch|Afternoon)/.test(
          String(x.name),
        ),
      );
      expect(presets.length).toBeGreaterThan(0);
      for (const p of presets) expect(typeof p.selected).toBe('boolean');
      expect(a.rows.map(x => x.name)).toEqual(
        expect.arrayContaining([
          'Reminder 30 minutes earlier',
          'Reminder 30 minutes later',
        ]),
      );
    }
    if (state === 'granted-enabled-reminder-off') {
      for (const x of a.rows.filter(y =>
        /^Reminder 30 minutes/.test(String(y.name)),
      )) {
        expect(x.disabled).toBe(true);
      }
    }
    unmount(r);
  });

  it('enable request refused (not denied) exposes an alert; button announced disabled while requesting', async () => {
    seedSettingsStores(appleSession);
    // notificationStore.requestPermissionAndEnable never rejects: an OS
    // failure resolves false with permission 'unknown'.
    let resolveRequest!: (v: boolean) => void;
    act(() => {
      useNotificationStore.setState({
        prefs: { ...DEFAULT_NOTIFICATION_PREFS, enabled: false },
        permission: 'unknown',
        requestPermissionAndEnable: jest.fn(
          () =>
            new Promise<boolean>(resolve => {
              resolveRequest = resolve;
            }),
        ),
      });
    });
    const r = render(<NotificationSettingsScreen />);
    await flush();
    await press(r, 'Turn on reminders');
    let a = audit(r, 'NotificationSettingsScreen', 'enable-requesting');
    expectClean(a.stateRow);
    expect(a.rows.find(x => x.name === 'Turn on reminders')?.disabled).toBe(
      true,
    );
    await act(async () => {
      resolveRequest(false);
    });
    await flush();
    a = audit(r, 'NotificationSettingsScreen', 'enable-request-failed');
    expectClean(a.stateRow);
    expect(a.stateRow.alerts).toBeGreaterThanOrEqual(1);
    expect(a.rows.find(x => x.name === 'Turn on reminders')?.disabled).toBe(
      false,
    );
    unmount(r);
  });
});

// ---------------------------------------------------------------------------
// PaywallScreen
// ---------------------------------------------------------------------------

const storePlans: StorePlans = {
  offeringId: 'default',
  monthly: {
    id: 'monthly',
    productId: 'pickle_sensei_pro_monthly',
    period: 'monthly',
    price: 7.99,
    priceString: '$7.99',
    pricePerMonthString: '$7.99',
    freeTrial: null,
  },
  annual: {
    id: 'annual',
    productId: 'pickle_sensei_pro_yearly',
    period: 'annual',
    price: 59.99,
    priceString: '$59.99',
    pricePerMonthString: '$5.00',
    freeTrial: { label: '7-day free trial', periodIso8601: 'P1W' },
  },
  lifetime: {
    id: 'lifetime',
    productId: 'pickle_sensei_pro_lifetime',
    period: 'lifetime',
    price: 159.99,
    priceString: '$159.99',
    pricePerMonthString: null,
    freeTrial: null,
  },
};
const planList = [
  storePlans.monthly!,
  storePlans.annual!,
  storePlans.lifetime!,
];

function billingDeps(
  loadPlans: () => Promise<StorePlans>,
): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(loadPlans),
      purchase: jest.fn(async () => ({
        premium: true,
        productId: 'x',
        expirationDate: null,
      })),
      restore: jest.fn(async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      })),
      readEntitlement: jest.fn(async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      })),
    },
    backend: {
      getAccess: jest.fn(async () => freeAccess),
      syncBilling: jest.fn(async () => {
        throw new Error('not exercised');
      }),
    },
  };
}

describe('PaywallScreen matrix', () => {
  async function renderPaywall() {
    let r!: Renderer;
    await act(async () => {
      r = TestRenderer.create(
        <PaywallScreen
          onClose={jest.fn()}
          onOpenTerms={jest.fn()}
          onOpenPrivacy={jest.fn()}
        />,
      );
    });
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });
    return r;
  }

  it('intro → pricing (3 plans) → each selection: labelled, prices verbatim', async () => {
    clearAccessStoreConfiguration();
    configureAccessStore(billingDeps(async () => storePlans));
    const r = await renderPaywall();
    let a = audit(r, 'PaywallScreen', 'intro');
    expectClean(a.stateRow);
    await pressTestId(r, 'paywall-see-plans');
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });
    a = audit(r, 'PaywallScreen', 'pricing-3-plans');
    expectClean(a.stateRow);
    for (const plan of planList) {
      expect(a.rendered).toContain(plan.priceString);
      const col = a.rows.find(x => x.testID === `paywall-plan-${plan.period}`);
      expect(col).toBeDefined();
      expect(col?.name).toContain(plan.priceString);
      expect(typeof col?.selected).toBe('boolean');
    }
    for (const period of ['monthly', 'annual', 'lifetime'] as const) {
      await pressTestId(r, `paywall-plan-${period}`);
      a = audit(r, 'PaywallScreen', `pricing-selected-${period}`);
      expectClean(a.stateRow);
      const col = a.rows.find(x => x.testID === `paywall-plan-${period}`);
      expect(col?.selected).toBe(true);
      expect(
        a.rows.filter(
          x => /^paywall-plan-/.test(String(x.testID)) && x.selected,
        ).length,
      ).toBe(1);
    }
    expect(a.rows.map(x => x.name)).toEqual(
      expect.arrayContaining(['Restore purchases']),
    );
    expect(a.rows.some(x => /terms/i.test(String(x.name)))).toBe(true);
    expect(a.rows.some(x => /privacy/i.test(String(x.name)))).toBe(true);
    unmount(r);
  });

  it('loading: labelled progressbar; failure: alert/retry, CTA disabled + announced', async () => {
    clearAccessStoreConfiguration();
    configureAccessStore(billingDeps(() => new Promise(() => undefined)));
    let r = await renderPaywall();
    await pressTestId(r, 'paywall-see-plans');
    let a = audit(r, 'PaywallScreen', 'pricing-loading');
    expectClean(a.stateRow);
    expect(a.rows.some(x => x.kind === 'progressbar' && x.name)).toBe(true);
    expect(a.rendered).not.toMatch(/\$\d/);
    unmount(r);

    clearAccessStoreConfiguration();
    configureAccessStore(
      billingDeps(async () => {
        throw new Error('offerings unavailable');
      }),
    );
    r = await renderPaywall();
    await pressTestId(r, 'paywall-see-plans');
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });
    a = audit(r, 'PaywallScreen', 'pricing-store-failed');
    expectClean(a.stateRow);
    expect(a.rendered).not.toMatch(/\$\d/);
    const cta = a.rows.find(x => x.testID === 'paywall-continue');
    expect(cta?.disabled).toBe(true);
    expect(cta?.name).toBe('Store pricing unavailable');
    expect(a.rows.find(x => x.testID === 'paywall-retry')).toBeDefined();
    unmount(r);
  });
});

// ---------------------------------------------------------------------------
// DrillLibraryScreen
// ---------------------------------------------------------------------------

const drillA: CatalogDrill = {
  id: '0b96363e-4a11-47c5-9d2c-3f5b8e6f2a17',
  slug: 'dink-target-ladder',
  title: 'Dink Target Ladder',
  description: 'Land four consecutive cross-court dinks per kitchen zone.',
  coachName: 'Pickle Sensei Training Library',
  equipment: ['paddle', 'balls'],
  difficultyMin: '2.0',
  difficultyMax: '3.5',
  families: ['dink'],
  validationState: 'PUBLISHED',
  saved: false,
};
const drillB: CatalogDrill = {
  id: '9d0a1c9e-2f65-4b7a-8c3d-6e5f4a3b2c1d',
  slug: 'volley-wall-intervals',
  title: 'Volley Wall Intervals',
  description: 'Timed volley intervals against a rebound wall.',
  coachName: 'Pickle Sensei Training Library',
  equipment: ['paddle', 'rebound wall'],
  difficultyMin: null,
  difficultyMax: null,
  families: ['volley'],
  validationState: 'PUBLISHED',
  saved: true,
};
const media: InstructionalMedia = {
  id: '6c8f2a4e-9b31-4f0d-8a57-2e9d4b7c1f03',
  kind: 'embed',
  provider: 'youtube',
  videoId: 'dnk101xyz',
  embedUrl: 'https://www.youtube-nocookie.com/embed/dnk101xyz',
  sourceUrl: 'https://www.youtube.com/watch?v=dnk101xyz',
  creatorName: 'Third Shot Sports',
  licenseName: 'YouTube Terms of Service',
  licenseUrl: 'https://www.youtube.com/t/terms',
  attribution: 'Video by Third Shot Sports on YouTube',
};
const detail: DrillDetail = {
  id: drillA.id,
  slug: drillA.slug,
  title: drillA.title,
  description: drillA.description,
  coachName: drillA.coachName,
  equipment: ['paddle'],
  difficultyMin: null,
  difficultyMax: null,
  saved: false,
  mappings: [
    {
      checkpoint: 'contact_height',
      shotType: 'dink',
      planRole: 'targeted',
      faultDirections: ['high'],
      cueText: 'Contact the ball below your waist.',
      targetSets: 3,
      targetRepetitionsPerSet: 10,
      targetDurationSeconds: null,
      restSeconds: 30,
    },
  ],
  instructionalMedia: [media],
};

describe('DrillLibraryScreen matrix', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockListCatalogDrills.mockReset().mockResolvedValue([drillA, drillB]);
    mockSaveDrill.mockReset().mockResolvedValue(undefined);
    mockUnsaveDrill.mockReset().mockResolvedValue(undefined);
    mockGetDrill.mockReset().mockResolvedValue(detail);
    mockListScoredCheckpointFacts.mockReset().mockResolvedValue([]);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('loading: labelled progressbar/live region, no unlabelled controls', async () => {
    mockListCatalogDrills.mockImplementation(
      () => new Promise(() => undefined),
    );
    const r = render(<DrillLibraryScreen />);
    await flush();
    const a = audit(r, 'DrillLibraryScreen', 'loading');
    expectClean(a.stateRow);
    expect(
      a.rows.some(x => x.kind === 'progressbar' && x.name) ||
        a.stateRow.liveRegions > 0,
    ).toBe(true);
    unmount(r);
  });

  it('unconfigured: connect-account CTA labelled; error: retry labelled + alert-ish', async () => {
    mockListCatalogDrills.mockRejectedValue(
      new TrainingError('training.unconfigured', 'Sign in first.', false),
    );
    let r = render(<DrillLibraryScreen />);
    await flush();
    let a = audit(r, 'DrillLibraryScreen', 'unconfigured');
    expectClean(a.stateRow);
    expect(a.rows.some(x => x.name === 'Connect account')).toBe(true);
    unmount(r);

    mockListCatalogDrills.mockRejectedValue(
      new TrainingError('training.request_failed', 'Catalog 503.', true),
    );
    r = render(<DrillLibraryScreen />);
    await flush();
    a = audit(r, 'DrillLibraryScreen', 'load-error');
    expectClean(a.stateRow);
    expect(a.rows.some(x => /retry|try again/i.test(String(x.name)))).toBe(
      true,
    );
    unmount(r);
  });

  it('empty catalog: no controls without names', async () => {
    mockListCatalogDrills.mockResolvedValue([]);
    const r = render(<DrillLibraryScreen />);
    await flush();
    expectClean(audit(r, 'DrillLibraryScreen', 'empty-catalog').stateRow);
    unmount(r);
  });

  it('catalog → filter chip → search no-match → clear → expand → media → save toast → save failure alert', async () => {
    const r = render(<DrillLibraryScreen />);
    await flush();
    let a = audit(r, 'DrillLibraryScreen', 'catalog');
    expectClean(a.stateRow);
    expect(a.rows.find(x => x.kind === 'textinput')?.name).toBe(
      'Search drills',
    );
    const saveA = a.rows.find(x => x.testID === `save-toggle-${drillA.slug}`);
    const saveB = a.rows.find(x => x.testID === `save-toggle-${drillB.slug}`);
    expect(saveA?.name).toContain(drillA.title);
    expect(saveB?.name).toContain(drillB.title);
    expect(saveA?.selected).toBe(false);
    expect(saveB?.selected).toBe(true);

    // Family filter chips are 38pt tall by style: they must recover ≥44 via
    // hitSlop or the A7 rule fails above.
    const chip = hostNodes(r).find(
      n =>
        typeof n.props.onClick === 'function' &&
        /Show (only )?dink drills|dink/i.test(
          String(n.props.accessibilityLabel),
        ),
    );
    if (chip) {
      await act(async () => {
        chip.props.onClick();
      });
      await flush();
      a = audit(r, 'DrillLibraryScreen', 'filter-dink');
      expectClean(a.stateRow);
      const active = a.rows.find(
        x =>
          x.name === chip.props.accessibilityLabel ||
          (/dink/i.test(String(x.name)) && x.selected !== null),
      );
      expect(active).toBeDefined();
      await act(async () => {
        chip.props.onClick();
      });
      await flush();
    }

    const input = r.root.findAllByType(TextInput)[0]!;
    await act(async () => {
      input.props.onChangeText('zzzz-no-such-drill-ünïcødé');
    });
    await act(async () => {
      jest.advanceTimersByTime(600);
    });
    await flush();
    a = audit(r, 'DrillLibraryScreen', 'search-no-match');
    expectClean(a.stateRow);
    expect(a.rows.some(x => x.name === 'Clear search')).toBe(true);
    await press(r, 'Clear search');
    await act(async () => {
      jest.advanceTimersByTime(600);
    });
    await flush();

    await press(r, `Show detail for ${drillA.title}`);
    await flush();
    await act(async () => {
      jest.advanceTimersByTime(50);
    });
    await flush();
    a = audit(r, 'DrillLibraryScreen', 'expanded-with-media');
    expectClean(a.stateRow);
    expect(a.rows.some(x => x.name === `Hide detail for ${drillA.title}`)).toBe(
      true,
    );
    expect(
      a.rows.some(x => x.name === `Watch demonstration for ${drillA.title}`),
    ).toBe(true);
    expect(
      a.rows.some(x => x.name === `Browse YouTube videos for ${drillA.title}`),
    ).toBe(true);

    await pressTestId(r, `watch-media-${drillA.slug}-0`);
    await flush();
    a = audit(r, 'DrillLibraryScreen', 'video-player-open');
    expectClean(a.stateRow);
    expect(a.stateRow.modalViews).toBeGreaterThanOrEqual(1);
    const closePlayer = hostNodes(r).find(
      n =>
        typeof n.props.onClick === 'function' &&
        /close/i.test(String(n.props.accessibilityLabel)),
    );
    expect(closePlayer).toBeDefined();
    await act(async () => {
      closePlayer!.props.onClick();
    });
    await flush();

    await pressTestId(r, `save-toggle-${drillA.slug}`);
    await flush();
    a = audit(r, 'DrillLibraryScreen', 'save-toast');
    expectClean(a.stateRow);
    expect(a.stateRow.liveRegions).toBeGreaterThanOrEqual(1);
    expect(
      a.rows.find(x => x.testID === `save-toggle-${drillA.slug}`)?.selected,
    ).toBe(true);

    mockUnsaveDrill.mockRejectedValue(
      new TrainingError('training.request_failed', 'Save failed.', true),
    );
    await pressTestId(r, `save-toggle-${drillA.slug}`);
    await flush();
    a = audit(r, 'DrillLibraryScreen', 'save-failed-inline-error');
    expectClean(a.stateRow);
    expect(a.stateRow.alerts).toBeGreaterThanOrEqual(1);
    expect(a.rows.some(x => x.name === 'Dismiss error')).toBe(true);
    // Optimistic toggle reverted: the drill is still saved after the failure.
    expect(
      a.rows.find(x => x.testID === `save-toggle-${drillA.slug}`)?.selected,
    ).toBe(true);
    unmount(r);
  });

  it('detail load failure: labelled retry inside the card', async () => {
    mockGetDrill.mockRejectedValue(
      new TrainingError('training.request_failed', 'Detail 503.', true),
    );
    const r = render(<DrillLibraryScreen />);
    await flush();
    await press(r, `Show detail for ${drillA.title}`);
    await flush();
    await act(async () => {
      jest.advanceTimersByTime(50);
    });
    await flush();
    const a = audit(r, 'DrillLibraryScreen', 'detail-failed');
    expectClean(a.stateRow);
    expect(
      a.rows.some(x => x.name === `Retry detail for ${drillA.title}`),
    ).toBe(true);
    unmount(r);
  });
});

// ---------------------------------------------------------------------------
// Copy policy roll-up (DUPR is reported, see header)
// ---------------------------------------------------------------------------

describe('copy policy roll-up', () => {
  it('no forbidden App Store copy rendered on any audited state', () => {
    const hits = stateRows.flatMap(s =>
      s.policyHits.map(h => `${s.screen}/${s.state}: ${h}`),
    );
    expect(hits).toEqual([]);
  });

  it('the in-app DUPR wording renders only in SettingsScreen (dossier 5.2.1 / §176)', () => {
    const where = new Set(
      stateRows.filter(s => s.duprHits.length).map(s => s.screen),
    );
    // Tracked by the dossier as an optional rename; any spread to another
    // audited screen is new.
    expect([...where]).toEqual(['SettingsScreen']);
  });
});

describe('known-defect ledger', () => {
  it('every pinned baseline defect is still observed and nothing else leaked', () => {
    const observed = [...observedDefects.keys()].sort();
    expect(observed).toEqual(KNOWN_DEFECTS.map(d => d.id).sort());
    expect(stateRows.flatMap(s => s.issues)).toEqual([]);
  });
});
