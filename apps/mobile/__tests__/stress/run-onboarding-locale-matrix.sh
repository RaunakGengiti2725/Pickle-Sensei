#!/usr/bin/env bash
# Drives the 12-locale matrix for the OnboardingScreen boundary/i18n/a11y
# stress harness. Node's ICU locale is process-wide, so each locale is a
# separate jest process; every results.json row records the ICU locale it
# actually resolved to (`icuLocale`), so a locale the OS lacks shows up as a
# mismatch in the artifact instead of a silent pass.
#
# Usage: cd apps/mobile && STRESS_ITER=16 __tests__/stress/run-onboarding-locale-matrix.sh [run-prefix]
set -u
cd "$(dirname "$0")/../.."
PREFIX="${1:-locale}"
ITER="${STRESS_ITER:-16}"
LOCALES=(de-DE fr-FR ar-EG hi-IN ja-JP pt-BR tr-TR ru-RU th-TH zh-CN en-IN es-419)
status=0
for loc in "${LOCALES[@]}"; do
  run_id="${PREFIX}-${loc}"
  # 65 seeds apart per locale so seed→variant coverage differs between runs.
  base=$((2000 + 65 * $(printf '%s\n' "${LOCALES[@]}" | grep -n -x "$loc" | cut -d: -f1)))
  echo "== ${loc} (seeds ${base}..$((base + ITER - 1))) =="
  LANG="${loc}.UTF-8" LC_ALL="${loc}.UTF-8" STRESS_ITER="$ITER" STRESS_SEED_BASE="$base" \
    STRESS_RUN_ID="$run_id" \
    npx jest --ci --silent __tests__/stress/onboardingScreen.boundaryI18nA11y.stress.test.tsx
  code=$?
  echo "== ${loc} → exit ${code} =="
  if [ "$code" -ne 0 ]; then status=1; fi
done
exit "$status"
