import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * E08 fresh-holdout contamination guard.
 *
 * datasets/pickleball/registry.json declares the fresh-candidates pool a
 * LABEL-BLIND holdout: no labels of any kind may exist or be created for
 * these clips before a future acquisition freeze registers them through the
 * front door. The value of that pool depends on it staying untouched — the
 * moment a target-acquisition case, corpus registration, split assignment,
 * or label sidecar references one of these clips pre-freeze, the only fresh
 * holdout footage in the repo is contaminated and cannot serve as a holdout.
 *
 * This suite pins that boundary mechanically:
 *  - every registered fresh candidate stays labelBlind with role
 *    fresh_candidate,
 *  - the fresh-candidates directory holds exactly the registered media files
 *    (no label/annotation sidecars can appear next to them),
 *  - each media file byte-matches its registered sha256 (no silent
 *    re-encode/replacement of holdout footage),
 *  - no ta-bench case and no corpus source/recording/split references a
 *    fresh-candidate id.
 *
 * Wave F (f11-e22-intake) extension: the registry now also carries a devPool
 * section — clips graduated to dev_label_eligible by an intake record. The
 * guard pins that boundary too: the two pools stay disjoint, dev-pool media
 * byte-matches its registered sha256, and the dev-pool directory holds exactly
 * the registered dev media files.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const registryPath = join(root, "datasets", "pickleball", "registry.json");
const freshDir = join(root, "datasets", "pickleball", "fresh-candidates");
const devDir = join(root, "datasets", "pickleball", "dev-pool");

interface FreshItem {
  id: string;
  role: string;
  labelBlind: boolean;
  path: string;
  media: { sha256: string };
}

function readRegistry(): {
  freshCandidates: { items: FreshItem[] };
  devPool?: { items: FreshItem[] };
} {
  return JSON.parse(readFileSync(registryPath, "utf8")) as {
    freshCandidates: { items: FreshItem[] };
    devPool?: { items: FreshItem[] };
  };
}

function freshItems(): FreshItem[] {
  return readRegistry().freshCandidates.items;
}

function devItems(): FreshItem[] {
  return readRegistry().devPool?.items ?? [];
}

describe("E08 fresh-holdout guard: label-blind pool stays uncontaminated", () => {
  it("every registered fresh candidate is labelBlind with role fresh_candidate", () => {
    const items = freshItems();
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.labelBlind, `${item.id} must stay labelBlind`).toBe(true);
      expect(item.role, `${item.id} role`).toBe("fresh_candidate");
    }
  });

  it("fresh-candidates directory holds exactly the registered media files (no sidecars)", () => {
    const registered = new Set(freshItems().map((item) => item.path.split("/").pop()));
    const onDisk = readdirSync(freshDir).filter((name) => !name.startsWith("."));
    expect(new Set(onDisk)).toEqual(registered);
  });

  it("each fresh-candidate file byte-matches its registered sha256", () => {
    for (const item of freshItems()) {
      const absolute = join(root, item.path);
      expect(existsSync(absolute), `${item.path} must exist`).toBe(true);
      const digest = createHash("sha256").update(readFileSync(absolute)).digest("hex");
      expect(digest, `${item.id} content hash`).toBe(item.media.sha256);
    }
  });

  it("no ta-bench case references a fresh-candidate id", () => {
    const cases = readFileSync(join(root, "datasets", "ta-bench", "cases.json"), "utf8");
    for (const item of freshItems()) {
      expect(cases.includes(item.id), `ta-bench must not reference ${item.id}`).toBe(false);
    }
  });

  it("no corpus source, recording, or split references a fresh-candidate id", () => {
    const corpusFiles = ["sources.json", "recordings.json", "splits.json"].map((name) =>
      join(root, "datasets", "corpus", name),
    );
    for (const file of corpusFiles) {
      const content = readFileSync(file, "utf8");
      for (const item of freshItems()) {
        expect(content.includes(item.id), `${file} must not reference ${item.id}`).toBe(false);
      }
    }
  });
});

describe("F11 dev-pool guard: graduated dev clips stay disjoint from the holdout pool", () => {
  it("every dev-pool item is dev_label_eligible and not labelBlind", () => {
    const items = devItems();
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.role, `${item.id} role`).toBe("dev_label_eligible");
      expect(item.labelBlind, `${item.id} labelBlind`).toBe(false);
    }
  });

  it("the fresh-candidate and dev pools share no clip id", () => {
    const freshIds = new Set(freshItems().map((item) => item.id));
    for (const item of devItems()) {
      expect(freshIds.has(item.id), `${item.id} must not be in both pools`).toBe(false);
    }
  });

  it("dev-pool directory holds exactly the registered dev media files", () => {
    const registered = new Set(devItems().map((item) => item.path.split("/").pop()));
    const onDisk = readdirSync(devDir).filter((name) => !name.startsWith("."));
    expect(new Set(onDisk)).toEqual(registered);
  });

  it("each dev-pool file byte-matches its registered sha256", () => {
    for (const item of devItems()) {
      const absolute = join(root, item.path);
      expect(existsSync(absolute), `${item.path} must exist`).toBe(true);
      const digest = createHash("sha256").update(readFileSync(absolute)).digest("hex");
      expect(digest, `${item.id} content hash`).toBe(item.media.sha256);
    }
  });
});
