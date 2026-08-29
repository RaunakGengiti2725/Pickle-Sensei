import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ITokenVerifier } from "../auth/tokens.js";
import { sendFailure } from "../lib/replies.js";
import { one } from "../lib/db.js";
import type { AppContext } from "../context.js";

/**
 * Authentication/authorization plugin. Every private resource requires an
 * authenticated user; ownership checks happen in each module's SQL
 * (`WHERE user_id = $me`) — possession of a UUID never grants access.
 */

export interface AuthedUser {
  id: string;
  authSubject: string;
  role: "user" | "admin";
}

declare module "fastify" {
  interface FastifyRequest {
    user: AuthedUser | null;
    identity: { authSubject: string; role: "user" | "admin" } | null;
  }
}

export function registerAuth(
  app: FastifyInstance,
  context: AppContext,
  verifier: ITokenVerifier,
): void {
  app.decorateRequest("user", null);
  app.decorateRequest("identity", null);

  /** Verifies the bearer token; does NOT require an app_user row (bootstrap). */
  app.decorate("verifyToken", async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return sendFailure(
        reply,
        request,
        401,
        "auth_failed",
        "auth.missing_token",
        "Missing bearer token.",
      );
    }
    const verified = await verifier.verify(header.slice("Bearer ".length));
    if (!verified.ok) {
      return sendFailure(
        reply,
        request,
        401,
        "auth_failed",
        verified.failure.code,
        verified.failure.message,
      );
    }
    request.identity = verified.value;
  });

  /** Requires token AND an existing (non-deleted) app_user. */
  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    await (
      app as FastifyInstance & {
        verifyToken: (r: FastifyRequest, p: FastifyReply) => Promise<unknown>;
      }
    ).verifyToken(request, reply);
    if (reply.sent) return;
    const identity = request.identity;
    if (!identity) return; // verifyToken already replied
    if (!context.pool) {
      return sendFailure(
        reply,
        request,
        503,
        "retryable",
        "auth.db_unavailable",
        "Database unavailable.",
      );
    }
    const user = await one<{ id: string; status: string }>(
      context.pool,
      "SELECT id, status FROM app_user WHERE auth_subject = $1",
      [identity.authSubject],
    );
    if (!user || user.status === "deleted") {
      return sendFailure(
        reply,
        request,
        401,
        "auth_failed",
        "auth.no_account",
        "No active account. Call /v1/account/bootstrap first.",
      );
    }
    if (user.status === "suspended") {
      return sendFailure(
        reply,
        request,
        401,
        "auth_failed",
        "auth.suspended",
        "Account suspended.",
      );
    }
    request.user = { id: user.id, authSubject: identity.authSubject, role: identity.role };
  });

  /** Admin-only routes: separate privileged role, always audited by callers. */
  app.decorate("requireAdmin", async (request: FastifyRequest, reply: FastifyReply) => {
    await (
      app as FastifyInstance & {
        authenticate: (r: FastifyRequest, p: FastifyReply) => Promise<unknown>;
      }
    ).authenticate(request, reply);
    if (reply.sent) return;
    if (request.user?.role !== "admin") {
      return sendFailure(
        reply,
        request,
        403,
        "permission_denied",
        "auth.admin_required",
        "Admin role required.",
      );
    }
    // Defence in depth: an `admin` token claim is a statement by the identity
    // provider, not proof of authority. Outside development the subject must
    // also appear in the server-side allowlist, so one mis-mapped (or
    // user-editable) IdP claim cannot mint an administrator.
    const allowlist = context.config.adminAuthSubjects ?? [];
    const allowlistRequired = context.config.env !== "development";
    if (allowlist.length > 0 || allowlistRequired) {
      if (!allowlist.includes(request.user.authSubject)) {
        request.log.warn(
          { authSubject: request.user.authSubject },
          "admin claim refused: subject not in ADMIN_AUTH_SUBJECTS",
        );
        return sendFailure(
          reply,
          request,
          403,
          "permission_denied",
          "auth.admin_not_authorized",
          "Admin role required.",
        );
      }
    }
  });
}

declare module "fastify" {
  interface FastifyInstance {
    verifyToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  }
}
