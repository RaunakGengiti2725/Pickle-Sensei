/**
 * P0-01 adversarial attacks (candidate f010c464: lazy `transform` /
 * `getCacheKey` getters in scripts/metro-asset-transformer.cjs).
 *
 * Every attack runs in a fresh Node child with the app's cwd so nothing here
 * depends on Jest's module registry, exactly like the candidate's own probes.
 * "Base-equivalent" below means `transformerPath = require.resolve(
 * 'metro-transform-worker')`: on BASE_SHA the guard did
 * `module.exports = require('metro-transform-worker')`, so the base wrapper
 * and the upstream module were the same object.
 *
 *   A1 real Metro worker (`metro/private/DeltaBundler/Worker`) JS/JSON/asset
 *      transform parity, dev and minified profiles, through the getter.
 *   A2 real `getTransformCacheKey` determinism across processes + cache
 *      separation between the candidate wrapper and the base-equivalent path.
 *   A3 CommonJS/ESM module-shape parity (keys, descriptors, spread, `in`,
 *      identity across getter accesses, named ESM exports).
 *   A4 failure boundary: an unloadable `metro-transform-worker` no longer
 *      breaks config load — it surfaces at the first worker transform, and
 *      recovers once the module is loadable again (no poisoned state).
 *   A5 module budget: which probes of the ICNS suite still load the full
 *      toolchain inside the 5 s / 192 MB guard the package was about.
 *   A6 real `Metro.runBuild` end to end (in-process AND jest-worker farm)
 *      with the candidate wrapper vs base-equivalent: identical bundle bytes,
 *      and a disguised ICNS asset is refused in both execution modes.
 */

// Module scope, so the `require` declaration below stays local to this file.
export {};

// Node built-ins, typed the same way be-mobile-security-secrets.test.ts does
// (the RN tsconfig ships no node types).
declare const require: (id: string) => unknown;
declare const __dirname: string;
const fs = require('fs') as {
  mkdtempSync: (prefix: string) => string;
  mkdirSync: (p: string, options: { recursive: true }) => void;
  writeFileSync: (p: string, data: string) => void;
  rmSync: (p: string, options: { recursive: true; force: true }) => void;
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
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
      stdio: ['pipe', 'pipe', 'pipe'];
    },
  ) => {
    status: number | null;
    signal: string | null;
    error?: { code?: string };
    stdout: string;
    stderr: string;
  };
};
const { execPath } = require('node:process') as { execPath: string };

const MOBILE_ROOT = path.resolve(__dirname, '..', '..');
const GUARD_TIMEOUT_MS = 5000;
const GUARD_HEAP_MB = 192;
const OUTPUT_CAP = 1024 * 1024;
// Bounded real-build budget; distinct from the candidate's 5 s config guard,
// which this file never relaxes (A1–A5 keep 5 s / 192 MB).
const BUILD_TIMEOUT_MS = 25000;

interface ProbeOptions {
  timeout?: number;
  heapMb?: number | null;
  esm?: boolean;
  // Run from a file instead of `-e`: `node -e` leaves `-e <source>` in
  // process.execArgv, which jest-worker forwards to every forked worker.
  asFile?: boolean;
}

// Scratch dir inside node_modules so file probes resolve the app's packages
// exactly like scripts/metro-asset-transformer.cjs does (gitignored).
const SCRATCH_DIR = path.join(
  MOBILE_ROOT,
  'node_modules',
  `.p0-01-attack-${(require('node:process') as { pid: number }).pid}`,
);
let scratchFiles = 0;
beforeAll(() => fs.mkdirSync(SCRATCH_DIR, { recursive: true }));
afterAll(() => fs.rmSync(SCRATCH_DIR, { recursive: true, force: true }));

