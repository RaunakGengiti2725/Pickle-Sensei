// Audit-only Jest project: same preset/mocks as the app suite, but only the
// `*.audit.tsx` harnesses under this directory. Not part of `npx jest` (the
// default testMatch only covers `__tests__/`), so the app suite is unchanged.
//
//   cd apps/mobile && npx jest --ci -c audit/screen-ux-a11y-i18n-2/jest.config.js
const path = require('path');
const base = require('../../jest.config.js');

module.exports = {
  ...base,
  rootDir: path.resolve(__dirname, '../..'),
  roots: ['<rootDir>/audit/screen-ux-a11y-i18n-2', '<rootDir>/__mocks__'],
  testMatch: ['<rootDir>/audit/screen-ux-a11y-i18n-2/**/*.audit.tsx'],
  // Render-heavy matrices: 4 screens × ~12 states × 9 cells (+ fuzz seeds).
  testTimeout: 600000,
  maxWorkers: 2,
};
