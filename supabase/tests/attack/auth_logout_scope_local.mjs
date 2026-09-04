// Adversarial pass 3 · S1 — the assertions behind auth_logout_scope_local.sh.
// Runs against a LOCAL GoTrue (AUTH_URL) + PostgREST (REST_URL); never
// against a hosted project. Exit 1 on any failed assertion; writes a JSON
// table of every step to $ART_DIR/auth_logout_scope_local.json. Tokens are
// never printed — only lengths and statuses.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const AUTH = process.env.AUTH_URL ?? "http://127.0.0.1:19999";
const REST = process.env.REST_URL ?? "http://127.0.0.1:13000";
const ART = process.env.ART_DIR ?? "/tmp/attack3-s1";
mkdirSync(ART, { recursive: true });

const steps = [];
let failures = 0;
function check(name, ok, detail) {
  steps.push({ name, ok, ...detail });
  const mark = ok ? "HELD  " : "BROKEN";
  console.log(`${mark} ${name}${detail?.status !== undefined ? ` (status ${detail.status})` : ""}`);
  if (!ok) failures += 1;
}

async function call(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body };
}

const json = (body) => ({
  "Content-Type": "application/json",
  body: JSON.stringify(body),
});

async function signUp(email, password) {
  const r = await call(`${AUTH}/signup`, { method: "POST", ...json({ email, password }) });
  if (r.status !== 200) throw new Error(`signup ${email} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
async function signIn(email, password) {
  const r = await call(`${AUTH}/token?grant_type=password`, {
    method: "POST",
    ...json({ email, password }),
  });
  if (r.status !== 200)
    throw new Error(`password grant ${email} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
const refresh = (token) =>
  call(`${AUTH}/token?grant_type=refresh_token`, {
    method: "POST",
    ...json({ refresh_token: token }),
  });
const user = (access) => call(`${AUTH}/user`, { headers: { Authorization: `Bearer ${access}` } });
const logout = (access, scope) =>
  call(`${AUTH}/logout?scope=${scope}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access}` },
  });
const profiles = (access) =>
  call(`${REST}/profiles?select=id,email`, {
    headers: { Authorization: `Bearer ${access}` },
  });

const nonce = Date.now().toString(36);
const A = { email: `device-a-${nonce}@example.test`, password: `pw-${nonce}-Aa1!` };
const B = { email: `other-b-${nonce}@example.test`, password: `pw-${nonce}-Bb2!` };

// ── Fixture: account A on two devices, account B on one ─────────────────────
const a1 = await signUp(A.email, A.password); // device 1
const a2 = await signIn(A.email, A.password); // device 2
const b1 = await signUp(B.email, B.password);
const aId = a1.user.id;
const bId = b1.user.id;
check(
  "fixture: A has two distinct sessions (device 1 ≠ device 2)",
  a1.refresh_token !== a2.refresh_token && a1.access_token !== a2.access_token,
  {
    aId,
    refreshLen: [a1.refresh_token.length, a2.refresh_token.length],
  },
);

// ── Preconditions: RLS reads own row only ───────────────────────────────────
{
  const r = await profiles(a2.access_token);
  check(
    "precondition: device 2 reads exactly its own profiles row",
    r.status === 200 && Array.isArray(r.body) && r.body.length === 1 && r.body[0].id === aId,
    {
      status: r.status,
      rows: Array.isArray(r.body) ? r.body.map((p) => p.id) : r.body,
    },
  );
  const rb = await profiles(b1.access_token);
  check(
    "precondition: account B reads exactly its own row (never A)",
    rb.status === 200 && Array.isArray(rb.body) && rb.body.length === 1 && rb.body[0].id === bId,
    {
      status: rb.status,
      rows: Array.isArray(rb.body) ? rb.body.map((p) => p.id) : rb.body,
    },
  );
  const anon = await profiles("");
  check(
    "precondition: no bearer → no rows (anon revoked)",
    anon.status !== 200 || (Array.isArray(anon.body) && anon.body.length === 0),
    {
      status: anon.status,
    },
  );
  const u1 = await user(a1.access_token);
  check(
    "precondition: device 1 access token resolves /user",
    u1.status === 200 && u1.body?.id === aId,
    { status: u1.status },
  );
}

// ── The attack: device 1 signs out with scope=local (what logoutRoute does) ─
{
  const r = await logout(a1.access_token, "local");
  check("logout?scope=local with device 1 bearer → 204", r.status === 204, {
    status: r.status,
    body: r.body,
  });
}

// ── Device 1 is dead ────────────────────────────────────────────────────────
{
  const r = await refresh(a1.refresh_token);
  check("device 1 refresh token is REFUSED after its own logout", r.status >= 400, {
    status: r.status,
    error: r.body?.error_code ?? r.body?.error ?? r.body?.msg ?? null,
  });
  const u = await user(a1.access_token);
  check(
    "device 1 access token no longer resolves /user (auth.getUser path)",
    u.status === 401 || u.status === 403,
    {
      status: u.status,
      error: u.body?.error_code ?? u.body?.msg ?? null,
    },
  );
}

