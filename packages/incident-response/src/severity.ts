/**
 * Incident severity taxonomy. Severity is assigned by user impact and blast
 * radius, never by which team owns the failing component.
 */

export const SEVERITIES = ["P0", "P1", "P2"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface SeverityDefinition {
  severity: Severity;
  summary: string;
  /** Concrete criteria — an incident matching any one of these gets this severity. */
  criteria: string[];
  /** Maximum time from detection to a human acknowledging the incident. */
  acknowledgeWithinMinutes: number;
  /** Maximum time from acknowledgement to user-facing mitigation (halt/disable/rollback). */
  mitigateWithinMinutes: number;
  postmortemRequired: boolean;
}

export const SEVERITY_DEFINITIONS: Record<Severity, SeverityDefinition> = {
  P0: {
    severity: "P0",
    summary:
      "Active harm to users or the business: wrong coaching delivered confidently at scale, privacy/consent breach, or irreversible data corruption.",
    criteria: [
      "Confidently wrong coaching (high-confidence, incorrect advice) reaching a non-trivial share of active users",
      "Personal data, video, or consent state exposed to unauthorized parties or used beyond its consent scope",
      "Data corruption that is spreading or irreversible without intervention",
      "Any incident where continued operation makes the damage worse",
    ],
    acknowledgeWithinMinutes: 15,
    mitigateWithinMinutes: 60,
    postmortemRequired: true,
  },
  P1: {
    severity: "P1",
    summary:
      "Major degradation without active spreading harm: a core workflow is down or badly degraded, but stopping the bleeding does not require disabling features for all users.",
    criteria: [
      "Analysis queue stalled — sessions accepted but results not produced",
      "Camera capture or upload regression blocking a significant fraction of new sessions",
      "A release gate or evaluation pipeline broken so regressions could ship undetected",
    ],
    acknowledgeWithinMinutes: 60,
    mitigateWithinMinutes: 240,
    postmortemRequired: true,
  },
  P2: {
    severity: "P2",
    summary:
      "Minor or contained degradation: quality regression on a narrow slice, degraded non-critical tooling, or an issue with a known workaround.",
    criteria: [
      "Quality regression confined to a narrow stroke type, device tier, or cohort",
      "Non-critical internal tooling (lab scripts, dashboards) degraded",
      "Any issue with a documented workaround and no user-data risk",
    ],
    acknowledgeWithinMinutes: 24 * 60,
    mitigateWithinMinutes: 7 * 24 * 60,
    postmortemRequired: false,
  },
};

export function isSeverity(value: string): value is Severity {
  return (SEVERITIES as readonly string[]).includes(value);
}

/** True when `a` is at least as severe as `b` (P0 is most severe). */
export function isAtLeastAsSevere(a: Severity, b: Severity): boolean {
  return SEVERITIES.indexOf(a) <= SEVERITIES.indexOf(b);
}
