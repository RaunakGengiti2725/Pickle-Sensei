/**
 * STRESS — scr-signinscreen / failure-injection: module-load faults.
 *
 * `SignInScreen` → `authStore` → `data/repository` → `camera/capture`, and
 * `camera/capture.ts` reads `NativeModules.PickleVideoCapture` when the module
 * is first evaluated. A broken / absent camera native module is therefore an
 * IMPORT-time dependency of the sign-in screen, not a runtime one. Each row
 * below re-evaluates the whole sign-in module graph in an isolated registry
 * with `NativeModules` shaped by the injected fault and records whether the
 * screen module can still be loaded and whether the camera seam degrades to
 * "unavailable" instead of throwing.
 *
 * Replay one row: STRESS_ONLY='<row id>' npx jest --ci __tests__/stress/signInScreen.moduleLoadFaults.stress.test.tsx
 */
import {
  stressOnlyFilter,
  writeStressJson,
} from '../../__harness__/stressSignIn/artifacts';

declare const require: (id: string) => unknown;

// `@op-engineering/op-sqlite` throws "Base module not found" from its own
// module body when its native part is absent, so the SQLite seam is stubbed
// exactly as the existing SignInScreen suites do (SQLite runtime faults are
// the failure-injection campaign's job). The view-layer native packages are
// pure-JS stand-ins; they are not the dependency under test here.
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    SafeAreaProvider: View,
    initialWindowMetrics: null,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});
jest.mock('react-native-svg', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  const Stub = (props: { children?: React.ReactNode }) =>
    R.createElement(RN.View, null, props.children);
  return {
    __esModule: true,
    default: Stub,
    Svg: Stub,
    Path: Stub,
    Circle: Stub,
    Rect: Stub,
    G: Stub,
    Line: Stub,
    Polyline: Stub,
    Polygon: Stub,
    Defs: Stub,
    LinearGradient: Stub,
    Stop: Stub,
    ClipPath: Stub,
    Ellipse: Stub,
    Text: Stub,
  };
});
jest.mock('react-native-linear-gradient', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: RN.View, LinearGradient: RN.View };
});

type NativeModulesBag = Record<string, unknown>;

type Fault =
  | { id: 'camera/module-missing'; apply: (bag: NativeModulesBag) => void }
  | { id: 'camera/module-null'; apply: (bag: NativeModulesBag) => void }
  | { id: 'camera/module-empty-object'; apply: (bag: NativeModulesBag) => void }
  | {
      id: 'camera/capture-not-a-function';
      apply: (bag: NativeModulesBag) => void;
    }
  | { id: 'camera/getter-throws'; apply: (bag: NativeModulesBag) => void }
  | { id: 'auth/module-missing'; apply: (bag: NativeModulesBag) => void }
  | { id: 'auth/getter-throws'; apply: (bag: NativeModulesBag) => void }
  | {
      id: 'all-native-modules-missing';
      apply: (bag: NativeModulesBag) => void;
    };

const throwingGetter = (bag: NativeModulesBag, key: string): void => {
  Object.defineProperty(bag, key, {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error(`${key} native module failed to initialise (simulated)`);
    },
  });
};

/** Faults marked synthetic have no real-platform counterpart: React Native's
 * `NativeModules` bag yields `null`/`undefined` for an unregistered module, it
 * never throws on read. They are still executed and recorded, but a failure
 * there is not a product finding. */
const SYNTHETIC: ReadonlySet<string> = new Set([
  'camera/getter-throws',
  'auth/getter-throws',
]);

const FAULTS: readonly Fault[] = [
  {
    id: 'camera/module-missing',
    apply: bag => {
      delete bag['PickleVideoCapture'];
    },
  },
  {
    id: 'camera/module-null',
    apply: bag => {
      bag['PickleVideoCapture'] = null;
    },
  },
  {
    id: 'camera/module-empty-object',
    apply: bag => {
      bag['PickleVideoCapture'] = {};
    },
  },
  {
    id: 'camera/capture-not-a-function',
    apply: bag => {
      bag['PickleVideoCapture'] = { capture: 'not-callable' };
    },
  },
  {
    id: 'camera/getter-throws',
    apply: bag => throwingGetter(bag, 'PickleVideoCapture'),
  },
  {
    id: 'auth/module-missing',
    apply: bag => {
      delete bag['PickleAuth'];
    },
  },
  {
    id: 'auth/getter-throws',
    apply: bag => throwingGetter(bag, 'PickleAuth'),
  },
  {
    id: 'all-native-modules-missing',
    apply: bag => {
      for (const key of Object.keys(bag)) {
        if (key.startsWith('Pickle')) delete bag[key];
      }
    },
  },
];

interface Row {
  id: string;
  synthetic: boolean;
  screenLoads: boolean;
  repositoryLoads: boolean;
  captureLoads: boolean;
  cameraAvailable: boolean | 'n/a';
  error: string | null;
  ok: boolean;
}

function runRow(fault: Fault): Row {
  const row: Row = {
    id: fault.id,
    synthetic: SYNTHETIC.has(fault.id),
    screenLoads: false,
    repositoryLoads: false,
    captureLoads: false,
    cameraAvailable: 'n/a',
    error: null,
    ok: false,
  };
  jest.isolateModules(() => {
    const rn = require('react-native') as { NativeModules: NativeModulesBag };
    fault.apply(rn.NativeModules);
    try {
      const capture = require('../../src/camera/capture') as {
        cameraAvailable: () => boolean;
      };
      row.captureLoads = true;
      row.cameraAvailable = capture.cameraAvailable();
      require('../../src/data/repository');
      row.repositoryLoads = true;
      const screen = require('../../src/screens/SignInScreen') as {
        SignInScreen?: unknown;
        default?: unknown;
      };
      row.screenLoads =
        typeof screen.SignInScreen === 'function' ||
        typeof screen.default === 'function';
    } catch (error) {
      row.error = error instanceof Error ? error.message : String(error);
    }
  });
  row.ok =
    row.screenLoads &&
    row.repositoryLoads &&
    row.captureLoads &&
    row.cameraAvailable === false &&
    row.error === null;
  return row;
}

const only = stressOnlyFilter();
const selected = FAULTS.filter(f => only === null || f.id.includes(only));
const rows: Row[] = [];

afterAll(() => {
  writeStressJson('signin-module-load-faults.json', {
    executed: rows.length,
    held: rows.filter(r => r.ok).length,
    failed: rows.filter(r => !r.ok).map(r => r.id),
    rows,
  });
});

describe('SignInScreen module graph survives native-module load faults', () => {
  for (const fault of selected) {
    test(fault.id, () => {
      const row = runRow(fault);
      rows.push(row);
      if (row.synthetic) return;
      expect(row).toMatchObject({
        screenLoads: true,
        repositoryLoads: true,
        captureLoads: true,
        cameraAvailable: false,
        error: null,
      });
    });
  }
});
