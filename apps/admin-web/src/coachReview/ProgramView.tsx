import React, { useEffect, useState } from "react";
import { submitMappingProposal, type CoachReviewData, type SubmitResult } from "./data";
import { mappingProposalIdFor } from "./records";
import { labBox, mono } from "./CoachReviewLab";

/** Drill mapping editor: coach-endorsed fault→drill mapping PROPOSALS.
 * Proposals never mutate the curated drill library — they are the evidence
 * trail from which validatedFaultMappings can later be filled by hand. */
function DrillMappingEditor({ data }: { data: CoachReviewData }) {
  const activeCoaches = data.registry.coaches.filter((coach) => coach.status === "active");
  const allFaults = data.taxonomy.families.flatMap((family) => family.faults);
  const [coachId, setCoachId] = useState("");
  const [drillId, setDrillId] = useState(data.drills.drills[0]?.id ?? "");
  const [faultId, setFaultId] = useState(allFaults[0]?.id ?? "");
  const [evidence, setEvidence] = useState("");
  const [rationale, setRationale] = useState("");
  const [result, setResult] = useState<SubmitResult | null>(null);
  const coach = activeCoaches.find((entry) => entry.coachId === coachId);

  return (
    <section style={labBox}>
      <h2>Drill mapping editor — {data.mappingProposals.length} proposal(s) on file</h2>
      <p style={{ color: "#42505f", fontSize: 13, maxWidth: 760 }}>
        A proposal records a provisioned coach's evidence that a drill addresses a fault (against{" "}
        <code style={mono}>{data.drills.version}</code> / <code style={mono}>{data.taxonomy.version}</code>). It is
        append-only input for curation — the library's <code style={mono}>validatedFaultMappings</code> stay EMPTY
        until proposals are reviewed and the library is re-versioned.
      </p>
      {data.mappingProposals.length > 0 && (
        <ul style={{ ...mono, fontSize: 12 }}>
          {data.mappingProposals.map((proposal) => (
            <li key={proposal.proposalId}>
              {proposal.drillId} ← {proposal.faultId} · by {proposal.coachId} · evidence: {proposal.evidence.join(", ")}
            </li>
          ))}
        </ul>
      )}
      {activeCoaches.length === 0 ? (
        <p style={{ color: "#92400e", fontSize: 13, maxWidth: 720 }}>
          No coach identity provisioned — mappings require a real coach to endorse them, so this editor stays
          disabled and the library stays UNVALIDATED.
        </p>
      ) : (
        <div style={{ fontSize: 13 }}>
          <select value={coachId} onChange={(e) => setCoachId(e.target.value)}>
            <option value="">— proposing coach —</option>
            {activeCoaches.map((entry) => (
              <option key={entry.coachId} value={entry.coachId}>
                {entry.coachId}
              </option>
            ))}
          </select>{" "}
          <select value={drillId} onChange={(e) => setDrillId(e.target.value)}>
            {data.drills.drills.map((drill) => (
              <option key={drill.id} value={drill.id}>
                {drill.name} · {drill.id}
              </option>
            ))}
          </select>{" "}
          <select value={faultId} onChange={(e) => setFaultId(e.target.value)}>
            {allFaults.map((fault) => (
              <option key={fault.id} value={fault.id}>
                {fault.id}
              </option>
            ))}
          </select>
          <div style={{ margin: "6px 0" }}>
            <input
              placeholder="evidence refs, comma-separated (e.g. reviewIds; ≥1 required)"
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              style={{ width: 420 }}
            />
          </div>
          <textarea
            placeholder="why this drill addresses this fault (≥20 chars, required)"
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            style={{ width: "100%", maxWidth: 760, minHeight: 40 }}
          />
          <div>
            <button
              disabled={!coach}
              onClick={() => {
                submitMappingProposal({
                  schemaVersion: 1,
                  proposalId: mappingProposalIdFor(drillId, faultId, coachId),
                  drillId,
                  faultId,
                  coachId,
                  coachCredentialRef: coach?.credentialRef ?? "",
                  evidence: evidence
                    .split(",")
                    .map((token) => token.trim())
                    .filter((token) => token !== ""),
                  rationale,
                  createdAtIso: new Date().toISOString(),
                })
                  .then(setResult)
                  .catch((e) => setResult({ ok: false, status: 0, message: String(e) }));
              }}
            >
              Submit mapping proposal (append-only)
            </button>
          </div>
          {result && <p style={{ color: result.ok ? "#15803d" : "#b91c1c" }}>{result.message}</p>}
        </div>
      )}
    </section>
  );
}

