// Adversarial pass (mobile-settings-account, pass 3), scenario S4: a
// delete-request carrying an exit survey the client type system would never
// produce (unknown reason, wrong-typed fields, prototype keys, oversized and
// spoofing-laden free text). The survey is a nicety; the deletion is the
// user's right — every malformed survey must be dropped while the challenge
// is still minted and returned.
//
//   (cd supabase/functions/api/__wf__ && deno task test)

import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const h = await loadHarness();

const FEEDBACK_PATH = "/rest/v1/account_deletion_feedback";
const REQUESTS_PATH = "/rest/v1/account_deletion_requests";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function surveyContext(userId: string): void {
  h.rpcs.access_state = [{ premium: false, scored_count: 1, reserved_count: 0 }];
  h.tables.profiles = [{ id: userId, created_at: "2026-01-01T00:00:00.000Z" }];
}

// delete-request has a 3/hour per-user budget, so every probe is its own
// (fake) user; the budget itself is pinned in the last test.
function freshUser(): { userId: string; token: string } {
  const userId = crypto.randomUUID();
  return { userId, token: fakeGoogleIdToken(userId) };
}

async function deleteRequest(body: unknown): Promise<{
  status: number;
  json: Record<string, unknown>;
  feedbackInserts: Record<string, unknown>[];
  challengeUpserts: Record<string, unknown>[];
  userId: string;
}> {
  h.reset();
  const { userId, token } = freshUser();
  surveyContext(userId);
  const response = await h.handler(userRequest("POST", "/v1/me/delete-request", { body, token }));
  const json = (await response.json()) as Record<string, unknown>;
  const posts = (path: string) =>
    h.calls
      .filter((call) => call.url.includes(path) && call.method === "POST")
      .map((call) => call.body as Record<string, unknown>);
  return {
    status: response.status,
    json,
    feedbackInserts: posts(FEEDBACK_PATH),
    challengeUpserts: posts(REQUESTS_PATH),
    userId,
  };
}

function assertDeletionProceeded(r: Awaited<ReturnType<typeof deleteRequest>>): void {
  assertEquals(r.status, 200);
  assertMatch(String(r.json.challenge), UUID_RE);
  assertEquals(r.challengeUpserts.length, 1);
  assertEquals(r.challengeUpserts[0]?.challenge, r.json.challenge);
  assertEquals(r.challengeUpserts[0]?.user_id, r.userId);
}

Deno.test("S4 baseline: a valid survey is recorded AND the challenge is minted", async () => {
  const r = await deleteRequest({
    survey: { reason: "privacy", wanted: "nothing", details: "  bye  ", platform: "ios" },
  });
  assertDeletionProceeded(r);
  assertEquals(r.feedbackInserts.length, 1);
  assertEquals(r.feedbackInserts[0]?.reason, "privacy");
  assertEquals(r.feedbackInserts[0]?.wanted, "nothing");
  assertEquals(r.feedbackInserts[0]?.details, "bye");
  assertEquals(r.feedbackInserts[0]?.user_id, r.userId);
});

Deno.test(
  "S4: unknown reason → survey dropped, no feedback insert, deletion proceeds",
  async () => {
    const r = await deleteRequest({
      survey: { reason: "bribed_by_competitor", wanted: "price", details: "x", platform: "ios" },
    });
    assertDeletionProceeded(r);
    assertEquals(r.feedbackInserts, []);
  },
);

Deno.test(
  "S4: reason variants that look valid but are not (case, whitespace, unicode, prototype key)",
  async () => {
    const reasons: unknown[] = [
      "Privacy",
      " privacy",
      "privacy\u0000",
      "privacy\u200b",
      "prívacy",
      "__proto__",
      "constructor",
      "toString",
      ["privacy"],
      { toString: () => "privacy" },
      7,
      null,
      true,
      "x".repeat(100_000),
    ];
    for (const reason of reasons) {
      const r = await deleteRequest({ survey: { reason, wanted: "price" } });
      assertDeletionProceeded(r);
      assertEquals(r.feedbackInserts, [], `reason=${JSON.stringify(reason)?.slice(0, 40)}`);
    }
  },
);

