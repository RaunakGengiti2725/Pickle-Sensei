---
name: admin-web-manual-smoke
description: Drive the Pickle Sensei admin console (apps/admin-web, Vite React) against the local Fastify API (services/api) in a real browser — API console health, Coach Review Lab datasets, dev-token-gated admin panels and feature flags from Postgres — plus tools/diagnostics/local_api_probe.mjs. Use when a change touches apps/admin-web, services/api auth/flags/admin routes, the Playwright smoke (apps/admin-web/e2e), or when a recorded human-visible proof of the admin golden path is needed on Linux.
---

# Admin web manual smoke (Linux, local only — never production)

Mirrors `apps/admin-web/e2e/smoke.e2e.ts` as a human-driven flow. Nothing here touches Supabase.

## Services

1. `docker compose up -d postgres redis` (postgres :5432 `pickle_dev`; DB must be migrated + seeded —
   `DATABASE_URL=postgres://pickle:pickle_dev_password@localhost:5432/pickle_dev pnpm --filter @pickle/database migrate && … seed`).
   Check without psql on the host: `docker exec pickle-sensei-postgres-1 psql -U pickle -d pickle_dev -c "select key, enabled from feature_flag order by key;"` (18 seeded rows) — use this as the oracle for the Feature flags table.
2. API — `services/api/src/server.ts` does NOT load `.env`; export the vars first:
   `set -a; source .env; set +a; export DEV_AUTH_SECRET=<>=16 chars>; pnpm --filter @pickle/api dev` → http://127.0.0.1:3001.
   `PICKLE_ENV=development` is required for the HS256 dev issuer and for the admin claim to be honoured without `ADMIN_AUTH_SUBJECTS` (services/api/src/plugins/authPlugin.ts ~L131).
3. Admin web — `pnpm --filter @pickle/admin-web dev -- --host` does NOT forward `--host` and vite binds `::1` only; run the binary:
   `pnpm --filter @pickle/admin-web exec vite --host 127.0.0.1 --port 5173 --strictPort`. Vite proxies `/v1` → :3001.

## Token

Mint with the same secret as the API (copy of `apps/admin-web/e2e/devToken.ts`, HS256, `iss: pickle-dev`, `pickle_role: admin`), then bootstrap the subject once (idempotent, writes to the LOCAL dev DB only):
`POST http://127.0.0.1:3001/v1/account/bootstrap` with `authorization: Bearer <token>` and body `{"locale":"en-US","timezone":"UTC","device":{"platform":"ios","osVersion":"e2e","appVersion":"0.0.0-e2e","model":"playwright"}}` → 200. Without bootstrap admin routes return 401 `auth.no_account`.

## Routes and what to expect

- `http://127.0.0.1:5173/#/` = API console: h1 "Pickle Sensei — Admin", password input placeholder "paste OIDC (or local dev) admin token", text "Provide a token to load panels."
- Empty hash (`/`) and `#/coach` = Coach Review Lab, file-based over `datasets/coach-review/*` (queue.json → "Review queue — N gold StrokeEvents"); needs no token.
- API health for the browser path: open `http://127.0.0.1:5173/v1/health` → `{"status":"ok","version":"0.1.0"}`. There is NO `/healthz` on the Fastify API (that route belongs to the Supabase Edge Function).
- Token entered → panels: "Quality dashboard (audited; …)", "Feature flags" (table key / ON green / off amber), "Model bundle release", "User lookup (audited)", "Support diagnostics (audited, privacy-limited)". A bad token shows "Error: Token verification failed." in red in the first two panels — good negative control.

## Gotchas

- The token input fires a fetch on EVERY keystroke (React onChange). Typing the token char-by-char with xdotool produces hundreds of 401s (one per prefix) before the final 200; the panels clear their red error on that success (pinned by `smoke.e2e.ts`). Paste in one go (Playwright `fill`) for a clean API log. No xclip/xsel on the box — clipboard paste is unavailable from the shell.
- Rate-limit plugin exists in the API (`services/api/src/plugins/rateLimitPlugin.ts`); many 401s in a burst may 429 — check the API log if panels stay empty.
- `node tools/diagnostics/local_api_probe.mjs [--json]` against the running API needs `DEV_AUTH_SECRET` exported to execute the 4 bearer probes (otherwise they are `unavailable`, still exit 0 with 6/10). Do NOT add `--start` while an API is already on :3001 (exit 1 by design).

## Devin Secrets Needed

none — everything is local dev defaults from `.env.example`.
