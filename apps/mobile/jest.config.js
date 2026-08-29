module.exports = {
  preset: '@react-native/jest-preset',
  moduleNameMapper: {
    // Shared monorepo packages consumed from TypeScript source.
    '^@pickle/shared-types$':
      '<rootDir>/../../packages/shared-types/src/index.ts',
    '^@pickle/scoring$': '<rootDir>/../../packages/scoring/src/index.ts',
    '^@pickle/audio-coach-core$':
      '<rootDir>/../../packages/audio-coach-core/src/index.ts',
    '^@pickle/vision-contracts$':
      '<rootDir>/../../packages/vision-contracts/src/index.ts',
    '^@pickle/swing-domain$':
      '<rootDir>/../../packages/swing-domain/src/index.ts',
    '^@pickle/model-registry$':
      '<rootDir>/../../packages/model-registry/src/index.ts',
    '^@pickle/evaluation$': '<rootDir>/../../packages/evaluation/src/index.ts',
    '^@pickle/vision-geometry$':
      '<rootDir>/../../packages/vision-geometry/src/index.ts',
    '^@pickle/analysis-pipeline$':
      '<rootDir>/../../packages/analysis-pipeline/src/index.ts',
    // RN-safe entry: the package's main index also exports the node-only
    // ffmpeg clip prober, which cannot load here.
    '^@pickle/capture-envelope$':
      '<rootDir>/../../packages/capture-envelope/src/core.ts',
    // ESM ".js" specifiers in those packages resolve to ".ts" sources.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // Shared packages live outside this app's tree; resolve helpers from here.
  moduleDirectories: ['node_modules', '<rootDir>/node_modules'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-navigation|react-native-.*|@op-engineering)/)',
  ],
  // The first test of a render-heavy suite pays the on-demand Babel transform
  // of every monorepo TS module it imports; on cold CI runners that alone can
  // exceed jest's 5s default.
  testTimeout: 30000,
};
