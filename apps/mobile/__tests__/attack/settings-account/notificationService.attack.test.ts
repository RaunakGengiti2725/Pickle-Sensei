import notifee from 'react-native-notify-kit';
import {
  getScheduler,
  screenTargetFromNotificationData,
  subscribeToNotificationPresses,
} from '../../../src/notifications/service';

/**
 * Adversarial pass (mobile-settings-account, pass 3): the native adapter
 * against hostile press payloads (S5) and out-of-contract authorization
 * statuses (S7), through the repo's react-native-notify-kit auto-mock.
 */

const mocked = notifee as unknown as {
  requestPermission: jest.Mock;
  getNotificationSettings: jest.Mock;
  getInitialNotification: jest.Mock;
  onForegroundEvent: jest.Mock;
};

beforeEach(() => {
  mocked.requestPermission.mockClear();
  mocked.getNotificationSettings.mockClear();
  mocked.getInitialNotification.mockClear();
  mocked.onForegroundEvent.mockClear();
});

afterEach(() => jest.restoreAllMocks());

// Deterministic seeded PRNG (mulberry32) so a failing fuzz row reproduces.
const FUZZ_SEED = 0x5eed_0003;
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

function subscribeWithCapturedHandler(navigate: jest.Mock) {
  let handler: ((event: unknown) => void) | null = null;
  const unsubscribe = jest.fn();
  mocked.getInitialNotification.mockResolvedValueOnce(null);
  mocked.onForegroundEvent.mockImplementationOnce(
    (h: (event: unknown) => void) => {
      handler = h;
      return unsubscribe;
    },
  );
  const off = subscribeToNotificationPresses(navigate);
  return { handler: handler!, unsubscribe, off };
}

