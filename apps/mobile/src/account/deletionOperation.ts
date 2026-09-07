import type { LocalDb } from '../data/db';
import {
  createDeletionCapabilityVault,
  type DeletionKeychain,
  type DeletionVaultRead,
  type DeletionVaultWrite,
} from './deletionCapabilityVault';
import { createDeletionOperationJournal } from './deletionOperationJournal';
import {
  createDeletionOperationTransport,
  receiptFromVerifiedDeletionStatus,
  type DeletionTransportContext,
  type DeletionTransportFailure,
} from './deletionOperationTransport';
import {
  DELETION_CLEANUP_STEPS,
  DELETION_FOUNDATION_LIMITS,
  DELETION_ISSUES,
  DeletionFoundationError,
  deletionBindingFor,
  deletionInteger,
  deletionMember,
  deletionUuid,
  parseDeletionOwnership,
  sameDeletionBinding,
  sameDeletionReceipt,
  type DeletionCleanupContinuation,
  type DeletionHttpPort,
  type DeletionIssue,
  type DeletionJournalEntry,
  type DeletionMaintenanceLease,
  type DeletionMaintenancePort,
  type DeletionMaintenanceRequest,
  type DeletionOwnershipDraft,
  type DeletionReceipt,
  type DeletionRuntimePort,
  type DeletionSecretRecord,
} from './deletionOperationContracts';

export interface DeletionFoundationDependencies {
  readonly db: LocalDb;
  readonly keychain: DeletionKeychain;
  readonly runtime: DeletionRuntimePort;
  readonly http: DeletionHttpPort;
  readonly newJobId: () => string;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly maintenance?: DeletionMaintenancePort;
  readonly cleanup?: DeletionCleanupContinuation;
}

export interface DeletionOperationHandle {
  readonly jobId: string;
}

export type DeletionOperationResult =
  | {
      readonly kind: 'available';
      readonly handle: DeletionOperationHandle;
      readonly entry: DeletionJournalEntry;
    }
  | {
      readonly kind: 'held';
      readonly reason: DeletionIssue;
      readonly jobId?: string;
    }
  | { readonly kind: 'missing'; readonly jobId: string };

interface Ticket {
  readonly entry: DeletionJournalEntry;
  readonly context: DeletionTransportContext;
}

const activeJobs = new WeakMap<LocalDb, Set<string>>();

function held(reason: DeletionIssue, jobId?: string): DeletionOperationResult {
  return Object.freeze({
    kind: 'held',
    reason,
    ...(jobId === undefined ? {} : { jobId }),
  });
}

function errorResult(error: unknown, jobId?: string): DeletionOperationResult {
  const reason =
    error instanceof DeletionFoundationError &&
    deletionMember(error.code, DELETION_ISSUES)
      ? error.code
      : 'unknown';
  return held(reason, jobId);
}

function vaultIssue(
  kind: Exclude<DeletionVaultRead['kind'], 'available'>,
): DeletionIssue {
  switch (kind) {
    case 'empty':
      return 'capability_missing';
    case 'unavailable':
      return 'capability_unavailable';
    case 'invalid':
      return 'capability_invalid';
    case 'unsupported':
      return 'capability_unsupported';
    case 'conflict':
      return 'capability_conflict';
  }
}

function requireVaultWrite(result: DeletionVaultWrite): void {
  if (result.kind === 'saved') return;
  throw new DeletionFoundationError(
    result.kind === 'ambiguous'
      ? 'capability_write_ambiguous'
      : vaultIssue(result.reason),
  );
}

function remoteIssue(reply: DeletionTransportFailure): DeletionIssue {
  return reply.kind === 'stale' ? 'stale_handler' : reply.kind;
}

