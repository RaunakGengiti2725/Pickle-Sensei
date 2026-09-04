import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * ADVERSARIAL PASS 3 — mobile-settings-account, scenario S5.
 *
 * The server ledger supports THREE scopes (`video_analysis`,
 * `model_training`, `evaluation_telemetry`); the privacy policy (§F in
 * `supabase/functions/api/legal.ts`) says evaluation telemetry is a separate
 * opt-in category and that "withdrawing an optional permission stops new
 * records … being collected". Here the consent status response carries an
 * ACTIVE `evaluation_telemetry` grant and we ask: does the Data & consent
 * screen let the user see (and withdraw) it?
 *
 * Part A ("ATTACK") states the transparency expectation — an active grant
 * is visible in-app. Part B ("PIN") records the product decision that
 * actually ships today (no in-app grant path, no in-app withdraw, legal copy
 * conditional on "if a control is offered") so a future change to any leg of
 * that decision is caught.
 *
 *   cd apps/mobile && npx jest --ci \
 *     __tests__/attack/settingsAccount.s5.evaluationTelemetryConsent.attack.test.tsx
 */

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));

import { ConsentSettingsScreen } from '../../src/screens/ConsentSettingsScreen';
import { BrandToggle } from '../../src/design/components';
import { useConsentStore } from '../../src/state/consentStore';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import type { ConsentFetch } from '../../src/account/consentApi';

/** Every renderer is unmounted in afterEach so a failed assertion cannot
 * leave a subscribed screen alive past the test (store updates in the next
 * test would re-render it after teardown). */
const mounted: TestRenderer.ReactTestRenderer[] = [];
function mount(element: React.ReactElement): TestRenderer.ReactTestRenderer {
  const renderer = TestRenderer.create(element);
  mounted.push(renderer);
  return renderer;
}
function unmountAll(): void {
  for (const renderer of mounted.splice(0)) {
    try {
      act(() => renderer.unmount());
    } catch {
      // already unmounted by the test
    }
  }
}

const OWNER = '55555555-5555-4555-8555-555555555555';

const authSession: AuthSession = {
  provider: 'google',
  subject: OWNER,
  canonicalAppUserId: OWNER,
  localOnly: false,
  displayName: 'Telemetry Tester',
  email: 'tt@example.com',
};

const STATUS_WITH_ACTIVE_TELEMETRY = {
  subjectPseudonym: 'pseudo-1',
  scopes: [
    {
      scope: 'video_analysis',
      active: true,
      consentVersion: 'video-analysis-v1',
      lastAction: 'granted',
      lastActionAt: '2026-08-01T00:00:00.000Z',
    },
    {
      scope: 'model_training',
      active: false,
      consentVersion: null,
      lastAction: null,
      lastActionAt: null,
    },
    {
      scope: 'evaluation_telemetry',
      active: true,
      consentVersion: 'evaluation-telemetry-v1',
      lastAction: 'granted',
      lastActionAt: '2026-09-01T12:00:00.000Z',
    },
  ],
};