// ── Device 2 (same account) is untouched ────────────────────────────────────
let a2Rotated = null;
{
  const u = await user(a2.access_token);
  check("device 2 access token still resolves /user", u.status === 200 && u.body?.id === aId, {
    status: u.status,
  });
  const r = await refresh(a2.refresh_token);
  a2Rotated = r.body;
  check(
    "device 2 refresh token still rotates (200, new pair)",
    r.status === 200 &&
      typeof r.body?.access_token === "string" &&
      typeof r.body?.refresh_token === "string" &&
      r.body.refresh_token !== a2.refresh_token,
    {
      status: r.status,
      error: r.body?.error_code ?? r.body?.error ?? null,
    },
  );
  if (a2Rotated?.access_token) {
    const p = await profiles(a2Rotated.access_token);
    check(
      "device 2 (rotated bearer) still reads exactly its own row",
      p.status === 200 && Array.isArray(p.body) && p.body.length === 1 && p.body[0].id === aId,
      {
        status: p.status,
        rows: Array.isArray(p.body) ? p.body.map((x) => x.id) : p.body,
      },
    );
  }
  const p0 = await profiles(a2.access_token);
  check(
    "device 2 (pre-rotation bearer, still unexpired) reads exactly its own row",
    p0.status === 200 && Array.isArray(p0.body) && p0.body.length === 1 && p0.body[0].id === aId,
    {
      status: p0.status,
    },
  );
  const pb = await profiles(b1.access_token);
  check(
    "account B still reads only its own row after A's logout",
    pb.status === 200 && Array.isArray(pb.body) && pb.body.length === 1 && pb.body[0].id === bId,
    {
      status: pb.status,
    },
  );
}

// ── Note (not an assertion of mobile behaviour): a stateless JWT stays valid
//    for PostgREST until exp; the edge fn never lets it through because
//    authenticate() consults auth.getUser (asserted dead above) and
//    logoutRoute drops the bearer from its cache.
{
  const p = await profiles(a1.access_token);
  steps.push({
    name: "observation: device 1 access JWT is still accepted by PostgREST until exp (stateless JWT; edge authenticate() is the gate)",
    ok: null,
    status: p.status,
    rows: Array.isArray(p.body) ? p.body.length : null,
  });
  console.log(
    `NOTE   device 1 JWT vs PostgREST after logout: status ${p.status}, rows ${Array.isArray(p.body) ? p.body.length : "n/a"}`,
  );
}

// ── Probe: refresh-token reuse (informs the mobile double-hydrate finding) ──
if (a2Rotated?.refresh_token) {
  const reuse = await refresh(a2.refresh_token); // the token we just rotated away
  steps.push({
    name: "probe: re-spending the just-rotated refresh token inside the reuse interval",
    ok: null,
    status: reuse.status,
    error: reuse.body?.error_code ?? reuse.body?.error ?? null,
    sameFamilyStillAlive: null,
  });
  console.log(
    `PROBE  reuse of rotated token within interval → ${reuse.status} ${reuse.body?.error_code ?? reuse.body?.error ?? ""}`,
  );
  const after = await refresh(a2Rotated.refresh_token);
  steps[steps.length - 1].sameFamilyStillAlive = after.status === 200;
  check(
    "device 2 session survives a within-interval reuse (current token still rotates)",
    after.status === 200,
    {
      status: after.status,
      error: after.body?.error_code ?? after.body?.error ?? null,
    },
  );
  if (after.status === 200) a2Rotated = after.body;
}

// ── Sanity: scope=global from device 2 kills every remaining A session ──────
if (a2Rotated?.access_token) {
  const r = await logout(a2Rotated.access_token, "global");
  check("logout?scope=global → 204", r.status === 204, { status: r.status });
  const rr = await refresh(a2Rotated.refresh_token);
  check("after scope=global device 2 refresh is refused too", rr.status >= 400, {
    status: rr.status,
  });
  const pb = await profiles(b1.access_token);
  check(
    "account B is still signed in after all of A's logouts",
    pb.status === 200 && Array.isArray(pb.body) && pb.body.length === 1,
    { status: pb.status },
  );
}

writeFileSync(
  join(ART, "auth_logout_scope_local.json"),
  JSON.stringify({ authUrl: AUTH, restUrl: REST, failures, steps }, null, 2),
);
console.log(
  `\n${failures === 0 ? "ALL HELD" : `${failures} BROKEN`} — ${steps.filter((s) => s.ok !== null).length} assertions`,
);
process.exit(failures === 0 ? 0 : 1);
