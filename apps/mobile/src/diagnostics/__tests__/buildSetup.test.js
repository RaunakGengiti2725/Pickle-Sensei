const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const mobileRoot = path.resolve(__dirname, '../../..');
const root = path.resolve(mobileRoot, '../..');
const debugId = '11111111-2222-4333-8444-555555555555';

function maps() {
  return [
    {
      version: 3,
      file: 'main.jsbundle',
      sources: ['src/fixture.ts'],
      sourcesContent: ['throw new Error();'],
      names: [],
      mappings: 'AAAA',
      debug_id: debugId,
      debugId,
    },
    {
      version: 3,
      file: 'main.jsbundle',
      sources: ['main.jsbundle'],
      names: [],
      mappings: 'AAAA',
      x_hermes_function_offsets: { 0: [0] },
    },
  ];
}

describe('Metro composition without collection or automatic configuration', () => {
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '-e',
        `
    const path = require('node:path');
    const sentry = require('@sentry/react-native/metro');
    const original = sentry.withSentryConfig;
    let integrationOptions;
    sentry.withSentryConfig = (config, options) => {
      integrationOptions = options;
      return original(config, options);
    };
    const config = require('./metro.config');
    const delegated = [];
    const context = {
      originModulePath: path.resolve('../../packages/scoring/src/index.ts'),
      resolveRequest: (_context, name, platform) => {
        delegated.push([name, platform]);
        return { type: 'empty' };
      },
    };
    const names = ['shared-types', 'scoring', 'audio-coach-core', 'vision-contracts', 'swing-domain', 'model-registry', 'evaluation', 'vision-geometry', 'analysis-pipeline', 'capture-envelope'];
    const aliases = Object.fromEntries(names.map(name => [name, config.resolver.resolveRequest(context, '@pickle/' + name, 'ios')]));
    const sharedImport = config.resolver.resolveRequest(context, './engine.js', 'ios');
    config.resolver.resolveRequest(context, 'react', 'ios');
    const excluded = ['@sentry/replay', '@sentry/feedback'].map(name => config.resolver.resolveRequest(context, name, 'ios'));
    process.stdout.write(JSON.stringify({
      integrationOptions,
      serializer: typeof config.serializer.customSerializer,
      watchFolders: config.watchFolders,
      nodeModulesPaths: config.resolver.nodeModulesPaths,
      aliases,
      sharedImport,
      delegated,
      excluded,
    }));
  `,
      ],
      { cwd: mobileRoot, encoding: 'utf8', env: { NODE_ENV: 'test' } },
    ),
  );

  it('adds the debug-ID serializer without options-file loading, replay, feedback or component annotations', () => {
    expect(result.integrationOptions).toEqual({
      annotateReactComponents: false,
      includeWebReplay: false,
      includeWebFeedback: false,
      enableSourceContextInDevelopment: false,
      optionsFile: false,
      autoWrapExpoRouterErrorBoundary: false,
    });
    expect(result.serializer).toBe('function');
    expect(result.watchFolders).toContain(path.join(root, 'packages'));
    expect(result.nodeModulesPaths).toEqual([
      path.join(mobileRoot, 'node_modules'),
      path.join(root, 'node_modules'),
    ]);
  });

  it('preserves every workspace alias and the RN-safe capture envelope entry', () => {
    for (const [name, resolution] of Object.entries(result.aliases)) {
      expect(resolution).toEqual({
        type: 'sourceFile',
        filePath: path.join(
          root,
          `packages/${name}/src/${name === 'capture-envelope' ? 'core' : 'index'}.ts`,
        ),
      });
    }
    expect(Object.keys(result.aliases)).toHaveLength(10);
  });

  it('retains shared .js to .ts resolution and delegates unrelated imports', () => {
    expect(result.sharedImport).toEqual({
      type: 'sourceFile',
      filePath: path.join(root, 'packages/scoring/src/engine.ts'),
    });
    expect(result.delegated).toEqual([['react', 'ios']]);
    expect(result.excluded).toEqual([{ type: 'empty' }, { type: 'empty' }]);
  });
});

