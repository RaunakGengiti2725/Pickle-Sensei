#!/usr/bin/env bash
# W05-01 attack 13: revision overflow trap probe. Exit 0 = candidate survives
# (typed failure), exit 1 = candidate crashed (break). Requires `swiftc`.
set -u
cd "$(dirname "$0")/../../../.."
out="${TMPDIR:-/tmp}/wallet-overflow-probe"
swiftc -parse-as-library \
  native/vision-core/Sources/OfflineWallet.swift \
  native/vision-core/Tests/OfflineWalletAttackProbe/main.swift \
  -o "$out" || exit 2
"$out"
status=$?
echo "probe exit=$status"
if [ "$status" -ne 0 ]; then
  echo "BREAK: OfflineWallet.replace trapped instead of returning a typed failure"
  exit 1
fi
