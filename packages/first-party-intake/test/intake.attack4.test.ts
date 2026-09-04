import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CONSENT_LEDGER_EXPORT_VERSION_V2,
  canonicalConsentExportSigningPayload,
  canonicalConsentRecordsJson,
  deriveConsentStatus,
  type ConsentLedgerExportV2,
  type ConsentRecord,
} from "@pickle/shared-types";
import { checkConsentForSubject, intakeClip, loadConsentLedger } from "../src/index.js";

/**
 * Adversarial pass 3 (tester #4) — first-party intake attacks.
 *
 *   S2  intakeClip on a directory / 0-byte clip (ffprobe must fail):
 *       REJECTED + "envelope measurement failed", manifestDraft null, CLI
 *       exit 1 (not 2), `--out` still written.
 *   S3  bare-array ledger where some rows carry seq and others do not:
 *       deterministic ordering or rejection.
 *   S4  v2 envelope with a VALID HMAC whose subjectPseudonym differs from the
 *       records only by Unicode normalization (NFC vs NFD), and one whose
 *       exportedAtIso is in the future.
 *
 * ALL fixtures are SYNTHETIC (`SYNTHETIC-TEST-FIXTURE` pseudonyms, lavfi
 * clips, tmpdir only). Nothing here may ever be copied under datasets/.
 */

const SUBJECT = "SYNTHETIC-TEST-FIXTURE.attack4-subject";
const KEY = "SYNTHETIC-TEST-FIXTURE.attack4-signing-key";
const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let dir: string;
let ledgerPath: string;
let metaPath: string;
let dirClip: string;
let emptyClip: string;
let garbageClip: string;

function row(overrides: Partial<ConsentRecord>): ConsentRecord {
  return {
    id: "SYNTHETIC-TEST-FIXTURE.record",
    subjectPseudonym: SUBJECT,
    scope: "video_analysis",
    action: "granted",
    consentVersion: "video-analysis-v1",
    source: "privacy_center",
    device: null,
    captureMode: "all_captures",
    strokeIntent: null,
    recordedAtIso: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

const GOOD_LEDGER: ConsentRecord[] = [
  row({ id: "SYNTHETIC-TEST-FIXTURE.a4-r1" }),
  row({
    id: "SYNTHETIC-TEST-FIXTURE.a4-r2",
    scope: "model_training",
    consentVersion: "model-training-v1",
    recordedAtIso: "2026-08-01T00:01:00.000Z",
  }),
];

const CAPTURE_META = {
  clipId: "SYNTHETIC-TEST-FIXTURE.a4-clip",
  athleteId: "SYNTHETIC-TEST-FIXTURE.a4-athlete",
  athleteGroupId: "SYNTHETIC-TEST-FIXTURE.a4-group",
  sessionId: "SYNTHETIC-TEST-FIXTURE.a4-session",
  recordedAt: "2026-08-15T10:00:00.000Z",
  capture: {
    cameraView: "rear",
    environment: "outdoor",
    lighting: "daylight",
    deviceClass: "synthetic-lavfi-generator",
    handedness: "unknown",
    skillBand: "unknown",
    ageBand: "withheld",
    adaptivePlay: false,
    bystanderState: "none",
  },
};

function write(name: string, body: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(body, null, 2));
  return path;
}

function signHeader(header: Omit<ConsentLedgerExportV2, "records" | "signature">): string {
  return createHmac("sha256", KEY)
    .update(canonicalConsentExportSigningPayload(header))
    .digest("hex");
}

function v2Envelope(
  records: ConsentRecord[],
  overrides: Partial<Omit<ConsentLedgerExportV2, "records" | "signature">> = {},
): ConsentLedgerExportV2 {
  const header: Omit<ConsentLedgerExportV2, "records" | "signature"> = {
    exportVersion: CONSENT_LEDGER_EXPORT_VERSION_V2,
    exportedAtIso: "2026-08-29T00:00:01.000Z",
    subjectPseudonym: records[0]?.subjectPseudonym ?? SUBJECT,
    recordCount: records.length,
    maxSeq: records.length > 0 ? (records.at(-1)!.seq ?? null) : null,
    recordsSha256: createHash("sha256").update(canonicalConsentRecordsJson(records)).digest("hex"),
    ...overrides,
  };
  return {
    ...header,
    records,
    signature: {
      alg: "HMAC-SHA256",
      keyId: "SYNTHETIC-TEST-FIXTURE.k1",
      value: signHeader(header),
    },
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "first-party-intake-attack4-"));
  ledgerPath = write("ledger.json", GOOD_LEDGER);
  metaPath = write("capture-meta.json", CAPTURE_META);
  dirClip = join(dir, "i-am-a-directory.mp4");
  mkdirSync(dirClip);
  emptyClip = join(dir, "zero-bytes.mp4");
  writeFileSync(emptyClip, "");
  garbageClip = join(dir, "garbage.mp4");
  writeFileSync(garbageClip, Buffer.from("SYNTHETIC-TEST-FIXTURE not a video container\n"));
});

