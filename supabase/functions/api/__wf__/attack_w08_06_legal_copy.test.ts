// W08-06 ADVERSARY (copy plane): the retained-record disclosures in legal.ts
// must match what the migrations actually keep after `delete from auth.users`
// — not just the free-rating ledger. Cross-checks support / privacy / terms /
// the in-app confirmation against the schema, and scans for prohibited terms.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json \
//     attack_w08_06_legal_copy.test.ts
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PRIVACY_POLICY_TEXT, SUPPORT_TEXT, TERMS_TEXT } from "../legal.ts";
import {
  ACCOUNT_DELETION_UNREAD_TABLES,
  ACCOUNT_OWNER_NAMESPACES,
} from "../accountDeletionOperations.ts";

const flat = (text: string) => text.replace(/\s+/g, " ");
const support = flat(SUPPORT_TEXT);
const privacy = flat(PRIVACY_POLICY_TEXT);
const terms = flat(TERMS_TEXT);

function section(text: string, heading: RegExp, next: RegExp): string {
  const start = text.search(heading);
  assert(start >= 0, `heading ${heading} present`);
  const rest = text.slice(start + 1);
  const end = rest.search(next);
  return rest.slice(0, end < 0 ? undefined : end);
}

const PROHIBITED =
  /Android|Google Play|guest mode|Live Court|DUPR|SwingVision|PB Vision|Selkirk|JOOLA|\d+\s?% accura|best-in-class|world[- ]class|#1|replaces? (a|your) coach|as good as a (human )?coach/i;

// ---------------------------------------------------------------------------
// ATTACK 20 — the support page points at "Section 7 of the Privacy Policy":
// the SHA-256 / scored-count statement must live INSIDE §7 (not §8), the hash
// algorithm must be the one the migration uses, and every surface (support,
// §7, §8, Terms §8, Terms §12, in-app confirmation) must agree on the two
// facts: same Apple/Google identity, used ratings not restored.
// ---------------------------------------------------------------------------
Deno.test("ATTACK W08-06 #20: retained free-rating record is disclosed identically on every surface and lives in the section the support page cites", async () => {
  const seven = section(privacy, /7\. RETENTION/, /8\. ACCOUNT DELETION/);
  assertStringIncludes(seven, "one-way hash (SHA-256)");
  assertStringIncludes(seven, "number of scored analyses");
  assertStringIncludes(seven, "survives account deletion");
  const eight = section(privacy, /8\. ACCOUNT DELETION/, /9\. /);
  assertStringIncludes(eight, "described in Section 7");
  assertStringIncludes(eight, "same Apple or Google account");

  const ledgerMigration = await Deno.readTextFile(
    new URL("../../../migrations/20260902150000_free_rating_identity_ledger.sql", import.meta.url),
  );
  assert(/sha256\(convert_to\(p_provider \|\| ':' \|\| p_provider_id/.test(ledgerMigration));

  const termsEight = section(terms, /8\. /, /9\. /);
  assertStringIncludes(termsEight, "once per sign-in identity");
  assertStringIncludes(termsEight, "same Apple or Google account");
  const termsTwelve = section(terms, /12\. /, /13\. /);
  assertStringIncludes(termsTwelve, "restore free ratings already used");

  const screen = flat(
    await Deno.readTextFile(
      new URL("../../../../apps/mobile/src/screens/ManageAccountScreen.tsx", import.meta.url),
    ),
  );
  assertStringIncludes(screen, "Free ratings you've already used stay used");
  assertStringIncludes(screen, "same Apple or Google sign-in");

  for (const [label, text] of [["support", support], ["privacy", privacy], ["terms", terms]]) {
    assert(!PROHIBITED.test(text), `${label}: prohibited term`);
    assert(text.includes("same Apple or Google account"), label);
  }
  // Support must not over-claim: it says "Only a one-way hash ... is kept for
  // this purpose" — scoped to the free-rating purpose, so it must not also say
  // nothing else survives.
  assert(
    !/nothing else is (kept|retained)|no other (data|record)s? (is|are) (kept|retained)/i.test(
      support,
    ),
  );
});

// ---------------------------------------------------------------------------
// ATTACK 21 — retention parity beyond the ledger: every server-side record
// the schema keeps AFTER auth.users loses the row must be described in the
// retention section. Derived from the migrations: tables carrying an account
// identifier with NO FK to auth.users/profiles, plus the candidate's own
// `retained` list. The deletion operation row (owner_id, hashed challenge,
// completion time — retained 7 days by `retain_until`) is one of them.
// ---------------------------------------------------------------------------
Deno.test("ATTACK W08-06 #21: every account-identifying record retained after Auth deletion is disclosed in Privacy §7", async () => {
  const seven = section(privacy, /7\. RETENTION/, /8\. ACCOUNT DELETION/);
  const retained: Array<[table: string, disclosure: RegExp]> = [
    ["free_rating_ledger", /one-way hash \(SHA-256\)/],
    ["webhook_events", /webhook audit records are scheduled for deletion after 90 days/],
    // api_private.account_deletion_operations: owner_id + hashed challenge +
    // status capability + completion time survive Auth deletion for 7 days
    // (status readable for 24 h) so the receipt can be re-served.
    [
      "account_deletion_operations",
      /(deletion (operation|receipt|status) records?|completion receipts?)[^.]*(7 days|seven days|24 hours)/i,
    ],
  ];
  for (
    const table of Object.keys(ACCOUNT_DELETION_UNREAD_TABLES).filter(
      (t) => ACCOUNT_DELETION_UNREAD_TABLES[t] === "retained",
    )
  ) {
    assert(
      retained.some(([name]) => name === table),
      `retained table ${table} is in the parity list`,
    );
  }
  const migration = await Deno.readTextFile(
    new URL("../../../migrations/20260907001500_account_deletion_operations.sql", import.meta.url),
  );
  assert(/owner_id uuid not null,/.test(migration), "owner_id has no FK (survives Auth deletion)");
  assert(/retain_until = created_at \+ interval '7 days'/.test(migration));
  assert(/status_expires_at = created_at \+ interval '24 hours'/.test(migration));

  const missing = retained.filter(([, disclosure]) => !disclosure.test(seven)).map(([t]) => t);
  assertEquals(
    missing,
    [],
    `records retained after account deletion but not described in Privacy §7: ${
      JSON.stringify(missing)
    }`,
  );
  // The namespaces the sweep verifies are the ones §8 promises to remove.
  const eight = section(privacy, /8\. ACCOUNT DELETION/, /9\. /);
  for (
    const phrase of [
      "profile",
      "synced analysis history",
      "sessions",
      "progress data",
      "saved drills",
      "consent records",
      "evaluation records",
      "feedback",
      "permits",
      "rank state",
      "entitlement row",
    ]
  ) {
    assertStringIncludes(eight, phrase);
  }
  assertEquals(ACCOUNT_OWNER_NAMESPACES.length, 16);
});
