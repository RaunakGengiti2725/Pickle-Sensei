'use strict';
/**
 * `node -r` hook for the process-death child. It lets a plain Node process
 * (no Jest, no Metro) load the shipping React Native TypeScript modules
 * unchanged:
 *   - Babel-compiles .ts/.tsx on require with the app's own babel.config.js;
 *   - resolves the monorepo `@pickle/*` packages and ESM `.js` specifiers via
 *     the SAME moduleNameMapper the Jest suite uses (jest.config.js);
 *   - swaps `react-native` for the headless stub and
 *     `@op-engineering/op-sqlite` for the durable node:sqlite adapter.
 * Nothing under src/ is edited: the child runs the real journal, analysis,
 * repository and outbox code against a real on-disk database.
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const mobileRoot = path.resolve(__dirname, '..', '..');
const babel = require(path.join(mobileRoot, 'node_modules', '@babel', 'core'));
const jestConfig = require(path.join(mobileRoot, 'jest.config.js'));

const mappers = Object.entries(jestConfig.moduleNameMapper).map(
  ([pattern, target]) => ({
    pattern: new RegExp(pattern),
    target: target.replace('<rootDir>', mobileRoot),
  }),
);
const stubs = {
  'react-native': path.join(__dirname, 'reactNativeStub.ts'),
  '@op-engineering/op-sqlite': path.join(__dirname, 'durableSqlite.ts'),
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, parent, isMain, options) {
  if (stubs[request]) return stubs[request];
  for (const { pattern, target } of mappers) {
    const match = pattern.exec(request);
    if (!match) continue;
    const mapped = target.replace(/\$(\d+)/g, (_, index) => match[index]);
    if (path.isAbsolute(mapped)) return mapped;
    // Relative ESM ".js" specifier: resolve against the importer as .ts/.tsx.
    if (parent && parent.filename) {
      const base = path.resolve(path.dirname(parent.filename), mapped);
      for (const ext of ['.ts', '.tsx', '.js']) {
        if (fs.existsSync(base + ext)) return base + ext;
      }
    }
  }
  try {
    return originalResolve.call(this, request, parent, isMain, options);
  } catch (error) {
    // Workspace packages (packages/*) have no node_modules of their own for
    // Babel runtime helpers etc.; fall back to the app's node_modules exactly
    // like Jest's moduleDirectories ['node_modules', '<rootDir>/node_modules'].
    if (error && error.code === 'MODULE_NOT_FOUND' && !request.startsWith('.'))
      return originalResolve.call(
        this,
        request,
        { ...parent, paths: [path.join(mobileRoot, 'node_modules')] },
        isMain,
        options,
      );
    throw error;
  }
};

const compile = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const out = babel.transformSync(source, {
    filename,
    root: mobileRoot,
    cwd: mobileRoot,
    envName: 'test',
    caller: { name: 'process-death-harness', supportsStaticESM: false },
    sourceMaps: 'inline',
  });
  module._compile(out.code, filename);
};
require.extensions['.ts'] = compile;
require.extensions['.tsx'] = compile;
