import React, { useEffect, useState } from "react";
import { loadCoachReviewData, type CoachReviewData } from "./data";
import { SYNTHETIC_BANNER } from "./syntheticFixtures";
import type { QueueItem } from "./types";
import { EventDetail } from "./EventDetail";
import { AgreementView } from "./AgreementView";
import { ProgramView } from "./ProgramView";

/**
 * COACH REVIEW LAB — file-based console over datasets/coach-review/*.
 * No API token needed: the vite dev middleware serves the repo artifacts
 * read-only, and the single write path (persisting a review) is gated on the
 * human-managed coach registry, which is empty until a real coach exists.
 */

export const labBox: React.CSSProperties = {
  border: "1px solid #dde5e1",
  borderRadius: 12,
  padding: 16,
  marginBottom: 16,
  fontFamily: "ui-sans-serif, system-ui",
};

export const mono: React.CSSProperties = { fontFamily: "ui-monospace, monospace", fontSize: 12 };

export function useHashRoute(): string {
  const [hash, setHash] = useState(window.location.hash || "#/coach");
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || "#/coach");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

function reviewCountFor(data: CoachReviewData, queueItemId: string): { real: number; synthetic: number } {
  const forItem = data.reviews.filter((entry) => entry.review.queueItemId === queueItemId);
  return {
    real: forItem.filter((entry) => !entry.synthetic).length,
    synthetic: forItem.filter((entry) => entry.synthetic).length,
  };
}

function QueueList({ data }: { data: CoachReviewData }) {
  return (
    <section style={labBox}>
      <h2>Review queue — {data.queue.queue.length} gold StrokeEvents</h2>
      <p style={{ color: "#42505f", maxWidth: 720 }}>
        Each item needs ≥{data.queue.queue[0]?.requiredReviewsTarget ?? 2} independent qualified-coach
        reviews. Generated {data.queue.generatedAtIso} · stroke taxonomy{" "}
        <code style={mono}>{data.schema.strokeTaxonomy.version}</code> · fault taxonomy{" "}
        <code style={mono}>{data.schema.faultTaxonomyVersion}</code> (draft).
      </p>
      <table cellPadding={8} style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "2px solid #dde5e1" }}>
            <th>Queue item</th>
            <th>Annotated stroke (v3)</th>
            <th>Event window</th>
            <th>Bundle</th>
            <th>Reviews</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.queue.queue.map((item: QueueItem) => {
            const counts = reviewCountFor(data, item.queueItemId);
            return (
              <tr key={item.queueItemId} style={{ borderBottom: "1px solid #eef2f0", verticalAlign: "top" }}>
                <td>
                  <strong>{item.queueItemId}</strong>
                  <div style={{ ...mono, color: "#6b7a75" }}>{item.video.split("/").pop()}</div>
                </td>
                <td>
                  {item.annotatedStrokeV3 ?? "—"}
                  <div style={{ color: "#6b7a75", fontSize: 12 }}>family: {item.strokeFamily}</div>
                </td>
                <td style={mono}>
                  {item.windowMs.start}–{item.windowMs.end} ms
                  <div>contact {item.contactMs ?? "—"} ms</div>
                </td>
                <td style={{ fontSize: 12, color: "#42505f", maxWidth: 220 }}>
                  role {item.bundle.role} · annotator {item.bundle.annotatorId} (conf{" "}
                  {item.bundle.annotatorConfidence}) · {item.bundle.analyzable ? "analyzable" : "NOT analyzable"}
                  {item.bundle.eventNote ? <div>“{item.bundle.eventNote}”</div> : null}
                </td>
                <td>
                  <strong style={{ color: counts.real === 0 ? "#b45309" : "#15803d" }}>
                    {counts.real}/{item.requiredReviewsTarget}
                  </strong>{" "}
                  real
                  {counts.synthetic > 0 && (
                    <div style={{ color: "#b91c1c", fontSize: 12 }}>+{counts.synthetic} SYNTHETIC (dev)</div>
                  )}
                </td>
                <td>
                  <a href={`#/coach/item/${item.queueItemId}`}>open →</a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

export function CoachReviewLab() {
  const [data, setData] = useState<CoachReviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hash = useHashRoute();

  const reload = () => {
    loadCoachReviewData()
      .then(setData)
      .catch((e) => setError(String(e)));
  };
  useEffect(reload, []);

  if (error) {
    return (
      <section style={labBox}>
        <h2>Coach Review Lab</h2>
        <p style={{ color: "#b91c1c" }}>{error}</p>
        <p>
          The lab reads <code style={mono}>datasets/coach-review/*</code> via the vite dev middleware. Run{" "}
          <code style={mono}>pnpm lab:coach-queue</code> at the repo root, then reload.
        </p>
      </section>
    );
  }
  if (!data) return <p style={{ fontFamily: "ui-sans-serif, system-ui" }}>Loading queue…</p>;

  const activeCoaches = data.registry.coaches.filter((coach) => coach.status === "active");
  const realReviews = data.reviews.filter((entry) => !entry.synthetic);

  const itemMatch = /^#\/coach\/item\/(.+)$/.exec(hash);
  const view = itemMatch ? "item" : hash.startsWith("#/coach/agreement") ? "agreement" : hash.startsWith("#/coach/program") ? "program" : "queue";
  const item = itemMatch ? data.queue.queue.find((entry) => entry.queueItemId === decodeURIComponent(itemMatch[1]!)) : undefined;

  return (
    <div>
      {data.syntheticMode && (
        <div style={{ ...labBox, background: "#fef2f2", border: "2px solid #b91c1c", color: "#b91c1c", fontWeight: 600 }}>
          {SYNTHETIC_BANNER}
        </div>
      )}
      {data.problems.map((problem) => (
        <div key={problem} style={{ ...labBox, background: "#fffbeb", border: "1px solid #b45309", color: "#b45309" }}>
          {problem}
        </div>
      ))}
      <section style={{ ...labBox, background: "#f8fafc" }}>
        <strong>Program status:</strong> {data.queue.status}
        <div style={{ marginTop: 8, color: "#42505f" }}>
          Provisioned coaches: <strong>{activeCoaches.length}</strong> · reviews on file:{" "}
          <strong>{realReviews.length}</strong>
          {activeCoaches.length === 0 && (
            <>
              {" "}
              — <em>no coach identity provisioned; submissions are disabled (recruitment is a human step, see{" "}
              <a href="#/coach/program">program &amp; onboarding</a>)</em>
            </>
          )}
        </div>
      </section>
      <nav style={{ marginBottom: 16, fontFamily: "ui-sans-serif, system-ui" }}>
        <a href="#/coach" style={{ marginRight: 16, fontWeight: view === "queue" ? 700 : 400 }}>
          Queue
        </a>
        <a href="#/coach/agreement" style={{ marginRight: 16, fontWeight: view === "agreement" ? 700 : 400 }}>
          Inter-coach agreement
        </a>
        <a href="#/coach/program" style={{ fontWeight: view === "program" ? 700 : 400 }}>
          Program: taxonomy · drills · onboarding
        </a>
      </nav>
      {view === "queue" && <QueueList data={data} />}
      {view === "item" &&
        (item ? (
          <EventDetail data={data} item={item} onPersisted={reload} />
        ) : (
          <p>Unknown queue item. <a href="#/coach">Back to queue</a></p>
        ))}
      {view === "agreement" && <AgreementView data={data} />}
      {view === "program" && <ProgramView data={data} />}
    </div>
  );
}
