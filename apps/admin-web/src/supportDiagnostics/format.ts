import type { SupportFailureCategory } from "./types";

/**
 * Pure presentation + defense-in-depth helpers for the support diagnostics
 * panel. The panel refuses to render any payload containing a key from the
 * forbidden list — the privacy contract is enforced client-side too, so a
 * regressed or spoofed API can never surface media or identity here.
 */

export const FORBIDDEN_DIAGNOSTIC_KEYS = [
  "bucket",
  "objectKey",
  "object_key",
  "sha256",
  "encryptionKeyId",
  "encryption_key_id",
  "pushToken",
  "push_token",
  "email",
  "displayName",
  "display_name",
  "handle",
] as const;

/** Deep scan; returns the JSONPath of every forbidden key found. */
export function findForbiddenKeys(payload: unknown, path = "$"): string[] {
  if (typeof payload !== "object" || payload === null) return [];
  if (Array.isArray(payload)) {
    return payload.flatMap((entry, index) => findForbiddenKeys(entry, `${path}[${index}]`));
  }
  const found: string[] = [];
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if ((FORBIDDEN_DIAGNOSTIC_KEYS as readonly string[]).includes(key)) {
      found.push(`${path}.${key}`);
    }
    found.push(...findForbiddenKeys(value, `${path}.${key}`));
  }
  return found;
}

/** "1.5s" / "230ms" / "—" for a not-yet-happened leg. */
export function formatLatencyMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

const CATEGORY_LABELS: Record<SupportFailureCategory, string> = {
  none: "completed",
  in_queue: "waiting in queue",
  in_progress: "processing",
  cancelled: "cancelled by user",
  cloud_model_unavailable: "cloud model unavailable",
  media: "media problem",
  validation: "invalid client request",
  quota: "quota / access denied",
  pipeline: "pipeline failure",
  unclassified: "unclassified",
};

export function describeFailureCategory(category: SupportFailureCategory): string {
  return CATEGORY_LABELS[category];
}

/** Traffic-light tone for the category badge. */
export function failureCategoryTone(category: SupportFailureCategory): "ok" | "pending" | "bad" {
  if (category === "none") return "ok";
  if (category === "in_queue" || category === "in_progress") return "pending";
  return "bad";
}
