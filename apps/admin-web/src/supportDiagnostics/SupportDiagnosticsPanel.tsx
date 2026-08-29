import React, { useCallback, useState } from "react";
import {
  describeFailureCategory,
  failureCategoryTone,
  findForbiddenKeys,
  formatLatencyMs,
} from "./format";
import type { SupportAnalysisDiagnostics, SupportAnalysisListEntry } from "./types";

/**
 * Support diagnostics panel (directive §45): audited, privacy-limited
 * "why did this analysis fail" lookup over the admin API. Renders only the
 * allowlisted report; any payload containing a forbidden key is refused
 * client-side (defense in depth on top of the server allowlist).
 */

const box: React.CSSProperties = {
  border: "1px solid #dde5e1",
  borderRadius: 12,
  padding: 16,
  marginBottom: 16,
  fontFamily: "ui-sans-serif, system-ui",
};

const TONE_COLORS = { ok: "#15803d", pending: "#b45309", bad: "#b91c1c" } as const;

function useApi(token: string) {
  return useCallback(
    async (path: string) => {
      const response = await fetch(path, {
        headers: { authorization: `Bearer ${token}` },
      });
      const json = (await response.json().catch(() => null)) as
        (Record<string, unknown> & { error?: { code: string; message: string } }) | null;
      if (!response.ok) throw new Error(json?.error?.message ?? `HTTP ${response.status}`);
      const leaks = findForbiddenKeys(json);
      if (leaks.length > 0) {
        throw new Error(
          `refusing to render: response contains forbidden keys (${leaks.join(", ")})`,
        );
      }
      return json;
    },
    [token],
  );
}

function CategoryBadge({ diagnostics }: { diagnostics: SupportAnalysisDiagnostics }) {
  const tone = failureCategoryTone(diagnostics.failureCategory);
  return (
    <span style={{ color: TONE_COLORS[tone], fontWeight: 700 }}>
      {describeFailureCategory(diagnostics.failureCategory)}
    </span>
  );
}

export function SupportDiagnosticsPanel({ token }: { token: string }) {
  const api = useApi(token);
  const [analysisId, setAnalysisId] = useState("");
  const [userId, setUserId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<SupportAnalysisDiagnostics | null>(null);
  const [list, setList] = useState<SupportAnalysisListEntry[] | null>(null);

  return (
    <section style={box}>
      <h2>Support diagnostics (audited, privacy-limited)</h2>
      <p style={{ color: "#42505f" }}>
        Why did this analysis fail? Job state, failure category, latency, pipeline and app/device
        versions only — never raw media or account identity.
      </p>
      {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
      <div>
        <input
          placeholder="analysis uuid"
          value={analysisId}
          onChange={(e) => setAnalysisId(e.target.value)}
          style={{ width: 320 }}
        />
        <button
          onClick={() => {
            setError(null);
            api(`/v1/admin/support/analyses/${analysisId}`)
              .then((json) =>
                setReport((json as { diagnostics: SupportAnalysisDiagnostics }).diagnostics),
              )
              .catch((e) => setError(String(e)));
          }}
        >
          Inspect analysis
        </button>
      </div>
      <div style={{ marginTop: 8 }}>
        <input
          placeholder="user uuid (recent analyses)"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          style={{ width: 320 }}
        />
        <button
          onClick={() => {
            setError(null);
            api(`/v1/admin/support/users/${userId}/analyses`)
              .then((json) => setList((json as { analyses: SupportAnalysisListEntry[] }).analyses))
              .catch((e) => setError(String(e)));
          }}
        >
          List analyses
        </button>
      </div>
      {report && (
        <dl>
          <dt>Outcome</dt>
          <dd>
            <CategoryBadge diagnostics={report} />
            {report.failureCode ? ` (${report.failureCode})` : ""}
          </dd>
          <dt>Server job state</dt>
          <dd>
            {report.serverJobState} · {report.inferenceMode} · permit {report.permit.status ?? "—"}/
            {report.permit.outcome ?? "—"}
          </dd>
          <dt>Latency</dt>
          <dd>
            queue {formatLatencyMs(report.latency.queueMs)} · processing{" "}
            {formatLatencyMs(report.latency.processingMs)} · total{" "}
            {formatLatencyMs(report.latency.totalMs)}
          </dd>
          <dt>Media / session</dt>
          <dd>
            {report.hasMedia ? `media: ${report.mediaStatus ?? "unknown"}` : "no media"} ·{" "}
            {report.hasSession ? "in session" : "no session"} · shot result:{" "}
            {report.shotResultKind ?? "—"}
          </dd>
          <dt>Pipeline versions</dt>
          <dd>
            {Object.entries(report.pipelineVersions)
              .map(([key, value]) => `${key}=${value}`)
              .join(", ") || "—"}
          </dd>
          <dt>Device</dt>
          <dd>
            {report.device
              ? `${report.device.platform} ${report.device.model ?? ""} · app ${
                  report.device.appVersion ?? "—"
                } · os ${report.device.osVersion ?? "—"} · tier ${
                  report.device.deviceTier ?? "—"
                } · bundle ${report.device.modelBundleVersion ?? "—"}`
              : "no registered device"}
          </dd>
        </dl>
      )}
      {list && (
        <table cellPadding={6}>
          <thead>
            <tr>
              <th>analysis</th>
              <th>state</th>
              <th>category</th>
              <th>requested</th>
              <th>total latency</th>
            </tr>
          </thead>
          <tbody>
            {list.map((entry) => (
              <tr key={entry.analysisId}>
                <td style={{ fontFamily: "ui-monospace, monospace" }}>{entry.analysisId}</td>
                <td>{entry.serverJobState}</td>
                <td style={{ color: TONE_COLORS[failureCategoryTone(entry.failureCategory)] }}>
                  {describeFailureCategory(entry.failureCategory)}
                </td>
                <td>{entry.requestedAt}</td>
                <td>{formatLatencyMs(entry.latency.totalMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
