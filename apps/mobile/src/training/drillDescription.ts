/**
 * DRILL DESCRIPTION — the catalog serves one drill's description as a
 * single string the edge function assembles from its seed record:
 *
 *   {purpose}
 *
 *   1. {step}
 *   2. {step}
 *   3. {step}
 *
 *   Dose: {reps or duration}.
 *
 * (supabase/functions/api/drills.ts `describe`). Rendering that string as a
 * clamped paragraph hides exactly the parts a player acts on — the steps and
 * the dose — so this parser splits it back into its parts. It is tolerant:
 * a description in any other shape comes back as `purpose` alone with no
 * steps and no dose, and the host renders it as plain text. Nothing is
 * invented for a description that carries no structure.
 *
 * Pure (no React, no IO) so jest pins it directly.
 */

export interface DrillDescriptionParts {
  /** The free text before (and outside) the numbered steps. */
  purpose: string;
  /** The numbered how-to steps in order; empty when none are present. */
  steps: string[];
  /** "3 × 10 shadow swings + 2 × 10 fed balls" — without the label or the
   * trailing period; null when the description carries no dose line. */
  dose: string | null;
}

const STEP_LINE = /^\s*\d+[.)]\s+(.+?)\s*$/;
const DOSE_LINE = /^\s*dose:\s*(.+?)\.?\s*$/i;

export function parseDrillDescription(
  description: string,
): DrillDescriptionParts {
  const purpose: string[] = [];
  const steps: string[] = [];
  let dose: string | null = null;
  for (const raw of description.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const step = STEP_LINE.exec(line);
    if (step?.[1]) {
      steps.push(step[1]);
      continue;
    }
    const dosed = DOSE_LINE.exec(line);
    if (dosed?.[1]) {
      dose = dosed[1];
      continue;
    }
    purpose.push(line);
  }
  return { purpose: purpose.join(' '), steps, dose };
}

/** "Paddle · Mirror or phone camera · Balls" — one quiet line from the
 * catalog's equipment list; null when the list is empty. */
export function equipmentLine(equipment: readonly string[]): string | null {
  const items = equipment
    .map(item => item.trim())
    .filter(item => item.length > 0)
    .map(item => item.charAt(0).toUpperCase() + item.slice(1));
  return items.length > 0 ? items.join(' · ') : null;
}
