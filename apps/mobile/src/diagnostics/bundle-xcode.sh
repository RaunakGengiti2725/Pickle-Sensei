#!/bin/bash
set -euo pipefail

export SENTRY_DISABLE_AUTO_UPLOAD=true
export SENTRY_DISABLE_XCODE_DEBUG_UPLOAD=true
case "${CONFIGURATION:-Release}" in
  *[Dd][Ee][Bb][Uu][Gg]*)
    printf '%s\n' 'Sentry uploads blocked: Debug bundling unchanged.'
    ;;
  *)
    export SOURCEMAP_FILE="${DERIVED_FILE_DIR:?}/main.jsbundle.map"
    export COMPOSE_SOURCEMAP_PATH="${PROJECT_DIR:?}/../src/diagnostics/composeSourceMaps.cjs"
    printf '%s\n' 'Sentry uploads blocked: preparing local source maps only.'
    ;;
esac

# Release identity for diagnostics (src/config/releaseIdentity.ts): the same
# validator fastlane runs before archiving prints the committed candidate, and
# its version, build, bundle identifier, commit and committed verdict become
# the build-time identity file Metro bundles (the validator's file list holds
# build-machine paths and stays out of the app). Any refusal leaves no file,
# so the diagnostics gate stays blocked_identity.
mobile_root="${PROJECT_DIR:?}/.."
identity_file="${mobile_root}/src/config/releaseIdentity.generated.json"
node_binary="${NODE_BINARY:-node}"
rm -f "${identity_file}" "${identity_file}.tmp"
if ! command -v "${node_binary}" >/dev/null 2>&1; then
  printf '%s\n' 'Release identity: node unavailable; diagnostics identity stays blocked.'
elif "${node_binary}" "${mobile_root}/scripts/release-identity.mjs" --check --require-committed --json >"${identity_file}.tmp" &&
  "${node_binary}" -e '
    const fs = require("node:fs");
    const { marketingVersion, buildNumber, bundleIdentifier, gitSha, committed } =
      JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    fs.writeFileSync(
      process.argv[2],
      `${JSON.stringify({ marketingVersion, buildNumber, bundleIdentifier, gitSha, committed })}\n`,
    );
  ' "${identity_file}.tmp" "${identity_file}"; then
  rm -f "${identity_file}.tmp"
  printf '%s\n' 'Release identity: committed candidate written for diagnostics.'
else
  rm -f "${identity_file}" "${identity_file}.tmp"
  printf '%s\n' 'Release identity: refused; diagnostics identity stays blocked.'
fi
exec /bin/bash "${REACT_NATIVE_PATH:?}/scripts/react-native-xcode.sh"
