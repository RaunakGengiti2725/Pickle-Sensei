import React, { useMemo, useState } from "react";
import {
  currentReviewVersion,
  downloadReviewJson,
  submitAmendment,
  submitReview,
  validationContextFrom,
  type CoachReviewData,
  type SubmitResult,
} from "./data";
import { amendmentIdFor, type ReviewAmendment } from "./records";
import { reviewIdFor, type CoachReview, type FaultEntry, type QualityValue, type QueueItem, type Severity, type StrokeConfirmation } from "./types";
import { validateReview } from "./validate";
import { labBox, mono } from "./CoachReviewLab";

/**
 * Structured review form — mirrors CoachReview v2 (schema.json). Honest by
 * construction: with an empty coach registry there is no identity to sign
 * the review with, so persistence AND export stay disabled and the form says
 * exactly why. Typing in the form fabricates nothing: no bytes leave the
 * browser until a provisioned coach submits.
 */

interface FaultDraft {
  faultId: string;
  severity: Severity;
  timestamps: number[];
  region: { x: number; y: number; w: number; h: number } | null;
  rationale: string;
}

const emptyFault = (faultId: string): FaultDraft => ({
  faultId,
  severity: 2,
  timestamps: [],
  region: null,
  rationale: "",
});

/** Primary = first listed fault of highest severity; all others secondary. */
export function primaryFaultIndex(faults: Array<{ severity: Severity }>): number | null {
  if (faults.length === 0) return null;
  const maxSeverity = Math.max(...faults.map((fault) => fault.severity));
  return faults.findIndex((fault) => fault.severity === maxSeverity);
}