// ───────────────────────────── S2 ─────────────────────────────

describe("S2 intakeClip when ffprobe cannot read the clip", () => {
  const cases: Array<[string, () => string]> = [
    ["directory", () => dirClip],
    ["0-byte file", () => emptyClip],
    ["non-media bytes", () => garbageClip],
  ];

  for (const [label, clip] of cases) {
    it(`${label}: REJECTED with 'envelope measurement failed', no manifest draft, no throw`, () => {
      const record = intakeClip({
        clipPath: clip(),
        consentLedgerPath: ledgerPath,
        subjectPseudonym: SUBJECT,
        captureMetaPath: metaPath,
        operatorId: "SYNTHETIC-TEST-FIXTURE.operator",
      });
      expect(record.status).toBe("REJECTED");
      expect(record.consent.ok).toBe(true); // consent alone would have passed
      expect(record.measurements).toBeNull();
      expect(record.envelope).toBeNull();
      expect(record.manifestDraft).toBeNull();
      expect(record.reasons).toHaveLength(1);
      expect(record.reasons[0]).toMatch(/^envelope measurement failed: /);
      // The reason carries ffprobe's stderr; it must not leak beyond the clip
      // path the operator supplied (no home dirs / other paths).
      expect(record.reasons[0]).not.toMatch(/\/home\/|\/Users\//);
    });
  }

  it("REPRO: byte-identical 0-byte intakes differ only by an ASLR heap address in the reason", () => {
    const results = Array.from({ length: 8 }, () =>
      intakeClip({
        clipPath: emptyClip,
        consentLedgerPath: ledgerPath,
        subjectPseudonym: SUBJECT,
        captureMetaPath: metaPath,
        operatorId: "SYNTHETIC-TEST-FIXTURE.operator",
      }),
    );
    // The reason embeds ffprobe's raw stderr, which carries a heap pointer
    // ("[mov,mp4,... @ 0x55dce0d9c100]"). Masking it makes all eight identical.
    const raw = results.map((r) => JSON.stringify({ ...r, intakeAtIso: null }));
    expect(results.every((r) => /@ 0x[0-9a-f]+\]/.test(r.reasons[0] ?? ""))).toBe(true);
    const masked = raw.map((s) => s.replace(/0x[0-9a-f]+/g, "0xPTR"));
    expect(new Set(masked).size).toBe(1);
  });

  it.fails(
    "EXPECTED: byte-identical inputs → byte-identical record modulo intakeAtIso (BROKEN, P3)",
    () => {
      const results = Array.from({ length: 8 }, () =>
        intakeClip({
          clipPath: emptyClip,
          consentLedgerPath: ledgerPath,
          subjectPseudonym: SUBJECT,
          captureMetaPath: metaPath,
          operatorId: "SYNTHETIC-TEST-FIXTURE.operator",
        }),
      );
      const raw = results.map((r) => JSON.stringify({ ...r, intakeAtIso: null }));
      expect(new Set(raw).size).toBe(1);
    },
  );

  it("nonexistent clip path is ALSO a REJECTED record (not a thrown error)", () => {
    const record = intakeClip({
      clipPath: join(dir, "does-not-exist.mp4"),
      consentLedgerPath: ledgerPath,
      subjectPseudonym: SUBJECT,
      captureMetaPath: metaPath,
      operatorId: "SYNTHETIC-TEST-FIXTURE.operator",
    });
    expect(record.status).toBe("REJECTED");
    expect(record.reasons[0]).toMatch(/^envelope measurement failed: /);
    expect(record.manifestDraft).toBeNull();
  });
});

