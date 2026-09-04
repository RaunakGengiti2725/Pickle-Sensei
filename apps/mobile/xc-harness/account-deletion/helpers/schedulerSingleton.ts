/**
 * The one fake OS notification scheduler for a test file; dependency-free so
 * the `jest.mock('../../src/notifications/service')` factory can require it.
 */
import type {
  PermissionState,
  SchedulerPort,
} from '../../../src/notifications/service';
import type { PlannedNotification } from '../../../src/notifications/types';

export class FakeScheduler implements SchedulerPort {
  permission: PermissionState = 'granted';
  requestCalls = 0;
  cancelAllCalls = 0;
  appliedPlans: PlannedNotification[][] = [];
  /** What the OS would currently have pending: last applied plan, or [] after
   * a cancelAllPlanned. */
  pending: PlannedNotification[] = [];
  async permissionState(): Promise<PermissionState> {
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    this.requestCalls += 1;
    return this.permission;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.appliedPlans.push([...plan]);
    this.pending = [...plan];
  }
  async cancelAllPlanned(): Promise<void> {
    this.cancelAllCalls += 1;
    this.pending = [];
  }
  async openSystemSettings(): Promise<void> {}
}

export const scheduler = new FakeScheduler();
