import type { FastifyReply, FastifyRequest } from "fastify";
import type { FailureKind } from "@pickle/shared-types";

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
