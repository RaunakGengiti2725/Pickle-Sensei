// Adversarial harness (P0-02): production jest config plus the zero-assertion
// audit. Usage (from apps/mobile):
//   PICKLE_ATTACK_ASSERTION_LOG=/abs/path/zero-assertions.jsonl \
//     npx jest --ci --silent --config __harness__/attack/jest.assertionAudit.config.js
const path = require('node:path');

const base = require('../../jest.config.js');

module.exports = {
  ...base,
  rootDir: path.resolve(__dirname, '../..'),
  setupFilesAfterEnv: [
    ...(base.setupFilesAfterEnv ?? []),
    path.join(__dirname, 'assertionAudit.setup.js'),
  ],
};