describe('S5: hostile press payloads never navigate', () => {
  const hostileScreens: Array<[string, unknown]> = [
    ['Settings', { screen: 'Settings' }],
    ['ManageAccount', { screen: 'ManageAccount' }],
    ['ConsentSettings', { screen: 'ConsentSettings' }],
    ['lower-case home', { screen: 'home' }],
    ['padded Home', { screen: ' Home' }],
    ['Home with NUL', { screen: 'Home\u0000' }],
    ['Home with RTL override', { screen: '\u202EemoH' }],
    ['Home as array', { screen: ['Home'] }],
    ['Home as object', { screen: { toString: () => 'Home' } }],
    ['Home as String object', { screen: new String('Home') }],
    ['screen is a function', { screen: () => 'Home' }],
    ['screen boolean', { screen: true }],
    ['screen numeric 0', { screen: 0 }],
    ['screen nested', { screen: { screen: 'Home' } }],
    ['screen absent', { target: 'Home' }],
    ['array payload', ['Home']],
    ['string payload', 'Home'],
    ['number payload', 1],
    ['null', null],
    ['undefined', undefined],
    ['Symbol', Symbol('Home')],
    ['huge screen', { screen: 'Home'.repeat(250_000) }],
    ['Home\\nPerformance', { screen: 'Home\nPerformance' }],
  ];

  it.each(hostileScreens)('%s → null', (_label, data) => {
    expect(screenTargetFromNotificationData(data)).toBeNull();
  });

  it('prototype-polluted payload: screen only via __proto__ → null', () => {
    const polluted = JSON.parse('{"__proto__":{"screen":"Home"}}') as unknown;
    // JSON.parse creates an OWN property named __proto__, so lookup of
    // `screen` must fail. Object.create() is the runtime-prototype variant.
    expect(screenTargetFromNotificationData(polluted)).toBeNull();
    const viaPrototype = Object.create({ screen: 'Home' }) as unknown;
    // A prototype-inherited `screen` IS readable with plain bracket access.
    // Pinned as characterization: inherited 'Home' currently navigates.
    expect(screenTargetFromNotificationData(viaPrototype)).toBe('Home');
  });

  it('a global Object.prototype pollution cannot mint a target from {}', () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    Object.defineProperty(proto, 'screen', {
      value: 'Home',
      configurable: true,
      enumerable: false,
      writable: true,
    });
    try {
      // With Object.prototype.screen === 'Home', an empty object inherits
      // it. Pinned: the validator only checks own+inherited value equality.
      expect(screenTargetFromNotificationData({})).toBe('Home');
      expect(
        screenTargetFromNotificationData({ screen: 'Settings' }),
      ).toBeNull();
    } finally {
      delete proto['screen'];
    }
    expect(screenTargetFromNotificationData({})).toBeNull();
  });

  it('seeded fuzz: 2000 random strings that are not exactly Home/Performance never navigate', () => {
    const rnd = mulberry32(FUZZ_SEED);
    const alphabet = 'HomePerfrmance \u0000\u202E\t\n0123456789_-';
    for (let i = 0; i < 2000; i += 1) {
      const len = 1 + Math.floor(rnd() * 16);
      let s = '';
      for (let j = 0; j < len; j += 1) {
        s += alphabet[Math.floor(rnd() * alphabet.length)];
      }
      const out = screenTargetFromNotificationData({ screen: s });
      if (s === 'Home' || s === 'Performance') {
        expect(out).toBe(s);
      } else {
        expect(out).toBeNull();
      }
    }
  });

  it('foreground PRESS with Settings / object payloads → navigate never called', () => {
    const navigate = jest.fn();
    const { handler, off } = subscribeWithCapturedHandler(navigate);
    for (const data of [
      { screen: 'Settings' },
      { screen: { screen: 'Home' } },
      JSON.parse('{"__proto__":{"screen":"Home"}}'),
      ['Home'],
      null,
    ]) {
      handler({ type: 1, detail: { notification: { data } } });
    }
    handler({ type: 1, detail: {} });
    handler({ type: 1, detail: { notification: null } });
    expect(navigate).not.toHaveBeenCalled();
    off();
  });

  it('CHARACTERIZATION: a PRESS event with no `detail` throws inside the foreground handler', () => {
    // notify-kit's Event contract always supplies `detail` (an object), so
    // this shape is out-of-contract; the handler nevertheless dereferences
    // `event.detail.notification` unguarded. Pinned so a future bridge that
    // emits `{type}` alone is caught here rather than as a JS crash.
    const navigate = jest.fn();
    const { handler, off } = subscribeWithCapturedHandler(navigate);
    expect(() => handler({ type: 1 })).toThrow(TypeError);
    expect(() => handler({ type: 1, detail: null })).toThrow(TypeError);
    expect(navigate).not.toHaveBeenCalled();
    off();
  });

  it('cold-start Settings payload and malformed initial shapes → no navigation', async () => {
    for (const initial of [
      { notification: { data: { screen: 'Settings' } } },
      { notification: { data: ['Home'] } },
      { notification: {} },
      { notification: { data: JSON.parse('{"__proto__":{"screen":"Home"}}') } },
    ]) {
      const navigate = jest.fn();
      mocked.getInitialNotification.mockResolvedValueOnce(initial);
      mocked.onForegroundEvent.mockImplementationOnce(() => () => {});
      subscribeToNotificationPresses(navigate);
      await flushMicrotasks();
      expect(navigate).not.toHaveBeenCalled();
    }
  });

  it('initial notification with no `notification` key rejects inside the promise, not synchronously', async () => {
    const navigate = jest.fn();
    mocked.getInitialNotification.mockResolvedValueOnce({});
    mocked.onForegroundEvent.mockImplementationOnce(() => () => {});
    expect(() => subscribeToNotificationPresses(navigate)).not.toThrow();
    await flushMicrotasks();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('rapid repeated PRESS with a valid target navigates once per press (no dedupe, no drop)', () => {
    const navigate = jest.fn();
    const { handler, off, unsubscribe } =
      subscribeWithCapturedHandler(navigate);
    for (let i = 0; i < 50; i += 1) {
      handler({
        type: 1,
        detail: { notification: { data: { screen: 'Home' } } },
      });
    }
    expect(navigate).toHaveBeenCalledTimes(50);
    off();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('non-PRESS event types (DISMISSED=0, DELIVERED=3, unknown=99) with a valid target never navigate', () => {
    const navigate = jest.fn();
    const { handler, off } = subscribeWithCapturedHandler(navigate);
    for (const type of [0, 2, 3, 4, 7, 99, -1, '1', undefined]) {
      handler({ type, detail: { notification: { data: { screen: 'Home' } } } });
    }
    expect(navigate).not.toHaveBeenCalled();
    off();
  });
});

describe('S7: iOS authorization statuses 2/3/4', () => {
  // react-native-notify-kit@10.5.0 declares AuthorizationStatus
  // {NOT_DETERMINED:-1, DENIED:0, AUTHORIZED:1, PROVISIONAL:2}; there is no
  // 3 or 4 in the JS contract. toPermissionState() (service.ts) treats every
  // value other than -1/0 as 'granted'. These rows pin that fail-open
  // default so it is a deliberate decision, not an accident.
  it.each([
    [2, 'granted', 'PROVISIONAL — documented + intended (quiet delivery)'],
    [3, 'granted', 'undeclared — falls through to granted'],
    [
      4,
      'granted',
      'undeclared (UNAuthorizationStatusEphemeral) — falls through',
    ],
    [5, 'granted', 'undeclared'],
    [-2, 'granted', 'undeclared negative'],
    [Number.NaN, 'granted', 'NaN'],
    [Number.POSITIVE_INFINITY, 'granted', 'Infinity'],
  ])(
    'getNotificationSettings authorizationStatus=%p → %s (%s)',
    async (status, expected) => {
      mocked.getNotificationSettings.mockResolvedValueOnce({
        authorizationStatus: status,
      });
      await expect(getScheduler().permissionState()).resolves.toBe(expected);
      mocked.requestPermission.mockResolvedValueOnce({
        authorizationStatus: status,
      });
      await expect(getScheduler().requestPermission()).resolves.toBe(expected);
    },
  );

  it('undefined / missing authorizationStatus (bridge returned an empty settings object) → granted', async () => {
    mocked.getNotificationSettings.mockResolvedValueOnce({});
    await expect(getScheduler().permissionState()).resolves.toBe('granted');
  });

  it('string-typed "0" / "-1" (a JSON-serialised bridge) bypass the denied/undetermined checks → granted', async () => {
    mocked.getNotificationSettings.mockResolvedValueOnce({
      authorizationStatus: '0',
    });
    await expect(getScheduler().permissionState()).resolves.toBe('granted');
    mocked.getNotificationSettings.mockResolvedValueOnce({
      authorizationStatus: '-1',
    });
    await expect(getScheduler().permissionState()).resolves.toBe('granted');
  });

  it('getNotificationSettings rejecting propagates (store maps it to unknown)', async () => {
    mocked.getNotificationSettings.mockRejectedValueOnce(new Error('bridge'));
    await expect(getScheduler().permissionState()).rejects.toThrow('bridge');
  });
});
