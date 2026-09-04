#!/usr/bin/env bash
# Copies the throwaway probes into apps/mobile/__tests__, runs them, removes them.
# A PASSING probe case means the failure mode is REPRODUCED; a FAILING case means refuted.
set -u
ROOT=$(git rev-parse --show-toplevel)
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT/apps/mobile"
cp "$HERE"/zz-probe-*.test.ts __tests__/
TZ=${PROBE_TZ:-America/New_York} npx jest --ci __tests__/zz-probe-mobile-settings-account.test.ts __tests__/zz-probe-consent.test.ts
rc=$?
rm -f __tests__/zz-probe-*.test.ts
echo "probe exit=$rc (non-zero is expected: refuted hypotheses fail by design)"
