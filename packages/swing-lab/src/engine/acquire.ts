import { execFileSync } from "node:child_process";
import { existsSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  CORPUS_DIR,
  REPO_ROOT,
  commonsSourceId,
  ensureCorpus,
  loadRecordings,
  loadSources,
  recordingIdForHash,
  sanitizeIdPart,
  upsertRecording,
  upsertSource,
  type RecordingRecord,
  type SourceRecord,
} from "./corpus.js";
import { probeMedia, sha256File } from "./probe.js";
import { parseLicense, rightsForLicense, trainingEligible } from "./rights.js";
import { assignSplit, loadSplits, saveSplits } from "./splits.js";

/**
 * LEGAL ACQUISITION FRONT DOOR — the only way media enters the corpus.
 *
 *   pnpm lab:acquire dvids   [--query pickleball] [--limit N] [--dry-run]
 *   pnpm lab:acquire commons [--query pickleball] [--limit N] [--dry-run]
 *
 * Sources used and why they are legitimate:
 *  - DVIDS (dvidshub.net): U.S. DoD media, public domain as works of the
 *    federal government (17 U.S.C. §105); DVIDS asks courtesy credit and no
 *    implied endorsement. Each page's credit block is recorded verbatim.
 *  - Wikimedia Commons: only files whose extmetadata license the rights
 *    parser recognizes (PD / CC0 / CC BY / CC BY-SA) AND derives as
 *    training-eligible are accepted — the same classifier that writes the
 *    stored rights record, so the pre-filter cannot disagree with it. The
 *    license and author are recorded per file. Anything else is skipped loudly.
 *
 * Every acquisition records: origin, originId, canonical URL, direct media
 * URL, license, per-modality rights, timestamps, SHA-256, and probe facts.
 * Downloads are resumable (curl -C -) and politely rate-limited.
 */

const USER_AGENT =
  "PickleSenseiDataEngine/0.2 (research dataset acquisition; provenance-recorded; contact: repo maintainer)";
const POLITE_DELAY_MS = 1500;

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

