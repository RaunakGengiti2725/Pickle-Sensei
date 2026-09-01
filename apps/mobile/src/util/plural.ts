/**
 * Grammatical-number helper for UI copy: returns `singular` when `count` is
 * exactly 1, otherwise `pluralForm` (default: `singular` + 's'). It only
 * chooses a label — the number itself is rendered by the caller, so counts
 * are never reformatted or hidden.
 */
export function plural(
  count: number,
  singular: string,
  pluralForm: string = `${singular}s`,
): string {
  return count === 1 ? singular : pluralForm;
}
