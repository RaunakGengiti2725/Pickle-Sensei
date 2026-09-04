/**
 * Regenerates `fontMetrics.fixture.json` from the TTFs that ship in
 * `apps/mobile/assets/fonts`, so the stress harness measures text with the
 * SAME glyph advances the app renders with (instead of a guessed average
 * character width).
 *
 * fontkit is deliberately NOT an app dependency (the fixture is committed, so
 * the harness needs nothing extra). Regenerate in a throwaway directory:
 *   mkdir -p /tmp/fontmetrics && cd /tmp/fontmetrics && npm i fontkit@2
 *   node <repo>/apps/mobile/testing/stress/notificationPriming/generateFontMetrics.mjs \
 *     <repo>/apps/mobile/assets/fonts \
 *     <repo>/apps/mobile/testing/stress/notificationPriming/fontMetrics.fixture.json
 */
import * as fontkit from 'fontkit';
import fs from 'node:fs';
import path from 'node:path';

const [, , FONT_DIR, OUT_PATH] = process.argv;

/** Every string NotificationPrimingCard can render (see the component). */
const CARD_STRINGS = [
  'A nudge on practice days?',
  'One daily reminder, plus a heads-up before a streak slips. Scheduled on this phone only.',
  'Turn on',
  'Not now',
  'Asking…',
  'Try again',
  'Reminders couldn’t be turned on. Try again, or allow notifications for Pickle Sensei in your phone’s Settings.',
];

const ASCII = Array.from({ length: 95 }, (_, i) =>
  String.fromCharCode(32 + i),
).join('');
const EXTRA = '…’‘“”—–°éöüßçñ';
const chars = [...new Set([...(ASCII + EXTRA + CARD_STRINGS.join(''))])];

const out = {
  note: 'Advance widths (fraction of the font size) and kerned string widths, extracted from the TTFs bundled at apps/mobile/assets/fonts with fontkit. Regenerate with testing/stress/notificationPriming/generateFontMetrics.mjs.',
  fonts: {},
};

for (const [key, file] of [
  ['Manrope_500Medium', 'Manrope_500Medium.ttf'],
  ['Manrope_600SemiBold', 'Manrope_600SemiBold.ttf'],
]) {
  const font = fontkit.openSync(path.join(FONT_DIR, file));
  const upm = font.unitsPerEm;
  const advanceEm = {};
  for (const ch of chars) {
    advanceEm[ch] =
      Math.round((font.layout(ch).glyphs[0].advanceWidth / upm) * 1e5) / 1e5;
  }
  const stringEm = {};
  for (const s of CARD_STRINGS) {
    stringEm[s] = Math.round((font.layout(s).advanceWidth / upm) * 1e5) / 1e5;
  }
  out.fonts[key] = {
    file: `assets/fonts/${file}`,
    unitsPerEm: upm,
    advanceEm,
    stringEm,
  };
}

fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
