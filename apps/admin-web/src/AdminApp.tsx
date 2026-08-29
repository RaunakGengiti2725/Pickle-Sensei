import React, { useCallback, useEffect, useState } from "react";
import { CoachReviewLab, useHashRoute } from "./coachReview/CoachReviewLab";

/**
 * Internal admin console (directive §45): feature flags, model bundles,
 * user lookup, drill review. Auth: paste an admin bearer token (OIDC in
 * staging/production; the API's dev issuer locally). Every admin read/write
 * is audited server-side.
 *
 * The COACH REVIEW LAB (#/coach) is file-based over datasets/coach-review/*
 * (vite dev middleware) and needs no token: reads are repo artifacts, and
 * the only write path is gated on the human-managed coach registry.
 */

const box: React.CSSProperties = {
  border: "1px solid #dde5e1",
  borderRadius: 12,
  padding: 16,
  marginBottom: 16,
  fontFamily: "ui-sans-serif, system-ui",
};

function useApi(token: string) {
  return useCallback(
    async (method: string, path: string, body?: unknown) => {
      const response = await fetch(path, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const json = (await response.json().catch(() => null)) as
        (Record<string, unknown> & { error?: { code: string; message: string } }) | null;
      if (!response.ok) throw new Error(json?.error?.message ?? `HTTP ${response.status}`);
      return json;
    },
    [token],
  );
}

interface QualityRate {
  numerator: number;
  denominator: number;
  rate: number | null;
}

interface QualityDashboard {
  schemaVersion: string;
  generatedAtIso: string;
  windowDays: number;
  trials: {
    attempts: number;
    outcomeCounts: Record<string, number>;
    completion: QualityRate;
    usableResult: QualityRate;
    abstention: QualityRate;
    envelopeRejection: QualityRate;
    targetLockSuccess: QualityRate;
    strokeDistribution: Array<{ key: string; count: number }>;
    latency: {
      measuredCount: number;
      p50Ms: number | null;
      p90Ms: number | null;
      p99Ms: number | null;
    };
    modelVersionDistribution: Array<{ key: string; count: number }>;
    userReportedWrongTrialCount: number;
  };
  sessions: { started: number; completed: number; completion: QualityRate };
  crashFree:
    { status: "measured"; rate: number | null } | { status: "not_evaluable"; reason: string };
  backend: {
    analysisJobs: { requested: number; failed: number; failureRate: QualityRate };
    deletionTasksFailed: number;
    apiErrors: { status: "not_evaluable"; reason: string } | QualityRate;
  };
  queues: {
    analysisQueued: number;
    analysisProcessing: number;
    oldestAnalysisQueuedAgeSeconds: number | null;
    deletionQueued: number;
    deletionProcessing: number;
  };
  review: {
    userReportedWrongShotRatings: number;
    coachReviewQueueDepth: number;
    silentFailureQueueDepth: number;
    coachReviewsRecorded: number;
  };
}

function pct(r: QualityRate): string {
  return r.rate === null
    ? "n/a (0 denominator)"
    : `${(r.rate * 100).toFixed(1)}% (${r.numerator}/${r.denominator})`;
}

function QualityDashboardPanel({ token }: { token: string }) {
  const api = useApi(token);
  const [windowDays, setWindowDays] = useState(7);
  const [data, setData] = useState<QualityDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api("GET", `/v1/admin/quality-dashboard?windowDays=${windowDays}`)
      .then((json) => setData(json as unknown as QualityDashboard))
      .catch((e) => setError(String(e)));
  }, [api, windowDays]);
  useEffect(load, [load]);

  return (
    <section style={box}>
      <h2>Quality dashboard (audited; aggregates only, never private media)</h2>
      <label>
        {"window days "}
        <input
          type="number"
          min={1}
          max={90}
          value={windowDays}
          onChange={(e) => setWindowDays(Number(e.target.value))}
          style={{ width: 64 }}
        />
      </label>
      <button onClick={load}>Refresh</button>
      {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
      {data && (
        <table cellPadding={6}>
          <tbody>
            <tr>
              <td>Trial attempts (consented)</td>
              <td>{data.trials.attempts}</td>
            </tr>
            <tr>
              <td>Completion</td>
              <td>{pct(data.trials.completion)}</td>
            </tr>
            <tr>
              <td>Usable-result rate</td>
              <td>{pct(data.trials.usableResult)}</td>
            </tr>
            <tr>
              <td>Abstention</td>
              <td>{pct(data.trials.abstention)}</td>
            </tr>
            <tr>
              <td>Envelope rejection</td>
              <td>{pct(data.trials.envelopeRejection)}</td>
            </tr>
            <tr>
              <td>Target-lock success</td>
              <td>{pct(data.trials.targetLockSuccess)}</td>
            </tr>
            <tr>
              <td>Stroke distribution</td>
              <td>
                {data.trials.strokeDistribution.map((s) => `${s.key}: ${s.count}`).join(", ") ||
                  "none"}
              </td>
            </tr>
            <tr>
              <td>Latency p50/p90/p99 (ms)</td>
              <td>
                {data.trials.latency.measuredCount === 0
                  ? "unmeasured"
                  : `${data.trials.latency.p50Ms} / ${data.trials.latency.p90Ms} / ${data.trials.latency.p99Ms} (n=${data.trials.latency.measuredCount})`}
              </td>
            </tr>
            <tr>
              <td>Model versions</td>
              <td>
                {data.trials.modelVersionDistribution
                  .map((m) => `${m.key}: ${m.count}`)
                  .join(", ") || "none"}
              </td>
            </tr>
            <tr>
              <td>User-flagged trials</td>
              <td>{data.trials.userReportedWrongTrialCount}</td>
            </tr>
            <tr>
              <td>Session completion</td>
              <td>{pct(data.sessions.completion)}</td>
            </tr>
            <tr>
              <td>Crash-free rate</td>
              <td>
                {data.crashFree.status === "not_evaluable"
                  ? `NOT_EVALUABLE — ${data.crashFree.reason}`
                  : String(data.crashFree.rate)}
              </td>
            </tr>
            <tr>
              <td>Analysis-job failures</td>
              <td>{pct(data.backend.analysisJobs.failureRate)}</td>
            </tr>
            <tr>
              <td>Deletion tasks failed</td>
              <td>{data.backend.deletionTasksFailed}</td>
            </tr>
            <tr>
              <td>API errors</td>
              <td>
                {"status" in data.backend.apiErrors
                  ? `NOT_EVALUABLE — ${data.backend.apiErrors.reason}`
                  : pct(data.backend.apiErrors)}
              </td>
            </tr>
            <tr>
              <td>Queues (analysis q/p, oldest s; deletion q/p)</td>
              <td>
                {data.queues.analysisQueued}/{data.queues.analysisProcessing},{" "}
                {data.queues.oldestAnalysisQueuedAgeSeconds === null
                  ? "—"
                  : Math.round(data.queues.oldestAnalysisQueuedAgeSeconds)}
                ; {data.queues.deletionQueued}/{data.queues.deletionProcessing}
              </td>
            </tr>
            <tr>
              <td>User-reported wrong (shot ratings)</td>
              <td>{data.review.userReportedWrongShotRatings}</td>
            </tr>
            <tr>
              <td>Coach-review queue depth</td>
              <td>{data.review.coachReviewQueueDepth}</td>
            </tr>
            <tr>
              <td>Silent-failure queue depth</td>
              <td>{data.review.silentFailureQueueDepth}</td>
            </tr>
            <tr>
              <td>Coach reviews recorded</td>
              <td>{data.review.coachReviewsRecorded}</td>
            </tr>
          </tbody>
        </table>
      )}
    </section>
  );
}

