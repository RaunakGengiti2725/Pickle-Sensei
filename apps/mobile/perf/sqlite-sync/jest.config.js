// Dedicated jest project for the SQLite/sync performance harness. It is NOT
// part of `npx jest` (testMatch below only picks *.perf.ts) because a 10k-row
// run takes minutes and needs node:sqlite (`--experimental-sqlite` on Node 22).
//
//   cd apps/mobile && NODE_OPTIONS="--experimental-sqlite --expose-gc" \
//     npx jest -c perf/sqlite-sync/jest.config.js --runInBand
const base = require('../../jest.config.js');

module.exports = {
  ...base,
  rootDir: '../..',
  testMatch: ['<rootDir>/perf/sqlite-sync/**/*.perf.ts'],
  testTimeout: 30 * 60 * 1000,
  maxWorkers: 1,
};