describe("S2 CLI exit codes for an unreadable clip", () => {
  function runCli(clip: string, out: string | null): ReturnType<typeof spawnSync> {
    const args = [
      "src/cli.ts",
      "--clip",
      clip,
      "--consent-ledger",
      ledgerPath,
      "--subject",
      SUBJECT,
      "--capture-meta",
      metaPath,
      "--operator",
      "SYNTHETIC-TEST-FIXTURE.operator",
    ];
    if (out !== null) args.push("--out", out);
    return spawnSync(join(PKG_DIR, "node_modules", ".bin", "tsx"), args, {
      cwd: PKG_DIR,
      encoding: "utf8",
      timeout: 60_000,
    });
  }

  it("directory clip → exit 1 (rejected), NOT 2 (malformed inputs); record still printed and written", () => {
    const out = join(dir, "record-dir.json");
    const res = runCli(dirClip, out);
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(1);
    expect(String(res.stderr)).toContain("intake status: REJECTED");
    expect(String(res.stderr)).toContain("envelope measurement failed");
    expect(String(res.stderr)).not.toContain("intake failed:");
    const record = JSON.parse(String(res.stdout)) as { status: string; manifestDraft: unknown };
    expect(record.status).toBe("REJECTED");
    expect(record.manifestDraft).toBeNull();
    expect(existsSync(out)).toBe(true);
  });

  it("0-byte clip → exit 1, NOT 2", () => {
    const res = runCli(emptyClip, null);
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(1);
    expect(String(res.stderr)).toContain("intake status: REJECTED");
    expect(String(res.stderr)).toContain("envelope measurement failed");
  });

  it("malformed LEDGER (not clip) → exit 2, so the two failure classes stay distinguishable", () => {
    const badLedger = write("bad-ledger.json", [{ id: "x" }]);
    const args = [
      "src/cli.ts",
      "--clip",
      emptyClip,
      "--consent-ledger",
      badLedger,
      "--subject",
      SUBJECT,
      "--capture-meta",
      metaPath,
      "--operator",
      "SYNTHETIC-TEST-FIXTURE.operator",
    ];
    const res = spawnSync(join(PKG_DIR, "node_modules", ".bin", "tsx"), args, {
      cwd: PKG_DIR,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(res.status).toBe(2);
    expect(String(res.stderr)).toContain("intake failed:");
  });
});

// ───────────────────────────── S3 ─────────────────────────────

/**
 * Convention for BROKEN scenarios in this file: the assertion states the
 * EXPECTED (correct) behaviour and the case is declared with `it.fails`, so
 * the suite is green while the defect exists and turns red the moment a fix
 * lands (flip `it.fails` → `it` then). HELD scenarios use plain `it`.
 */

describe("S3 bare-array ledger with MIXED seq presence", () => {
  const training = (overrides: Partial<ConsentRecord>): ConsentRecord =>
    row({ scope: "model_training", consentVersion: "model-training-v1", ...overrides });

  // Same subject, model_training scope: a grant WITHOUT seq that is
  // timestamp-later, and a withdrawal WITH seq that is timestamp-earlier.
  // The comparator only uses seq when BOTH rows carry it, otherwise falls
  // back to recordedAtIso — so mixed rows sort by timestamp only.
  const grantNoSeq = training({
    id: "SYNTHETIC-TEST-FIXTURE.mixed-grant",
    action: "granted",
    recordedAtIso: "2026-08-03T00:00:00.000Z",
  });
  const withdrawSeq = training({
    id: "SYNTHETIC-TEST-FIXTURE.mixed-withdraw",
    action: "withdrawn",
    recordedAtIso: "2026-08-02T00:00:00.000Z",
    seq: 7,
  });
  const videoSeq = row({ id: "SYNTHETIC-TEST-FIXTURE.mixed-video", seq: 1 });

  const permutations = <T>(arr: T[]): T[][] =>
    arr.length <= 1
      ? [arr]
      : arr.flatMap((x, i) =>
          permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p]),
        );

  it("loadConsentLedger ACCEPTS the mixed array — no rejection (pinned)", () => {
    const path = write("mixed-seq.json", [videoSeq, withdrawSeq, grantNoSeq]);
    expect(() => loadConsentLedger(path)).not.toThrow();
    expect(loadConsentLedger(path)).toHaveLength(3);
  });

  it("two-row mix: the timestamp-later un-seq'd GRANT beats the seq'd WITHDRAWAL (pinned)", () => {
    // With one seq'd and one un-seq'd row the comparator is timestamp-only, so
    // an un-sequenced row with a later (possibly skewed) clock reactivates a
    // withdrawn scope. Stable across permutations for two rows, so pinned here
    // rather than reported; the order-dependence below is the real defect.
    for (const p of permutations([videoSeq, withdrawSeq, grantNoSeq])) {
      const t = deriveConsentStatus(p).find((s) => s.scope === "model_training")!;
      expect(t.lastAction).toBe("granted");
      expect(t.active).toBe(true);
    }
  });

  it("control: when BOTH rows carry seq, seq wins over a skewed timestamp", () => {
    const grantSeq = { ...grantNoSeq, seq: 5 };
    const status = deriveConsentStatus([videoSeq, withdrawSeq, grantSeq]);
    const training = status.find((s) => s.scope === "model_training")!;
    expect(training.lastAction).toBe("withdrawn");
    expect(training.active).toBe(false);
  });

  // Found by a seeded search (LCG seed 12345, trial 7): the partial comparator
  // is not a total order, so Array.prototype.sort's result depends on the
  // input order and the SAME ledger yields model_training ACTIVE or INACTIVE
  // depending on how its rows happen to be arranged in the file.
  const A = training({
    id: "SYNTHETIC-TEST-FIXTURE.tri-A",
    action: "withdrawn",
    recordedAtIso: "2026-08-01T00:00:00.000Z",
    seq: 5,
  });
  const B = training({
    id: "SYNTHETIC-TEST-FIXTURE.tri-B",
    action: "withdrawn",
    recordedAtIso: "2026-08-03T00:00:00.000Z",
  });
  const C = training({
    id: "SYNTHETIC-TEST-FIXTURE.tri-C",
    action: "granted",
    recordedAtIso: "2026-08-08T00:00:00.000Z",
    seq: 4,
  });

  it("REPRO: deriveConsentStatus verdict for {A,B,C} depends on input order", () => {
    // seq: C(4) < A(5). ts: A < B < C. B has no seq → cmp(A,B) and cmp(B,C) are
    // by timestamp while cmp(A,C) is by seq: a cycle A<B<C<A.
    const verdicts = permutations([A, B, C]).map((p) => {
      const t = deriveConsentStatus(p).find((s) => s.scope === "model_training")!;
      return `${t.lastAction}@${t.lastActionAtIso}`;
    });
    // VERIFIED on 4d812e1a: three different "latest" rows across six orderings.
    expect(new Set(verdicts).size).toBeGreaterThan(1);
    expect(verdicts).toContain("granted@2026-08-08T00:00:00.000Z");
    expect(verdicts).toContain("withdrawn@2026-08-01T00:00:00.000Z");
  });

  it.fails(
    "EXPECTED: same rows, any file order → same consent verdict (BROKEN on 4d812e1a)",
    () => {
      const verdicts = new Set(
        permutations([A, B, C]).map((p, i) =>
          JSON.stringify(
            checkConsentForSubject(loadConsentLedger(write(`tri-${i}.json`, p)), SUBJECT),
          ),
        ),
      );
      expect(verdicts.size).toBe(1);
    },
  );

  it.fails(
    "EXPECTED: a bare array mixing seq'd and un-seq'd rows is rejected OR ordered totally (BROKEN)",
    () => {
      // Either defence closes the hole: refuse the mix at load time (the envelope
      // path already demands seq on every row), or make the comparator total.
      const path = write("tri-mixed.json", [A, B, C]);
      let loaded: ConsentRecord[] | null = null;
      try {
        loaded = loadConsentLedger(path);
      } catch {
        loaded = null;
      }
      if (loaded === null) return; // rejected: acceptable
      const outcomes = new Set(
        permutations(loaded).map(
          (p) => deriveConsentStatus(p).find((s) => s.scope === "model_training")!.lastAction,
        ),
      );
      expect(outcomes.size).toBe(1);
    },
  );

  it("REPRO: two un-seq'd rows with IDENTICAL recordedAtIso — verdict depends on input order", () => {
    // Seeded search trial 10: equal timestamps and no seq → comparator returns 0
    // → sort is stable → whichever row came LAST in the file wins.
    const g = training({
      id: "SYNTHETIC-TEST-FIXTURE.tie-g",
      action: "granted",
      recordedAtIso: "2026-08-05T00:00:00.000Z",
    });
    const w = training({
      id: "SYNTHETIC-TEST-FIXTURE.tie-w",
      action: "withdrawn",
      recordedAtIso: "2026-08-05T00:00:00.000Z",
    });
    const gw = deriveConsentStatus([g, w]).find((s) => s.scope === "model_training")!;
    const wg = deriveConsentStatus([w, g]).find((s) => s.scope === "model_training")!;
    expect(gw.lastAction).toBe("withdrawn");
    expect(wg.lastAction).toBe("granted");
    expect(gw.active).not.toBe(wg.active);
  });
});

