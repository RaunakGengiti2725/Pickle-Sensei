import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { validateReview, type ValidationContext } from "./src/coachReview/validate";
import type {
  CoachRegistry,
  CoachReview,
  DrillLibrary,
  FaultTaxonomy,
  QueueManifest,
  SchemaDescriptor,
} from "./src/coachReview/types";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COACH_REVIEW_DIR = join(REPO_ROOT, "datasets/coach-review");
const REVIEWS_DIR = join(COACH_REVIEW_DIR, "reviews");

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".md": "text/markdown; charset=utf-8",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

/** Static read-only file serving for /datasets/** (+ docs/COACHING.md), with
 * HTTP Range support so the event <video> can seek/loop efficiently. */
function serveRepoFile(req: IncomingMessage, res: ServerResponse, urlPath: string): void {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "");
  const filePath = normalize(join(REPO_ROOT, decoded));
  const allowed =
    filePath.startsWith(join(REPO_ROOT, "datasets") + "/") ||
    filePath === join(REPO_ROOT, "docs/COACHING.md");
  if (!allowed || !existsSync(filePath) || !statSync(filePath).isFile()) {
    sendJson(res, 404, { message: `not found: ${decoded}` });
    return;
  }
  const extension = filePath.slice(filePath.lastIndexOf("."));
  const contentType = CONTENT_TYPES[extension] ?? "application/octet-stream";
  const { size } = statSync(filePath);
  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      "content-type": contentType,
      "content-range": `bytes ${start}-${end}/${size}`,
      "accept-ranges": "bytes",
      "content-length": end - start + 1,
    });
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": size,
    "accept-ranges": "bytes",
  });
  createReadStream(filePath).pipe(res);
}

function readBody(req: IncomingMessage, limitBytes: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        rejectPromise(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectPromise);
  });
}

function loadValidationContext(): ValidationContext {
  const queue = JSON.parse(
    readFileSync(join(COACH_REVIEW_DIR, "queue.json"), "utf8"),
  ) as QueueManifest;
  const schema = JSON.parse(
    readFileSync(join(COACH_REVIEW_DIR, "schema.json"), "utf8"),
  ) as SchemaDescriptor;
  const taxonomy = JSON.parse(
    readFileSync(join(COACH_REVIEW_DIR, "taxonomy/fault-taxonomy.v0-draft.json"), "utf8"),
  ) as FaultTaxonomy;
  const drills = JSON.parse(
    readFileSync(join(COACH_REVIEW_DIR, "drills/drill-library.v0.json"), "utf8"),
  ) as DrillLibrary;
  return {
    knownQueueItemIds: queue.queue.map((item) => item.queueItemId),
    knownFaultIds: taxonomy.families.flatMap((family) => family.faults.map((fault) => fault.id)),
    knownDrillIds: drills.drills.map((drill) => drill.id),
    strokeTaxonomyVersion: schema.strokeTaxonomy.version,
    strokeLabels: schema.strokeTaxonomy.labels,
    faultTaxonomyVersion: schema.faultTaxonomyVersion,
    qualityScaleId: schema.qualityScale.id,
  };
}

/**
 * Coach Review Lab dev API.
 *
 * POST /api/coach-reviews is the ONLY write path, and it is gated so that
 * fabricated reviews are structurally impossible from this tool:
 *  - the coachId MUST be provisioned (status "active") in the HUMAN-managed
 *    datasets/coach-review/coaches.json registry — which is EMPTY today, so
 *    every write is refused with 403 "no coach identity provisioned" until
 *    a real coach is onboarded per docs/COACHING.md;
 *  - SYNTHETIC ids are rejected outright (dev fixtures never persist);
 *  - storage is append-only: an existing reviewId can never be overwritten.
 */
function coachReviewLabPlugin(): Plugin {
  return {
    name: "pickle-coach-review-lab",
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        void (async () => {
          const url = req.url ?? "";
          if (
            req.method === "GET" &&
            (url.startsWith("/datasets/") || url === "/docs/COACHING.md")
          ) {
            serveRepoFile(req, res, url);
            return;
          }
          if (url.split("?")[0] !== "/api/coach-reviews") {
            next();
            return;
          }
          if (req.method === "GET") {
            mkdirSync(REVIEWS_DIR, { recursive: true });
            const entries = readdirSync(REVIEWS_DIR)
              .filter((name) => name.endsWith(".json"))
              .map((name) => ({
                file: `datasets/coach-review/reviews/${name}`,
                review: JSON.parse(readFileSync(join(REVIEWS_DIR, name), "utf8")) as CoachReview,
              }));
            sendJson(res, 200, entries);
            return;
          }
          if (req.method !== "POST") {
            sendJson(res, 405, { message: "method not allowed" });
            return;
          }
          let review: CoachReview;
          try {
            review = JSON.parse(await readBody(req, 1_000_000)) as CoachReview;
          } catch (error) {
            sendJson(res, 400, { message: `invalid JSON body: ${String(error)}` });
            return;
          }
          const registry = JSON.parse(
            readFileSync(join(COACH_REVIEW_DIR, "coaches.json"), "utf8"),
          ) as CoachRegistry;
          const activeCoach = registry.coaches.find(
            (coach) => coach.coachId === review.coachId && coach.status === "active",
          );
          if (!activeCoach) {
            sendJson(res, 403, {
              message:
                "no coach identity provisioned: coachId is not an active entry in datasets/coach-review/coaches.json. " +
                "Reviews can only be persisted by provisioned coaches (docs/COACHING.md §2). Review count remains unchanged.",
            });
            return;
          }
          if (
            /synthetic/i.test(review.coachId) ||
            /synthetic/i.test(review.coachCredentialRef ?? "")
          ) {
            sendJson(res, 403, {
              message: "SYNTHETIC identities are dev fixtures and can never be persisted",
            });
            return;
          }
          if (review.coachCredentialRef !== activeCoach.credentialRef) {
            sendJson(res, 403, {
              message: "coachCredentialRef does not match the provisioned registry entry",
            });
            return;
          }
          const problems = validateReview(review, loadValidationContext());
          if (problems.length > 0) {
            sendJson(res, 422, { message: "review failed schema validation", problems });
            return;
          }
          mkdirSync(REVIEWS_DIR, { recursive: true });
          const filePath = join(REVIEWS_DIR, `${review.reviewId}.json`);
          if (existsSync(filePath)) {
            sendJson(res, 409, {
              message: `append-only: ${review.reviewId}.json already exists and is never overwritten. Adjudication/amendments are separate records (docs/COACHING.md §6).`,
            });
            return;
          }
          writeFileSync(filePath, JSON.stringify(review, null, 2));
          sendJson(res, 201, {
            ok: true,
            message: "review persisted (append-only)",
            path: `datasets/coach-review/reviews/${review.reviewId}.json`,
          });
        })().catch((error) => sendJson(res, 500, { message: String(error) }));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), coachReviewLabPlugin()],
  server: {
    port: 5173,
    proxy: {
      "/v1": "http://127.0.0.1:3001",
    },
  },
});
