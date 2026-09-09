/**
 * INT-security-privacy adversary — analytics redaction guard.
 *
 * REVIEW.md / AGENTS.md: analytics telemetry is categorical and must reject
 * media URIs, paths, emails, free text, base64 data and device identifiers.
 * Every case below plants one such value in a field the closed event union
 * types as `string` and asserts the guard refuses the event.
 *
 *   cd apps/mobile && npx jest --ci --silent __tests__/adv/secprvAnalyticsRedaction.test.ts
 */
import {
  BufferedAnalytics,
  findPrivacyViolations,
  type AnalyticsEvent,
  type PrivacyViolation,
} from '../../../../packages/analytics/src/index';

const at = '2026-09-09T05:00:00.000Z';
const CANARY = 'XCANARY_ANL_31c7';

function failureEvent(failureKind: string): AnalyticsEvent {
  return { name: 'analysis_failed', at, failureKind };
}

function routeEvent(route: string): AnalyticsEvent {
  return {
    name: 'api_failure',
    at,
    route,
    method: 'GET',
    statusCode: 500,
    errorCode: 'internal',
  };
}

const secretShaped: Array<[string, string]> = [
  ['compact JWT', `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIke${CANARY}In0.abc123XYZ_-`],
  ['bearer header value', `Bearer sess-${CANARY}-0123456789abcdef`],
  ['RevenueCat public key', `appl_${CANARY}AbCdEfGh`],
  ['Stripe-style live key', `sk_live_${CANARY}0123456789`],
  ['GitHub token', `ghp_${CANARY}0123456789abcdef`],
  ['Supabase personal token', `sbp_${CANARY}0123456789`],
  ['Google API key', `AIza${CANARY}0123456789abcdefghijklmn`],
  ['query-string token', `access_token=${CANARY}0123456789`],
  ['refresh token (43 base64url chars)', 'A'.repeat(21) + '-' + '_'.repeat(21)],
];

const identifierShaped: Array<[string, string]> = [
  ['UUID (user / device / install id)', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
  ['IPv4 address', '203.0.113.42'],
  ['IPv6 address', '2001:0db8:85a3:0000:0000:8a2e:0370:7334'],
  ['IDFV-style upper UUID', 'B7E7C5D3-1E4A-4A0B-9C2D-8F6E5A4B3C2D'],
  ['phone number', '+1 (415) 555-0142'],
];

const mediaAndPathShaped: Array<[string, string]> = [
  ['media basename', `IMG_${CANARY}_0042.MOV`],
  ['HEIC basename', `${CANARY}.heic`],
  ['relative Documents path', `Documents/Pickle/${CANARY}/clip.mp4`],
  ['home-relative path', `~/Library/Caches/${CANARY}`],
  ['iOS Library path', `/Library/Caches/pickle/${CANARY}`],
  ['file URL after a colon', `error:file:///var/mobile/${CANARY}`],
  ['percent-encoded file URL', `file%3A%2F%2F%2Fvar%2Fmobile%2F${CANARY}`],
  [
    'Photos localIdentifier',
    `${CANARY.slice(0, 8)}-1E4A-4A0B-9C2D-8F6E5A4B3C2D/L0/001`,
  ],
  ['Windows path', `C:\\Users\\${CANARY}\\Videos\\clip.mp4`],
  [
    'path inside a sentence after a colon',
    `at:/var/mobile/Containers/${CANARY}`,
  ],
];

function rejected(event: AnalyticsEvent): PrivacyViolation[] {
  return findPrivacyViolations(event);
}

describe('analytics redaction guard — secret-shaped values', () => {
  it.each(secretShaped)(
    'rejects a %s in a categorical field',
    (_label, value) => {
      expect(rejected(failureEvent(value))).not.toEqual([]);
    },
  );
});

describe('analytics redaction guard — device / user identifiers', () => {
  it.each(identifierShaped)(
    'rejects a %s in a categorical field',
    (_label, value) => {
      expect(rejected(failureEvent(value))).not.toEqual([]);
    },
  );

  it('rejects identifiers under keys the forbidden-key list does not name', () => {
    const smuggled = {
      name: 'analysis_failed',
      at,
      failureKind: 'timeout',
      userId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      installId: 'B7E7C5D3-1E4A-4A0B-9C2D-8F6E5A4B3C2D',
      ip: '203.0.113.42',
    } as unknown as AnalyticsEvent;
    expect(rejected(smuggled)).not.toEqual([]);
  });
});

describe('analytics redaction guard — media and path shapes', () => {
  it.each(mediaAndPathShaped)(
    'rejects a %s in a categorical field',
    (_label, value) => {
      expect(rejected(routeEvent(value))).not.toEqual([]);
    },
  );
});

describe('analytics redaction guard — free text', () => {
  it('rejects multi-word free text in a categorical field', () => {
    expect(
      rejected(failureEvent(`user said: my knee hurts when I ${CANARY} lunge`)),
    ).not.toEqual([]);
  });

  it('rejects an oversized value even when it is split across array items', () => {
    const items = Array.from(
      { length: 32 },
      (_, i) => `dim${i}-` + 'x'.repeat(190),
    );
    const event: AnalyticsEvent = {
      name: 'scoring_calibration_drift',
      at,
      algorithmVersion: 'v1',
      thresholdsVersion: 'v1',
      failedDimensions: items,
      driftScore: 1,
    } as unknown as AnalyticsEvent;
    expect(rejected(event)).not.toEqual([]);
  });
});

describe('BufferedAnalytics — violation handling never leaks the offending value', () => {
  it('reports only path+rule to onViolation and never buffers/transports the event', async () => {
    const sent: AnalyticsEvent[][] = [];
    const reported: Array<[string, PrivacyViolation[]]> = [];
    const sink = new BufferedAnalytics(
      async batch => {
        sent.push(batch);
      },
      50,
      (eventName, violations) => reported.push([eventName, violations]),
    );
    const hostile = failureEvent(
      `file:///var/mobile/${CANARY}/clip.mov user@leak.example`,
    );
    for (let i = 0; i < 100; i += 1) sink.track(hostile);
    await sink.flush();
    expect(sent).toEqual([]);
    expect(sink.pendingCount()).toBe(0);
    expect(sink.droppedViolationCount()).toBe(100);
    expect(reported).toHaveLength(100);
    expect(JSON.stringify(reported)).not.toContain(CANARY);
    expect(JSON.stringify(reported)).not.toContain('leak.example');
  });

  it('bounds the re-buffer when the transport keeps failing (no unbounded retention)', async () => {
    const sink = new BufferedAnalytics(async () => {
      throw new Error('offline');
    }, 10);
    for (let round = 0; round < 50; round += 1) {
      for (let i = 0; i < 10; i += 1) sink.track(failureEvent('timeout'));
      await sink.flush();
    }
    expect(sink.pendingCount()).toBeLessThanOrEqual(20);
  });
});