export function createDeletionOperationFoundation(
  input: DeletionFoundationDependencies,
) {
  const dependencies = Object.freeze({ ...input });
  const journal = createDeletionOperationJournal(dependencies.db);
  const vault = createDeletionCapabilityVault(dependencies.keychain);
  const transport = createDeletionOperationTransport(dependencies);
  const tickets = new WeakMap<DeletionOperationHandle, Ticket>();
  let disposed = false;

  function now(): number {
    const value = (dependencies.now ?? Date.now)();
    if (!deletionInteger(value) || value > Number.MAX_SAFE_INTEGER - 86_400_000)
      throw new DeletionFoundationError('unknown');
    return value;
  }

  function requireCurrent(context: DeletionTransportContext): void {
    if (disposed || !transport.isCurrent(context))
      throw new DeletionFoundationError('stale_handler');
  }

  function view(
    entry: DeletionJournalEntry,
    context: DeletionTransportContext,
  ): DeletionOperationResult {
    if (disposed || !transport.isCurrent(context))
      return held('stale_handler', entry.jobId);
    const handle = Object.freeze({ jobId: entry.jobId });
    tickets.set(handle, { entry, context });
    return Object.freeze({ kind: 'available', handle, entry });
  }

  async function withJob(
    jobId: string,
    operation: () => Promise<DeletionOperationResult>,
  ): Promise<DeletionOperationResult> {
    if (!deletionUuid(jobId)) return held('invalid_binding');
    const active = activeJobs.get(dependencies.db) ?? new Set<string>();
    if (active.has(jobId)) return held('stale_handler', jobId);
    active.add(jobId);
    activeJobs.set(dependencies.db, active);
    try {
      return await operation();
    } catch (error) {
      return errorResult(error, jobId);
    } finally {
      active.delete(jobId);
      if (active.size === 0) activeJobs.delete(dependencies.db);
    }
  }

  function update(
    entry: DeletionJournalEntry,
    changes: Partial<DeletionJournalEntry>,
  ): Promise<DeletionJournalEntry> {
    return journal.update(entry, {
      ...entry,
      ...changes,
      revision: entry.revision + 1,
    });
  }

  async function secure(
    entry: DeletionJournalEntry,
  ): Promise<DeletionSecretRecord> {
    const binding = deletionBindingFor(entry);
    if (!binding) throw new DeletionFoundationError('request_unknown');
    const read = await vault.read(binding);
    if (read.kind !== 'available')
      throw new DeletionFoundationError(vaultIssue(read.kind));
    if (
      read.record.expiresAt !== entry.expiresAt ||
      read.record.statusExpiresAt !== entry.statusExpiresAt ||
      (read.record.receipt !== null &&
        !sameDeletionReceipt(read.record.receipt, entry.receipt)) ||
      (entry.receipt !== null &&
        read.record.receipt === null &&
        entry.phase !== 'receipt_pending')
    ) {
      throw new DeletionFoundationError('capability_conflict');
    }
    return read.record;
  }

  async function runHandle(
    handle: DeletionOperationHandle,
    operation: (ticket: Ticket) => Promise<DeletionOperationResult>,
  ): Promise<DeletionOperationResult> {
    const ticket = tickets.get(handle);
    if (!ticket || disposed || !transport.isCurrent(ticket.context))
      return held('stale_handler');
    return withJob(ticket.entry.jobId, async () => {
      const current = await journal.read(ticket.entry.jobId);
      requireCurrent(ticket.context);
      if (!current || JSON.stringify(current) !== JSON.stringify(ticket.entry))
        throw new DeletionFoundationError('stale_handler');
      return operation({ context: ticket.context, entry: current });
    });
  }

  function delay(
    entry: DeletionJournalEntry,
    reply: DeletionTransportFailure,
    requesting = false,
  ): number {
    if (reply.kind === 'in_progress' || reply.kind === 'rate_limited')
      return reply.retryAfterMs;
    return requesting
      ? 0
      : Math.min(60_000, 3000 * 2 ** Math.min(entry.retryCount, 5));
  }

  async function submitRequest(
    entry: DeletionJournalEntry,
    context: DeletionTransportContext,
  ): Promise<DeletionOperationResult> {
    requireCurrent(context);
    const reply = await transport.request(context);
    if (reply.kind !== 'requested') {
      const unknown = await update(entry, {
        phase: 'request_unknown',
        serverState: 'unknown',
        lastIssue: remoteIssue(reply),
        nextAttemptAtMs: now() + delay(entry, reply, true),
        retryCount: Math.min(20, entry.retryCount + 1),
      });
      return view(unknown, context);
    }
    const securing = await update(entry, {
      phase: 'securing',
      operationId: reply.request.operationId,
      expiresAt: reply.request.expiresAt,
      statusExpiresAt: reply.request.statusExpiresAt,
      reviewAfterMs: now() + DELETION_FOUNDATION_LIMITS.reviewMilliseconds,
      serverState: 'pending',
      lastIssue: null,
      nextAttemptAtMs: 0,
      retryCount: 0,
    });
    requireVaultWrite(
      await vault.store({
        version: 1,
        jobId: entry.jobId,
        ownerId: entry.ownerId,
        apiOrigin: entry.apiOrigin,
        ...reply.request,
        receipt: null,
      }),
    );
    const ready = await update(securing, { phase: 'ready' });
    return view(ready, context);
  }

  async function seal(
    entry: DeletionJournalEntry,
    context: DeletionTransportContext,
    receipt: DeletionReceipt,
  ): Promise<DeletionOperationResult> {
    if (entry.receipt !== null && !sameDeletionReceipt(entry.receipt, receipt))
      throw new DeletionFoundationError('receipt_conflict');
    if (entry.receipt !== null && entry.phase !== 'receipt_pending')
      return view(entry, context);
    const pending =
      entry.receipt !== null
        ? entry
        : await update(entry, {
            phase: 'receipt_pending',
            receipt,
            serverState: 'completed',
            lastIssue: null,
            nextAttemptAtMs: 0,
            retryCount: 0,
          });
    const binding = deletionBindingFor(pending);
    if (!binding) throw new DeletionFoundationError('invalid_binding');
    requireVaultWrite(await vault.sealReceipt(binding, receipt));
    const verified = await update(pending, { phase: 'receipt_verified' });
    return view(verified, context);
  }

  return Object.freeze({
    dispose() {
      disposed = true;
      transport.dispose();
    },
    async list(): Promise<
      | {
          readonly kind: 'entries';
          readonly entries: readonly DeletionJournalEntry[];
        }
      | DeletionOperationResult
    > {
      if (disposed) return held('stale_handler');
      try {
        return Object.freeze({
          kind: 'entries',
          entries: await journal.list(),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    async request(
      draft: DeletionOwnershipDraft = {
        references: [],
        legacyMedia: 'unverified',
      },
    ): Promise<DeletionOperationResult> {
      const ownership = parseDeletionOwnership(draft);
      if (!ownership) return held('invalid_ownership_draft');
      const context = transport.captureOwner();
      if (!context)
        return held(disposed ? 'stale_handler' : 'origin_unavailable');
      try {
        const jobId = dependencies.newJobId();
        if (!deletionUuid(jobId)) return held('invalid_binding');
        return await withJob(jobId, async () => {
          const entry = await journal.create({
            version: 1,
            jobId,
            ownerId: context.ownerId,
            apiOrigin: context.apiOrigin,
            operationId: null,
            revision: 0,
            phase: 'request_pending',
            expiresAt: null,
            statusExpiresAt: null,
            reviewAfterMs: null,
            createdAtMs: now(),
            nextAttemptAtMs: 0,
            retryCount: 0,
            serverState: null,
            lastIssue: null,
            receipt: null,
            cleanup: { completed: [], pending: null },
            ownership,
          });
          return submitRequest(entry, context);
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    async open(jobId: string): Promise<DeletionOperationResult> {
      if (disposed) return held('stale_handler');
      return withJob(jobId, async () => {
        let entry = await journal.read(jobId);
        if (!entry) return Object.freeze({ kind: 'missing', jobId });
        const context = transport.captureRecovery(entry);
        if (!context) return held('origin_unavailable', jobId);
        if (entry.operationId !== null) {
          const record = await secure(entry);
          requireCurrent(context);
          if (entry.phase === 'securing')
            entry = await update(entry, { phase: 'ready' });
          else if (entry.phase === 'receipt_pending' && record.receipt !== null)
            entry = await update(entry, { phase: 'receipt_verified' });
        }
        return view(entry, context);
      });
    },
    retryRequest(
      handle: DeletionOperationHandle,
    ): Promise<DeletionOperationResult> {
      return runHandle(handle, async ({ entry, context }) => {
        if (
          entry.operationId !== null ||
          (entry.phase !== 'request_pending' &&
            entry.phase !== 'request_unknown')
        )
          throw new DeletionFoundationError('request_unknown');
        if (context.activeOwner.ownerKey !== entry.ownerId)
          throw new DeletionFoundationError('session_required');
        if (now() < entry.nextAttemptAtMs)
          throw new DeletionFoundationError('retry_later');
        const pending = await update(entry, { phase: 'request_pending' });
        return submitRequest(pending, context);
      });
    },
    confirm(handle: DeletionOperationHandle): Promise<DeletionOperationResult> {
      return runHandle(handle, async ({ entry, context }) => {
        if (entry.operationId === null)
          throw new DeletionFoundationError('request_unknown');
        if (context.activeOwner.ownerKey !== entry.ownerId)
          throw new DeletionFoundationError('session_required');
        if (entry.phase !== 'ready')
          throw new DeletionFoundationError('confirmation_unknown');
        if (now() < entry.reviewAfterMs!)
          throw new DeletionFoundationError('review_required');
        if (now() >= Date.parse(entry.expiresAt!))
          throw new DeletionFoundationError('confirmation_expired');
        if (now() < entry.nextAttemptAtMs)
          throw new DeletionFoundationError('retry_later');
        const record = await secure(entry);
        requireCurrent(context);
        const pending = await update(entry, {
          phase: 'confirm_pending',
          serverState: 'unknown',
          lastIssue: null,
        });
        const reply = await transport.confirm(context, record);
        if (reply.kind === 'completed')
          return seal(pending, context, reply.receipt);
        const unknown = await update(pending, {
          phase: reply.kind === 'in_progress' ? 'observing' : 'confirm_pending',
          serverState: reply.kind === 'in_progress' ? 'in_progress' : 'unknown',
          lastIssue: remoteIssue(reply),
          nextAttemptAtMs: now() + delay(entry, reply),
          retryCount: Math.min(20, entry.retryCount + 1),
        });
        return view(unknown, context);
      });
    },
    poll(handle: DeletionOperationHandle): Promise<DeletionOperationResult> {
      return runHandle(handle, async ({ entry, context }) => {
        if (entry.operationId === null)
          throw new DeletionFoundationError('request_unknown');
        if (now() >= Date.parse(entry.statusExpiresAt!))
          throw new DeletionFoundationError('status_expired');
        if (now() < entry.nextAttemptAtMs)
          throw new DeletionFoundationError('retry_later');
        const record = await secure(entry);
        requireCurrent(context);
        const reply = await transport.status(context, record);
        if (reply.kind === 'status' && reply.status.state === 'completed') {
          const receipt = receiptFromVerifiedDeletionStatus(reply.status);
          if (!receipt) throw new DeletionFoundationError('receipt_required');
          return seal(entry, context, receipt);
        }
        if (entry.receipt !== null) {
          if (reply.kind === 'status')
            throw new DeletionFoundationError('receipt_conflict');
          return held(remoteIssue(reply), entry.jobId);
        }
        const observed =
          reply.kind === 'status'
            ? await update(entry, {
                phase: reply.status.state === 'pending' ? 'ready' : 'observing',
                serverState: reply.status.state,
                lastIssue: null,
                retryCount: 0,
                nextAttemptAtMs: now() + 3000,
              })
            : await update(entry, {
                phase:
                  entry.phase === 'confirm_pending'
                    ? 'confirm_pending'
                    : 'observing',
                serverState: 'unknown',
                lastIssue: remoteIssue(reply),
                nextAttemptAtMs: now() + delay(entry, reply),
                retryCount: Math.min(20, entry.retryCount + 1),
              });
        return view(observed, context);
      });
    },
    continueCleanup(
      handle: DeletionOperationHandle,
    ): Promise<DeletionOperationResult> {
      return runHandle(handle, async ({ entry, context }) => {
        if (
          !entry.receipt ||
          !['receipt_verified', 'cleanup_pending', 'cleanup_complete'].includes(
            entry.phase,
          )
        )
          throw new DeletionFoundationError('receipt_required');
        await secure(entry);
        requireCurrent(context);
        if (entry.phase === 'cleanup_complete') return view(entry, context);
        if (!dependencies.maintenance || !dependencies.cleanup)
          throw new DeletionFoundationError('maintenance_required');
        const binding = deletionBindingFor(entry);
        if (!binding) throw new DeletionFoundationError('receipt_required');
        const request: DeletionMaintenanceRequest = Object.freeze({
          binding,
          activeOwner: context.activeOwner,
          originGeneration: context.originGeneration,
          mutationScope: 'original-owner-only',
          globalSessionMutation: 'forbidden',
          globalProfileMutation: 'forbidden',
        });
        let lease: DeletionMaintenanceLease | null;
        try {
          lease = await dependencies.maintenance.acquire(request);
        } catch {
          throw new DeletionFoundationError('maintenance_required');
        }
        let live = true;
        const isCurrent = () => {
          try {
            return (
              live &&
              !disposed &&
              transport.isCurrent(context) &&
              lease !== null &&
              sameDeletionBinding(lease.binding, binding) &&
              lease.isCurrent()
            );
          } catch {
            return false;
          }
        };
        try {
          if (!isCurrent())
            throw new DeletionFoundationError('maintenance_required');
          const step = DELETION_CLEANUP_STEPS[entry.cleanup.completed.length];
          if (!step) throw new DeletionFoundationError('journal_invalid');
          const pending = await update(entry, {
            phase: 'cleanup_pending',
            cleanup: { completed: entry.cleanup.completed, pending: step },
          });
          if (!isCurrent()) throw new DeletionFoundationError('stale_handler');
          let outcome: 'checkpointed' | 'pending';
          try {
            outcome = await dependencies.cleanup(
              Object.freeze({
                ...request,
                receipt: entry.receipt,
                step,
                idempotencyKey: `account-deletion:${entry.jobId}:${binding.operationId}:${step}`,
                ownership: entry.ownership,
                nativeOwnershipVerified: false,
                isCurrent,
              }),
            );
          } catch {
            throw new DeletionFoundationError('cleanup_unknown');
          }
          if (!isCurrent()) throw new DeletionFoundationError('stale_handler');
          if (outcome === 'pending') return view(pending, context);
          if (outcome !== 'checkpointed')
            throw new DeletionFoundationError('cleanup_unknown');
          const completed = [...pending.cleanup.completed, step];
          const checkpointed = await update(pending, {
            phase:
              completed.length === DELETION_CLEANUP_STEPS.length
                ? 'cleanup_complete'
                : 'cleanup_pending',
            cleanup: { completed, pending: null },
          });
          return view(checkpointed, context);
        } finally {
          live = false;
          try {
            await lease?.release();
          } catch {
            live = false;
          }
        }
      });
    },
  });
}
