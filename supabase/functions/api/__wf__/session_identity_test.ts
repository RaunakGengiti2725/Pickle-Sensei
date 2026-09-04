// authenticate() identity source (AGENTS.md → "Auth sessions"): the user a
// request acts as is the user GoTrue verified for the bearer, never a claim
// read out of the (unverified) JWT payload. The fake GoTrue looks sessions up
// by the exact bearer string, so a session can be registered whose payload
// `sub` disagrees with the account it belongs to; every downstream query the
// function issues must then be scoped to the verified account.
//
// Killing test for the variant mutant
//   index.ts authenticate():  `id: verified.data.user.id` → `id: String(payload?.sub)`
// which the adopted session_contract_test.ts leaves alive (its minted
// sessions always carry sub === userId).
//
//   cd supabase/functions/api/__wf__ && deno task test

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  apiRequest,
  fakeJwt,
  GOOGLE_USER_ID,
  loadSessionHarness,
  SUPABASE_URL,
} from "./sessionHarness.ts";

const CLAIMED_SUB = "99999999-9999-4999-8999-999999999999";

Deno.test(
  "the identity comes from the user GoTrue verified, not from the bearer's own sub claim",
  async () => {
    const h = await loadSessionHarness();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const accessToken = fakeJwt({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: CLAIMED_SUB,
      aud: "authenticated",
      role: "authenticated",
      session_id: crypto.randomUUID(),
      exp: expiresAt,
    });
    h.sessions.set(accessToken, {
      userId: GOOGLE_USER_ID,
      accessToken,
      refreshToken: `rt-${crypto.randomUUID()}`,
      expiresAt,
      revoked: false,
    });
    h.tables.profiles = [
      {
        id: GOOGLE_USER_ID,
        email: "google@example.com",
        onboarding_state: "complete",
        provider: "google",
        skill_level: "intermediate",
        handedness: "right",
        primary_goal: "consistency",
        biggest_problem: "pop-ups",
        focus_checkpoint: "paddle_face",
        first_name: "Pat",
        gender: null,
      },
    ];

    const response = await h.handler(apiRequest("GET", "/v1/me", { token: accessToken }));
    assertEquals(response.status, 200);
    await response.body?.cancel();
    assertEquals(h.callsTo("/auth/v1/user").length, 1, "the bearer was verified upstream");

    const profileReads = h.callsTo("/rest/v1/profiles");
    assertEquals(profileReads.length, 1, "one profile lookup");
    assertStringIncludes(
      profileReads[0].url,
      `id=eq.${GOOGLE_USER_ID}`,
      "the profile lookup is scoped to the account GoTrue verified",
    );
    assertEquals(
      profileReads[0].url.includes(CLAIMED_SUB),
      false,
      "the unverified sub claim never reaches a query",
    );
  },
);
