// Adversarial harness (P0-02): records every test that finishes with ZERO
// `expect` calls. A green suite whose tests assert nothing is a vacuous pass,
// so the audit writes {file, fullName} lines to PICKLE_ATTACK_ASSERTION_LOG
// (JSONL, append) for offline review. It never fails a test by itself: the
// verdict belongs to the reviewer, not to the harness.
const fs = require('node:fs');

const logPath = process.env.PICKLE_ATTACK_ASSERTION_LOG;
if (!logPath) {
  throw new Error('PICKLE_ATTACK_ASSERTION_LOG must point at a writable file');
}

afterEach(() => {
  const state = expect.getState();
  if (state.assertionCalls === 0) {
    fs.appendFileSync(
      logPath,
      JSON.stringify({
        file: state.testPath,
        fullName: state.currentTestName,
      }) + '\n',
    );
  }
});