function composeLocally(metro, hermes) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pickle-diagnostics-maps-'),
  );
  try {
    const input = path.join(directory, 'metro map.json');
    const compiler = path.join(directory, 'hermes map.json');
    const output = path.join(directory, 'main.jsbundle.map');
    fs.writeFileSync(input, JSON.stringify(metro));
    fs.writeFileSync(compiler, JSON.stringify(hermes));
    execFileSync(
      process.execPath,
      [
        path.join(mobileRoot, 'src/diagnostics/composeSourceMaps.cjs'),
        input,
        compiler,
        '-o',
        output,
      ],
      {
        env: { NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return JSON.parse(fs.readFileSync(output, 'utf8'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe('matching local Hermes maps, with no uploads', () => {
  it('composes the Metro and Hermes mappings while preserving the injected debug ID', () => {
    const [metro, hermes] = maps();
    const result = composeLocally(metro, hermes);
    expect(result).toMatchObject({
      version: 3,
      debug_id: debugId,
      debugId,
      sources: ['src/fixture.ts'],
      sourcesContent: ['throw new Error();'],
      x_hermes_function_offsets: { 0: [0] },
    });
    expect(result.mappings).toBe('AAAA');
  });

  it('fails closed for absent or inconsistent debug IDs and unsupported maps', () => {
    const [metro, hermes] = maps();
    for (const patch of [
      { debug_id: undefined, debugId: undefined },
      { debug_id: 'SENSITIVE_FIXTURE_DO_NOT_TRANSMIT' },
      { debug_id: '22222222-2222-4333-8444-555555555555' },
      { x_facebook_offsets: [] },
    ]) {
      expect(() => composeLocally({ ...metro, ...patch }, hermes)).toThrow();
    }
    expect(() =>
      composeLocally(metro, { ...hermes, x_facebook_segments: [] }),
    ).toThrow();
  });

  it.each(['Release', 'Debug'])(
    'runs only the local RN bundler and overrides inherited upload intent (%s)',
    configuration => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'pickle-diagnostics-build-'),
      );
      try {
        const rn = path.join(directory, 'react native');
        fs.mkdirSync(path.join(rn, 'scripts'), { recursive: true });
        fs.writeFileSync(
          path.join(rn, 'scripts/react-native-xcode.sh'),
          'printf "%s\\n" "$SENTRY_DISABLE_AUTO_UPLOAD" "$SENTRY_DISABLE_XCODE_DEBUG_UPLOAD" "$SOURCEMAP_FILE" "$COMPOSE_SOURCEMAP_PATH"',
        );
        const output = execFileSync(
          '/bin/bash',
          [path.join(mobileRoot, 'src/diagnostics/bundle-xcode.sh')],
          {
            env: {
              PATH: '/usr/bin:/bin',
              CONFIGURATION: configuration,
              REACT_NATIVE_PATH: rn,
              PROJECT_DIR: path.join(mobileRoot, 'ios'),
              DERIVED_FILE_DIR: directory,
              SENTRY_DISABLE_AUTO_UPLOAD: 'false',
              SENTRY_DISABLE_XCODE_DEBUG_UPLOAD: 'false',
            },
            encoding: 'utf8',
          },
        );
        expect(output.split('\n').slice(0, -1)).toEqual(
          configuration === 'Debug'
            ? [
                'Sentry uploads blocked: Debug bundling unchanged.',
                'true',
                'true',
                '',
                '',
              ]
            : [
                'Sentry uploads blocked: preparing local source maps only.',
                'true',
                'true',
                path.join(directory, 'main.jsbundle.map'),
                `${mobileRoot}/ios/../src/diagnostics/composeSourceMaps.cjs`,
              ],
        );
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('keeps the Xcode Sentry phases local and does not wire SDK upload scripts', () => {
    const project = fs.readFileSync(
      path.join(mobileRoot, 'ios/PickleSensei.xcodeproj/project.pbxproj'),
      'utf8',
    );
    expect(project).toContain('src/diagnostics/bundle-xcode.sh');
    expect(project).toContain('Sentry symbols (upload blocked)');
    expect(project).toContain('SENTRY_DISABLE_AUTO_UPLOAD=true');
    expect(project).toContain('SENTRY_DISABLE_XCODE_DEBUG_UPLOAD=true');
    expect(project).not.toContain('sentry-xcode-debug-files.sh');
    expect(project).not.toContain('scripts/sentry-xcode.sh');
    expect(project).not.toContain('SENTRY_AUTH_TOKEN');
  });
});
