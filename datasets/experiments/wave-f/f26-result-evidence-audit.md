# F26 — Mobile Result surface evidence audit (element → evidence source)

Workstream: f26-result-evidence-audit (Wave F).
Scope: `apps/mobile` Result surface — `StrokeResult.tsx`, `strokeResultModel.ts`,
`strokeResultData.ts`, `UncertaintyNote.tsx`, `ResultScreen.tsx`.
Method: claim-by-claim static trace of every visible element to the record
field it renders from, checking the code path when that field is absent.
e19 (`resultStateProps.test.ts`) covers state transitions; this audit covers
EVIDENCE BACKING. Stored records are unvalidated JSON (`JSON.parse` in
`strokeResultData.ts:loadAnalysisRecordById`), so malformed shapes are
reachable at runtime even where TypeScript types say otherwise.

## Element → evidence source map

| # | Visible element | Renderer | Evidence source | Absent-evidence behavior | Verdict |
|---|---|---|---|---|---|
| 1 | Stroke title + eyebrow + source subtitle | `strokeResultHeader` | `record.strokeIntent` (resolutionBasis, declaredStroke, predictedStroke, disagreement); fallback `analysis.shotType` / `record.result.shotType` | No envelope → "Saved stroke / From your saved analysis" (no provenance claim). Abstained → "Stroke not identified". | **2 DEFECTS (fixed): D1, D2. 1 hardening: D4** |
| 2 | Declared-vs-predicted disagreement line | `strokeResultHeader` declared case | `strokeIntent.disagreement` (declared, predictedLabel) | No disagreement → plain declared header. Both fields required by the render path; nothing invented. | OK |
| 3 | Contact marker + uncertainty halo + confirmation caption | `contactMarkerPresentation` → `ReplayCard` | `record.contact` (status `estimated`, `estimatedContactMs` finite, ballConfirmed \|\| paddleConfirmed \|\| confidence ≥ 0.6) | Absent/abstained/undefensible/non-finite → `not_established`, honest line, NO marker. Halo width derives from recorded confidence only. | OK (gate verified incl. NaN ms) |
| 4 | Phase strip + legend + contact tick | `phaseTimelinePresentation` → `ReplayCard` | `record.temporalPhasesV2` (status `segmented`, ordered finite boundaries; anchor-free via `anchorBasis === "event_peak"`) | Absent → nothing; abstained → reason line; disordered/non-finite anchored contact → withheld ("phase boundaries incomplete/out of order"). Anchor-free never draws a tick and always carries the motion-evidence caption. | OK |
| 5 | Replay time base / scrubber / window shade | `ReplayCard` | `clip.durationMs` (real capture row, `durationMs > 0` gated in `strokeResultData.ts`), else `analysis.timestamps`, else measured phase extent | None of the three → "No replay evidence is stored" card. No synthetic time axis. | OK |
| 6 | Clip poster + ON-DEVICE CLIP badge | `ReplayCard` | `local_capture` row via `record.captureId` | No clip → "NO PER-EVENT CLIP STORED" badge, no image. | OK |
| 7 | ONE insight sentence | `selectInsight` | disagreement > defensible contact > segmented timeline > abstention, each re-derived through the same gates as the rendered elements | Nothing defensible → explicit could-not-establish sentence (limiting factor verbatim from `record.uncertainty.limitingFactors`, else generic honest line). | OK |
| 8 | Measured rows + provenance pills | `measuredRows` | stroke window ← `analysis.timestamps`; contact row ← marker gate; phases row ← timeline gate; classifier read ← `strokeIntent.predictedStroke` (label ≠ UNKNOWN); metric rows ← `analysis.measurements` | Each row emitted only when its field exists; card hidden when zero rows. Provenance labels (DETECTED/ESTIMATE/MEASURED/PREDICTED) match the actual source kind. | OK |
| 9 | Attempt chips (Attempt 1…N) | `attemptChips` | `local_shot` rows sharing `analysis.sessionId`, ordered by `capturedAtIso` | Unknown current id or null sessionId → no chips. Labels are capture-order positions, never ranks (e19 property-tested). | OK (note N1) |
| 10 | Abstention ledger (WHAT HELD / COULDN'T ESTABLISH) | `abstentionLedger` | clip presence, `analysis.timestamps`, envelope basis, marker gate, timeline gate, `uncertainty.limitingFactors` | Every "held" line requires its field; every gap line mirrors a withheld element. Guidance line ← recorded `analysis.guidance` only. | OK |
| 11 | Uncertainty notes | `uncertaintyNotes` | same gates as #3/#4 + envelope basis + `overallScore` + `record.captureEnvelope.overall` | Note emitted ONLY when the matching element was withheld; capture-quality note requires a measured DEGRADED/UNSUPPORTED verdict AND another withheld element. | OK |
| 12 | Technique score ring + SCORABLE pill + read confidence + version trace | `ResultScreen` scored block | `analysis.resultKind === "scored"` **and** `analysis.overallScore` | Previously: `resultKind === "scored"` alone — a scored kind with `overallScore: null` rendered the score stage ("TECHNIQUE SCORE", SCORABLE pill, "—" ring) while `isAbstainedResult` simultaneously rendered the ledger saying scoring was withheld. | **DEFECT (fixed): D3** |
| 13 | Measured priority (fault card: direction, checkpoint score, confidence) | `ResultScreen` | `analysis.priorityFix` + matching row in `analysis.checkpoints` | No fix → card absent; missing checkpoint → "not reported" / "—". | OK (now also behind D3 gate) |
| 14 | Stroke map checkpoint rows | `ResultScreen` + `CheckpointRow` | `analysis.checkpoints` filtered `applicable` | Null score → "—", "not read" a11y label; low confidence → LOW READ flag. | OK |
| 15 | Personalized training states | `ResultScreen` | `scoredReal` (source real + scored + non-null score) + server sync receipt (`hasShotSyncReceipt`) + server plan | Score/sync/plan absent → explicit honest state cards; unknown sync → paused, not assumed. Score delta shown only from server-verified comparison (null → no invented delta). | OK |

## Defects found and fixed

- **D1 — fabricated declaration** (`strokeResultModel.ts` `strokeResultHeader`, declared case):
  `resolutionBasis === "declared"` with `declaredStroke` missing (heterogeneous/corrupt
  stored row) rendered a title from `analysis.shotType` (or the literal "stroke") under the
  subtitle "You chose this technique." — a declaration claim with no recorded declaration.
  Fix: no declaration field → no-provenance saved-analysis header.
- **D2 — fabricated classifier claim** (`strokeResultHeader`, predicted_l3 case):
  `resolutionBasis === "predicted_l3"` with `predictedStroke.leaf` missing rendered the
  analyzed shot (or "stroke") as "Auto-detected by the on-device classifier". Fix: recorded
  family label → family-level framing; no prediction record → no-provenance header.
- **D3 — score stage without a score** (`ResultScreen.tsx`): the technique-score block was
  gated on `resultKind === "scored"` only; `overallScore: null` (type-reachable, and
  reachable from stored JSON) rendered the score stage AND the abstention ledger together.
  Fix: new pure gate `techniqueScoreSectionVisible` (scored AND non-null score), pinned by
  tests.
- **D4 — hardening, unknown basis** (`strokeResultHeader`): a corrupt stored row with an
  out-of-union `resolutionBasis` fell off the exhaustive switch and returned `undefined`,
  crashing the surface. Fix: default → no-provenance header.

Regression tests: `apps/mobile/__tests__/resultEvidenceAudit.test.tsx` (D1, D2, D3, D4 +
a surface-level render pin that a corrupt declared record never renders the declaration
claim).

## Non-defect observations

- **N1** `loadSessionAttempts` reads the latest 200 shots; a session extending past that
  window would renumber attempt chips. Not evidence fabrication (labels remain capture-order
  positions over the loaded set); flagged for a future data workstream.
- Metric rows label all `analysis.measurements` MEASURED; each measurement carries its own
  `confidence` that is not surfaced per-row. Provenance is accurate (the vision layer did
  measure it); surfacing per-metric confidence is a design decision, not a defect.
