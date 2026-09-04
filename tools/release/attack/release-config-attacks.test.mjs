/**
 * node:test suite — one test per adversarial scenario. Each test asserts the release-config
 * INVARIANT (what the checkers must do), so a failing test here is a real gap in the gates,
 * not a broken harness. Run:
 *
 *   node --test tools/release/attack/release-config-attacks.test.mjs
 *
 * Nothing in the repo is modified: every scenario runs in a throwaway sandbox copy.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSandbox, destroySandbox, runBoth } from "./sandbox.mjs";
import { generated, scenarios } from "./scenarios.mjs";

function assertExpectation(label, expectation, result) {
  if (expectation === "any") return;
  const want = expectation === "pass" ? 0 : 1;
  assert.equal(
    result.exitCode,
    want,
    `${label}: expected exit ${want} (${expectation}), got ${result.exitCode}\n${result.stdout}${result.stderr}`,
  );
}

test("baseline sandbox: both checkers pass an unmodified copy", () => {
  const root = createSandbox();
  try {
    const { releaseCheck, distributionCheck } = runBoth(root);
    assert.equal(releaseCheck.exitCode, 0, releaseCheck.stdout);
    assert.equal(distributionCheck.exitCode, 0, distributionCheck.stdout);
  } finally {
    destroySandbox(root);
  }
});

test("rapid repeat: 5 back-to-back sandbox runs stay deterministic", () => {
  const codes = new Set();
  for (let i = 0; i < 5; i += 1) {
    const root = createSandbox();
    try {
      const { releaseCheck, distributionCheck } = runBoth(root);
      codes.add(`${releaseCheck.exitCode}/${distributionCheck.exitCode}`);
    } finally {
      destroySandbox(root);
    }
  }
  assert.deepEqual([...codes], ["0/0"]);
});

for (const scenario of scenarios) {
  test(`${scenario.id}: ${scenario.invariant} [seed ${generated.seed}]`, () => {
    const root = createSandbox();
    try {
      scenario.mutate(root);
      const { releaseCheck, distributionCheck } = runBoth(root);
      assertExpectation("release:check", scenario.expect.releaseCheck, releaseCheck);
      assertExpectation("check:distribution", scenario.expect.distributionCheck, distributionCheck);
    } finally {
      destroySandbox(root);
    }
  });
}
