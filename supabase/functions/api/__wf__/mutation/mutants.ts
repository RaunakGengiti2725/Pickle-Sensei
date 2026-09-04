// Mutation catalogue for the RevenueCat webhook + billing entitlement sync.
//
// Each mutant is a single, exact textual substitution applied to a COPY of a
// production source file (the runner never touches the checked-in file). The
// `find` string must occur exactly once in the target file — the runner
// refuses to run a mutant whose anchor is ambiguous or missing, so a drifted
// catalogue fails loudly instead of silently testing the wrong thing.
//
// Categories:
//   secret  — bypass / weaken the shared-secret gate on POST /webhooks/revenuecat
//   body    — trust webhook body / RevenueCat response shapes for entitlement state
//   dedupe  — idempotency, audit-row ordering, double-apply of a verdict
//   sync    — POST /v1/billing/sync verification + persistence contract
//   access  — accessPayload folding of the verified premium state
//
// `expect` is the catalogue author's prediction against the EXISTING suite at
// 4d812e1a (before the attack tests were added). It is recorded so the run can
// report where the prediction was wrong; it never influences the verdict.

export type MutantCategory = "secret" | "body" | "dedupe" | "sync" | "access";

export interface Mutant {
  id: string;
  category: MutantCategory;
  /** Path relative to supabase/functions/api/ */
  file: "index.ts" | "http.ts";
  description: string;
  find: string;
  replace: string;
  expect: "killed" | "survived";
}

