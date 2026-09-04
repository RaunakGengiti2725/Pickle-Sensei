#!/usr/bin/env python3
"""Run the ml/scripts unittest suite in randomized order under several seeds.

`python -m unittest` has no --shuffle flag, so this harness loads the same
suite that `python3 -m unittest discover -s ml/scripts -p 'test_*.py'` runs,
flattens it, shuffles with an explicit seed, and runs it. Any order-dependent
test (shared mutable module state, fixture leakage) shows up as a failure
under some seed while the default order passes.

Usage:
  python3 tools/audit/ml_tooling/run_shuffled_unittests.py [--seeds 5] [--seed N ...]
Exit 0 = every seed passed; 1 = at least one failure/error.
"""
from __future__ import annotations

import argparse
import random
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
TEST_DIR = REPO_ROOT / "ml" / "scripts"


def flatten(suite: unittest.TestSuite) -> list[unittest.TestCase]:
    out: list[unittest.TestCase] = []
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            out.extend(flatten(item))
        else:
            out.append(item)
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seeds", type=int, default=5, help="number of random seeds when --seed is not given")
    parser.add_argument("--seed", type=int, action="append", help="explicit seed(s)")
    args = parser.parse_args()

    seeds = args.seed or [random.SystemRandom().randrange(1, 2**31) for _ in range(args.seeds)]
    sys.path.insert(0, str(TEST_DIR))
    loader = unittest.TestLoader()
    base = flatten(loader.discover(str(TEST_DIR), pattern="test_*.py"))
    if not base:
        print("no tests discovered", file=sys.stderr)
        return 1

    failed = False
    for seed in seeds:
        tests = list(base)
        random.Random(seed).shuffle(tests)
        order = [t.id().rsplit(".", 1)[-1] for t in tests]
        print(f"== seed {seed}: {len(tests)} tests, order: {', '.join(order)}")
        result = unittest.TextTestRunner(verbosity=1, stream=sys.stdout).run(unittest.TestSuite(tests))
        ok = result.wasSuccessful()
        print(f"== seed {seed}: {'OK' if ok else 'FAILED'} (run={result.testsRun} failures={len(result.failures)} errors={len(result.errors)})")
        failed |= not ok
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
