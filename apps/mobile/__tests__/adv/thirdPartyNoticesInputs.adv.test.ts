/**
 * INT-release-config adversary — third-party notice inputs.
 *
 * Attacked head: 30a4065036a917514fb4984fde73f87867f38619.
 *
 * The notice receipt (`scripts/third-party-notices.sources.json`) pins the
 * four locked dependency inputs by sha256 and `--check` is the CI gate. This
 * file attacks the binding: committed inputs must hash to the receipt, every
 * native pod that Podfile.lock resolves must be a receipt component at that
 * version and appear in the shipped notice text, and the validator must fail
 * closed when an input is tampered with, missing, or dropped from the receipt.
 *
 * `--check-app <PickleSensei.app>` (final binary membership) needs a Mac
 * archive and is NOT exercised here.
 *
 *   cd apps/mobile && npx jest --ci __tests__/adv/thirdPartyNoticesInputs.adv.test.ts
 */

export {};

declare const require: (id: string) => unknown;
declare const __dirname: string;
const fs = require('fs') as {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string) => Uint8Array;
  mkdtempSync: (prefix: string) => string;
  mkdirSync: (p: string, options: { recursive: true }) => void;
  writeFileSync: (p: string, data: string) => void;
  copyFileSync: (src: string, dest: string) => void;
  cpSync: (src: string, dest: string, options: { recursive: true }) => void;
  rmSync: (p: string, options: { recursive: true; force: true }) => void;
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
  dirname: (p: string) => string;
};
const os = require('os') as { tmpdir: () => string };
const { execPath } = require('node:process') as { execPath: string };
const { createHash } = require('crypto') as {
  createHash: (algorithm: 'sha256') => {
    update: (data: Uint8Array) => { digest: (encoding: 'hex') => string };
  };
};
const childProcess = require('child_process') as {
  spawnSync: (
    executable: string,
    args: string[],
    options: {
      cwd: string;
      encoding: 'utf8';
      timeout: number;
      killSignal: 'SIGKILL';
      maxBuffer: number;
    },
  ) => {
    status: number | null;
    error?: { code?: string };
    stdout: string;
    stderr: string;
  };
};

const MOBILE_ROOT = path.resolve(__dirname, '..', '..');
const GENERATOR = path.join(
  MOBILE_ROOT,
  'scripts',
  'generate-third-party-notices.mjs',
);
const RECEIPT_PATH = path.join(
  MOBILE_ROOT,
  'scripts',
  'third-party-notices.sources.json',
);
const NOTICES_PATH = path.join(
  MOBILE_ROOT,
  'assets',
  'legal',
  'ThirdPartyNotices.txt',
);

const text = (p: string) => Buffer.from(fs.readFileSync(p)).toString('utf8');
const sha256 = (p: string) =>
  createHash('sha256').update(fs.readFileSync(p)).digest('hex');

interface Receipt {
  inputs: { path: string; sha256: string }[];
  guards: { path: string; sha256: string; purpose: string }[];
  components: { id: string; name: string; version: string; role: string }[];
}
const receipt = JSON.parse(text(RECEIPT_PATH)) as Receipt;
const podfileLock = text(path.join(MOBILE_ROOT, 'ios', 'Podfile.lock'));
const notices = text(NOTICES_PATH);

function run(args: string[], cwd: string = MOBILE_ROOT) {
  const result = childProcess.spawnSync(execPath, args, {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`spawn failed: ${JSON.stringify(result.error)}`);
  }
  return result;
}

/** Top-level `- Name (version)` entries of the PODS section. */
function lockedPods(): Map<string, string> {
  const section = podfileLock.split('\nDEPENDENCIES:')[0] ?? '';
  const pods = new Map<string, string>();
  for (const match of section.matchAll(
    /^ {2}- "?([^\s(/"]+)(?:\/[^\s("]+)?"? \(([^)]+)\)/gm,
  )) {
    const name = match[1] ?? '';
    if (!pods.has(name)) pods.set(name, match[2] ?? '');
  }
  return pods;
}

const fixtures: string[] = [];
afterAll(() => {
  for (const root of fixtures)
    fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A workspace copy holding exactly the files `validateReceipt` reads outside
 * ios/Pods (inputs, non-Pods guards, bundled fonts), mutated as requested.
 */
function fixture(mutate: (root: string) => void): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-notices-'));
  fixtures.push(root);
  const files = [
    ...receipt.inputs.map(i => i.path),
    ...receipt.guards
      .filter(
        g =>
          g.purpose === 'preserve-font-and-splash-input-bytes' &&
          !g.path.startsWith('ios/Pods/'),
      )
      .map(g => g.path),
  ];
  for (const relative of files) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(MOBILE_ROOT, relative), target);
  }
  fs.cpSync(
    path.join(MOBILE_ROOT, 'assets', 'fonts'),
    path.join(root, 'assets', 'fonts'),
    {
      recursive: true,
    },
  );
  mutate(root);
  return root;
}

/** Runs validateReceipt(receiptJson, { root }) in the generator's own module. */
function validateRaw(root: string, receiptOverride?: Receipt) {
  const script = `
    import { validateReceipt } from ${JSON.stringify(GENERATOR)};
    import { readFileSync } from 'node:fs';
    const receipt = JSON.parse(readFileSync(process.argv[1], 'utf8'));
    process.stdout.write(JSON.stringify(validateReceipt(receipt, { root: process.argv[2] })));
  `;
  const receiptFile = path.join(root, 'receipt-under-test.json');
  fs.writeFileSync(receiptFile, JSON.stringify(receiptOverride ?? receipt));
  return run(['--input-type=module', '-e', script, receiptFile, root]);
}

