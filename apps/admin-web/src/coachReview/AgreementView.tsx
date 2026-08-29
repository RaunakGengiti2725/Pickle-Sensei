import React, { useState } from "react";
import { computeAllAgreements } from "./agreement";
import {
  computePairKappas,
  primaryFaultLabelExtractor,
  strokeLabelExtractor,
  type PairKappa,
} from "./kappa";
import {
  buildAdjudicatedExport,
  downloadJson,
  latestReviewVersions,
  submitAdjudication,
  type CoachReviewData,
  type SubmitResult,
} from "./data";
import { isBlindInProgress } from "./blind";
import type { AdjudicationOutcome, AdjudicationRecord } from "./records";
import type { QualityValue } from "./types";
import { labBox, mono } from "./CoachReviewLab";

const formatRate = (rate: number | null): string =>
  rate === null ? "—" : `${Math.round(rate * 100)}%`;
const formatNumber = (value: number | null): string => (value === null ? "—" : value.toFixed(2));

function KappaTable({ title, pairs }: { title: string; pairs: PairKappa[] }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <h4 style={{ margin: "4px 0" }}>{title}</h4>
      {pairs.length === 0 ? (
        <p style={{ color: "#6b7a75", fontSize: 13 }}>
          No coach pair shares evaluable reviews yet.
        </p>
      ) : (
        <table cellPadding={6} style={{ borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "2px solid #dde5e1" }}>
              <th>Coach pair</th>
              <th>Shared items</th>
              <th>Observed agr.</th>
              <th>Chance agr.</th>
              <th>κ</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((pair) => (
              <tr
                key={`${pair.coachA}|${pair.coachB}`}
                style={{ borderBottom: "1px solid #eef2f0" }}
              >
                <td style={mono}>
                  {pair.coachA} × {pair.coachB}
                </td>
                <td>{pair.sharedItems}</td>
                <td>{formatRate(pair.observedAgreement)}</td>
                <td>{formatRate(pair.expectedAgreement)}</td>
                <td>
                  {pair.kappa === null ? (
                    <span title="undefined: <2 shared items or no label variation">—</span>
                  ) : (
                    <strong>{pair.kappa.toFixed(2)}</strong>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AdjudicationEditor({ data, queueItemId }: { data: CoachReviewData; queueItemId: string }) {
  const realReviews = data.reviews
    .filter((entry) => !entry.synthetic && entry.review.queueItemId === queueItemId)
    .map((entry) => entry.review);
  const reviewerIds = new Set(realReviews.map((review) => review.coachId));
  const eligible = data.registry.coaches.filter(
    (coach) => coach.status === "active" && !reviewerIds.has(coach.coachId),
  );
  const [adjudicatorId, setAdjudicatorId] = useState("");
  const [outcomeKind, setOutcomeKind] = useState<"uphold" | "new_verdict" | "unresolvable">(
    "uphold",
  );
  const [upheldReviewId, setUpheldReviewId] = useState(realReviews[0]?.reviewId ?? "");
  const [stroke, setStroke] = useState<string>("");
  const [quality, setQuality] = useState<string>("");
  const [primaryFaultId, setPrimaryFaultId] = useState<string>("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [rationale, setRationale] = useState("");
  const [timestamps, setTimestamps] = useState("");
  const [result, setResult] = useState<SubmitResult | null>(null);

  const adjudicator = eligible.find((coach) => coach.coachId === adjudicatorId);
  const outcome: AdjudicationOutcome =
    outcomeKind === "uphold"
      ? { kind: "uphold", reviewId: upheldReviewId }
      : outcomeKind === "new_verdict"
        ? {
            kind: "new_verdict",
            stroke: stroke === "" ? null : stroke,
            overallQuality: quality === "" ? null : (Number(quality) as QualityValue),
            primaryFaultId: primaryFaultId === "" ? null : primaryFaultId,
            note,
          }
        : { kind: "unresolvable", reason };
  const record: AdjudicationRecord = {
    schemaVersion: 1,
    queueItemId,
    adjudicatorId,
    adjudicatorCredentialRef: adjudicator?.credentialRef ?? "",
    reviewedReviewIds: realReviews.map((review) => review.reviewId),
    outcome,
    rationale,
    evidenceTimestampsMs: timestamps
      .split(",")
      .map((token) => token.trim())
      .filter((token) => token !== "")
      .map(Number),
    createdAtIso: new Date().toISOString(),
  };

  if (eligible.length === 0) {
    return (
      <p style={{ color: "#92400e", fontSize: 13 }}>
        No eligible adjudicator: an adjudication needs an active provisioned coach who was NOT one
        of the original reviewers. Nothing can be recorded until such a coach exists.
      </p>
    );
  }
  return (
    <div style={{ border: "1px dashed #cbd5d1", borderRadius: 8, padding: 8, fontSize: 13 }}>
      <label>
        Adjudicator (third coach):{" "}
        <select value={adjudicatorId} onChange={(e) => setAdjudicatorId(e.target.value)}>
          <option value="">— select —</option>
          {eligible.map((coach) => (
            <option key={coach.coachId} value={coach.coachId}>
              {coach.coachId}
            </option>
          ))}
        </select>
      </label>
      <div style={{ margin: "6px 0" }}>
        outcome:{" "}
        {(["uphold", "new_verdict", "unresolvable"] as const).map((kind) => (
          <label key={kind} style={{ marginRight: 10 }}>
            <input
              type="radio"
              checked={outcomeKind === kind}
              onChange={() => setOutcomeKind(kind)}
            />{" "}
            {kind}
          </label>
        ))}
      </div>
      {outcomeKind === "uphold" && (
        <label>
          upheld review:{" "}
          <select value={upheldReviewId} onChange={(e) => setUpheldReviewId(e.target.value)}>
            {realReviews.map((review) => (
              <option key={review.reviewId} value={review.reviewId}>
                {review.reviewId}
              </option>
            ))}
          </select>
        </label>
      )}
      {outcomeKind === "new_verdict" && (
        <div>
          <select value={stroke} onChange={(e) => setStroke(e.target.value)}>
            <option value="">stroke: no verdict</option>
            {data.schema.strokeTaxonomy.labels.map((label) => (
              <option key={label}>{label}</option>
            ))}
          </select>{" "}
          <select value={quality} onChange={(e) => setQuality(e.target.value)}>
            <option value="">quality: no verdict</option>
            {[1, 2, 3, 4, 5].map((value) => (
              <option key={value} value={value}>
                quality {value}
              </option>
            ))}
          </select>{" "}
          <select value={primaryFaultId} onChange={(e) => setPrimaryFaultId(e.target.value)}>
            <option value="">primary fault: no verdict</option>
            {data.taxonomy.families
              .flatMap((family) => family.faults)
              .map((fault) => (
                <option key={fault.id} value={fault.id}>
                  {fault.id}
                </option>
              ))}
          </select>{" "}
          <input
            placeholder="note (required)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            style={{ width: 260 }}
          />
        </div>
      )}
      {outcomeKind === "unresolvable" && (
        <input
          placeholder="why unresolvable (≥10 chars)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          style={{ width: 420 }}
        />
      )}
      <div style={{ marginTop: 6 }}>
        <textarea
          placeholder="adjudication rationale (≥20 chars, required)"
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          style={{ width: "100%", minHeight: 40 }}
        />
        <input
          placeholder="evidence timestamps ms, comma-separated (optional)"
          value={timestamps}
          onChange={(e) => setTimestamps(e.target.value)}
          style={{ width: 320 }}
        />{" "}
        <button
          disabled={!adjudicator}
          onClick={() => {
            submitAdjudication(record)
              .then(setResult)
              .catch((e) => setResult({ ok: false, status: 0, message: String(e) }));
          }}
        >
          Record adjudication (append-only)
        </button>
      </div>
      {result && <p style={{ color: result.ok ? "#15803d" : "#b91c1c" }}>{result.message}</p>}
    </div>
  );
}

/**
 * Inter-coach agreement. The computation (agreement.ts, unit-tested on
 * synthetic fixtures) runs on whatever reviews exist; with today's truthful
 * zero, every row is "awaiting reviews". Open with ?synthetic=1 to exercise
 * the computed/adjudication states against the flagged dev fixtures.
 */
export function AgreementView({ data }: { data: CoachReviewData }) {
  const resolved = latestReviewVersions(data.reviews, data.amendments);
  const reviews = resolved.map((entry) => entry.review);
  const realCountByItem = new Map<string, number>();
  for (const entry of resolved) {
    if (entry.synthetic) continue;
    const id = entry.review.queueItemId;
    realCountByItem.set(id, (realCountByItem.get(id) ?? 0) + 1);
  }
  const blindItems = new Set(
    data.queue.queue
      .filter((item) =>
        isBlindInProgress(item.requiredReviewsTarget, realCountByItem.get(item.queueItemId) ?? 0),
      )
      .map((item) => item.queueItemId),
  );
  const agreements = computeAllAgreements(data.queue.queue, reviews);
  const anyComputed = agreements.some((agreement) => agreement.status === "computed");
  // Real reviews on items still collecting stay OUT of the cross-item kappas:
  // their labels are blind content until the item reaches its target.
  const kappaInput = resolved
    .filter((entry) => entry.synthetic || !blindItems.has(entry.review.queueItemId))
    .map((entry) => entry.review);
  const strokeKappas = computePairKappas(kappaInput, strokeLabelExtractor);
  const faultKappas = computePairKappas(kappaInput, primaryFaultLabelExtractor);
  const adjudicationByItem = new Map(
    data.adjudications.map((record) => [record.queueItemId, record]),
  );

  return (
    <div>
      <section style={labBox}>
        <h2>Inter-coach agreement</h2>
        <p style={{ color: "#42505f", maxWidth: 760 }}>
          Policy: {data.queue.program.disagreementPolicy}. Metrics (
          {data.queue.program.agreementMetrics}) are pairwise over evaluable reviews;{" "}
          <em>cannot-evaluate</em> outcomes are counted, never imputed. Agreement is computed once a
          queue item has ≥2 evaluable reviews.
        </p>
        {!anyComputed && !data.syntheticMode && (
          <p style={{ color: "#b45309" }}>
            <strong>Awaiting reviews:</strong> 0 coach reviews exist, so no agreement can be
            computed yet. The computation is implemented and unit-tested
            (apps/admin-web/src/coachReview/agreement.ts); append{" "}
            <code style={mono}>?synthetic=1</code> to the URL to see it exercise flagged dev
            fixtures.
          </p>
        )}
        <table cellPadding={8} style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "2px solid #dde5e1" }}>
              <th>Queue item</th>
              <th>Reviews</th>
              <th>Status</th>
              <th>Stroke agr.</th>
              <th>Rating exact / mean |Δ|</th>
              <th>Primary fault agr.</th>
              <th>Severity exact / mean |Δ|</th>
              <th>Fault-set Jaccard</th>
              <th>Adjudication</th>
            </tr>
          </thead>
          <tbody>
            {agreements.map((agreement) => {
              const blind = blindItems.has(agreement.queueItemId);
              return (
                <tr
                  key={agreement.queueItemId}
                  style={{ borderBottom: "1px solid #eef2f0", verticalAlign: "top" }}
                >
                  <td>
                    <a href={`#/coach/item/${agreement.queueItemId}`}>{agreement.queueItemId}</a>
                  </td>
                  <td>
                    {agreement.reviewCount}/{agreement.requiredReviewsTarget}
                    {agreement.cannotEvaluateCount > 0 && (
                      <div style={{ color: "#6b7a75", fontSize: 11 }}>
                        {agreement.cannotEvaluateCount} cannot-evaluate
                      </div>
                    )}
                  </td>
                  <td
                    style={{
                      color: agreement.status === "computed" && !blind ? "#15803d" : "#b45309",
                    }}
                  >
                    {blind
                      ? "blind (collecting)"
                      : agreement.status === "computed"
                        ? "computed"
                        : "awaiting reviews"}
                    {blind && (
                      <div style={{ color: "#6b7a75", fontSize: 11, maxWidth: 160 }}>
                        review-derived metrics withheld until {agreement.requiredReviewsTarget} real
                        reviews exist
                      </div>
                    )}
                  </td>
                  <td>{blind ? "withheld" : formatRate(agreement.stroke.rate)}</td>
                  <td>
                    {blind
                      ? "withheld"
                      : `${formatRate(agreement.rating.exactMatchRate)} / ${formatNumber(agreement.rating.meanAbsDiff)}`}
                  </td>
                  <td>{blind ? "withheld" : formatRate(agreement.primaryFault.rate)}</td>
                  <td>
                    {blind
                      ? "withheld"
                      : `${formatRate(agreement.severity.exactRate)} / ${formatNumber(agreement.severity.meanAbsDiff)}`}
                  </td>
                  <td>{blind ? "withheld" : formatNumber(agreement.faultOverlap.meanJaccard)}</td>
                  <td>
                    {blind ? (
                      "\u2014"
                    ) : agreement.adjudication.required ? (
                      adjudicationByItem.has(agreement.queueItemId) ? (
                        <details style={{ color: "#15803d" }}>
                          <summary>
                            RECORDED ({adjudicationByItem.get(agreement.queueItemId)!.outcome.kind})
                          </summary>
                          <div style={{ ...mono, fontSize: 11 }}>
                            by {adjudicationByItem.get(agreement.queueItemId)!.adjudicatorId} ·{" "}
                            {adjudicationByItem.get(agreement.queueItemId)!.rationale}
                          </div>
                        </details>
                      ) : (
                        <details style={{ color: "#b91c1c" }}>
                          <summary>REQUIRED ({agreement.adjudication.reasons.length})</summary>
                          <ul>
                            {agreement.adjudication.reasons.map((reason) => (
                              <li key={reason} style={{ fontSize: 11 }}>
                                {reason}
                              </li>
                            ))}
                          </ul>
                          <AdjudicationEditor data={data} queueItemId={agreement.queueItemId} />
                        </details>
                      )
                    ) : agreement.status === "computed" ? (
                      "not required"
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <section style={labBox}>
        <h3>Chance-corrected agreement — Cohen's κ per coach pair (cross-item)</h3>
        <p style={{ color: "#42505f", fontSize: 13, maxWidth: 760 }}>
          κ compares observed cross-item agreement with the chance agreement implied by each coach's
          own label marginals. It is only reported when a pair shares ≥2 evaluable items AND labels
          vary — otherwise “—”, never a fabricated number. Per-item percent agreement stays in the
          table above.
        </p>
        <KappaTable
          title={`Stroke label (${data.schema.strokeTaxonomy.version})`}
          pairs={strokeKappas}
        />
        <KappaTable
          title={`Primary fault (${data.schema.faultTaxonomyVersion}; zero faults ⇒ CLEAN)`}
          pairs={faultKappas}
        />
      </section>
      <section style={labBox}>
        <h3>Adjudicated reviews — export</h3>
        <p style={{ color: "#42505f", fontSize: 13, maxWidth: 760 }}>
          JSON export of every adjudicated queue item: the adjudication record plus the frozen
          disagreeing reviews (latest revision + full amendment history). Synthetic dev fixtures are
          always excluded. Currently <strong>{data.adjudications.length}</strong> adjudication(s) on
          file.
        </p>
        <button
          disabled={data.adjudications.length === 0}
          title={
            data.adjudications.length === 0
              ? "no adjudications exist — nothing to export"
              : "download JSON"
          }
          onClick={() =>
            downloadJson(
              `adjudicated-reviews-${new Date().toISOString().slice(0, 10)}.json`,
              buildAdjudicatedExport(data.reviews, data.amendments, data.adjudications),
            )
          }
        >
          Export adjudicated reviews (JSON)
        </button>
      </section>
      <section style={labBox}>
        <h3>Adjudication flow</h3>
        <ol style={{ color: "#42505f", maxWidth: 760 }}>
          <li>
            A queue item whose computed agreement trips a trigger (stroke mismatch · rating gap ≥2 ·
            primary-fault mismatch) is flagged <strong>REQUIRED</strong> above. Original reviews are
            never edited or averaged.
          </li>
          <li>
            A third qualified coach (not among the original reviewers) reviews the clip blind, then
            sees the disagreeing reviews and records an adjudication:{" "}
            <code style={mono}>datasets/coach-review/adjudications/&lt;queueItemId&gt;.json</code> —{" "}
            {"{"}adjudicatorId, outcome, rationale, timestamps{"}"} (append-only, same identity
            rules as reviews).
          </li>
          <li>
            Consumers (future calibration training sets) use adjudicated truth where it exists and
            PRESERVE the disagreement record alongside it. Full contract: docs/COACHING.md §6.
          </li>
        </ol>
      </section>
    </div>
  );
}