Deno.test("S4: survey shapes that are not a record are ignored, deletion proceeds", async () => {
  for (const survey of [null, "privacy", 1, true, ["privacy"], []]) {
    const r = await deleteRequest({ survey });
    assertDeletionProceeded(r);
    assertEquals(r.feedbackInserts, [], `survey=${JSON.stringify(survey)}`);
  }
  const noBody = await deleteRequest(undefined);
  assertDeletionProceeded(noBody);
  assertEquals(noBody.feedbackInserts, []);
  const notJson = await (async () => {
    h.reset();
    const { userId, token } = freshUser();
    surveyContext(userId);
    const request = userRequest("POST", "/v1/me/delete-request", { token });
    const raw = new Request(request, { body: "{not json", method: "POST" });
    raw.headers.set("Content-Type", "application/json");
    return await h.handler(raw);
  })();
  assertEquals(notJson.status, 200);
  assertMatch(String(((await notJson.json()) as { challenge: unknown }).challenge), UUID_RE);
});

Deno.test(
  "S4: valid reason with hostile secondary fields → recorded with fields nulled/sanitized",
  async () => {
    const r = await deleteRequest({
      survey: {
        reason: "other",
        wanted: "world_peace",
        details: "\u202E  drop\u0000 table\u200b   users  \ud800 ",
        platform: "android\u0000",
        appVersion: 12,
        __proto__: { reason: "privacy" },
        user_id: "22222222-2222-4222-8222-222222222222",
        premium: true,
      },
    });
    assertDeletionProceeded(r);
    assertEquals(r.feedbackInserts.length, 1);
    const row = r.feedbackInserts[0]!;
    assertEquals(row.reason, "other");
    assertEquals(row.wanted, null);
    assertEquals(row.details, "drop table users");
    assertEquals(row.platform, null);
    assertEquals(row.app_version, null);
    // Row identity comes from the authenticated user, never the body.
    assertEquals(row.user_id, r.userId);
    assertEquals("premium" in row && row.premium === true, false);
  },
);

Deno.test(
  "S4: 5,000-char details is capped at 500 code points; 5,000 emoji is capped by code points not UTF-16 units",
  async () => {
    const ascii = await deleteRequest({ survey: { reason: "other", details: "a".repeat(5_000) } });
    assertDeletionProceeded(ascii);
    assertEquals(String(ascii.feedbackInserts[0]?.details).length, 500);

    const emoji = await deleteRequest({ survey: { reason: "other", details: "😀".repeat(5_000) } });
    assertDeletionProceeded(emoji);
    assertEquals(Array.from(String(emoji.feedbackInserts[0]?.details)).length, 500);

    const wsOnly = await deleteRequest({
      survey: { reason: "other", details: " \n\t\u200b\u00a0 " },
    });
    assertDeletionProceeded(wsOnly);
    assert(
      wsOnly.feedbackInserts[0]?.details === null,
      "whitespace-only details must store as null",
    );
  },
);

Deno.test("S4: feedback insert failure never blocks the deletion request", async () => {
  h.reset();
  const { userId, token } = freshUser();
  surveyContext(userId);
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;
    if (url.includes(FEEDBACK_PATH)) {
      return Promise.resolve(
        new Response(JSON.stringify({ code: "42501", message: "permission denied" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const response = await h.handler(
      userRequest("POST", "/v1/me/delete-request", {
        token,
        body: { survey: { reason: "too_expensive", wanted: "price" } },
      }),
    );
    assertEquals(response.status, 200);
    assertMatch(String(((await response.json()) as { challenge: unknown }).challenge), UUID_RE);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test(
  "S4: 5 concurrent delete-requests from one user → 3 fresh challenges then 429s; the survey is recorded only for accepted requests",
  async () => {
    h.reset();
    const { userId, token } = freshUser();
    surveyContext(userId);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        h.handler(
          userRequest("POST", "/v1/me/delete-request", {
            token,
            body: { survey: { reason: "not_using" } },
          }),
        ),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    assertEquals(statuses, [200, 200, 200, 429, 429]);
    const challenges = new Set<string>();
    for (const response of results) {
      if (response.status !== 200) {
        assert(response.headers.get("retry-after"), "429 must carry Retry-After");
        await response.body?.cancel();
        continue;
      }
      challenges.add(String(((await response.json()) as { challenge: string }).challenge));
    }
    assertEquals(challenges.size, 3);
    assertEquals(
      h.calls.filter((c) => c.url.includes(FEEDBACK_PATH) && c.method === "POST").length,
      3,
    );
    assertEquals(
      h.calls.filter((c) => c.url.includes(REQUESTS_PATH) && c.method === "POST").length,
      3,
    );
  },
);