const fetchStatus: ConsentFetch = async () =>
  new Response(JSON.stringify(STATUS_WITH_ACTIVE_TELEMETRY), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

// Node globals for the source-scan half (same pattern as
// importedRealFootageAnalysis.test.ts; the RN tsconfig has no node types).
declare const __dirname: string;
const { readdirSync, readFileSync, statSync } = require('fs') as {
  readdirSync: (path: string) => string[];
  readFileSync: (path: string, encoding: 'utf8') => string;
  statSync: (path: string) => { isDirectory: () => boolean };
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const MOBILE_SRC = join(__dirname, '..', '..', 'src');
const LEGAL_TS = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'supabase',
  'functions',
  'api',
  'legal.ts',
);

beforeEach(() => {
  establishApiSession({
    apiBaseUrl: 'https://api.attack.invalid',
    bearerToken: 'bearer-owner',
    canonicalAppUserId: OWNER,
    provider: 'google',
  });
  useAuthStore.setState({
    hydrated: true,
    session: authSession,
    busy: false,
    error: null,
  });
  useConsentStore.setState({
    availability: 'loading',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
  });
});
afterEach(() => {
  unmountAll();
  clearApiSession();
});

describe('S5 — active evaluation_telemetry grant in the consent status', () => {
  it('precondition: the store hydrates from a status carrying the active telemetry grant', async () => {
    await useConsentStore.getState().hydrate(fetchStatus);
    const state = useConsentStore.getState();
    expect(state.availability).toBe('ready');
    expect(state.modelTrainingActive).toBe(false);
  });

  it('ATTACK (store): the hydrated state carries the evaluation_telemetry grant somewhere', async () => {
    await useConsentStore.getState().hydrate(fetchStatus);
    const state = useConsentStore.getState() as unknown as Record<
      string,
      unknown
    >;
    const serialized = JSON.stringify(
      Object.fromEntries(
        Object.entries(state).filter(([, v]) => typeof v !== 'function'),
      ),
    );
    console.info('[attack s5] consent store after hydrate:', serialized);
    expect(serialized.toLowerCase()).toMatch(/evaluation|telemetry/);
  });

  it('ATTACK (screen): with the grant active, the Data & consent screen shows it (or a way to withdraw it)', async () => {
    await useConsentStore.getState().hydrate(fetchStatus);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = mount(<ConsentSettingsScreen />);
    });
    const copy = allText(renderer);
    const toggles = renderer.root.findAllByType(BrandToggle);
    console.info(
      '[attack s5] toggles rendered:',
      toggles.length,
      'copy mentions telemetry:',
      /telemetry|evaluation/i.test(copy),
    );
    expect(/telemetry|evaluation/i.test(copy)).toBe(true);
    act(() => renderer.unmount());
  });

  it('ATTACK (screen): the only toggle shown is model training — and it reads OFF while telemetry is ON server-side', async () => {
    await useConsentStore.getState().hydrate(fetchStatus);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = mount(<ConsentSettingsScreen />);
    });
    const toggles = renderer.root.findAllByType(BrandToggle);
    expect(toggles).toHaveLength(1);
    expect(toggles[0]!.props.value).toBe(false);
    // The single "off" toggle beside "Nothing is shared"-style copy must not
    // read as "no optional processing is active" when one scope IS active.
    const copy = allText(renderer);
    expect(copy).toMatch(/telemetry|evaluation/i);
    act(() => renderer.unmount());
  });
});

describe('S5 PIN — the shipping decision: no in-app evaluation-telemetry control', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
    return out;
  }

  it('no shipping code path grants or withdraws evaluation_telemetry (only the API client defines it)', () => {
    const callers = walk(MOBILE_SRC).filter(file => {
      if (file.endsWith(join('account', 'consentApi.ts'))) return false;
      const source = readFileSync(file, 'utf8');
      return /grantEvaluationTelemetryConsent|withdrawEvaluationTelemetryConsent/.test(
        source,
      );
    });
    expect(callers).toEqual([]);
  });

  it('the privacy policy keeps the telemetry control CONDITIONAL ("If an evaluation-telemetry control is offered")', () => {
    const legal = readFileSync(LEGAL_TS, 'utf8');
    expect(legal).toContain(
      'Evaluation telemetry is a separate, opt-in category',
    );
    expect(legal).toContain('If an evaluation-telemetry control is offered');
  });

  it('consent screen renders exactly one toggle (model training) for a signed-in user', async () => {
    await useConsentStore.getState().hydrate(fetchStatus);
    expect(useConsentStore.getState().availability).toBe('ready');
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = mount(<ConsentSettingsScreen />);
    });
    expect(renderer.root.findAllByType(BrandToggle)).toHaveLength(1);
    expect(allText(renderer)).toContain('Use my feedback to improve scoring');
    act(() => renderer.unmount());
  });
});