function probe(
  source: string,
  args: string[] = [],
  options: ProbeOptions = {},
) {
  const nodeArgs: string[] = [];
  if (options.heapMb !== null) {
    nodeArgs.push(`--max-old-space-size=${options.heapMb ?? GUARD_HEAP_MB}`);
  }
  if (options.esm) nodeArgs.push('--input-type=module');
  let entry = ['-e', source];
  if (options.asFile) {
    const file = path.join(SCRATCH_DIR, `probe-${scratchFiles++}.cjs`);
    // Keep `-e` argv semantics: process.argv[1] is the first probe argument.
    fs.writeFileSync(file, `process.argv.splice(1, 1);\n${source}`);
    entry = [file];
  }
  return childProcess.spawnSync(execPath, [...nodeArgs, ...entry, ...args], {
    cwd: MOBILE_ROOT,
    encoding: 'utf8',
    timeout: options.timeout ?? GUARD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: OUTPUT_CAP,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function ok(result: ReturnType<typeof probe>): string {
  expect({
    status: result.status,
    signal: result.signal,
    error: result.error?.code,
    stderr: result.stderr,
  }).toEqual({ status: 0, signal: null, error: undefined, stderr: '' });
  return result.stdout.trim();
}

function lastJsonLine<T>(stdout: string): T {
  const lines = stdout.split('\n').filter(line => line.trim() !== '');
  return JSON.parse(lines[lines.length - 1]!) as T;
}

const ICNS_HEX = '69636e73000000106963703100000000';

// Runs the REAL Metro worker entry (the module jest-worker loads in every
// transform child) against a transformerPath. `Worker.transform` calls
// `Transformer.transform(...)` as a method on whatever the path exports, so
// this also exercises the getter under Metro's own `this`.
const workerParityProbe = `
  const config = require('./metro.config.js');
  const { transform } = require('metro/private/DeltaBundler/Worker');
  const files = JSON.parse(process.argv[1]);
  const variants = JSON.parse(process.argv[2]);
  const paths = {
    wrapped: config.transformerPath,
    upstream: require.resolve('metro-transform-worker'),
  };
  (async () => {
    const out = {};
    for (const [label, transformerPath] of Object.entries(paths)) {
      out[label] = [];
      for (const file of files) {
        for (const variant of variants) {
          const value = await transform(
            file,
            {
              type: /\\.(png|ttf|mp4)$/.test(file) ? 'asset' : 'module',
              platform: 'ios',
              inlineRequires: false,
              experimentalImportSupport: false,
              unstable_transformProfile: 'hermes-stable',
              ...variant,
            },
            config.projectRoot,
            { transformerPath, transformerConfig: config.transformer },
          );
          out[label].push({ file, variant, sha1: value.sha1, result: value.result });
        }
      }
    }
    console.log(JSON.stringify(out));
  })().catch(error => { console.error(error); process.exitCode = 1; });
`;

describe('P0-01 attack: lazy metro-transform-worker guard (f010c464)', () => {
  it('A1 real Metro worker transform output is byte-identical through the wrapper for JS, JSON and asset modules (dev + minified)', () => {
    const files = [
      'src/analysis/stabilityTelemetry.ts',
      'app.json',
      'assets/brand/pickle-mark.png',
    ].map(file => path.join(MOBILE_ROOT, file));
    const variants = [
      { dev: true, minify: false },
      { dev: false, minify: true },
    ];
    const out = JSON.parse(
      ok(
        probe(
          workerParityProbe,
          [JSON.stringify(files), JSON.stringify(variants)],
          { timeout: BUILD_TIMEOUT_MS, heapMb: null },
        ),
      ),
    ) as Record<
      'wrapped' | 'upstream',
      {
        file: string;
        variant: { dev: boolean; minify: boolean };
        sha1: string;
        result: { output: { type: string; data: { code: string } }[] };
      }[]
    >;
    expect(out.wrapped).toHaveLength(files.length * variants.length);
    expect(out.wrapped).toEqual(out.upstream);
    const byType = new Map(
      out.wrapped.map(entry => [entry.file, entry.result.output[0]!.type]),
    );
    expect(byType.get(files[0]!)).toBe('js/module');
    expect(byType.get(files[1]!)).toBe('js/module');
    expect(byType.get(files[2]!)).toBe('js/module/asset');
    for (const entry of out.wrapped) {
      expect(entry.sha1).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.result.output[0]!.data.code.length).toBeGreaterThan(0);
    }
    const minified = out.wrapped.filter(entry => entry.variant.minify);
    const dev = out.wrapped.filter(entry => !entry.variant.minify);
    expect(minified.map(e => e.result.output[0]!.data.code)).not.toEqual(
      dev.map(e => e.result.output[0]!.data.code),
    );
  });

  it('A2 real getTransformCacheKey is deterministic across fresh processes through the getter and does not collide with the base-equivalent path', () => {
    const cacheKeyProbe = `
      const assert = require('node:assert/strict');
      const config = require('./metro.config.js');
      const getTransformCacheKey = require('metro/private/DeltaBundler/getTransformCacheKey').default;
      const loaded = id => require.cache[require.resolve(id)] !== undefined;
      assert.equal(loaded('metro-transform-worker'), false);
      const keyFor = transformerPath => getTransformCacheKey({
        cacheVersion: config.cacheVersion,
        projectRoot: config.projectRoot,
        transformerConfig: { transformerPath, transformerConfig: config.transformer },
      });
      const wrapped = keyFor(config.transformerPath);
      assert.equal(loaded('metro-transform-worker'), true);
      const wrappedAgain = keyFor(config.transformerPath);
      const upstream = keyFor(require.resolve('metro-transform-worker'));
      const guard = require(config.transformerPath);
      const worker = require('metro-transform-worker');
      const opts = { projectRoot: config.projectRoot };
      console.log(JSON.stringify({
        wrapped,
        wrappedAgain,
        upstream,
        innerKeyEqual:
          guard.getCacheKey(config.transformer, opts) === worker.getCacheKey(config.transformer, opts),
        innerKeyStable:
          guard.getCacheKey(config.transformer, opts) === guard.getCacheKey(config.transformer, opts),
      }));
    `;
    type Keys = {
      wrapped: string;
      wrappedAgain: string;
      upstream: string;
      innerKeyEqual: boolean;
      innerKeyStable: boolean;
    };
    const first = JSON.parse(ok(probe(cacheKeyProbe))) as Keys;
    const second = JSON.parse(ok(probe(cacheKeyProbe))) as Keys;
    expect(first.wrapped).toMatch(/^[0-9a-f]{40}$/);
    expect(first.wrappedAgain).toBe(first.wrapped);
    expect(second.wrapped).toBe(first.wrapped);
    expect(first.innerKeyEqual).toBe(true);
    expect(first.innerKeyStable).toBe(true);
    // Metro hashes require.resolve(transformerPath) itself into the key, so a
    // wrapper change invalidates cache entries written by the previous wrapper.
    expect(first.upstream).not.toBe(first.wrapped);
    expect(second.upstream).toBe(first.upstream);
  });

  it('A3 CommonJS shape stays usable the way Metro consumes it; getter descriptors and ESM named exports are the observable differences', () => {
    const shapeProbe = `
      const config = require('./metro.config.js');
      const wrapped = require(config.transformerPath);
      const describe = value => ({
        keys: Object.keys(value).sort(),
        ownNames: Object.getOwnPropertyNames(value).sort(),
        descriptors: Object.fromEntries(
          Object.getOwnPropertyNames(value).sort().map(name => {
            const d = Object.getOwnPropertyDescriptor(value, name);
            return [name, {
              kind: d.get ? 'getter' : typeof d.value,
              enumerable: d.enumerable,
              configurable: d.configurable,
              writable: d.writable ?? null,
            }];
          }),
        ),
        spreadKeys: Object.keys({ ...value }).sort(),
        hasTransform: 'transform' in value,
        hasGetCacheKey: 'getCacheKey' in value,
        esModuleFlag: value.__esModule ?? null,
        frozen: Object.isFrozen(value),
        prototype: Object.getPrototypeOf(value) === Object.prototype,
      });
      const before = describe(wrapped);
      const { transform, getCacheKey } = wrapped;
      const upstream = require('metro-transform-worker');
      const strictAssign = () => {
        'use strict';
        try { wrapped.transform = () => {}; return null; } catch (error) { return error.name; }
      };
      console.log(JSON.stringify({
        before,
        after: describe(wrapped),
        upstream: describe(upstream),
        strictAssign: strictAssign(),
        assignLeaked: upstream.transform !== transform,
        identity: {
          sameObject: wrapped === upstream,
          transformStable: transform === wrapped.transform && wrapped.transform === wrapped.transform,
          getCacheKeyStable: getCacheKey === wrapped.getCacheKey,
          transformIsUpstream: transform === upstream.transform,
          getCacheKeyIsUpstream: getCacheKey === upstream.getCacheKey,
          transformIsAsync: transform.constructor.name,
        },
      }));
    `;
    type Shape = {
      keys: string[];
      ownNames: string[];
      descriptors: Record<
        string,
        {
          kind: string;
          enumerable: boolean;
          configurable: boolean;
          writable: boolean | null;
        }
      >;
      spreadKeys: string[];
      hasTransform: boolean;
      hasGetCacheKey: boolean;
      esModuleFlag: boolean | null;
      frozen: boolean;
      prototype: boolean;
    };
    const out = JSON.parse(ok(probe(shapeProbe))) as {
      before: Shape;
      after: Shape;
      upstream: Shape;
      strictAssign: string | null;
      assignLeaked: boolean;
      identity: Record<string, boolean | string>;
    };
    // Functional parity for every access pattern Metro and jest-worker use.
    expect(out.before.keys).toEqual(['getCacheKey', 'transform']);
    expect(out.before.keys).toEqual(out.upstream.keys);
    expect(out.before.spreadKeys).toEqual(out.upstream.spreadKeys);
    expect(out.before.hasTransform && out.before.hasGetCacheKey).toBe(true);
    expect(out.after).toEqual(out.before);
    expect(out.identity).toEqual({
      sameObject: false,
      transformStable: true,
      getCacheKeyStable: true,
      transformIsUpstream: true,
      getCacheKeyIsUpstream: true,
      transformIsAsync: 'AsyncFunction',
    });
    // Observed differences vs the base-equivalent (upstream) module object.
    expect(out.before.descriptors.transform!.kind).toBe('getter');
    expect(out.upstream.descriptors.transform!.kind).toBe('function');
    expect(out.before.esModuleFlag).toBeNull();
    expect(out.upstream.esModuleFlag).toBe(true);
    // Base shared the upstream object, so a strict-mode reassignment of
    // `transform` used to succeed and leak into every consumer of the upstream
    // module; the getter-only wrapper rejects it and the upstream stays intact.
    expect(out.strictAssign).toBe('TypeError');
    expect(out.assignLeaked).toBe(false);

    // ESM interop: Node's cjs-module-lexer follows `module.exports =
    // require(...)` (base) but cannot see getter-object members (candidate).
    const esmProbe = `
      const { pathToFileURL } = await import('node:url');
      const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
      const wrapperUrl = pathToFileURL(process.cwd() + '/scripts/metro-asset-transformer.cjs').href;
      const baseDir = process.cwd() + '/node_modules/.p0-01-attack-' + process.pid;
      mkdirSync(baseDir, { recursive: true });
      writeFileSync(baseDir + '/base.cjs', "module.exports = require('metro-transform-worker');\\n");
      const baseUrl = pathToFileURL(baseDir + '/base.cjs').href;
      const named = async url => {
        try {
          const ns = await import('data:text/javascript,import { transform, getCacheKey } from ' + JSON.stringify(url) + '; export const kinds = [typeof transform, typeof getCacheKey];');
          return { ok: true, kinds: ns.kinds };
        } catch (error) {
          return { ok: false, name: error.name, message: error.message.split('\\n')[0] };
        }
      };
      try {
        const wrapped = await import(wrapperUrl);
        const base = await import(baseUrl);
        console.log(JSON.stringify({
          wrappedNamespaceKeys: Object.keys(wrapped).sort(),
          baseNamespaceKeys: Object.keys(base).sort(),
          wrappedDefaultTransform: typeof wrapped.default.transform,
          wrappedNamed: await named(wrapperUrl),
          baseNamed: await named(baseUrl),
        }));
      } finally {
        rmSync(baseDir, { recursive: true, force: true });
      }
    `;
    const esm = JSON.parse(ok(probe(esmProbe, [], { esm: true }))) as {
      wrappedNamespaceKeys: string[];
      baseNamespaceKeys: string[];
      wrappedDefaultTransform: string;
      wrappedNamed: { ok: boolean; name?: string; message?: string };
      baseNamed: { ok: boolean; kinds?: string[] };
    };
    expect(esm.wrappedDefaultTransform).toBe('function');
    expect(esm.baseNamed).toEqual({
      ok: true,
      kinds: ['function', 'function'],
    });
    expect(esm.baseNamespaceKeys).toEqual(
      expect.arrayContaining(['getCacheKey', 'transform']),
    );
    // BREAK (P3): named ESM imports that resolved on the base wrapper are a
    // SyntaxError on the candidate wrapper. No in-repo consumer imports the
    // guard as ESM (Metro requires it), so functional impact is nil today.
    expect(esm.wrappedNamespaceKeys).toEqual(['default', 'module.exports']);
    expect(esm.wrappedNamed.ok).toBe(false);
    expect(esm.wrappedNamed.name).toBe('SyntaxError');
    expect(esm.wrappedNamed.message).toMatch(
      /Named export '(transform|getCacheKey)' not found/,
    );
  });

  it('A4 an unloadable metro-transform-worker no longer fails config load; it surfaces at the first worker transform and recovers once loadable', () => {
    const out = JSON.parse(
      ok(
        probe(
          `
          const assert = require('node:assert/strict');
          const Module = require('node:module');
          const originalLoad = Module._load;
          let blocked = true;
          Module._load = function (request) {
            if (blocked && request === 'metro-transform-worker') {
              const error = new Error("Cannot find module 'metro-transform-worker' (attack: simulated broken install)");
              error.code = 'MODULE_NOT_FOUND';
              throw error;
            }
            return originalLoad.apply(this, arguments);
          };
          const config = require('./metro.config.js');
          const loaded = id => require.cache[require.resolve(id)] !== undefined;
          assert.equal(loaded('metro-transform-worker'), false);
          const { getAssetSize } = require('metro/private/Assets');
          assert.throws(
            () => getAssetSize('png', Buffer.from(process.argv[1], 'hex'), 'disguised.png'),
            { name: 'TypeError', message: 'disabled file type: icns' },
          );
          const guard = require(config.transformerPath);
          const readGetter = name => {
            try { guard[name]; return null; } catch (error) { return error.code; }
          };
          const { transform } = require('metro/private/DeltaBundler/Worker');
          const file = require('node:path').join(config.projectRoot, 'app.json');
          const run = () => transform(
            file,
            { type: 'module', platform: 'ios', dev: true, minify: false, inlineRequires: false, experimentalImportSupport: false, unstable_transformProfile: 'hermes-stable' },
            config.projectRoot,
            { transformerPath: config.transformerPath, transformerConfig: config.transformer },
          );
          (async () => {
            const getterCodes = [readGetter('transform'), readGetter('getCacheKey')];
            let firstTransform = null;
            try { await run(); } catch (error) { firstTransform = { code: error.code, message: error.message }; }
            const stillUnloaded = !loaded('metro-transform-worker');
            blocked = false;
            const recovered = await run();
            console.log(JSON.stringify({
              getterCodes,
              firstTransform,
              stillUnloaded,
              recoveredType: recovered.result.output[0].type,
              recoveredHasCode: recovered.result.output[0].data.code.length > 0,
              loadedAfter: loaded('metro-transform-worker'),
            }));
          })().catch(error => { console.error(error); process.exitCode = 1; });
        `,
          [ICNS_HEX],
        ),
      ),
    ) as {
      getterCodes: (string | null)[];
      firstTransform: { code: string; message: string } | null;
      stillUnloaded: boolean;
      recoveredType: string;
      recoveredHasCode: boolean;
      loadedAfter: boolean;
    };
    expect(out.getterCodes).toEqual(['MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']);
    expect(out.firstTransform).toEqual({
      code: 'MODULE_NOT_FOUND',
      message: expect.stringContaining('metro-transform-worker'),
    });
    expect(out.stillUnloaded).toBe(true);
    expect(out.recoveredType).toBe('js/module');
    expect(out.recoveredHasCode).toBe(true);
    expect(out.loadedAfter).toBe(true);
  });

  it('A5 the ICNS suite still runs two probes that load the whole worker toolchain inside the same 5 s / 192 MB guard (module superset of the base defect)', () => {
    // Workloads, each measured in its own fresh child under the guard:
    //   config  — what the `rejects detected $type bytes` probes now load;
    //   base    — the base defect (config + eager metro-transform-worker);
    //   worker  — what `disables only the affected decoders…` and the
    //             candidate's new regression probe load (config + wrapper
    //             getters + upstream + getCacheKey).
    const workloads = {
      config: `require('./metro.config.js');`,
      base: `require('./metro.config.js'); require('metro-transform-worker');`,
      worker: `
        const config = require('./metro.config.js');
        const wrapped = require(config.transformerPath);
        const upstream = require('metro-transform-worker');
        if (wrapped.transform !== upstream.transform) throw new Error('parity');
        wrapped.getCacheKey(config.transformer, { projectRoot: config.projectRoot });
      `,
    };
    // Module graphs only — CPU/wall timings are host-dependent and belong in
    // the contention artifact, not in a pass/fail assertion.
    type Measure = { modules: string[] };
    const measure = (body: string): Measure =>
      JSON.parse(
        ok(
          probe(`
            ${body}
            console.log(JSON.stringify({ modules: Object.keys(require.cache) }));
          `),
        ),
      ) as Measure;
    const measured = Object.fromEntries(
      Object.entries(workloads).map(([label, body]) => [label, measure(body)]),
    ) as Record<keyof typeof workloads, Measure>;
    const toolchain = (files: string[]) =>
      files.filter(file =>
        /[\\/]node_modules[\\/](metro-transform-worker|metro-minify-terser|@babel[\\/]core)[\\/]/.test(
          file,
        ),
      );
    // The fix holds for the config-only probes…
    expect(toolchain(measured.config.modules)).toEqual([]);
    expect(measured.config.modules.length).toBeLessThan(
      measured.base.modules.length,
    );
    // …but the worker-loading probes load a strict superset of the base
    // defect's module graph, inside the identical 5 s / 192 MB guard, so the
    // CPU-starvation mechanism that killed base still kills those two probes.
    const workerSet = new Set(measured.worker.modules);
    expect(measured.base.modules.every(file => workerSet.has(file))).toBe(true);
    expect(measured.worker.modules.length).toBeGreaterThan(
      measured.base.modules.length,
    );
    expect(toolchain(measured.worker.modules).length).toBeGreaterThan(0);
  });

  const runBuildProbe = `
    const path = require('node:path');
    const fs = require('node:fs');
    const os = require('node:os');
    const Metro = require('metro');
    const { mergeConfig } = require('metro-config');
    const [scenario, maxWorkers] = [process.argv[1], Number(process.argv[2])];
    (async () => {
      const appConfig = await Metro.loadConfig({ cwd: process.cwd(), config: path.join(process.cwd(), 'metro.config.js') });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-p0-01-attack-'));
      try {
        const png = scenario === 'icns'
          ? (fs.writeFileSync(path.join(dir, 'disguised.png'), Buffer.from(process.argv[3], 'hex')), path.join(dir, 'disguised.png'))
          : path.join(process.cwd(), 'assets/brand/pickle-mark.png');
        const entry = path.join(dir, 'entry.js');
        fs.writeFileSync(entry,
          'const icon = require(' + JSON.stringify(png) + ');\\n' +
          'const { stabilitySlo } = require(' + JSON.stringify(path.join(process.cwd(), 'src/analysis/stabilityTelemetry')) + ');\\n' +
          'module.exports = { icon, stabilitySlo };\\n');
        const config = mergeConfig(appConfig, {
          maxWorkers,
          cacheStores: [],
          resetCache: true,
          reporter: { update() {} },
          watchFolders: [...appConfig.watchFolders, dir],
          serializer: { getModulesRunBeforeMainModule: () => [], getPolyfills: () => [] },
          ...(scenario === 'upstream' ? { transformerPath: require.resolve('metro-transform-worker') } : {}),
        });
        const out = path.join(dir, 'out.js');
        let failure = null;
        try {
          await Metro.runBuild(config, { entry, out, platform: 'ios', dev: false, minify: true, sourceMap: false });
        } catch (error) {
          failure = { name: error.name, message: String(error.message).split('\\n')[0] };
        }
        const code = failure ? null : fs.readFileSync(out, 'utf8');
        console.log(JSON.stringify({
          scenario,
          maxWorkers,
          failure,
          sha1: code === null ? null : require('node:crypto').createHash('sha1').update(code).digest('hex'),
          bytes: code === null ? null : code.length,
          registersAsset: code === null ? null : code.includes('registerAsset'),
          hasTelemetry: code === null ? null : code.includes('stabilitySlo'),
          workerLoadedInMain: require.cache[require.resolve('metro-transform-worker')] !== undefined,
        }));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  type BuildResult = {
    scenario: string;
    maxWorkers: number;
    failure: { name: string; message: string } | null;
    sha1: string | null;
    bytes: number | null;
    registersAsset: boolean | null;
    hasTelemetry: boolean | null;
    workerLoadedInMain: boolean;
  };
  const runBuild = (scenario: string, maxWorkers: number): BuildResult =>
    lastJsonLine<BuildResult>(
      ok(
        probe(runBuildProbe, [scenario, String(maxWorkers), ICNS_HEX], {
          timeout: BUILD_TIMEOUT_MS,
          heapMb: null,
          asFile: true,
        }),
      ),
    );

  it('A6a real Metro.runBuild in-process (maxWorkers=1) produces identical bundle bytes with the wrapper and the base-equivalent path', () => {
    const wrapped = runBuild('wrapped', 1);
    const upstream = runBuild('upstream', 1);
    expect(wrapped.failure).toBeNull();
    expect(wrapped.registersAsset).toBe(true);
    expect(wrapped.hasTelemetry).toBe(true);
    expect(wrapped.bytes).toBeGreaterThan(0);
    expect(wrapped.sha1).toBe(upstream.sha1);
    expect(wrapped.workerLoadedInMain).toBe(true);
  });

  it('A6b real Metro.runBuild through the jest-worker farm (maxWorkers=2) matches the in-process bundle and never loads the worker toolchain in the main process', () => {
    const farm = runBuild('wrapped', 2);
    const inProcess = runBuild('wrapped', 1);
    expect(farm.failure).toBeNull();
    expect(farm.sha1).toBe(inProcess.sha1);
    expect(farm.workerLoadedInMain).toBe(false);
    expect(inProcess.workerLoadedInMain).toBe(true);
  });

  it('A6c a disguised ICNS asset fails the real build in both execution modes with the guard error, not a hang', () => {
    for (const maxWorkers of [1, 2]) {
      const result = runBuild('icns', maxWorkers);
      expect(result.sha1).toBeNull();
      expect(result.failure).toEqual({
        name: expect.any(String),
        message: expect.stringContaining('disabled file type: icns'),
      });
    }
  });
});