/** Program reference: schema, fault-taxonomy draft, drill library, onboarding. */
export function ProgramView({ data }: { data: CoachReviewData }) {
  const [coachingDoc, setCoachingDoc] = useState<string | null>(null);
  useEffect(() => {
    fetch("/docs/COACHING.md")
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then(setCoachingDoc)
      .catch(() => setCoachingDoc(null));
  }, []);

  return (
    <div>
      <section style={labBox}>
        <h2>Program contract</h2>
        <ul style={{ color: "#42505f" }}>
          {Object.entries(data.queue.program).map(([key, value]) => (
            <li key={key}>
              <strong>{key}:</strong> {value}
            </li>
          ))}
        </ul>
        <h3>Artifacts</h3>
        <ul style={mono}>
          {Object.entries(data.queue.artifacts).map(([key, value]) => (
            <li key={key}>
              {key}: {value}
            </li>
          ))}
        </ul>
        <h3>Review record storage</h3>
        <p style={{ color: "#42505f" }}>
          {data.schema.reviewRecord.storage} · reviewId rule: <code style={mono}>{data.schema.reviewRecord.reviewIdRule}</code>
        </p>
        <h3>Quality scale — {data.schema.qualityScale.id}</h3>
        <p style={{ color: "#b45309" }}>{data.schema.qualityScale.status}</p>
        <ol>
          {Object.entries(data.schema.qualityScale.anchors).map(([value, anchor]) => (
            <li key={value} value={Number(value)}>
              {anchor}
            </li>
          ))}
        </ol>
        <h3>Fault severity</h3>
        <ul>
          {Object.entries(data.schema.severityScale).map(([value, meaning]) => (
            <li key={value}>
              <strong>{value}</strong> — {meaning}
            </li>
          ))}
        </ul>
      </section>

      <section style={labBox}>
        <h2>
          Fault taxonomy <code style={mono}>{data.taxonomy.version}</code>
        </h2>
        <p style={{ color: "#b45309", maxWidth: 760 }}>{data.taxonomy.status}</p>
        {data.taxonomy.families.map((family) => (
          <details key={family.family} open={family.family === "global"}>
            <summary>
              <strong>{family.displayName}</strong> ({family.faults.length} draft faults)
            </summary>
            <table cellPadding={6} style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
              <tbody>
                {family.faults.map((fault) => (
                  <tr key={fault.id} style={{ borderBottom: "1px solid #eef2f0", verticalAlign: "top" }}>
                    <td style={{ ...mono, whiteSpace: "nowrap" }}>{fault.id}</td>
                    <td>
                      <strong>{fault.name}</strong> <span style={{ color: "#6b7a75" }}>({fault.typicalPhase})</span>
                      <div>{fault.description}</div>
                      <div style={{ color: "#6b7a75", fontSize: 12 }}>Observable: {fault.observableEvidence}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ))}
      </section>

      <section style={labBox}>
        <h2>
          Drill library <code style={mono}>{data.drills.version}</code>
        </h2>
        <p style={{ color: "#b45309", maxWidth: 760 }}>{data.drills.status}</p>
        <table cellPadding={6} style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "2px solid #dde5e1" }}>
              <th>Drill</th>
              <th>Status</th>
              <th>Techniques</th>
              <th>Validated fault mappings</th>
              <th>Provenance</th>
            </tr>
          </thead>
          <tbody>
            {data.drills.drills.map((drill) => (
              <tr key={drill.id} style={{ borderBottom: "1px solid #eef2f0", verticalAlign: "top" }}>
                <td>
                  <strong>{drill.name}</strong>
                  <div style={{ ...mono, fontSize: 11 }}>{drill.id}</div>
                  <div style={{ color: "#6b7a75", fontSize: 12, maxWidth: 280 }}>{drill.description}</div>
                  <div style={{ fontSize: 12 }}>
                    {drill.difficulty} · {drill.repsOrDuration} · equipment: {drill.equipment.join(", ")}
                  </div>
                </td>
                <td style={{ color: drill.validationStatus === "UNVALIDATED" ? "#b91c1c" : "#15803d", fontWeight: 700 }}>
                  {drill.validationStatus}
                </td>
                <td style={{ ...mono, fontSize: 11 }}>{drill.supportedTechniques.join(", ")}</td>
                <td>
                  {drill.validatedFaultMappings.length === 0 ? (
                    <em style={{ color: "#6b7a75" }}>EMPTY — requires coach evidence</em>
                  ) : (
                    drill.validatedFaultMappings.map((mapping) => mapping.faultId).join(", ")
                  )}
                </td>
                <td style={{ fontSize: 12, color: "#6b7a75", maxWidth: 200 }}>
                  {drill.provenance}
                  <div>coachProvenance: {drill.coachProvenance === null ? "null" : drill.coachProvenance.coachId}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <DrillMappingEditor data={data} />

      <section style={labBox}>
        <h2>Coach onboarding (docs/COACHING.md)</h2>
        {coachingDoc ? (
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, background: "#f8fafc", padding: 12, borderRadius: 8 }}>
            {coachingDoc}
          </pre>
        ) : (
          <p style={{ color: "#b45309" }}>docs/COACHING.md not reachable from the dev server.</p>
        )}
      </section>
    </div>
  );
}
