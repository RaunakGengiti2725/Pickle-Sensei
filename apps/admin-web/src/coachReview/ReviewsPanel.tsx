import React, { useState } from "react";
import { currentReviewVersion, submitAssignment, type CoachReviewData, type SubmitResult } from "./data";
import { canSeeOtherReviews } from "./blind";
import type { CoachReview, QueueItem } from "./types";
import { labBox, mono } from "./CoachReviewLab";

function ReviewCard({ data, review, synthetic }: { data: CoachReviewData; review: CoachReview; synthetic: boolean }) {
  const { review: current, revision, history } = currentReviewVersion(review, data.amendments);
  const primary =
    current.faults.length === 0
      ? null
      : current.faults.find(
          (fault) => fault.severity === Math.max(...current.faults.map((entry) => entry.severity)),
        );
  return (
    <div style={{ border: "1px dashed #cbd5d1", borderRadius: 8, padding: 8, marginBottom: 8, fontSize: 13 }}>
      <strong>{current.coachId}</strong> {synthetic && <span style={{ color: "#b91c1c" }}>SYNTHETIC (dev)</span>} ·
      rev {revision}
      {history.length > 0 && (
        <span style={{ color: "#6b7a75" }}>
          {" "}
          (amended ×{history.length}: {history.map((entry) => `r${entry.revision} — ${entry.reason}`).join("; ")})
        </span>
      )}
      <div>
        stroke:{" "}
        {current.strokeConfirmation.kind === "cannot_judge"
          ? `cannot judge (${current.strokeConfirmation.reason})`
          : `${current.strokeConfirmation.kind} ${current.strokeConfirmation.stroke}`}{" "}
        · quality: {current.overallQuality?.value ?? "—"} · confidence {current.confidence}
        {current.cannotEvaluate && <span style={{ color: "#b45309" }}> · CANNOT EVALUATE: {current.cannotEvaluate.reason}</span>}
      </div>
      {current.faults.length > 0 && (
        <ul style={{ margin: "4px 0" }}>
          {current.faults.map((fault) => (
            <li key={fault.faultId} style={mono}>
              {fault === primary ? <strong>[primary]</strong> : "[secondary]"} {fault.faultId} · sev {fault.severity} @{" "}
              {fault.evidence.timestampsMs.join(", ")} ms — {fault.rationale}
            </li>
          ))}
        </ul>
      )}
      {current.rationale && <div style={{ color: "#42505f" }}>“{current.rationale}”</div>}
    </div>
  );
}

/** Existing reviews for one queue item, gated by the blind policy. */
export function ReviewsPanel({ data, item }: { data: CoachReviewData; item: QueueItem }) {
  const activeCoaches = data.registry.coaches.filter((coach) => coach.status === "active");
  const [viewerCoachId, setViewerCoachId] = useState<string>("");
  const loaded = data.reviews.filter((entry) => entry.review.queueItemId === item.queueItemId);
  const real = loaded.filter((entry) => !entry.synthetic).map((entry) => entry.review);
  const visible = canSeeOtherReviews(item, real, viewerCoachId || null);
  const shown = visible ? loaded : loaded.filter((entry) => entry.review.coachId === viewerCoachId);

  return (
    <section style={labBox}>
      <h3>
        Existing reviews — {real.length} real
        {loaded.length - real.length > 0 && <span style={{ color: "#b91c1c" }}> (+{loaded.length - real.length} synthetic dev)</span>}
      </h3>
      <label style={{ display: "block", marginBottom: 8 }}>
        Viewing as:{" "}
        <select value={viewerCoachId} onChange={(e) => setViewerCoachId(e.target.value)}>
          <option value="">— observer (no coach identity) —</option>
          {activeCoaches.map((coach) => (
            <option key={coach.coachId} value={coach.coachId}>
              {coach.coachId}
            </option>
          ))}
        </select>
      </label>
      {!visible && (
        <p style={{ color: "#b45309", fontSize: 13, maxWidth: 720 }}>
          <strong>Blind review in progress:</strong> contents are hidden until this item reaches{" "}
          {item.requiredReviewsTarget} real reviews, or until the viewing coach has submitted their own review.
          Counts stay visible; reviews stay independent.
        </p>
      )}
      {shown.length === 0 && visible && <p style={{ color: "#6b7a75", fontSize: 13 }}>No reviews on file for this item.</p>}
      {shown.map((entry) => (
        <ReviewCard key={entry.review.reviewId + entry.source} data={data} review={entry.review} synthetic={entry.synthetic} />
      ))}
    </section>
  );
}

/** Multi-coach assignment per queue item (admin workflow config, registry-gated). */
export function AssignmentPanel({ data, item, onSaved }: { data: CoachReviewData; item: QueueItem; onSaved: () => void }) {
  const activeCoaches = data.registry.coaches.filter((coach) => coach.status === "active");
  const existing = data.assignments.assignments.find((entry) => entry.queueItemId === item.queueItemId);
  const [selected, setSelected] = useState<string[]>(existing?.coachIds ?? []);
  const [assignedBy, setAssignedBy] = useState("");
  const [result, setResult] = useState<SubmitResult | null>(null);

  return (
    <section style={labBox}>
      <h3>Coach assignment — {existing ? `${existing.coachIds.length} assigned` : "unassigned"}</h3>
      {existing && (
        <p style={{ ...mono, fontSize: 12 }}>
          {existing.coachIds.join(", ")} · by {existing.assignedBy} @ {existing.assignedAtIso}
        </p>
      )}
      {activeCoaches.length === 0 ? (
        <p style={{ color: "#92400e", fontSize: 13, maxWidth: 720 }}>
          No coach identity provisioned — nothing can be assigned. This panel unlocks the day coaches exist in{" "}
          <code style={mono}>datasets/coach-review/coaches.json</code>.
        </p>
      ) : (
        <>
          {activeCoaches.map((coach) => (
            <label key={coach.coachId} style={{ marginRight: 12 }}>
              <input
                type="checkbox"
                checked={selected.includes(coach.coachId)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked ? [...selected, coach.coachId] : selected.filter((id) => id !== coach.coachId),
                  )
                }
              />{" "}
              {coach.coachId}
            </label>
          ))}
          <input placeholder="assignedBy (admin identity)" value={assignedBy} onChange={(e) => setAssignedBy(e.target.value)} />{" "}
          <button
            disabled={selected.length === 0 || assignedBy.trim() === ""}
            onClick={() => {
              submitAssignment({
                queueItemId: item.queueItemId,
                coachIds: selected,
                assignedAtIso: new Date().toISOString(),
                assignedBy,
              })
                .then((submitResult) => {
                  setResult(submitResult);
                  if (submitResult.ok) onSaved();
                })
                .catch((e) => setResult({ ok: false, status: 0, message: String(e) }));
            }}
          >
            Save assignment
          </button>
        </>
      )}
      {result && <p style={{ color: result.ok ? "#15803d" : "#b91c1c" }}>{result.message}</p>}
    </section>
  );
}
