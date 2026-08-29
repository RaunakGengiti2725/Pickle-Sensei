import React, { useEffect, useState } from "react";
import type { CoachReviewData } from "./data";
import { labBox, mono } from "./CoachReviewLab";

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