function FlagsPanel({ token }: { token: string }) {
  const api = useApi(token);
  const [flags, setFlags] = useState<Record<string, boolean> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editKey, setEditKey] = useState("");
  const [editPercent, setEditPercent] = useState(100);
  const [editEnabled, setEditEnabled] = useState(true);

  const load = useCallback(() => {
    api("GET", "/v1/flags")
      .then((json) => setFlags((json as { flags: Record<string, boolean> }).flags))
      .catch((e) => setError(String(e)));
  }, [api]);
  useEffect(load, [load]);

  return (
    <section style={box}>
      <h2>Feature flags</h2>
      {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
      {flags && (
        <table cellPadding={6}>
          <tbody>
            {Object.entries(flags).map(([key, on]) => (
              <tr key={key}>
                <td>{key}</td>
                <td style={{ color: on ? "#15803d" : "#b45309" }}>{on ? "ON" : "off"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Update flag</h3>
      <input placeholder="flag key" value={editKey} onChange={(e) => setEditKey(e.target.value)} />
      <label>
        {" enabled "}
        <input
          type="checkbox"
          checked={editEnabled}
          onChange={(e) => setEditEnabled(e.target.checked)}
        />
      </label>
      <label>
        {" rollout % "}
        <input
          type="number"
          min={0}
          max={100}
          value={editPercent}
          onChange={(e) => setEditPercent(Number(e.target.value))}
          style={{ width: 64 }}
        />
      </label>
      <button
        onClick={() => {
          api("PUT", `/v1/admin/flags/${editKey}`, {
            enabled: editEnabled,
            rolloutPercent: editPercent,
          })
            .then(load)
            .catch((e) => setError(String(e)));
        }}
      >
        Save
      </button>
    </section>
  );
}

function ModelBundlePanel({ token }: { token: string }) {
  const api = useApi(token);
  const [status, setStatus] = useState<string>("");
  const [version, setVersion] = useState("");
  const [sha, setSha] = useState("");
  const [stage, setStage] = useState("canary");
  const [rollout, setRollout] = useState(1);

  return (
    <section style={box}>
      <h2>Model bundle release</h2>
      <p style={{ color: "#42505f" }}>
        Staged rollout: draft → canary (1%) → active. Signed SHA-256 manifest required. Never
        straight to 100%.
      </p>
      <input
        placeholder="version e.g. 2026.09.1"
        value={version}
        onChange={(e) => setVersion(e.target.value)}
      />
      <input
        placeholder="manifest sha256 (64 hex)"
        value={sha}
        onChange={(e) => setSha(e.target.value)}
        style={{ width: 320 }}
      />
      <select value={stage} onChange={(e) => setStage(e.target.value)}>
        {["draft", "canary", "active", "retired"].map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
      <input
        type="number"
        min={0}
        max={100}
        value={rollout}
        onChange={(e) => setRollout(Number(e.target.value))}
        style={{ width: 64 }}
      />
      <button
        onClick={() => {
          api("PUT", `/v1/admin/model-bundles/${version}`, {
            manifestSha256: sha,
            status: stage,
            rolloutPercent: rollout,
          })
            .then(() => setStatus("saved"))
            .catch((e) => setStatus(String(e)));
        }}
      >
        Publish
      </button>
      <span> {status}</span>
    </section>
  );
}

function UserLookupPanel({ token }: { token: string }) {
  const api = useApi(token);
  const [userId, setUserId] = useState("");
  const [result, setResult] = useState<string>("");

  return (
    <section style={box}>
      <h2>User lookup (audited)</h2>
      <input
        placeholder="user uuid"
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
        style={{ width: 320 }}
      />
      <button
        onClick={() => {
          api("GET", `/v1/admin/users/${userId}`)
            .then((json) => setResult(JSON.stringify(json, null, 2)))
            .catch((e) => setResult(String(e)));
        }}
      >
        Look up
      </button>
      <pre style={{ whiteSpace: "pre-wrap" }}>{result}</pre>
    </section>
  );
}

export function AdminApp() {
  const [token, setToken] = useState("");
  const hash = useHashRoute();
  const coachLab = hash.startsWith("#/coach");
  return (
    <main style={{ maxWidth: coachLab ? 1080 : 860, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontFamily: "ui-sans-serif, system-ui" }}>Pickle Sensei — Admin</h1>
      <nav style={{ marginBottom: 16, fontFamily: "ui-sans-serif, system-ui" }}>
        <a href="#/" style={{ marginRight: 16, fontWeight: coachLab ? 400 : 700 }}>
          API console
        </a>
        <a href="#/coach" style={{ fontWeight: coachLab ? 700 : 400 }}>
          Coach Review Lab
        </a>
      </nav>
      {coachLab ? (
        <CoachReviewLab />
      ) : (
        <>
          <section style={box}>
            <label>
              Admin bearer token:{" "}
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                style={{ width: 420 }}
                placeholder="paste OIDC (or local dev) admin token"
              />
            </label>
          </section>
          {token ? (
            <>
              <QualityDashboardPanel token={token} />
              <FlagsPanel token={token} />
              <ModelBundlePanel token={token} />
              <UserLookupPanel token={token} />
            </>
          ) : (
            <p>
              Provide a token to load panels. All admin actions are role-gated and audited by the
              API.
            </p>
          )}
        </>
      )}
    </main>
  );
}
