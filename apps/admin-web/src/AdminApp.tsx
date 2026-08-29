import React, { useCallback, useEffect, useState } from "react";
import { CoachReviewLab, useHashRoute } from "./coachReview/CoachReviewLab";
import { SupportDiagnosticsPanel } from "./supportDiagnostics/SupportDiagnosticsPanel";

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
              <FlagsPanel token={token} />
              <ModelBundlePanel token={token} />
              <UserLookupPanel token={token} />
              <SupportDiagnosticsPanel token={token} />
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
