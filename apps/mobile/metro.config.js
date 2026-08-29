const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const monorepoRoot = path.resolve(__dirname, '../..');

/**
 * Metro config: the app consumes shared monorepo packages (@pickle/*) directly
 * from TypeScript source. Those packages use ESM ".js" import specifiers, so a
 * custom resolver maps missing ".js" files to their ".ts" sources.
 */
const pickleAliases = {
  '@pickle/shared-types': path.join(
    monorepoRoot,
    'packages/shared-types/src/index.ts',
  ),
  '@pickle/scoring': path.join(monorepoRoot, 'packages/scoring/src/index.ts'),
  '@pickle/audio-coach-core': path.join(
    monorepoRoot,
    'packages/audio-coach-core/src/index.ts',
  ),
  '@pickle/vision-contracts': path.join(
    monorepoRoot,
    'packages/vision-contracts/src/index.ts',
  ),
  '@pickle/swing-domain': path.join(
    monorepoRoot,
    'packages/swing-domain/src/index.ts',
  ),
  '@pickle/model-registry': path.join(
    monorepoRoot,
    'packages/model-registry/src/index.ts',
  ),
  '@pickle/evaluation': path.join(
    monorepoRoot,
    'packages/evaluation/src/index.ts',
  ),
  '@pickle/vision-geometry': path.join(
    monorepoRoot,
    'packages/vision-geometry/src/index.ts',
  ),
  '@pickle/analysis-pipeline': path.join(
    monorepoRoot,
    'packages/analysis-pipeline/src/index.ts',
  ),
  // RN-safe entry: the package's main index also exports the node-only
  // ffmpeg clip prober, which cannot bundle for the app.
  '@pickle/capture-envelope': path.join(
    monorepoRoot,
    'packages/capture-envelope/src/core.ts',
  ),
};

const config = {
  watchFolders: [path.join(monorepoRoot, 'packages')],
  resolver: {
    // Bare imports from shared packages (e.g. @babel/runtime helpers injected
    // by the transform) resolve against the app's node_modules.
    nodeModulesPaths: [
      path.join(__dirname, 'node_modules'),
      path.join(monorepoRoot, 'node_modules'),
    ],
    resolveRequest: (context, moduleName, platform) => {
      if (pickleAliases[moduleName]) {
        return { type: 'sourceFile', filePath: pickleAliases[moduleName] };
      }
      // ESM ".js" specifiers inside @pickle packages point at ".ts" sources.
      if (
        moduleName.endsWith('.js') &&
        context.originModulePath.includes(`${path.sep}packages${path.sep}`)
      ) {
        const candidate = path.resolve(
          path.dirname(context.originModulePath),
          moduleName.replace(/\.js$/, '.ts'),
        );
        try {
          return { type: 'sourceFile', filePath: candidate };
        } catch {
          // fall through to default resolution
        }
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
