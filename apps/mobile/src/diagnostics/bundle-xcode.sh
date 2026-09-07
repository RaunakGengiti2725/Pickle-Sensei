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
exec /bin/bash "${REACT_NATIVE_PATH:?}/scripts/react-native-xcode.sh"