export function ReviewForm({
  data,
  item,
  getCurrentMs,
  onPersisted,
}: {
  data: CoachReviewData;
  item: QueueItem;
  getCurrentMs: () => number;
  onPersisted: () => void;
}) {
  const activeCoaches = data.registry.coaches.filter((coach) => coach.status === "active");
  const [coachId, setCoachId] = useState<string>("");
  const [confirmKind, setConfirmKind] = useState<"confirmed" | "corrected" | "cannot_judge">("confirmed");
  const [correctedStroke, setCorrectedStroke] = useState<string>(item.annotatedStrokeV3 ?? "UNKNOWN");
  const [correctedNote, setCorrectedNote] = useState("");
  const [cannotJudgeReason, setCannotJudgeReason] = useState("");
  const [cannotEvaluate, setCannotEvaluate] = useState(false);
  const [cannotEvaluateReason, setCannotEvaluateReason] = useState("");
  const [quality, setQuality] = useState<QualityValue | null>(null);
  const [faults, setFaults] = useState<FaultDraft[]>([]);
  const [drills, setDrills] = useState<Array<{ drillId: string | null; freeText: string }>>([]);
  const [confidence, setConfidence] = useState(0.7);
  const [rationale, setRationale] = useState("");
  const [createdAtIso] = useState(() => new Date().toISOString());
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [amendReason, setAmendReason] = useState("");

  const coach = activeCoaches.find((entry) => entry.coachId === coachId);
  const existingLoaded = data.reviews.find(
    (entry) => !entry.synthetic && entry.review.queueItemId === item.queueItemId && entry.review.coachId === coachId,
  );
  const amendBase = existingLoaded ? currentReviewVersion(existingLoaded.review, data.amendments) : null;
  const relevantFamilies = data.taxonomy.families.filter((family) => item.relevantFaultFamilies.includes(family.family));
  const otherFamilies = data.taxonomy.families.filter((family) => !item.relevantFaultFamilies.includes(family.family));
  const context = useMemo(() => validationContextFrom(data), [data]);

  const buildReview = (): CoachReview => {
    const strokeConfirmation: StrokeConfirmation =
      confirmKind === "confirmed"
        ? { kind: "confirmed", stroke: item.annotatedStrokeV3 ?? "UNKNOWN" }
        : confirmKind === "corrected"
          ? { kind: "corrected", stroke: correctedStroke, note: correctedNote }
          : { kind: "cannot_judge", reason: cannotJudgeReason };
    return {
      schemaVersion: 2,
      reviewId: reviewIdFor(item.queueItemId, coachId || "UNSET"),
      queueItemId: item.queueItemId,
      coachId: coachId || "UNSET",
      coachCredentialRef: coach?.credentialRef ?? "",
      eventRef: item.eventRef,
      strokeTaxonomyVersion: data.schema.strokeTaxonomy.version,
      faultTaxonomyVersion: data.schema.faultTaxonomyVersion,
      drillLibraryVersion: data.schema.drillLibraryVersion,
      strokeConfirmation,
      overallQuality: quality === null ? null : { scaleId: data.schema.qualityScale.id, value: quality },
      faults: faults.map(
        (draft): FaultEntry => ({
          faultId: draft.faultId,
          severity: draft.severity,
          evidence: { timestampsMs: draft.timestamps, region: draft.region },
          rationale: draft.rationale,
        }),
      ),
      drillSuggestions: drills,
      confidence,
      cannotEvaluate: cannotEvaluate ? { reason: cannotEvaluateReason } : null,
      rationale,
      createdAtIso,
      submittedAtIso: new Date().toISOString(),
    };
  };

  const review = buildReview();
  const problems = validateReview(review, context);
  const identityMissing = activeCoaches.length === 0 || !coach;
  const amendReasonMissing = amendBase !== null && amendReason.trim().length < 10;
  const submitBlocked = identityMissing || problems.length > 0 || amendReasonMissing;
  const primaryIndex = primaryFaultIndex(faults);

  return (
    <section style={labBox}>
      <h2>Structured review — {item.queueItemId}</h2>
      <p style={{ color: "#42505f", fontSize: 13, maxWidth: 760 }}>
        Schema v{data.schema.schemaVersion} ({data.schema.reviewRecord.typescriptSource}). Storage:{" "}
        {data.schema.reviewRecord.storage}. Fault taxonomy <strong>{data.schema.faultTaxonomyVersion}</strong> is an{" "}
        <em>engineering draft — pending expert validation</em>: correct it freely in the rationale prose.
      </p>

      {activeCoaches.length === 0 ? (
        <div style={{ background: "#fffbeb", border: "1px solid #b45309", color: "#92400e", borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <strong>No coach identity provisioned.</strong> The coach registry
          (<code style={mono}>datasets/coach-review/coaches.json</code>) has no active entries, so this form cannot
          submit or export anything — reviews on file remain <strong>0</strong>. Provisioning a real coach is a human
          step: docs/COACHING.md §2. The form stays fully explorable so the flow is ready the day a coach exists.
        </div>
      ) : (
        <label style={{ display: "block", marginBottom: 12 }}>
          Reviewing as:{" "}
          <select value={coachId} onChange={(e) => setCoachId(e.target.value)}>
            <option value="">— select provisioned coach —</option>
            {activeCoaches.map((entry) => (
              <option key={entry.coachId} value={entry.coachId}>
                {entry.coachId} (credential {entry.credentialRef})
              </option>
            ))}
          </select>
        </label>
      )}

      <fieldset style={{ border: "1px solid #dde5e1", borderRadius: 8, marginBottom: 12 }}>
        <legend>1 · Stroke confirmation ({data.schema.strokeTaxonomy.version})</legend>
        <label style={{ marginRight: 12 }}>
          <input type="radio" checked={confirmKind === "confirmed"} onChange={() => setConfirmKind("confirmed")} /> confirm{" "}
          <strong>{item.annotatedStrokeV3 ?? "UNKNOWN"}</strong>
        </label>
        <label style={{ marginRight: 12 }}>
          <input type="radio" checked={confirmKind === "corrected"} onChange={() => setConfirmKind("corrected")} /> correct to
        </label>
        {confirmKind === "corrected" && (
          <>
            <select value={correctedStroke} onChange={(e) => setCorrectedStroke(e.target.value)}>
              {data.schema.strokeTaxonomy.labels.map((label) => (
                <option key={label}>{label}</option>
              ))}
            </select>{" "}
            <input placeholder="why (required)" value={correctedNote} onChange={(e) => setCorrectedNote(e.target.value)} style={{ width: 260 }} />
          </>
        )}
        <label style={{ marginLeft: 12 }}>
          <input type="radio" checked={confirmKind === "cannot_judge"} onChange={() => setConfirmKind("cannot_judge")} /> cannot judge
        </label>
        {confirmKind === "cannot_judge" && (
          <input placeholder="reason (required)" value={cannotJudgeReason} onChange={(e) => setCannotJudgeReason(e.target.value)} style={{ width: 260, marginLeft: 8 }} />
        )}
      </fieldset>

      <fieldset style={{ border: "1px solid #dde5e1", borderRadius: 8, marginBottom: 12 }}>
        <legend>2 · Cannot evaluate (first-class outcome)</legend>
        <label>
          <input type="checkbox" checked={cannotEvaluate} onChange={(e) => setCannotEvaluate(e.target.checked)} /> I cannot
          evaluate this clip
        </label>
        {cannotEvaluate && (
          <input
            placeholder="reason (≥10 chars, required)"
            value={cannotEvaluateReason}
            onChange={(e) => setCannotEvaluateReason(e.target.value)}
            style={{ width: 420, marginLeft: 8 }}
          />
        )}
      </fieldset>

      {!cannotEvaluate && (
        <>
          <fieldset style={{ border: "1px solid #dde5e1", borderRadius: 8, marginBottom: 12 }}>
            <legend>
              3 · Overall technique quality — {data.schema.qualityScale.id}{" "}
              <span style={{ color: "#b45309" }}>({data.schema.qualityScale.status})</span>
            </legend>
            <label style={{ display: "block", marginBottom: 6 }}>
              <input type="radio" checked={quality === null} onChange={() => setQuality(null)} /> not assessable
            </label>
            {([1, 2, 3, 4, 5] as QualityValue[]).map((value) => (
              <label key={value} style={{ display: "block", marginBottom: 4 }}>
                <input type="radio" checked={quality === value} onChange={() => setQuality(value)} /> <strong>{value}</strong> —{" "}
                {data.schema.qualityScale.anchors[String(value)]}
              </label>
            ))}
          </fieldset>

          <fieldset style={{ border: "1px solid #dde5e1", borderRadius: 8, marginBottom: 12 }}>
            <legend>
              4 · Faults ({data.schema.faultTaxonomyVersion} — draft, will be revised by coaches) · first fault of highest
              severity = primary; reorder to change which
            </legend>
            {faults.map((draft, index) => (
              <div key={index} style={{ border: "1px dashed #cbd5d1", borderRadius: 8, padding: 8, marginBottom: 8 }}>
                <strong style={{ color: index === primaryIndex ? "#b91c1c" : "#6b7a75", marginRight: 8 }}>
                  {index === primaryIndex ? "PRIMARY" : "secondary"}
                </strong>
                <button
                  disabled={index === 0}
                  title="move up"
                  onClick={() => {
                    const next = [...faults];
                    [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                    setFaults(next);
                  }}
                >
                  ↑
                </button>{" "}
                <button
                  disabled={index === faults.length - 1}
                  title="move down"
                  onClick={() => {
                    const next = [...faults];
                    [next[index + 1], next[index]] = [next[index]!, next[index + 1]!];
                    setFaults(next);
                  }}
                >
                  ↓
                </button>{" "}
                <select
                  value={draft.faultId}
                  onChange={(e) => setFaults(faults.map((f, i) => (i === index ? { ...f, faultId: e.target.value } : f)))}
                >
                  {relevantFamilies.map((family) => (
                    <optgroup key={family.family} label={`${family.displayName} (relevant)`}>
                      {family.faults.map((fault) => (
                        <option key={fault.id} value={fault.id}>
                          {fault.name} · {fault.id}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                  {otherFamilies.map((family) => (
                    <optgroup key={family.family} label={family.displayName}>
                      {family.faults.map((fault) => (
                        <option key={fault.id} value={fault.id}>
                          {fault.name} · {fault.id}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <span style={{ marginLeft: 8 }}>
                  severity{" "}
                  {([1, 2, 3] as Severity[]).map((severity) => (
                    <label key={severity} title={data.schema.severityScale[String(severity)] ?? ""} style={{ marginRight: 6 }}>
                      <input
                        type="radio"
                        checked={draft.severity === severity}
                        onChange={() => setFaults(faults.map((f, i) => (i === index ? { ...f, severity } : f)))}
                      />
                      {severity}
                    </label>
                  ))}
                </span>
                <button onClick={() => setFaults(faults.filter((_, i) => i !== index))} style={{ float: "right" }}>
                  remove
                </button>
                <div style={{ ...mono, fontSize: 11, color: "#6b7a75", margin: "4px 0" }}>
                  {(() => {
                    const definition = data.taxonomy.families.flatMap((f) => f.faults).find((f) => f.id === draft.faultId);
                    return definition ? `${definition.description} Evidence: ${definition.observableEvidence}` : "";
                  })()}
                </div>
                <div style={{ margin: "4px 0" }}>
                  evidence timestamps:{" "}
                  {draft.timestamps.map((tMs, tIndex) => (
                    <span key={tIndex} style={{ ...mono, background: "#eef2f0", borderRadius: 6, padding: "2px 6px", marginRight: 4 }}>
                      {tMs} ms{" "}
                      <a
                        href="#evidence"
                        onClick={(e) => {
                          e.preventDefault();
                          setFaults(
                            faults.map((f, i) => (i === index ? { ...f, timestamps: f.timestamps.filter((_, j) => j !== tIndex) } : f)),
                          );
                        }}
                      >
                        ×
                      </a>
                    </span>
                  ))}
                  <button
                    onClick={() =>
                      setFaults(
                        faults.map((f, i) => (i === index ? { ...f, timestamps: [...f.timestamps, getCurrentMs()] } : f)),
                      )
                    }
                  >
                    mark current video time
                  </button>
                  <label style={{ marginLeft: 12 }}>
                    region (optional, normalized x/y/w/h):{" "}
                    <input
                      type="checkbox"
                      checked={draft.region !== null}
                      onChange={(e) =>
                        setFaults(
                          faults.map((f, i) =>
                            i === index ? { ...f, region: e.target.checked ? { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } : null } : f,
                          ),
                        )
                      }
                    />
                  </label>
                  {draft.region &&
                    (["x", "y", "w", "h"] as const).map((key) => (
                      <input
                        key={key}
                        type="number"
                        min={0}
                        max={1}
                        step={0.01}
                        value={draft.region![key]}
                        title={key}
                        onChange={(e) =>
                          setFaults(
                            faults.map((f, i) =>
                              i === index ? { ...f, region: { ...f.region!, [key]: Number(e.target.value) } } : f,
                            ),
                          )
                        }
                        style={{ width: 56, marginLeft: 4 }}
                      />
                    ))}
                </div>
                <textarea
                  placeholder="per-fault rationale (≥10 chars, required — coach language builds the real taxonomy)"
                  value={draft.rationale}
                  onChange={(e) => setFaults(faults.map((f, i) => (i === index ? { ...f, rationale: e.target.value } : f)))}
                  style={{ width: "100%", minHeight: 40 }}
                />
              </div>
            ))}
            <button onClick={() => setFaults([...faults, emptyFault(relevantFamilies[0]?.faults[0]?.id ?? "global.other_see_rationale")])}>
              + add fault
            </button>
          </fieldset>

          <fieldset style={{ border: "1px solid #dde5e1", borderRadius: 8, marginBottom: 12 }}>
            <legend>5 · Drill suggestions (seeds for the future library — never user-facing recommendations)</legend>
            {drills.map((suggestion, index) => (
              <div key={index} style={{ marginBottom: 6 }}>
                <select
                  value={suggestion.drillId ?? ""}
                  onChange={(e) =>
                    setDrills(drills.map((d, i) => (i === index ? { ...d, drillId: e.target.value === "" ? null : e.target.value } : d)))
                  }
                >
                  <option value="">free text only</option>
                  {data.drills.drills.map((drill) => (
                    <option key={drill.id} value={drill.id}>
                      {drill.name} [{drill.validationStatus}]
                    </option>
                  ))}
                </select>{" "}
                <input
                  placeholder="free text (what/why)"
                  value={suggestion.freeText}
                  onChange={(e) => setDrills(drills.map((d, i) => (i === index ? { ...d, freeText: e.target.value } : d)))}
                  style={{ width: 380 }}
                />{" "}
                <button onClick={() => setDrills(drills.filter((_, i) => i !== index))}>remove</button>
              </div>
            ))}
            <button onClick={() => setDrills([...drills, { drillId: null, freeText: "" }])}>+ add suggestion</button>
          </fieldset>
        </>
      )}

      <fieldset style={{ border: "1px solid #dde5e1", borderRadius: 8, marginBottom: 12 }}>
        <legend>6 · Confidence &amp; rationale</legend>
        <label>
          confidence {confidence.toFixed(2)}{" "}
          <input type="range" min={0} max={1} step={0.05} value={confidence} onChange={(e) => setConfidence(Number(e.target.value))} />
        </label>
        <div style={{ ...mono, fontSize: 11, color: "#6b7a75" }}>{data.schema.confidenceSemantics}</div>
        {!cannotEvaluate && (
          <textarea
            placeholder="review-level rationale (≥20 chars, required — the prose is the signal)"
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            style={{ width: "100%", minHeight: 64, marginTop: 8 }}
          />
        )}
      </fieldset>

      {problems.length > 0 && (
        <details style={{ marginBottom: 8, color: "#b45309" }}>
          <summary>{problems.length} validation problem(s) — submit stays disabled</summary>
          <ul>
            {problems.map((problem) => (
              <li key={problem} style={{ fontSize: 12 }}>
                {problem}
              </li>
            ))}
          </ul>
        </details>
      )}

      {amendBase && (
        <div style={{ background: "#eff6ff", border: "1px solid #1d4ed8", borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <strong>Amendment mode:</strong> {coachId} already has revision {amendBase.revision} of{" "}
          <code style={mono}>{amendBase.review.reviewId}</code> on file. The original is never edited — submitting
          appends a full replacement record as revision {amendBase.revision + 1}.
          <div>
            <input
              placeholder="amendment reason (≥10 chars, required)"
              value={amendReason}
              onChange={(e) => setAmendReason(e.target.value)}
              style={{ width: 420, marginTop: 6 }}
            />
          </div>
        </div>
      )}
      <button
        disabled={submitBlocked}
        title={
          identityMissing
            ? "no coach identity provisioned"
            : problems.length > 0
              ? "fix validation problems"
              : amendReasonMissing
                ? "amendment reason required"
                : amendBase
                  ? "append amendment"
                  : "persist review"
        }
        onClick={() => {
          const submission = amendBase
            ? (() => {
                const revision = amendBase.revision + 1;
                const amendment: ReviewAmendment = {
                  schemaVersion: 1,
                  amendmentId: amendmentIdFor(amendBase.review.reviewId, revision),
                  reviewId: amendBase.review.reviewId,
                  revision,
                  reason: amendReason,
                  review: buildReview(),
                  createdAtIso: new Date().toISOString(),
                };
                return submitAmendment(amendment);
              })()
            : submitReview(buildReview());
          submission
            .then((submitResult) => {
              setResult(submitResult);
              if (submitResult.ok) onPersisted();
            })
            .catch((e) => setResult({ ok: false, status: 0, message: String(e) }));
        }}
        style={{ padding: "8px 16px", fontWeight: 700 }}
      >
        {amendBase ? `Submit amendment (revision ${amendBase.revision + 1}, append-only)` : "Submit review (append-only)"}
      </button>{" "}
      <button disabled={submitBlocked} onClick={() => downloadReviewJson(buildReview())} title={identityMissing ? "no coach identity provisioned" : "download the exact JSON that would be persisted"}>
        Download review JSON
      </button>
      {identityMissing && (
        <span style={{ marginLeft: 12, color: "#92400e" }}>
          submission disabled — no coach identity provisioned
        </span>
      )}
      {result && (
        <p style={{ color: result.ok ? "#15803d" : "#b91c1c" }}>
          {result.ok ? `✓ ${result.message} → ${result.path ?? ""} — rerun \`pnpm lab:coach-queue\` to refresh queue counts` : `✗ ${result.message}`}
        </p>
      )}
      <p style={{ ...mono, fontSize: 11, color: "#6b7a75" }}>
        would persist as:{" "}
        {amendBase
          ? `datasets/coach-review/amendments/${amendmentIdFor(review.reviewId, amendBase.revision + 1)}.json`
          : `datasets/coach-review/reviews/${review.reviewId}.json`}
      </p>
    </section>
  );
}