export const MUTANTS: Mutant[] = [
  // ── secret ────────────────────────────────────────────────────────────────
  {
    id: "SEC-01-skip-secret-check",
    category: "secret",
    file: "index.ts",
    description: "Delete the Authorization comparison: any caller reaches processing.",
    find: `  if (!constantTimeEqual(authorization, secret)) {
    return errorJson(401, "Invalid webhook credentials.");
  }
`,
    replace: ``,
    expect: "killed",
  },
  {
    id: "SEC-02-unset-secret-fails-open",
    category: "secret",
    file: "index.ts",
    description:
      "Unset REVENUECAT_WEBHOOK_AUTH no longer returns 503; '' == '' then passes the gate.",
    find: `  if (!secret) {
    // Fail closed: without a configured secret no webhook is accepted.
    return errorJson(503, "Webhook is not configured.");
  }
`,
    replace: ``,
    expect: "killed",
  },
  {
    id: "SEC-03-prefix-compare",
    category: "secret",
    file: "index.ts",
    description: "Authorization only needs to START with the secret (secret + junk accepted).",
    find: `  if (!constantTimeEqual(authorization, secret)) {`,
    replace: `  if (!authorization.startsWith(secret)) {`,
    expect: "survived",
  },
  {
    id: "SEC-04-case-insensitive-compare",
    category: "secret",
    file: "index.ts",
    description: "Secret comparison is case-insensitive.",
    find: `  if (!constantTimeEqual(authorization, secret)) {`,
    replace: `  if (!constantTimeEqual(authorization.toLowerCase(), secret.toLowerCase())) {`,
    expect: "survived",
  },
  {
    id: "SEC-05-length-only-compare",
    category: "secret",
    file: "http.ts",
    description: "constantTimeEqual returns true for ANY same-length pair.",
    find: `  let diff = 0;
  for (let i = 0; i < bufA.length; i += 1) diff |= bufA[i] ^ bufB[i];
  return diff === 0;`,
    replace: `  return true;`,
    expect: "killed",
  },
  {
    id: "SEC-06-length-mismatch-accepts",
    category: "secret",
    file: "http.ts",
    description: "constantTimeEqual returns true when lengths differ.",
    find: `    return noise === -1;`,
    replace: `    return noise === 0;`,
    expect: "killed",
  },
  {
    id: "SEC-07-bearer-prefix-stripped",
    category: "secret",
    file: "index.ts",
    description: "Compare only the part after the first space (accepts 'anything <secret>').",
    find: `  const authorization = request.headers.get("Authorization") ?? "";
  if (!constantTimeEqual(authorization, secret)) {`,
    replace: `  const authorization = (request.headers.get("Authorization") ?? "").split(" ").pop() ?? "";
  if (!constantTimeEqual(authorization, secret)) {`,
    expect: "survived",
  },
  {
    id: "SEC-08-webhook-rate-limit-removed",
    category: "secret",
    file: "index.ts",
    description: "Per-IP webhook rate limit (240/min) is never enforced.",
    find: `    if (!rl.allowed) return rateLimitResponse(rl);
    return handleRevenueCatWebhook(request);`,
    replace: `    void rl;
    return handleRevenueCatWebhook(request);`,
    expect: "survived",
  },
  {
    id: "SEC-09-empty-authorization-accepted",
    category: "secret",
    file: "index.ts",
    description: "A missing Authorization header is accepted (only a WRONG header is rejected).",
    find: `  if (!constantTimeEqual(authorization, secret)) {`,
    replace: `  if (authorization !== "" && !constantTimeEqual(authorization, secret)) {`,
    expect: "killed",
  },

  // ── body ──────────────────────────────────────────────────────────────────
  {
    id: "BODY-01-verdict-from-event-body",
    category: "body",
    file: "index.ts",
    description:
      "When the event carries entitlement_ids, build the verdict from the body and skip RevenueCat.",
    find: `  for (const userId of subjectIds) {
    const verdict = await verifyRevenueCatSubscriber(userId);`,
    replace: `  for (const userId of subjectIds) {
    const verdict = Array.isArray(event.entitlement_ids)
      ? {
        premium: true,
        productKey: typeof event.product_id === "string" ? event.product_id : null,
        expiresAt: typeof event.expiration_at_ms === "number"
          ? new Date(event.expiration_at_ms).toISOString()
          : null,
        activeEntitlements: (event.entitlement_ids as unknown[]).filter(
          (x): x is string => typeof x === "string",
        ),
      }
      : await verifyRevenueCatSubscriber(userId);`,
    expect: "killed",
  },
  {
    id: "BODY-02-premium-or-body-claim",
    category: "body",
    file: "index.ts",
    description: "premium = RevenueCat verdict OR body says entitlement_ids.",
    find: `    verdicts.push({ userId, verdict });`,
    replace: `    verdicts.push({
      userId,
      verdict: { ...verdict, premium: verdict.premium || Array.isArray(event.entitlement_ids) },
    });`,
    expect: "killed",
  },
  {
    id: "BODY-03-expiry-from-body",
    category: "body",
    file: "index.ts",
    description:
      "expires_at is taken from the body's expiration_at_ms when present (RC value ignored).",
    find: `    verdicts.push({ userId, verdict });`,
    replace: `    verdicts.push({
      userId,
      verdict: {
        ...verdict,
        expiresAt: typeof event.expiration_at_ms === "number"
          ? new Date(event.expiration_at_ms).toISOString()
          : verdict.expiresAt,
      },
    });`,
    expect: "survived",
  },
  {
    id: "BODY-04-product-from-body",
    category: "body",
    file: "index.ts",
    description: "product_key is taken from the body's product_id when present.",
    find: `    verdicts.push({ userId, verdict });`,
    replace: `    verdicts.push({
      userId,
      verdict: {
        ...verdict,
        productKey: typeof event.product_id === "string" ? event.product_id : verdict.productKey,
      },
    });`,
    expect: "survived",
  },
  {
    id: "BODY-05-expiration-type-skips-verify",
    category: "body",
    file: "index.ts",
    description:
      "EXPIRATION/CANCELLATION events revoke premium from the event TYPE without asking RevenueCat.",
    find: `  for (const userId of subjectIds) {
    const verdict = await verifyRevenueCatSubscriber(userId);`,
    replace: `  for (const userId of subjectIds) {
    const verdict = eventType === "EXPIRATION" || eventType === "CANCELLATION"
      ? { premium: false, productKey: null, expiresAt: null, activeEntitlements: [] }
      : await verifyRevenueCatSubscriber(userId);`,
    expect: "survived",
  },
  {
    id: "BODY-06-non-uuid-subject-forwarded",
    category: "body",
    file: "index.ts",
    description:
      "Any string app_user_id (e.g. $RCAnonymousID) is sent to RevenueCat and persisted.",
    find: `  if (isUuid(event.app_user_id)) {
    subjectIds.add(event.app_user_id);`,
    replace: `  if (typeof event.app_user_id === "string") {
    subjectIds.add(event.app_user_id);`,
    expect: "killed",
  },
  {
    id: "BODY-07-any-entitlement-key-grants",
    category: "body",
    file: "index.ts",
    description:
      "Every entitlement key on the subscriber grants premium, not just pickle_sensei_pro/premium.",
    find: `  for (const name of PREMIUM_ENTITLEMENT_KEYS) {
    const entitlement = entitlementMap[name];`,
    replace: `  for (const name of Object.keys(entitlementMap)) {
    const entitlement = entitlementMap[name];`,
    expect: "survived",
  },
  {
    id: "BODY-08-undefined-expiry-grants",
    category: "body",
    file: "index.ts",
    description: "A missing expires_date (undefined) counts as lifetime — only null should.",
    find: `      expires === null ||
      (typeof expires === "string" &&`,
    replace: `      expires == null ||
      (typeof expires === "string" &&`,
    expect: "survived",
  },
  {
    id: "BODY-09-expiry-comparison-inverted",
    category: "body",
    file: "index.ts",
    description: "Only EXPIRED entitlements count as active.",
    find: `        Date.parse(expires) > Date.now());`,
    replace: `        Date.parse(expires) < Date.now());`,
    expect: "killed",
  },
  {
    id: "BODY-10-expiry-never-checked",
    category: "body",
    file: "index.ts",
    description: "Any parseable expires_date counts as active (lapsed subscriptions stay premium).",
    find: `        Number.isFinite(Date.parse(expires)) &&
        Date.parse(expires) > Date.now());`,
    replace: `        Number.isFinite(Date.parse(expires)));`,
    expect: "killed",
  },
  {
    id: "BODY-11-rc-error-as-empty-subscriber",
    category: "body",
    file: "index.ts",
    description:
      "A non-2xx RevenueCat response is folded as 'no entitlements' (premium:false persisted) instead of retry.",
    find: `    } else {
      await rcResponse.text().catch(() => undefined);
    }`,
    replace: `    } else {
      await rcResponse.text().catch(() => undefined);
      subscriber = {};
    }`,
    expect: "killed",
  },
  {
    id: "BODY-12-rc-malformed-200-as-empty",
    category: "body",
    file: "index.ts",
    description:
      "A 2xx RevenueCat body without a subscriber object is folded as premium:false instead of retry.",
    find: `      subscriber = isRecord(parsed) && isRecord(parsed.subscriber) ? parsed.subscriber : null;`,
    replace: `      subscriber = isRecord(parsed) && isRecord(parsed.subscriber) ? parsed.subscriber : {};`,
    expect: "survived",
  },
  {
    id: "BODY-13-rc-auth-header-dropped",
    category: "body",
    file: "index.ts",
    description: "RevenueCat is called without the Authorization header.",
    find: `          Authorization: \`Bearer \${rcKey}\`,
          Accept: "application/json",`,
    replace: `          Accept: "application/json",`,
    expect: "killed",
  },
  {
    id: "BODY-14-alias-preferred-over-app-user-id",
    category: "body",
    file: "index.ts",
    description:
      "When app_user_id is a uuid, ALSO re-verify every alias uuid the body lists (body picks extra subjects).",
    find: `  for (const id of uuidList(event.transferred_from)) subjectIds.add(id);`,
    replace: `  for (const id of uuidList(event.aliases)) subjectIds.add(id);
  for (const id of uuidList(event.transferred_from)) subjectIds.add(id);`,
    expect: "survived",
  },

  // ── dedupe / double-apply ─────────────────────────────────────────────────
  {
    id: "DUP-01-dedupe-removed",
    category: "dedupe",
    file: "index.ts",
    description:
      "An already-logged event id is fully re-processed (RevenueCat + entitlement write again).",
    find: `  } else if (seen.data) {
    return json(200, { received: true, duplicate: true });
  }`,
    replace: `  }`,
    expect: "survived",
  },
  {
    id: "DUP-02-dedupe-inverted",
    category: "dedupe",
    file: "index.ts",
    description: "Fresh events are acknowledged as duplicates; only replays are processed.",
    find: `  } else if (seen.data) {
    return json(200, { received: true, duplicate: true });
  }`,
    replace: `  } else if (!seen.data) {
    return json(200, { received: true, duplicate: true });
  }`,
    expect: "killed",
  },
  {
    id: "DUP-03-lookup-error-acks-as-duplicate",
    category: "dedupe",
    file: "index.ts",
    description:
      "A failed webhook_events lookup acknowledges the event as duplicate (nothing verified, RC never retries).",
    find: `  if (seen.error) {
    console.error("[api] webhook event lookup failed:", seen.error.message);
  } else if (seen.data) {`,
    replace: `  if (seen.error || seen.data) {`,
    expect: "survived",
  },
  {
    id: "DUP-04-audit-before-verify",
    category: "dedupe",
    file: "index.ts",
    description:
      "Audit row is written BEFORE verification, so a 503'd delivery is deduped on retry and never synced.",
    find: `  if (!appUserId) {
    // Nothing to verify (e.g. an anonymous-only subscriber). Acknowledge so`,
    replace: `  await logEvent();
  if (!appUserId) {
    // Nothing to verify (e.g. an anonymous-only subscriber). Acknowledge so`,
    expect: "killed",
  },
  {
    id: "DUP-05-audit-never-written",
    category: "dedupe",
    file: "index.ts",
    description: "The audit row is never written after a successful verification.",
    find: `  await logEvent();
  return json(200, { received: true, verified });`,
    replace: `  return json(200, { received: true, verified });`,
    expect: "killed",
  },
  {
    id: "DUP-06-audit-merge-not-ignore",
    category: "dedupe",
    file: "index.ts",
    description: "Audit upsert overwrites the first-seen row instead of ignoring duplicates.",
    find: `        payload: body,
      },
      { onConflict: "id", ignoreDuplicates: true },`,
    replace: `        payload: body,
      },
      { onConflict: "id" },`,
    expect: "killed",
  },
  {
    id: "DUP-07-verdict-persisted-twice",
    category: "dedupe",
    file: "index.ts",
    description: "Each verdict is written twice (double-apply).",
    find: `    const persistError = await persistBillingVerdict(userId, verdict, verifiedAt);
    if (persistError) {
      // A user who has never bootstrapped`,
    replace: `    await persistBillingVerdict(userId, verdict, verifiedAt);
    const persistError = await persistBillingVerdict(userId, verdict, verifiedAt);
    if (persistError) {
      // A user who has never bootstrapped`,
    expect: "killed",
  },
  {
    id: "DUP-08-persist-error-reported-verified",
    category: "dedupe",
    file: "index.ts",
    description: "A failed entitlement write still answers verified:true.",
    find: `      console.error("[api] webhook verdict persist failed:", persistError);
      verified = false;`,
    replace: `      console.error("[api] webhook verdict persist failed:", persistError);`,
    expect: "survived",
  },
  {
    id: "DUP-09-persist-stops-at-first-error",
    category: "dedupe",
    file: "index.ts",
    description: "TRANSFER: after one side's write fails the other side is never written.",
    find: `      console.error("[api] webhook verdict persist failed:", persistError);
      verified = false;`,
    replace: `      console.error("[api] webhook verdict persist failed:", persistError);
      verified = false;
      break;`,
    expect: "survived",
  },
  {
    id: "DUP-10-upsert-without-conflict-target",
    category: "dedupe",
    file: "index.ts",
    description:
      "billing_entitlements upsert has no on_conflict target (second sync for a user is a PK violation).",
    find: `    { onConflict: "user_id" },
  );
  return upserted.error ? upserted.error.message : null;`,
    replace: `    {},
  );
  return upserted.error ? upserted.error.message : null;`,
    expect: "survived",
  },
  {
    id: "DUP-11-transfer-from-not-reverified",
    category: "dedupe",
    file: "index.ts",
    description: "TRANSFER source account is never re-verified (keeps premium after the move).",
    find: `  for (const id of uuidList(event.transferred_from)) subjectIds.add(id);
`,
    replace: ``,
    expect: "killed",
  },
  {
    id: "DUP-12-missing-event-acknowledged",
    category: "dedupe",
    file: "index.ts",
    description: "A body without `event` is acknowledged 200 instead of 400.",
    find: `  if (!event) {
    return errorJson(400, "Missing event payload.");
  }`,
    replace: `  if (!event) {
    return json(200, { received: true, verified: false });
  }`,
    expect: "killed",
  },
  {
    id: "DUP-13-anonymous-not-logged",
    category: "dedupe",
    file: "index.ts",
    description: "Anonymous-only events are acknowledged without an audit row.",
    find: `    // RevenueCat stops retrying; the audit row preserves the event.
    await logEvent();`,
    replace: `    // RevenueCat stops retrying; the audit row preserves the event.`,
    expect: "survived",
  },
  {
    id: "DUP-14-audit-drops-event-id",
    category: "dedupe",
    file: "index.ts",
    description:
      "Audit row id is a fresh uuid instead of the RevenueCat event id (dedupe key broken).",
    find: `        id: eventId,
        provider: "revenuecat",`,
    replace: `        id: crypto.randomUUID(),
        provider: "revenuecat",`,
    expect: "killed",
  },

  // ── billing sync ──────────────────────────────────────────────────────────
  {
    id: "SYNC-01-verdict-hardcoded-premium",
    category: "sync",
    file: "index.ts",
    description: "POST /v1/billing/sync never asks RevenueCat; everybody is premium.",
    find: `      const verdict = await verifyRevenueCatSubscriber(authed.id);
      if (!verdict) {`,
    replace: `      const verdict: BillingVerdict | null = {
        premium: true,
        productKey: "pickle_sensei_pro_monthly",
        expiresAt: null,
        activeEntitlements: ["pickle_sensei_pro"],
      };
      if (!verdict) {`,
    expect: "killed",
  },
  {
    id: "SYNC-02-persist-error-ignored",
    category: "sync",
    file: "index.ts",
    description: "A failed billing_entitlements write on sync still answers 200 with the verdict.",
    find: `      if (persistError) {
        return serviceUnavailable("Billing verification", persistError);
      }`,
    replace: ``,
    expect: "survived",
  },
  {
    id: "SYNC-03-lapsed-not-persisted",
    category: "sync",
    file: "index.ts",
    description:
      "Only premium verdicts are persisted; a lapsed subscription never revokes the saved row.",
    find: `      const persistError = await persistBillingVerdict(authed.id, verdict, verifiedAt);
      if (persistError === "service role unavailable") {`,
    replace: `      const persistError = verdict.premium
        ? await persistBillingVerdict(authed.id, verdict, verifiedAt)
        : null;
      if (persistError === "service role unavailable") {`,
    expect: "killed",
  },
  {
    id: "SYNC-04-access-from-stale-db",
    category: "sync",
    file: "index.ts",
    description:
      "access is re-read from the DB instead of the just-verified verdict (billing.premium != access.premium).",
    find: `      const access = await accessPayload(authed, {
        premium: verdict.premium,
        activeEntitlements: verdict.activeEntitlements,
      });`,
    replace: `      const access = await accessPayload(authed);`,
    expect: "killed",
  },
  {
    id: "SYNC-05-unconfigured-rc-not-503",
    category: "sync",
    file: "index.ts",
    description: "Missing RevenueCat API key is not reported as billing_unconfigured.",
    find: `      if (!rcKey) {
        return codedError(
          503,
          "billing_unconfigured",
          "Billing verification is not configured on the server.",
        );
      }

      const verdict = await verifyRevenueCatSubscriber(authed.id);`,
    replace: `      void rcKey;

      const verdict = await verifyRevenueCatSubscriber(authed.id);`,
    expect: "survived",
  },
  {
    id: "SYNC-06-outage-answers-200-not-premium",
    category: "sync",
    file: "index.ts",
    description:
      "RevenueCat outage on sync answers 200 premium:false (client revokes access) instead of 502.",
    find: `      const verdict = await verifyRevenueCatSubscriber(authed.id);
      if (!verdict) {
        return codedError(
          502,
          "billing_unavailable",
          "The billing provider could not be reached to verify membership. Try again shortly.",
        );
      }`,
    replace: `      const verdict = (await verifyRevenueCatSubscriber(authed.id)) ?? {
        premium: false,
        productKey: null,
        expiresAt: null,
        activeEntitlements: [],
      };`,
    expect: "killed",
  },

  // ── access ────────────────────────────────────────────────────────────────
  {
    id: "ACC-01-premium-ignored-for-rating",
    category: "access",
    file: "index.ts",
    description: "canStartRating ignores premium (paying users hit the free-rating paywall).",
    find: `  const canStartRating = premium || availableToReserve > 0;`,
    replace: `  const canStartRating = availableToReserve > 0;`,
    expect: "killed",
  },
  {
    id: "ACC-02-db-premium-ignored",
    category: "access",
    file: "index.ts",
    description: "GET /v1/me/access ignores the verified billing_entitlements row.",
    find: `    premium: Boolean(state.premium),
    activeEntitlements: [],`,
    replace: `    premium: false,
    activeEntitlements: [],`,
    expect: "survived",
  },
  {
    id: "ACC-03-entitlements-leak-when-not-premium",
    category: "access",
    file: "index.ts",
    description: "entitlements list is populated even when not premium.",
    find: `  const entitlements = premium
    ? ["premium", ...billing.activeEntitlements.filter((name) => name !== "premium")]
    : [];`,
    replace: `  const entitlements = ["premium", ...billing.activeEntitlements.filter((name) => name !== "premium")];`,
    expect: "survived",
  },

  // ── adversarial variants of the XCM-08/09/10 pins (attack-fix-a1b2c248) ──
  // `expect` below is the prediction against the permanent suite at a1b2c248
  // (webhook_billing_invariants.test.ts included).
  {
    id: "SEC-10-rate-limit-only-after-secret",
    category: "secret",
    file: "index.ts",
    description:
      "The per-IP webhook budget only counts deliveries that already carry the right secret — wrong-secret guesses are never rate limited (pre-auth budget gone, authenticated budget intact).",
    find: `    const rl = await enforceRateLimit(
      "webhook",
      ip,
      WEBHOOK_LIMIT.limit,
      WEBHOOK_LIMIT.windowSeconds,
    );
    if (!rl.allowed) return rateLimitResponse(rl);
    return handleRevenueCatWebhook(request);`,
    replace: `    const webhookSecret = Deno.env.get("REVENUECAT_WEBHOOK_AUTH") ?? "";
    if (
      webhookSecret &&
      constantTimeEqual(request.headers.get("Authorization") ?? "", webhookSecret)
    ) {
      const rl = await enforceRateLimit(
        "webhook",
        ip,
        WEBHOOK_LIMIT.limit,
        WEBHOOK_LIMIT.windowSeconds,
      );
      if (!rl.allowed) return rateLimitResponse(rl);
    }
    return handleRevenueCatWebhook(request);`,
    expect: "survived",
  },
  {
    id: "BODY-15-rc-4xx-as-empty",
    category: "body",
    file: "index.ts",
    description:
      "A 4xx RevenueCat response (401 rotated key, 403, 404, 429) is folded as 'no entitlements' (premium:false persisted) instead of retry; only 5xx stays unavailable.",
    find: `    } else {
      await rcResponse.text().catch(() => undefined);
    }`,
    replace: `    } else {
      await rcResponse.text().catch(() => undefined);
      if (rcResponse.status < 500) subscriber = {};
    }`,
    expect: "survived",
  },
  {
    id: "BODY-16-no-rc-key-as-empty",
    category: "body",
    file: "index.ts",
    description:
      "Without any RevenueCat API key the webhook verdict is 'no entitlements' (premium revoked and persisted) instead of 503 unavailable.",
    find: `  if (!rcKey) return null;
`,
    replace: `  if (!rcKey) {
    return { premium: false, productKey: null, expiresAt: null, activeEntitlements: [] };
  }
`,
    expect: "survived",
  },
];
