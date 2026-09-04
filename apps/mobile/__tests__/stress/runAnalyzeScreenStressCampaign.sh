#!/usr/bin/env bash
# Locale × time-zone campaign for the AnalyzeScreen boundary/i18n/a11y stress
# suite. Each cell is a separate jest process so Node's Intl default locale
# (LC_ALL) and time zone (TZ) are really different; every row records the
# locale/zone Intl actually resolved, so a cell that silently fell back to
# en-US is visible in the JSON rather than assumed.
#
#   cd apps/mobile && __tests__/stress/runAnalyzeScreenStressCampaign.sh
#
# Env: CELL_ITER (iterations per cell, default 13 → 12 cells = 156 rows),
#      STRESS_OUT (artifact dir, default artifacts/stress).
# Exit status is non-zero if ANY cell reported a BROKEN seed.
set -u
cd "$(dirname "$0")/../.."

CELL_ITER="${CELL_ITER:-13}"
OUT="${STRESS_OUT:-$PWD/artifacts/stress}"
mkdir -p "$OUT"

LOCALES=(de_DE fr_FR ar_EG hi_IN ja_JP pt_BR tr_TR ru_RU th_TH zh_CN en_IN es_419)
ZONES=(
  Pacific/Kiritimati
  Etc/GMT+12
  America/New_York
  Europe/Berlin
  Asia/Kolkata
  Australia/Lord_Howe
  Pacific/Chatham
  America/Santiago
)

manifest="$OUT/campaign-cells.tsv"
: >"$manifest"
failed=0
for i in "${!LOCALES[@]}"; do
  locale="${LOCALES[$i]}"
  zone="${ZONES[$((i % ${#ZONES[@]}))]}"
  cell="${locale}__${zone//\//-}"
  seed=$((2000 + i * 100))
  echo "== cell $cell seeds $seed..$((seed + CELL_ITER - 1))"
  if LC_ALL="$locale.UTF-8" LANG="$locale.UTF-8" TZ="$zone" \
    STRESS_CELL="$cell" STRESS_SEED="$seed" STRESS_ITER="$CELL_ITER" \
    STRESS_OUT="$OUT" \
    npx jest --ci --silent --runInBand \
    __tests__/stress/analyzeScreenBoundaryI18nA11y.stress.test.tsx \
    >"$OUT/cell.$cell.log" 2>&1; then
    rc=0
  else
    rc=$?
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$cell" "$locale" "$zone" "$seed" "$rc" >>"$manifest"
  echo "   exit $rc"
  if [ "$rc" -ne 0 ]; then failed=1; fi
done

node __tests__/stress/summarizeAnalyzeScreenStress.mjs "$OUT"
exit "$failed"
