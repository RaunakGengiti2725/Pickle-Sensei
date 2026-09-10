/**
 * W05-07 adversarial cross-plane check — the wire entry the mobile drain
 * (apps/mobile/src/data/offlineWallet.ts submission()) actually produces at
 * be905c7a, presented to the shipping route POST /v1/offline/receipts.
 *
 * The fixture fixtures/w05_07_device_wire_entry.json is the exact JSON the
 * device posted in apps/mobile/__tests__/w05CourtOfflineRunAttack.test.ts
 * (A10, run with W05_ATTACK_WIRE_DUMP). Two questions:
 *   1. does the route accept the entry the device sends (receipt shape, grant
 *      transport, output digest binding)?
 *   2. does the route answer in a shape the device can read
 *      (`{ receipts, rejected }` per api.ts parseOfflineReceiptVerdicts)?
 * Either answer being "no" means a court-offline read can never settle
 * against the production backend.
 */
import { assert, assertEquals } from "@std/assert";
import { exportJWK, generateKeyPair } from "jose";
import { digestCanonicalOfflineJson, digestOfflineGrantTransport } from "../canonicalDigest.ts";
import {
  validateOfflineResultReceiptShape,
  validateOfflineSignedGrantShape,
} from "../../../../packages/shared-types/src/offlineAuthorization.ts";
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const h = await loadHarness();

const RECEIPTS_PATH = "/v1/offline/receipts";
const SIGNING_ENV = "OFFLINE_GRANT_SIGNING_JWK";
const KID = "w05-07-attack-key";

const keyPair = await generateKeyPair("ES256", { extractable: true });
const privateJwk = { ...(await exportJWK(keyPair.privateKey)), kid: KID };

const fixtureUrl = new URL("./fixtures/w05_07_device_wire_entry.json", import.meta.url);
const deviceEntry = JSON.parse(await Deno.readTextFile(fixtureUrl)) as {
  receipt: Record<string, unknown>;
  grant: Record<string, unknown>;
  output: Record<string, unknown> | null;
};
const deviceOwner = deviceEntry.receipt.ownerId as string;

function reset(): void {
  h.reset();
  Deno.env.set(SIGNING_ENV, JSON.stringify(privateJwk));
}

Deno.test(
  "the device receipt is the frozen offline-result-receipt-v1 the route validates before anything else",
  () => {
    const shape = validateOfflineResultReceiptShape(deviceEntry.receipt);
    assertEquals(
      shape.ok ? null : { rejected: shape, sentFields: Object.keys(deviceEntry.receipt).sort() },
      null,
      "receipt as persisted by the device must validate as offline-result-receipt-v1",
    );
  },
);

Deno.test(
  "the device grant transport and output digest bind exactly as the route recomputes them",
  async () => {
    const grant = validateOfflineSignedGrantShape(deviceEntry.grant);
    assert(grant.ok, "grant must be offline-signed-grant-v1");
    assertEquals(
      await digestOfflineGrantTransport(deviceEntry.grant),
      deviceEntry.receipt.grantJwsSha256,
      "grantJwsSha256 must be sha256(compactJws)",
    );
    assert(deviceEntry.output !== null, "the device still held the output");
    assertEquals(
      deviceEntry.output.id,
      deviceEntry.receipt.resultId,
      "output.id must name the result",
    );
    assertEquals(
      await digestCanonicalOfflineJson(deviceEntry.output),
      deviceEntry.receipt.fullOutputSha256,
      "the server's RFC 8785 digest of output must equal the device's fullOutputSha256",
    );
  },
);

Deno.test(
  "POST /v1/offline/receipts with the device entry: the route neither rejects the receipt nor answers in a shape the device cannot read",
  async () => {
    reset();
    const response = await h.handler(
      userRequest("POST", RECEIPTS_PATH, {
        token: fakeGoogleIdToken(deviceOwner),
        body: { receipts: [deviceEntry] },
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;
    assertEquals(response.status, 200);
    const results = body.results as Array<Record<string, unknown>> | undefined;
    assertEquals(
      results?.map((r) => ({ delivery: r.delivery, error: r.error })),
      [{ delivery: "settled", error: null }],
      "the route must not reject the exact entry the device produces",
    );
    assert(
      Array.isArray(body.receipts) && Array.isArray(body.rejected ?? []),
      `api.ts parseOfflineReceiptVerdicts needs { receipts, rejected }; the route answered keys ${JSON.stringify(
        Object.keys(body),
      )}`,
    );
  },
);
