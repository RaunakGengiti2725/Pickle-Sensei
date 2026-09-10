// Runs the Edge function's own authority verification and admission against a
// saved `read_analysis_release_policy()` result, plus the shared per-input
// eligibility for the shipping observations. Usage (repo root):
//
//   npx --yes deno@2.5.6 run --config supabase/functions/api/deno.json \
//     --lock=supabase/functions/api/deno.lock --frozen --node-modules-dir=none \
//     --allow-read tools/release-policy/verify-authority.ts <authority.json>
//
// `<authority.json>` is the `--output json` of
// `supabase db query --linked "select public.read_analysis_release_policy() as authority"`.
import {
  admitChargeableRelease,
  eligibilityForVerifiedRelease,
  readVerifiedReleasePolicy,
} from "../../supabase/functions/api/releasePolicy.ts";

const path = Deno.args[0];
if (!path) {
  console.error("usage: verify-authority.ts <authority.json>");
  Deno.exit(2);
}
const rows = JSON.parse(await Deno.readTextFile(path)) as Array<
  { authority: unknown }
>;
const authority = rows[0]?.authority;
const now = Math.floor(Date.now() / 1000);
const policy = await readVerifiedReleasePolicy(() =>
  Promise.resolve({ data: authority, error: null })
);
const admission = admitChargeableRelease(policy, now);
console.log("verified policy:", policy ? policy.approval.policy : null);
console.log(
  "policy-level admission (route/edge charge paths):",
  JSON.stringify(
    admission.status === "active"
      ? { status: "active", version: admission.policy.document.version }
      : admission,
  ),
);
const probes = [
  {
    shotType: "forehand_drive",
    cameraView: "side",
    handedness: "right",
    captureMode: "automatic_pose_trigger",
  },
  {
    shotType: "dink",
    cameraView: "side",
    handedness: "left",
    captureMode: "imported_video",
  },
  {
    shotType: "overhead",
    cameraView: "side",
    handedness: "ambidextrous",
    captureMode: "imported_video",
  },
  {
    shotType: "forehand_drive",
    cameraView: "rear_oblique",
    handedness: "right",
    captureMode: "automatic_pose_trigger",
  },
] as const;
for (const probe of probes) {
  const eligibility = eligibilityForVerifiedRelease(
    policy,
    { ...probe, source: "real", intentConfirmed: true },
    now,
  );
  console.log(
    `${probe.shotType}/${probe.cameraView}/${probe.handedness}/${probe.captureMode}:`,
    eligibility.status === "eligible"
      ? "eligible"
      : `ineligible (${eligibility.reasonCode})`,
  );
}
const fixture = eligibilityForVerifiedRelease(
  policy,
  { ...probes[0], source: "fixture", intentConfirmed: true },
  now,
);
console.log(
  "fixture input:",
  fixture.status === "eligible"
    ? "eligible"
    : `ineligible (${fixture.reasonCode})`,
);