function validate(root: string, receiptOverride?: Receipt): string[] {
  const result = validateRaw(root, receiptOverride);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as string[];
}

// ─── N1: committed binding ───────────────────────────────────────────────────

describe('N1 the receipt is bound to the committed lock inputs', () => {
  test('every receipt input hashes to the committed file', () => {
    expect(receipt.inputs.map(i => i.path).sort()).toEqual(
      [
        'package.json',
        'package-lock.json',
        'ios/Podfile.lock',
        'ios/PickleSensei.xcworkspace/xcshareddata/swiftpm/Package.resolved',
      ].sort(),
    );
    for (const input of receipt.inputs) {
      expect(
        `${input.path}:${sha256(path.join(MOBILE_ROOT, input.path))}`,
      ).toBe(`${input.path}:${input.sha256}`);
    }
  });

  test('`--check` exits 0 on the committed tree and claims no current-binary clearance', () => {
    const result = run([GENERATOR, '--check']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no current-binary clearance is claimed');
  });

  test('validateReceipt reports no problem for the committed inputs (control)', () => {
    expect(validate(fixture(() => undefined))).toEqual([]);
  });
});

// ─── N2: native pods → receipt → shipped notice text ─────────────────────────

describe('N2 every pod Podfile.lock resolves is a receipt component at that version and is in the notice text', () => {
  const pods = lockedPods();

  test('Podfile.lock resolves the expected pods (evidence input)', () => {
    expect(pods.size).toBeGreaterThan(20);
    expect(pods.get('RNSentry')).toBe('8.24.0');
    expect(pods.get('RevenueCat')).toBeDefined();
    expect(pods.get('GoogleSignIn')).toBeDefined();
  });

  test('each locked pod is a `pod:` component with the locked version', () => {
    const missing: string[] = [];
    for (const [name, version] of pods) {
      const component = receipt.components.find(c => c.id === `pod:${name}`);
      if (!component || component.version !== version) {
        missing.push(`${name}@${version} -> ${component?.version ?? 'absent'}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('no `pod:` component names a pod that Podfile.lock no longer resolves', () => {
    const stale = receipt.components
      .filter(c => c.id.startsWith('pod:'))
      .filter(c => !pods.has(c.name))
      .map(c => c.id);
    expect(stale).toEqual([]);
  });

  test('every third-party pod and the prebuilt Sentry framework appear in ThirdPartyNotices.txt', () => {
    const absent: string[] = [];
    for (const name of pods.keys()) {
      if (name === 'PickleNative') continue;
      if (!notices.includes(name)) absent.push(name);
    }
    expect(absent).toEqual([]);
    expect(notices).toContain('Sentry Cocoa — 9.24.0');
    expect(notices).toContain('Component: native:Sentry');
  });
});

// ─── N3: fail-closed on tampered / missing / dropped inputs ──────────────────

describe('N3 validateReceipt fails closed on input tampering', () => {
  test('a Podfile.lock whose RNSentry version changed', () => {
    const root = fixture(r => {
      const lock = path.join(r, 'ios', 'Podfile.lock');
      fs.writeFileSync(
        lock,
        text(lock).replace('RNSentry (8.24.0)', 'RNSentry (8.25.0)'),
      );
    });
    expect(validate(root)).toEqual(
      expect.arrayContaining(['Pinned input changed: ios/Podfile.lock']),
    );
  });

  test('a package-lock.json with one byte appended (process died mid-write)', () => {
    const root = fixture(r => {
      const lock = path.join(r, 'package-lock.json');
      fs.writeFileSync(lock, `${text(lock)}\n`);
    });
    expect(validate(root)).toEqual(
      expect.arrayContaining(['Pinned input changed: package-lock.json']),
    );
  });

  test('a missing SwiftPM Package.resolved', () => {
    const root = fixture(r => {
      fs.rmSync(
        path.join(
          r,
          'ios/PickleSensei.xcworkspace/xcshareddata/swiftpm/Package.resolved',
        ),
        { recursive: true, force: true },
      );
    });
    // Fail-closed either way: a listed problem, or the validator throwing
    // before it can list one (nonzero exit, no success output).
    const result = validateRaw(root);
    const closed =
      result.status !== 0
        ? result.stderr.includes('Package.resolved') && result.stdout === ''
        : (JSON.parse(result.stdout) as string[]).includes(
            'Pinned input missing: ios/PickleSensei.xcworkspace/xcshareddata/swiftpm/Package.resolved',
          );
    expect(closed).toBe(true);
  });

  test('a receipt that silently drops Podfile.lock from its inputs', () => {
    const dropped: Receipt = {
      ...receipt,
      inputs: receipt.inputs.filter(i => i.path !== 'ios/Podfile.lock'),
    };
    expect(
      validate(
        fixture(() => undefined),
        dropped,
      ),
    ).toEqual(
      expect.arrayContaining(['Required locked input coverage changed']),
    );
  });

  test('a receipt whose Sentry component version drifts from the vendored framework', () => {
    const drifted: Receipt = {
      ...receipt,
      components: receipt.components.map(c =>
        c.id === 'native:Sentry' ? { ...c, version: '9.25.0' } : c,
      ),
    };
    expect(
      validate(
        fixture(() => undefined),
        drifted,
      ),
    ).toEqual(
      expect.arrayContaining([
        'Required native component missing/version changed: native:Sentry@9.24.0',
      ]),
    );
  });

  test('a bundled font removed from assets/fonts', () => {
    const root = fixture(r => {
      fs.rmSync(path.join(r, 'assets', 'fonts', 'Manrope_700Bold.ttf'), {
        recursive: true,
        force: true,
      });
    });
    expect(validate(root)).toEqual(
      expect.arrayContaining(['Bundled font coverage changed']),
    );
  });
});
