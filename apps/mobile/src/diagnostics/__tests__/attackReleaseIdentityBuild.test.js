// Adversarial tests for W10-03 (candidate 4675b54f): the Xcode bundle phase
// src/diagnostics/bundle-xcode.sh, the unmodified scripts/release-identity.mjs
// it runs, and Metro's treatment of the generated identity file. Every test
// asserts the behaviour the work package objective promises ("version/build/
// commit from ... the immutable candidate"); a failing test is a confirmed
// break. Nothing here writes into this checkout: the real validator runs in a
// throwaway shared sparse clone of HEAD, fake trees live under os.tmpdir().
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const {
  parseGeneratedReleaseIdentity,
  applyGeneratedReleaseIdentity,
} = require('../../config/releaseIdentity');
const { diagnosticsGate } = require('../sentry');

const mobileRoot = path.resolve(__dirname, '../../..');
const repoRoot = path.resolve(mobileRoot, '../..');
const bundlePhase = path.join(mobileRoot, 'src/diagnostics/bundle-xcode.sh');
const generatedIdentityFile = 'src/config/releaseIdentity.generated.json';
const sha = '0123456789abcdef0123456789abcdef01234567';
const dsn = `https://${'a'.repeat(32)}@o1.ingest.sentry.io/1`;
const record = {
  marketingVersion: '1.0',
  buildNumber: 1,
  bundleIdentifier: 'com.picklesensei',
  moduleName: 'PickleSensei',
  displayName: 'Pickle Sensei',
  configurations: ['Debug', 'Release'],
  gitSha: sha,
  committed: true,
  uncommitted: [],
  identityFiles: ['infra/release/release-manifest.json'],
};
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'attack',
  GIT_AUTHOR_EMAIL: 'attack@example.invalid',
  GIT_COMMITTER_NAME: 'attack',
  GIT_COMMITTER_EMAIL: 'attack@example.invalid',
};

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
}

function approvedConfig() {
  const { getRuntimePublicConfig } = require('../../config/runtimeConfig');
  return {
    ...getRuntimePublicConfig().diagnostics,
    transportEnabled: true,
    providerApproved: true,
    disclosuresApproved: true,
    nativePrivacyApproved: true,
    dsn,
    environment: 'test',
    modelVersion: 'scoring-v1',
    policyVersion: 'policy-v1',
  };
}

// A shared sparse clone of this checkout's HEAD holding exactly the files the
// real release-identity validator reads plus the diagnostics sources, so the
// real script and the real bundle phase can run against a tree we may dirty
// and commit to without touching this working tree.
function candidateClone(directory) {
  const clone = path.join(directory, 'candidate');
  const head = git(repoRoot, ['rev-parse', 'HEAD']).trim();
  git(repoRoot, ['clone', '--quiet', '--shared', '--no-checkout', '.', clone]);
  git(clone, [
    'sparse-checkout',
    'set',
    '--no-cone',
    'apps/mobile/ios',
    'apps/mobile/scripts',
    'apps/mobile/app.json',
    'apps/mobile/src/config',
    'apps/mobile/src/diagnostics',
    'infra/release',
  ]);
  git(clone, ['checkout', '--quiet', head]);
  return { clone, head, mobile: path.join(clone, 'apps/mobile') };
}

