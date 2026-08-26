import type { FastifyReply, FastifyRequest } from "fastify";
import type { FailureKind, OperationFailure } from "@pickle/shared-types";

/** Typed error envelope for every failure (directive §6). */
export function sendFailure(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  kind: FailureKind,
  code: string,
  message: string,
): FastifyReply {
  return reply.status(status).send({
    error: {
      kind,
      code,
      message,
      retryable: kind === "timeout" || kind === "retryable" || kind === "network",
      requestId: request.id,
    },
  });
}

export function statusForFailure(failure: OperationFailure): number {
  switch (failure.kind) {
    case "auth_failed":
      return 401;
    case "permission_denied":
      return 403;
    case "not_implemented":
      return 501;
    case "network":
    case "retryable":
    case "timeout":
      return 503;
    case "corrupted_media":
    case "low_confidence":
    case "unsupported_device":
      return 422;
    case "permanent":
      return 500;
  }
}

export function sendOpFailure(
  reply: FastifyReply,
  request: FastifyRequest,
  failure: OperationFailure,
): FastifyReply {
  return sendFailure(
    reply,
    request,
    statusForFailure(failure),
    failure.kind,
    failure.code,
    failure.message,
  );
}