// ───────────────────────────── S4 ─────────────────────────────

describe("S4 v2 envelope: valid HMAC, subject differs only by Unicode normalization", () => {
  const NFC = "SYNTHETIC-TEST-FIXTURE.caf\u00e9"; // é as one code point
  const NFD = "SYNTHETIC-TEST-FIXTURE.cafe\u0301"; // e + combining acute
  const training = (subject: string): ConsentRecord[] => [
    row({ id: "SYNTHETIC-TEST-FIXTURE.u1", subjectPseudonym: subject, seq: 1 }),
    row({
      id: "SYNTHETIC-TEST-FIXTURE.u2",
      subjectPseudonym: subject,
      scope: "model_training",
      consentVersion: "model-training-v1",
      recordedAtIso: "2026-08-01T00:01:00.000Z",
      seq: 2,
    }),
  ];

  it("sanity: NFC and NFD forms are distinct strings that normalize equal", () => {
    expect(NFC).not.toBe(NFD);
    expect(NFC.normalize("NFC")).toBe(NFD.normalize("NFC"));
  });

  it("envelope subject NFD, records NFC, signature valid over the NFD header → REJECTED", () => {
    const records = training(NFC);
    const env = v2Envelope(records, { subjectPseudonym: NFD });
    const path = write("nfd-envelope.json", env);
    expect(() => loadConsentLedger(path, { signingKey: KEY })).toThrow(
      /records reference a subject other than the envelope's subjectPseudonym/,
    );
  });

  it("consistent NFD everywhere verifies, but a lookup with the NFC spelling finds NO consent", () => {
    const records = training(NFD);
    const path = write("nfd-consistent.json", v2Envelope(records));
    const ledger = loadConsentLedger(path, { signingKey: KEY });
    expect(checkConsentForSubject(ledger, NFD).ok).toBe(true);
    // Byte-exact matching: a differently-normalized spelling is a different
    // subject → NOT consented by default (fail closed). Pinned.
    const nfcLookup = checkConsentForSubject(ledger, NFC);
    expect(nfcLookup.ok).toBe(false);
    expect(nfcLookup.subjectRecordCount).toBe(0);
  });

  it("valid HMAC but a subject with trailing whitespace / zero-width joiner → REJECTED", () => {
    for (const evil of [`${SUBJECT} `, `${SUBJECT}\u200d`, `\ufeff${SUBJECT}`]) {
      const env = v2Envelope(training(SUBJECT), { subjectPseudonym: evil });
      const path = write(`evil-subject-${Buffer.from(evil).toString("hex").slice(-8)}.json`, env);
      expect(() => loadConsentLedger(path, { signingKey: KEY })).toThrow(
        /records reference a subject other than the envelope's subjectPseudonym/,
      );
    }
  });
});

