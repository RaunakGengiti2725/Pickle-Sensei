// A SECOND edge isolate for the logout stress tests (stress_logout_redis_failure.test.ts).
//
// A Web Worker has its own module graph, so this boots a fresh copy of the
// real ../index.ts with EMPTY L1 caches (cache.ts / rateLimit.ts state) and its
// own fake GoTrue, while the parent seeds this isolate's fake Upstash store from
// its own — i.e. two isolates sharing one Redis, which is exactly the shape the
// cross-isolate session fence (auth:revoked:<session_id>) exists for.
//
// Protocol (structured-clone messages, `id` echoed on every reply):
//   { id, type: "seed", redis: [key, entry][], users: FakeUser[], sessions: FakeSession[] }
//     → { id, type: "seeded" }
//   { id, type: "request", method, url, headers: [name, value][] }
//     → { id, type: "response", status, body, gotrueUserCalls, gotrueLogoutCalls }
//   { id, type: "redis" } → { id, type: "redis", entries: [key, entry][] }

import {
  loadSessionHarness,
  type FakeRedisEntry,
  type FakeSession,
  type FakeUser,
} from "./sessionHarness.ts";

export type IsolateCommand =
  | {
      id: number;
      type: "seed";
      redis: Array<[string, FakeRedisEntry]>;
      users: FakeUser[];
      sessions: FakeSession[];
    }
  | { id: number; type: "request"; method: string; url: string; headers: Array<[string, string]> }
  | { id: number; type: "redis" };

export type IsolateReply =
  | { id: number; type: "seeded" }
  | {
      id: number;
      type: "response";
      status: number;
      body: string;
      gotrueUserCalls: number;
      gotrueLogoutCalls: number;
    }
  | { id: number; type: "redis"; entries: Array<[string, FakeRedisEntry]> }
  | { id: number; type: "error"; message: string };

const ready = loadSessionHarness({ redis: true });
// The default lib types `self` as a Window; inside a module worker it is the
// worker's global scope.
const scope = self as unknown as {
  postMessage(message: IsolateReply): void;
  onmessage: ((event: MessageEvent<IsolateCommand>) => void) | null;
};
const post = (reply: IsolateReply) => scope.postMessage(reply);

scope.onmessage = async (event: MessageEvent<IsolateCommand>) => {
  const command = event.data;
  try {
    const h = await ready;
    switch (command.type) {
      case "seed": {
        h.redis = new Map(command.redis);
        for (const user of command.users) h.registerUser(user);
        for (const session of command.sessions) h.sessions.set(session.accessToken, session);
        post({ id: command.id, type: "seeded" });
        return;
      }
      case "request": {
        const before = {
          user: h.callsTo("/auth/v1/user").length,
          logout: h.callsTo("/auth/v1/logout").length,
        };
        const response = await h.handler(
          new Request(command.url, { method: command.method, headers: command.headers }),
        );
        const body = await response.text().catch(() => "");
        post({
          id: command.id,
          type: "response",
          status: response.status,
          body,
          gotrueUserCalls: h.callsTo("/auth/v1/user").length - before.user,
          gotrueLogoutCalls: h.callsTo("/auth/v1/logout").length - before.logout,
        });
        return;
      }
      case "redis": {
        post({ id: command.id, type: "redis", entries: [...h.redis.entries()] });
        return;
      }
    }
  } catch (error) {
    post({
      id: command.id,
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