function curlDownload(url: string, outPath: string): void {
  execFileSync(
    "curl",
    [
      "-sS",
      "-L",
      "--fail",
      "--retry",
      "3",
      "--retry-delay",
      "2",
      "-C",
      "-",
      "-A",
      USER_AGENT,
      "-o",
      outPath,
      url,
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
}

interface AcquireOutcome {
  sourceId: string;
  status: "registered" | "already_present" | "skipped" | "failed";
  detail: string;
}

// ── DVIDS ────────────────────────────────────────────────────────────────

interface DvidsPage {
  videoId: string;
  url: string;
  title: string;
  description: string;
  author: string;
  dateTaken: string | null;
  virin: string | null;
  location: string | null;
  category: string | null;
  mediaUrl: string;
}

async function dvidsSearch(query: string): Promise<string[]> {
  const urls = new Set<string>();
  for (let page = 1; page <= 10; page += 1) {
    const html = await fetchText(
      `https://www.dvidshub.net/search?q=${encodeURIComponent(query)}&view=grid&filter%5Btype%5D=video&page=${page}`,
    );
    const before = urls.size;
    for (const match of html.matchAll(/href="(\/video\/\d+\/[^"]+)"/g)) {
      urls.add(`https://www.dvidshub.net${match[1]!.split("?")[0]}`);
    }
    if (urls.size === before) break; // no new results → past the last page
    await sleep(POLITE_DELAY_MS);
  }
  return [...urls].sort();
}

function metaContent(html: string, property: string): string | null {
  const match = html.match(new RegExp(`<meta (?:name|property)="${property}" content="([^"]*)"`));
  return match ? match[1]! : null;
}

async function dvidsParseVideoPage(url: string): Promise<DvidsPage> {
  const html = await fetchText(url);
  const videoId = url.match(/\/video\/(\d+)\//)?.[1] ?? "unknown";
  const details = new Map<string, string>();
  for (const match of html.matchAll(/<td>([^<:]+):<\/td>\s*<td>([^<]*)<\/td>/g)) {
    details.set(match[1]!.trim(), match[2]!.trim());
  }
  const mediaUrl = html.match(/https:\/\/[^"']+\.mp4[^"']*/)?.[0];
  if (!mediaUrl) throw new Error(`no direct media URL on ${url}`);
  const credit = html.match(/copyright_info">This work,.*?by(.*?)identified by/s);
  const author = credit
    ? credit[1]!
        .replace(/<[^>]+>/g, " ")
        .replace(/[\s,]+/g, " ")
        .trim()
    : (metaContent(html, "og:description")?.match(/\(([^)]*video by[^)]*)\)/i)?.[1] ??
      "U.S. DoD (DVIDS)");
  return {
    videoId,
    url,
    title: metaContent(html, "og:title") ?? `DVIDS video ${videoId}`,
    description: metaContent(html, "og:description") ?? "",
    author,
    dateTaken: details.get("Date Taken") ?? null,
    virin: details.get("VIRIN") ?? null,
    location: details.get("Location") ?? null,
    category: details.get("Category") ?? null,
    mediaUrl: mediaUrl.split("?")[0]!,
  };
}

async function acquireDvids(
  query: string,
  limit: number,
  dryRun: boolean,
): Promise<AcquireOutcome[]> {
  const paths = ensureCorpus();
  const known = new Set(loadSources().map((source) => source.sourceId));
  const outcomes: AcquireOutcome[] = [];
  const pageUrls = await dvidsSearch(query);
  console.log(`dvids search "${query}": ${pageUrls.length} video pages`);
  let acquired = 0;
  for (const pageUrl of pageUrls) {
    if (acquired >= limit) break;
    const videoId = pageUrl.match(/\/video\/(\d+)\//)?.[1];
    const sourceId = `src-dvids-${videoId}`;
    if (known.has(sourceId)) {
      outcomes.push({ sourceId, status: "already_present", detail: pageUrl });
      continue;
    }
    if (dryRun) {
      outcomes.push({ sourceId, status: "skipped", detail: `dry-run: would acquire ${pageUrl}` });
      continue;
    }
    try {
      await sleep(POLITE_DELAY_MS);
      const page = await dvidsParseVideoPage(pageUrl);
      const mediaPath = join(paths.mediaDir, `dvids-${page.videoId}.mp4`);
      console.log(`↓ ${sourceId} · ${page.title}`);
      curlDownload(page.mediaUrl, mediaPath);
      const outcome = await registerAcquired({
        origin: "dvids",
        originId: page.videoId,
        sourceId,
        url: page.url,
        mediaUrl: page.mediaUrl,
        mediaPath,
        title: page.title,
        author: page.author,
        publishedDate: page.dateTaken ?? undefined,
        license: "Public domain (U.S. federal government work, PD-USGov; DVIDS)",
        restrictions: [
          "DVIDS requests journalist credit (author recorded)",
          "must not imply DoD endorsement",
        ],
        description: [
          page.description,
          page.virin ? `VIRIN ${page.virin}` : "",
          page.location ?? "",
          page.category ?? "",
        ]
          .filter(Boolean)
          .join(" · "),
        // Same venue + same date = one SESSION (the split unit). Two crews
        // filming one event must never land in different splits.
        sessionKey:
          page.location && page.dateTaken
            ? `dvids-${sanitizeIdPart(page.location.split(",")[0]!.toLowerCase()).slice(0, 24)}-${sanitizeIdPart(page.dateTaken)}`
            : `dvids-${page.videoId}`,
      });
      outcomes.push(outcome);
      acquired += 1;
    } catch (error) {
      outcomes.push({ sourceId, status: "failed", detail: String(error) });
    }
  }
  return outcomes;
}

// ── Wikimedia Commons ────────────────────────────────────────────────────

const ACQUIRE_REVIEWER = "lab:acquire (rule-derived; human spot-check required for unclear)";

/** Automated acquisition admits a license only when the parsed rights allow training. */
function commonsLicenseRejection(licenseShort: string): string | null {
  const parsed = parseLicense(licenseShort);
  if (parsed.status !== "recognized") return parsed.reason;
  const rights = rightsForLicense(licenseShort, ACQUIRE_REVIEWER);
  if (!trainingEligible(rights)) {
    return `"${licenseShort}" is not training-eligible (train=${rights.train}, store=${rights.store}, analyze=${rights.analyze})`;
  }
  return null;
}

async function acquireCommons(
  query: string,
  limit: number,
  dryRun: boolean,
): Promise<AcquireOutcome[]> {
  const paths = ensureCorpus();
  const known = new Set(loadSources().map((source) => source.sourceId));
  const outcomes: AcquireOutcome[] = [];
  const search = (await (
    await fetch(
      `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}%20filetype:video&srnamespace=6&srlimit=50&format=json`,
      { headers: { "user-agent": USER_AGENT } },
    )
  ).json()) as { query?: { search?: Array<{ title: string }> } };
  const titles = (search.query?.search ?? []).map((result) => result.title);
  console.log(`commons search "${query}": ${titles.length} files`);
  let acquired = 0;
  for (const title of titles) {
    if (acquired >= limit) break;
    const originId = title.replace(/^File:/, "");
    const sourceId = commonsSourceId(title);
    if (known.has(sourceId)) {
      outcomes.push({ sourceId, status: "already_present", detail: title });
      continue;
    }
    await sleep(POLITE_DELAY_MS);
    const info = (await (
      await fetch(
        `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=imageinfo&iiprop=url|extmetadata|size&format=json`,
        { headers: { "user-agent": USER_AGENT } },
      )
    ).json()) as {
      query?: {
        pages?: Record<
          string,
          { imageinfo?: Array<{ url: string; extmetadata?: Record<string, { value: string }> }> }
        >;
      };
    };
    const pages = Object.values(info.query?.pages ?? {});
    const imageInfo = pages[0]?.imageinfo?.[0];
    const meta = imageInfo?.extmetadata ?? {};
    const licenseShort = (meta.LicenseShortName?.value ?? "unknown").replace(/<[^>]+>/g, "").trim();
    const rejection = imageInfo ? commonsLicenseRejection(licenseShort) : "no imageinfo";
    if (!imageInfo || rejection !== null) {
      outcomes.push({
        sourceId,
        status: "skipped",
        detail: `license not accepted: ${rejection}`,
      });
      continue;
    }
    const parsedLicense = parseLicense(licenseShort);
    if (dryRun) {
      outcomes.push({
        sourceId,
        status: "skipped",
        detail: `dry-run: would acquire ${title} (${licenseShort})`,
      });
      continue;
    }
    try {
      const originalPath = join(paths.mediaDir, `commons-${sanitizeIdPart(originId)}`);
      console.log(`↓ ${sourceId} · ${title} (${licenseShort})`);
      curlDownload(imageInfo.url, originalPath);
      // AVFoundation cannot decode VP9/AV1 reliably → normalize to H.264 and
      // register the transcode; the original bytes stay next to it.
      const mediaPath = `${originalPath.replace(/\.[a-z0-9]+$/i, "")}.h264.mp4`;
      execFileSync("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-i",
        originalPath,
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-an",
        mediaPath,
      ]);
      const outcome = await registerAcquired({
        origin: "wikimedia_commons",
        originId,
        sourceId,
        url: `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`,
        mediaUrl: imageInfo.url,
        mediaPath,
        title: originId,
        author: (meta.Artist?.value ?? "unknown").replace(/<[^>]+>/g, "").trim(),
        license: licenseShort,
        restrictions:
          parsedLicense.status === "recognized" && parsedLicense.license.kind === "cc"
            ? ["attribution required on redistribution"]
            : [],
        description: `Wikimedia Commons file; transcoded to H.264 for AVFoundation (original retained: ${originalPath.replace(`${REPO_ROOT}/`, "")})`,
        sessionKey: `commons-${sanitizeIdPart(originId).slice(0, 60)}`,
      });
      outcomes.push(outcome);
      acquired += 1;
    } catch (error) {
      outcomes.push({ sourceId, status: "failed", detail: String(error) });
    }
  }
  return outcomes;
}

// ── shared registration ──────────────────────────────────────────────────

async function registerAcquired(input: {
  origin: SourceRecord["origin"];
  originId: string;
  sourceId: string;
  url: string;
  mediaUrl: string;
  mediaPath: string;
  title: string;
  author: string;
  publishedDate?: string | undefined;
  license: string;
  restrictions: string[];
  description: string;
  sessionKey: string;
}): Promise<AcquireOutcome> {
  const probe = probeMedia(input.mediaPath);
  if (probe.durationMs < 3000) {
    unlinkSync(input.mediaPath);
    return {
      sourceId: input.sourceId,
      status: "skipped",
      detail: `too short (${probe.durationMs}ms)`,
    };
  }
  const sha256 = await sha256File(input.mediaPath);
  const recordingId = recordingIdForHash(sha256);
  const existing = loadRecordings().find((recording) => recording.sha256 === sha256);
  if (existing) {
    unlinkSync(input.mediaPath);
    return {
      sourceId: input.sourceId,
      status: "already_present",
      detail: `bytes identical to ${existing.recordingId}`,
    };
  }
  const finalPath = input.mediaPath.replace(
    /(\.[a-z0-9.]+)$/i,
    `-${recordingId.replace(/^rec-/, "")}$1`,
  );
  renameSync(input.mediaPath, finalPath);

  const source: SourceRecord = {
    schemaVersion: 1,
    sourceId: input.sourceId,
    origin: input.origin,
    originId: input.originId,
    url: input.url,
    title: input.title,
    author: input.author,
    publishedDate: input.publishedDate,
    license: input.license,
    rights: rightsForLicense(input.license, ACQUIRE_REVIEWER),
    acquisition: {
      acquiredAtIso: new Date().toISOString(),
      method: `${input.origin} page parse + direct media download`,
      mediaUrl: input.mediaUrl,
      tool: "lab:acquire v0.2",
    },
    restrictions: input.restrictions,
    description: input.description,
  };
  upsertSource(source);
  const recording: RecordingRecord = {
    schemaVersion: 1,
    recordingId,
    sourceId: input.sourceId,
    path: finalPath.replace(`${REPO_ROOT}/`, ""),
    sha256,
    probe,
    sessionKey: input.sessionKey,
    registeredAtIso: new Date().toISOString(),
    derivedFrom: [],
  };
  upsertRecording(recording);
  const splitsPath = join(CORPUS_DIR, "splits.json");
  const splits = loadSplits(splitsPath);
  assignSplit(splits, input.sessionKey);
  saveSplits(splitsPath, splits);
  return {
    sourceId: input.sourceId,
    status: "registered",
    detail: `${recordingId} · ${(probe.durationMs / 1000).toFixed(0)}s ${probe.width}x${probe.height}@${probe.fps} → ${recording.path}`,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith("acquire.ts");
if (isMain) {
  const mode = process.argv[2];
  const flag = (name: string) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? (process.argv[index + 1] ?? null) : null;
  };
  const query = flag("--query") ?? "pickleball";
  const limit = Number(flag("--limit") ?? 100);
  const dryRun = process.argv.includes("--dry-run");
  if (mode !== "dvids" && mode !== "commons") {
    console.error("usage: pnpm lab:acquire <dvids|commons> [--query q] [--limit N] [--dry-run]");
    process.exit(2);
  }
  const run =
    mode === "dvids" ? acquireDvids(query, limit, dryRun) : acquireCommons(query, limit, dryRun);
  run.then((outcomes) => {
    console.log("═".repeat(66));
    for (const outcome of outcomes)
      console.log(`${outcome.status.padEnd(16)} ${outcome.sourceId} · ${outcome.detail}`);
    const registered = outcomes.filter((outcome) => outcome.status === "registered").length;
    console.log(
      `registered ${registered} · present ${outcomes.filter((o) => o.status === "already_present").length} · skipped ${outcomes.filter((o) => o.status === "skipped").length} · failed ${outcomes.filter((o) => o.status === "failed").length}`,
    );
    if (!existsSync(join(CORPUS_DIR, "sources.json"))) process.exitCode = 1;
  });
}
