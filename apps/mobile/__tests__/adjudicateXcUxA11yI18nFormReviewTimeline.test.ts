/**
 * Adjudication reproduction for area xc-ux-a11y-i18n (Form Review player).
 *
 *  F1 — the Form Review timeline (`testID="form-review-timeline"` in
 *       src/review/FormReviewPlayer.tsx) was a drag-only responder view that
 *       was `accessible` with a label/hint ("Drag to move through the clip…")
 *       but carried NO `accessibilityRole="adjustable"`, NO
 *       `accessibilityValue` and NO `accessibilityActions`/
 *       `onAccessibilityAction`. A screen-reader user cannot drag, so the
 *       playhead was unreachable to them — while the sibling scrubber in
 *       src/components/StrokeResult.tsx (`testID="stroke-result-scrubber"`)
 *       exposes all of those.
 *
 * Static source pin (Linux plane): the element attributes are read straight
 * from the JSX. Real VoiceOver behaviour still needs the M4 plane. The
 * mounted-flow pin (increment/decrement actually move the clock) lives in
 * formReviewScreen.test.tsx.
 *
 * Run: cd apps/mobile && npx jest --ci __tests__/adjudicateXcUxA11yI18nFormReviewTimeline.test.ts
 */
export {};

declare const require: (id: string) => unknown;
declare const __dirname: string;
const { readFileSync } = require('fs') as {
  readFileSync: (path: string, encoding: 'utf8') => string;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const PLAYER = join(__dirname, '..', 'src', 'review', 'FormReviewPlayer.tsx');
const STROKE_RESULT = join(
  __dirname,
  '..',
  'src',
  'components',
  'StrokeResult.tsx',
);

/** The JSX opening tag (attributes only) of the element carrying `testID`. */
function openingTagWithTestId(source: string, testID: string): string {
  const marker = `testID="${testID}"`;
  const at = source.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const start = source.lastIndexOf('<View', at);
  const end = source.indexOf('>', at);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(at);
  return source.slice(start, end + 1);
}

describe('F1 — Form Review timeline exposes screen-reader adjustable semantics', () => {
  const player = readFileSync(PLAYER, 'utf8');
  const strokeResult = readFileSync(STROKE_RESULT, 'utf8');
  const timeline = openingTagWithTestId(player, 'form-review-timeline');
  const scrubber = openingTagWithTestId(strokeResult, 'stroke-result-scrubber');

  test('control: the Result scrubber exposes adjustable role, value and actions', () => {
    expect(scrubber).toContain('accessibilityRole="adjustable"');
    expect(scrubber).toContain('accessibilityValue=');
    expect(scrubber).toContain('accessibilityActions=');
    expect(scrubber).toContain('onAccessibilityAction=');
  });

  test('the Form Review timeline is still an accessible drag target for sighted touch users', () => {
    expect(timeline).toContain('accessible');
    expect(timeline).toContain('accessibilityLabel="Review timeline"');
    expect(timeline).toContain('onResponderGrant=');
    expect(timeline).toContain('onResponderMove=');
  });

  test('expected: the Form Review timeline exposes the same adjustable semantics as the Result scrubber', () => {
    expect(timeline).toContain('accessibilityRole="adjustable"');
    expect(timeline).toContain('accessibilityValue=');
    expect(timeline).toContain('accessibilityActions=');
    expect(timeline).toContain('onAccessibilityAction=');
  });

  test('expected: the hint tells screen-reader users to swipe up or down, not only to drag', () => {
    expect(timeline).toMatch(/accessibilityHint="[^"]*swipe up (and|or) down/i);
  });
});
