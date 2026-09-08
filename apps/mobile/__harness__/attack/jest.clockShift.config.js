// Adversarial harness (P0-02): the production jest config plus a clock-shift
// setup file. Usage (from apps/mobile):
//   PICKLE_ATTACK_CLOCK_SHIFT_MS=<ms> npx jest --ci --silent \
//     --config __harness__/attack/jest.clockShift.config.js
// Nothing in the base config is weakened: same preset, mappers, transform
// ignore patterns and testTimeout; the only change is one extra setupFile
// that runs BEFORE the app's jest.setup.js.
const path = require('node:path');

const base = require('../../jest.config.js');

module.exports = {
  ...base,
  rootDir: path.resolve(__dirname, '../..'),
  setupFiles: [
    path.join(__dirname, 'clockShift.setup.js'),
    ...(base.setupFiles ?? []),
  ],
};
