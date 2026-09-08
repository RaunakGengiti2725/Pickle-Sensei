import type { DurableSnapshot, OutcomeSummary } from '../processDeath/report';

export interface AttackChildReport {
  readonly launch: '1' | '2';
  readonly mode: 'full' | 'recover_only';
  readonly clockOffsetMs: number;
  readonly ownerKey: string;
  readonly apiOrigin: string;
  readonly asFound: DurableSnapshot;
  readonly afterRecovery: DurableSnapshot;
  /** null when the launch only ran recovery/drain (`recover_only`). */
  readonly outcome: OutcomeSummary | null;
  readonly final: DurableSnapshot;
}
