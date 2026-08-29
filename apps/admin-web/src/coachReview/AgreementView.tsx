import React from "react";
import { computeAllAgreements } from "./agreement";
import type { CoachReviewData } from "./data";
import { labBox, mono } from "./CoachReviewLab";

const formatRate = (rate: number | null): string => (rate === null ? "—" : `${Math.round(rate * 100)}%`);
const formatNumber = (value: number | null): string => (value === null ? "—" : value.toFixed(2));

/**
 * Inter-coach agreement. The computation (agreement.ts, unit-tested on
 * synthetic fixtures) runs on whatever reviews exist; with today's truthful
 * zero, every row is "awaiting reviews". Open with ?synthetic=1 to exercise
 * the computed/adjudication states against the flagged dev fixtures.
 */
export function AgreementView({ data }: { data: CoachReviewData }) {
  const reviews = data.reviews.map((entry) => entry.review);
  const agreements = computeAllAgreements(data.queue.queue, reviews);
  const anyComputed = agreements.some((agreement) => agreement.status === "computed");

  return (
    <div>
      <section style={labBox}>
        <h2>Inter-coach agreement</h2>
        <p style={{ color: "#42505f", maxWidth: 760 }}>
          Policy: {data.queue.program.disagreementPolicy}. Metrics ({data.queue.program.agreementMetrics}) are
          pairwise over evaluable reviews; <em>cannot-evaluate</em> outcomes are counted, never imputed. Agreement is
          computed once a queue item has ≥2 evaluable reviews.
        </p>
        {!anyComputed && !data.syntheticMode && (
          <p style={{ color: "#b45309" }}>
            <strong>Awaiting reviews:</strong> 0 coach reviews exist, so no agreement can be computed yet. The
            computation is implemented and unit-tested (apps/admin-web/src/coachReview/agreement.ts); append{" "}
            <code style={mono}>?synthetic=1</code> to the URL to see it exercise flagged dev fixtures.
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
            {agreements.map((agreement) => (
              <tr key={agreement.queueItemId} style={{ borderBottom: "1px solid #eef2f0", verticalAlign: "top" }}>
                <td>
                  <a href={`#/coach/item/${agreement.queueItemId}`}>{agreement.queueItemId}</a>
                </td>
                <td>
                  {agreement.reviewCount}/{agreement.requiredReviewsTarget}
                  {agreement.cannotEvaluateCount > 0 && (
                    <div style={{ color: "#6b7a75", fontSize: 11 }}>{agreement.cannotEvaluateCount} cannot-evaluate</div>
                  )}
                </td>
                <td style={{ color: agreement.status === "computed" ? "#15803d" : "#b45309" }}>
                  {agreement.status === "computed" ? "computed" : "awaiting reviews"}
                </td>
                <td>{formatRate(agreement.stroke.rate)}</td>
                <td>
                  {formatRate(agreement.rating.exactMatchRate)} / {formatNumber(agreement.rating.meanAbsDiff)}
                </td>
                <td>{formatRate(agreement.primaryFault.rate)}</td>
                <td>
                  {formatRate(agreement.severity.exactRate)} / {formatNumber(agreement.severity.meanAbsDiff)}
                </td>
                <td>{formatNumber(agreement.faultOverlap.meanJaccard)}</td>
                <td>
                  {agreement.adjudication.required ? (
                    <details style={{ color: "#b91c1c" }}>
                      <summary>REQUIRED ({agreement.adjudication.reasons.length})</summary>
                      <ul>
                        {agreement.adjudication.reasons.map((reason) => (
                          <li key={reason} style={{ fontSize: 11 }}>
                            {reason}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : agreement.status === "computed" ? (
                    "not required"
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section style={labBox}>
        <h3>Adjudication flow (stub — no adjudications can exist before reviews)</h3>
        <ol style={{ color: "#42505f", maxWidth: 760 }}>
          <li>
            A queue item whose computed agreement trips a trigger (stroke mismatch · rating gap ≥2 · primary-fault
            mismatch) is flagged <strong>REQUIRED</strong> above. Original reviews are never edited or averaged.
          </li>
          <li>
            A third qualified coach (not among the original reviewers) reviews the clip blind, then sees the
            disagreeing reviews and records an adjudication:{" "}
            <code style={mono}>
              datasets/coach-review/adjudications/&lt;queueItemId&gt;.json
            </code>{" "}
            — {"{"}adjudicatorId, outcome, rationale, timestamps{"}"} (append-only, same identity rules as reviews).
          </li>
          <li>
            Consumers (future calibration training sets) use adjudicated truth where it exists and PRESERVE the
            disagreement record alongside it. Full contract: docs/COACHING.md §6.
          </li>
        </ol>
      </section>
    </div>
  );
}