function fakeReactNative(directory, script) {
  const rn = path.join(directory, 'react native');
  fs.mkdirSync(path.join(rn, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(rn, 'scripts/react-native-xcode.sh'), script);
  return rn;
}

// The bundler stand-in prints whatever identity file it finds when it runs:
// that is exactly the record Metro would inline into main.jsbundle.
const printIdentity =
  'f="$PROJECT_DIR/../src/config/releaseIdentity.generated.json"; if [ -f "$f" ]; then cat "$f"; else echo MISSING; fi';

function phaseEnv(mobile, rn, directory, configuration, extra = {}) {
  return {
    PATH: '/usr/bin:/bin',
    NODE_BINARY: process.execPath,
    CONFIGURATION: configuration,
    REACT_NATIVE_PATH: rn,
    PROJECT_DIR: path.join(mobile, 'ios'),
    DERIVED_FILE_DIR: directory,
    ...extra,
  };
}

function runPhase(env) {
  return execFileSync('/bin/bash', [bundlePhase], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function fakeTree(directory, validator) {
  const mobile = path.join(directory, 'mobile');
  fs.mkdirSync(path.join(mobile, 'ios'), { recursive: true });
  fs.mkdirSync(path.join(mobile, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(mobile, 'src/config'), { recursive: true });
  fs.writeFileSync(
    path.join(mobile, 'scripts/release-identity.mjs'),
    validator,
  );
  return mobile;
}

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function until(predicate) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never held');
    await sleep(20);
  }
}

describe('ATTACK identity drift: the commit stamped on the bundle vs the sources bundled', () => {
  it('refuses to stamp HEAD onto a tree whose diagnostics sources differ from HEAD', () => {
    const directory = tmp('pickle-attack-drift-');
    try {
      const { mobile, head } = candidateClone(directory);
      // Uncommitted edits to the very sources Metro is about to bundle: the
      // objective's "commit" tag must identify these sources, or refuse.
      fs.appendFileSync(
        path.join(mobile, 'src/diagnostics/sentry.ts'),
        '\nexport const attackDrift = 1;\n',
      );
      fs.appendFileSync(
        path.join(mobile, 'src/config/releaseIdentity.ts'),
        '\nexport const attackDrift = 1;\n',
      );
      expect(git(mobile, ['status', '--porcelain']).trim()).not.toBe('');
      const rn = fakeReactNative(directory, printIdentity);
      const output = runPhase(phaseEnv(mobile, rn, directory, 'Release'));
      const lines = output.split('\n').slice(0, -1);
      const file = path.join(mobile, generatedIdentityFile);
      // Expected: the dirty candidate is refused, so no identity ships and the
      // gate stays blocked_identity rather than attributing this bundle to a
      // commit that does not contain it.
      expect(lines[1]).toBe(
        'Release identity: refused; diagnostics identity stays blocked.',
      );
      expect(fs.existsSync(file)).toBe(false);
      expect(lines[2]).toBe('MISSING');
      expect(output).not.toContain(head);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('ATTACK validator/runtime boundary: build numbers the release gate accepts', () => {
  it('carries a committed date-style build number the release gate accepts through to the envelope', () => {
    const directory = tmp('pickle-attack-build-');
    try {
      const { mobile, head } = candidateClone(directory);
      const dateBuild = 2026090801;
      const manifest = path.join(
        directory,
        'candidate/infra/release/release-manifest.json',
      );
      fs.writeFileSync(
        manifest,
        fs
          .readFileSync(manifest, 'utf8')
          .replace('"buildNumber": 1,', `"buildNumber": ${dateBuild},`),
      );
      const pbxproj = path.join(
        mobile,
        'ios/PickleSensei.xcodeproj/project.pbxproj',
      );
      fs.writeFileSync(
        pbxproj,
        fs
          .readFileSync(pbxproj, 'utf8')
          .replaceAll(
            'CURRENT_PROJECT_VERSION = 1;',
            `CURRENT_PROJECT_VERSION = ${dateBuild};`,
          ),
      );
      git(mobile, ['commit', '--quiet', '--all', '--message', 'build number']);
      const committed = git(mobile, ['rev-parse', 'HEAD']).trim();
      expect(committed).not.toBe(head);
      // The release gate fastlane runs before archiving accepts this identity.
      const verdict = JSON.parse(
        execFileSync(
          process.execPath,
          [
            'scripts/release-identity.mjs',
            '--check',
            '--require-committed',
            '--json',
          ],
          { cwd: mobile, encoding: 'utf8' },
        ),
      );
      expect(verdict).toMatchObject({
        buildNumber: dateBuild,
        committed: true,
        gitSha: committed,
      });
      const rn = fakeReactNative(directory, printIdentity);
      const output = runPhase(phaseEnv(mobile, rn, directory, 'Release'));
      const lines = output.split('\n').slice(0, -1);
      expect(lines[1]).toBe(
        'Release identity: committed candidate written for diagnostics.',
      );
      const generated = JSON.parse(lines[2]);
      expect(generated).toEqual({
        marketingVersion: '1.0',
        buildNumber: dateBuild,
        bundleIdentifier: 'com.picklesensei',
        gitSha: committed,
        committed: true,
      });
      // Expected: what the phase wrote for an accepted candidate is what the
      // runtime carries — otherwise every gate passes and the archive ships
      // with the identity silently refused.
      const parsed = parseGeneratedReleaseIdentity(generated);
      expect(parsed).toEqual({
        bundleIdentifier: 'com.picklesensei',
        marketingVersion: '1.0',
        nativeBuildNumber: String(dateBuild),
        sourceRevision: committed,
      });
      expect(diagnosticsGate(approvedConfig(), parsed).state).toBe(
        'ready_js_only',
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('agrees with the validator on every in-range build number and version shape', () => {
    // Validator: positive safe integer (<= Number.MAX_SAFE_INTEGER), version
    // /^\d+\.\d+(\.\d+)?$/. Runtime must not silently refuse a subset.
    const accepted = [
      { buildNumber: 99_999_999 },
      { buildNumber: 100_000_000 },
      { buildNumber: 2026090801 },
      { buildNumber: Number.MAX_SAFE_INTEGER },
      { marketingVersion: '1.12345' },
      { marketingVersion: '10000.0' },
    ];
    for (const patch of accepted) {
      const parsed = parseGeneratedReleaseIdentity({ ...record, ...patch });
      expect(parsed).not.toBeNull();
      expect(
        applyGeneratedReleaseIdentity(
          { ...approvedConfig(), marketingVersion: parsed.marketingVersion },
          parsed,
        ),
      ).not.toBeNull();
    }
  });
});

describe('ATTACK concurrency: two builds bundling from the same source tree', () => {
  it('lets the first build bundle the identity its own phase wrote while a second phase starts', async () => {
    const directory = tmp('pickle-attack-race-');
    try {
      const signals = path.join(directory, 'signals');
      fs.mkdirSync(signals);
      const validator = `import fs from 'node:fs';
const signals = ${JSON.stringify(signals)};
const gate = process.env.ATTACK_GATE;
if (gate) {
  fs.writeFileSync(\`\${signals}/\${gate}-validating\`, '');
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(\`\${signals}/\${gate}-go\`)) {
    if (Date.now() > deadline) process.exit(3);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}
process.stdout.write(\`\${JSON.stringify(${JSON.stringify(record)})}\\n\`);
`;
      const mobile = fakeTree(directory, validator);
      const rn = fakeReactNative(
        directory,
        `touch "${signals}/$ATTACK_BUNDLER-bundling"
i=0
while [ ! -f "${signals}/$ATTACK_BUNDLER-go" ] && [ "$i" -lt 500 ]; do sleep 0.02; i=$((i + 1)); done
${printIdentity}`,
      );
      const run = (name, extra) =>
        new Promise((resolve, reject) => {
          const child = spawn('/bin/bash', [bundlePhase], {
            env: phaseEnv(mobile, rn, directory, 'Release', extra),
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          child.stdout.on('data', chunk => {
            stdout += chunk;
          });
          child.on('error', reject);
          child.on('close', code => resolve({ name, code, stdout }));
        });
      // Build A (the archive): its phase writes the identity, then its bundler
      // starts reading sources.
      const a = run('a', { ATTACK_BUNDLER: 'a' });
      await until(() => fs.existsSync(path.join(signals, 'a-bundling')));
      expect(fs.existsSync(path.join(mobile, generatedIdentityFile))).toBe(
        true,
      );
      // Build B (a Debug build of the same tree, e.g. a simulator run kicked
      // off while the archive bundles) reaches its validator step.
      const b = run('b', { ATTACK_GATE: 'b', ATTACK_BUNDLER: 'b' });
      await until(() => fs.existsSync(path.join(signals, 'b-validating')));
      // Now A's bundler reads the identity file its own phase wrote.
      fs.writeFileSync(path.join(signals, 'a-go'), '');
      const resultA = await a;
      fs.writeFileSync(path.join(signals, 'b-go'), '');
      const resultB = await b;
      expect(resultA.code).toBe(0);
      expect(resultB.code).toBe(0);
      const linesA = resultA.stdout.split('\n').slice(0, -1);
      expect(linesA[1]).toBe(
        'Release identity: committed candidate written for diagnostics.',
      );
      // Expected: build A bundles the identity its phase reported as written.
      expect(linesA[2]).not.toBe('MISSING');
      expect(JSON.parse(linesA[2])).toMatchObject({
        gitSha: sha,
        committed: true,
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('ATTACK bundle phase boundaries', () => {
  it('survives hostile PROJECT_DIR characters and a temp file left by a crashed phase', () => {
    const directory = tmp('pickle-attack-paths-');
    try {
      const hostile = path.join(directory, 'we ird $(DIR) \'quoted\' "root"');
      fs.mkdirSync(hostile);
      const mobile = fakeTree(
        hostile,
        `process.stdout.write(\`\${JSON.stringify(${JSON.stringify(record)})}\\n\`);`,
      );
      const file = path.join(mobile, generatedIdentityFile);
      fs.writeFileSync(`${file}.tmp`, '{"gitSha":"partial');
      fs.writeFileSync(file, '{"gitSha":"stale"}');
      const rn = fakeReactNative(hostile, printIdentity);
      const output = runPhase(phaseEnv(mobile, rn, directory, 'Release'));
      const lines = output.split('\n').slice(0, -1);
      expect(lines[1]).toBe(
        'Release identity: committed candidate written for diagnostics.',
      );
      expect(JSON.parse(lines[2])).toEqual({
        marketingVersion: '1.0',
        buildNumber: 1,
        bundleIdentifier: 'com.picklesensei',
        gitSha: sha,
        committed: true,
      });
      expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'a warning line before the JSON (a shape fastlane tolerates)',
      `process.stdout.write('warning: something\\n' + JSON.stringify(${JSON.stringify(record)}) + '\\n');`,
    ],
    [
      'valid JSON with a refusing exit code',
      `process.stdout.write(JSON.stringify(${JSON.stringify(record)}) + '\\n'); process.exit(1);`,
    ],
    ['an empty stdout with exit 0', 'process.exit(0);'],
    ['a JSON array', "process.stdout.write('[]\\n');"],
    ['a bare null', "process.stdout.write('null\\n');"],
    [
      'a validator that hangs up mid-write',
      'process.stdout.write(\'{"marketingVersion":"1.0","buildNumber":1,\'); process.exit(0);',
    ],
  ])(
    'writes no identity and bundles blocked when the validator prints %s',
    (_title, validator) => {
      const directory = tmp('pickle-attack-output-');
      try {
        const mobile = fakeTree(directory, validator);
        const file = path.join(mobile, generatedIdentityFile);
        fs.writeFileSync(file, JSON.stringify(record));
        const rn = fakeReactNative(directory, printIdentity);
        const output = runPhase(phaseEnv(mobile, rn, directory, 'Release'));
        const lines = output.split('\n').slice(0, -1);
        expect(lines[1]).toBe(
          'Release identity: refused; diagnostics identity stays blocked.',
        );
        expect(lines[2]).toBe('MISSING');
        expect(fs.existsSync(file)).toBe(false);
        expect(fs.existsSync(`${file}.tmp`)).toBe(false);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('forwards an uncommitted verdict the validator exits 0 with, and the runtime refuses it', () => {
    const directory = tmp('pickle-attack-uncommitted-');
    try {
      const uncommitted = {
        ...record,
        committed: false,
        uncommitted: ['app.json: working tree content differs'],
      };
      const mobile = fakeTree(
        directory,
        `process.stdout.write(\`\${JSON.stringify(${JSON.stringify(uncommitted)})}\\n\`);`,
      );
      const rn = fakeReactNative(directory, printIdentity);
      const output = runPhase(phaseEnv(mobile, rn, directory, 'Release'));
      const lines = output.split('\n').slice(0, -1);
      expect(lines[1]).toBe(
        'Release identity: committed candidate written for diagnostics.',
      );
      const generated = JSON.parse(lines[2]);
      expect(generated.committed).toBe(false);
      expect(parseGeneratedReleaseIdentity(generated)).toBeNull();
      expect(diagnosticsGate(approvedConfig(), null)).toEqual({
        state: 'blocked_identity',
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('never treats a relative or empty NODE_BINARY as available off PATH', () => {
    const directory = tmp('pickle-attack-node-');
    try {
      const mobile = fakeTree(
        directory,
        `process.stdout.write(\`\${JSON.stringify(${JSON.stringify(record)})}\\n\`);`,
      );
      const file = path.join(mobile, generatedIdentityFile);
      const rn = fakeReactNative(directory, printIdentity);
      // A PATH holding only rm: no node anywhere.
      const bin = path.join(directory, 'bin');
      fs.mkdirSync(bin);
      fs.symlinkSync('/bin/rm', path.join(bin, 'rm'));
      for (const nodeBinary of ['', 'node', './node', 'missing-node']) {
        fs.writeFileSync(file, JSON.stringify(record));
        const output = runPhase({
          ...phaseEnv(mobile, rn, directory, 'Release'),
          NODE_BINARY: nodeBinary,
          PATH: bin,
        });
        const lines = output.split('\n').slice(0, -1);
        expect(lines[1]).toBe(
          'Release identity: node unavailable; diagnostics identity stays blocked.',
        );
        expect(lines[2]).toBe('MISSING');
        expect(fs.existsSync(file)).toBe(false);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('ATTACK Metro: what the bundler really inlines from the reader', () => {
  // A real Metro build of src/config/readGeneratedReleaseIdentity.js against
  // a shared clone of HEAD (so the generated file never touches this checkout),
  // run out of process because Metro cannot load inside Jest's registry.
  const directory = tmp('pickle-attack-metro-');
  let mobile;

  beforeAll(() => {
    ({ mobile } = candidateClone(directory));
  });

  afterAll(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function bundle(name, resetCache) {
    const out = path.join(directory, `${name}.bundle.js`);
    execFileSync(
      process.execPath,
      [
        '-e',
        `
        const path = require('node:path');
        const Metro = require('metro');
        (async () => {
          const base = await Metro.loadConfig({ cwd: process.cwd(), config: path.resolve('metro.config.js') });
          const config = { ...base, maxWorkers: 1, watchFolders: [...base.watchFolders, ${JSON.stringify(mobile)}], resetCache: ${resetCache} };
          await Metro.runBuild(config, {
            entry: ${JSON.stringify(path.join(mobile, 'src/config/readGeneratedReleaseIdentity.js'))},
            platform: 'ios',
            dev: false,
            minify: false,
            out: ${JSON.stringify(out)},
            sourceMap: false,
          });
        })().catch(error => { console.error(error); process.exit(1); });
        `,
      ],
      {
        cwd: mobileRoot,
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'production' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return fs.readFileSync(out, 'utf8');
  }

  it('inlines a null dependency when no build wrote the file, and the reader returns null', () => {
    const code = bundle('without', true);
    expect(code).not.toContain('marketingVersion');
    expect(code).toContain('},0,[null]);');
    expect(code).toContain('return require(_dependencyMap[0]);');
    // The bundle must not leak the build machine's path to the missing file.
    expect(code).not.toContain(mobile);
    expect(code).not.toContain(mobileRoot);
  });

  it('inlines the record the phase wrote on the next build without a cache reset', () => {
    fs.writeFileSync(
      path.join(mobile, generatedIdentityFile),
      `${JSON.stringify({
        marketingVersion: '1.0',
        buildNumber: 1,
        bundleIdentifier: 'com.picklesensei',
        gitSha: sha,
        committed: true,
      })}\n`,
    );
    const code = bundle('with', false);
    expect(code).toContain(`"gitSha":"${sha}"`);
    expect(code).toContain('"committed":true');
    expect(code).not.toContain('},0,[null]);');
    expect(code).not.toContain(mobile);
  });

  it('does not replay the previous build’s identity after the phase removed the file', () => {
    fs.rmSync(path.join(mobile, generatedIdentityFile));
    const code = bundle('removed', false);
    expect(code).not.toContain(sha);
    expect(code).toContain('},0,[null]);');
  });
});