describe("S4 v2 envelope: valid HMAC with exportedAtIso in the future / garbage", () => {
  const records = [
    row({ id: "SYNTHETIC-TEST-FIXTURE.f1", seq: 1 }),
    row({
      id: "SYNTHETIC-TEST-FIXTURE.f2",
      scope: "model_training",
      consentVersion: "model-training-v1",
      recordedAtIso: "2026-08-01T00:01:00.000Z",
      seq: 2,
    }),
  ];

  it("REPRO: exportedAtIso 100 years in the future with a valid signature is ACCEPTED", () => {
    const future = new Date(Date.now() + 100 * 365 * 24 * 3600 * 1000).toISOString();
    const env = v2Envelope(records, { exportedAtIso: future });
    const path = write("future-export.json", env);
    // VERIFIED on 4d812e1a: no freshness / clock-skew check exists on exportedAtIso.
    expect(() => loadConsentLedger(path, { signingKey: KEY })).not.toThrow();
  });

  it.fails("EXPECTED: exportedAtIso far in the future is rejected (BROKEN on 4d812e1a)", () => {
    const future = new Date(Date.now() + 100 * 365 * 24 * 3600 * 1000).toISOString();
    const path = write(
      "future-export-expected.json",
      v2Envelope(records, { exportedAtIso: future }),
    );
    expect(() => loadConsentLedger(path, { signingKey: KEY })).toThrow();
  });

  it.fails(
    "EXPECTED: exportedAtIso that is not a date at all is rejected (BROKEN on 4d812e1a)",
    () => {
      const env = v2Envelope(records, { exportedAtIso: "not-a-timestamp" });
      const path = write("garbage-export-ts.json", env);
      expect(() => loadConsentLedger(path, { signingKey: KEY })).toThrow();
    },
  );

  it.fails(
    "EXPECTED: exportedAtIso EARLIER than the newest record is rejected (BROKEN on 4d812e1a)",
    () => {
      // An export cannot predate the rows it contains; accepting it means the
      // header timestamp carries no semantics at all.
      const env = v2Envelope(records, { exportedAtIso: "2000-01-01T00:00:00.000Z" });
      const path = write("stale-export-ts.json", env);
      expect(() => loadConsentLedger(path, { signingKey: KEY })).toThrow();
    },
  );

  it("control: flipping ONE character of exportedAtIso after signing is rejected", () => {
    const env = v2Envelope(records, { exportedAtIso: "2026-08-29T00:00:01.000Z" });
    const tampered = { ...env, exportedAtIso: "2026-08-29T00:00:02.000Z" };
    const path = write("tampered-export-ts.json", tampered);
    expect(() => loadConsentLedger(path, { signingKey: KEY })).toThrow(
      /export signature does not verify/,
    );
  });

  it("control: signature over NFD subject presented with NFC subject fails the HMAC", () => {
    const env = v2Envelope(records, {
      subjectPseudonym: "SYNTHETIC-TEST-FIXTURE.cafe\u0301",
    });
    const swapped = { ...env, subjectPseudonym: "SYNTHETIC-TEST-FIXTURE.caf\u00e9" };
    const path = write("swapped-nfc.json", swapped);
    expect(() => loadConsentLedger(path, { signingKey: KEY })).toThrow(
      /export signature does not verify/,
    );
  });

  it("signature.value with non-hex but same length is rejected (no truthy coercion)", () => {
    const env = v2Envelope(records);
    const bogus = { ...env, signature: { ...env.signature, value: "z".repeat(64) } };
    const path = write("bogus-sig.json", bogus);
    expect(() => loadConsentLedger(path, { signingKey: KEY })).toThrow(
      /export signature does not verify/,
    );
  });
});
