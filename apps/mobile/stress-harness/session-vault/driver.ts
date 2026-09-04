/**
 * Sequence driver: replays one seeded sequence against the real
 * `sessionVault` module and the reference model, checking every invariant
 * after EVERY step. Returns a deterministic trace (same seed → same trace)
 * plus the list of violations, so callers can shrink failing seeds.
 */
import {
  clearPersistedSession,
  loadPersistedSession,
  savePersistedSession,
  type PersistedSession,
} from '../../src/account/sessionVault';
import {
  CORRUPT_RECORD_VARIANTS,
  FOREIGN_SERVICE,
  describeStep,
  generateSequence,
  sessionVariant,
  traceHash,
  type Step,
} from './generator';
import { keychainFake, type KeychainItem } from './keychainFake';
import {
  PERSISTED_SESSION_KEYS,
  VAULT_ACCESSIBLE,
  VAULT_ACCOUNT,
  VAULT_SERVICE,
  initialModel,
  modelClear,
  modelLoad,
  modelParse,
  modelSave,
  type ModelState,
} from './model';

export const FOREIGN_ITEM: KeychainItem = {
  username: 'other',
  password: 'other-app-item',
  accessible: 'AccessibleWhenUnlockedThisDeviceOnly',
};

export interface StepResult {
  summary: string;
  violations: string[];
}

export interface SequenceResult {
  seed: number;
  steps: number;
  outcome: 'held' | 'violated';
  violations: string[];
  traceHash: string;
  trace: string[];
  /** Coverage witnesses, aggregated by the campaign for honest reporting. */
  counters: Record<string, number>;
}

function digest(value: unknown): string {
  if (value === null) return 'null';
  const record = value as PersistedSession;
  return [
    record.version,
    record.provider,
    record.canonicalAppUserId,
    `len:${record.refreshToken.length}`,
    record.email === null ? 'email:null' : `email:${record.email.length}`,
    record.displayName === null
      ? 'name:null'
      : `name:${record.displayName.length}`,
  ].join('|');
}

function itemsEqual(
  actual: Map<string, KeychainItem>,
  expected: Map<string, KeychainItem>,
): string | null {
  if (actual.size !== expected.size) {
    return `keychain item count ${actual.size} != model ${expected.size}`;
  }
  for (const [service, want] of expected) {
    const got = actual.get(service);
    if (!got) return `keychain missing item for service ${service}`;
    if (got.username !== want.username) {
      return `item ${service} username ${got.username} != ${want.username}`;
    }
    if (got.accessible !== want.accessible) {
      return `item ${service} accessible ${String(got.accessible)} != ${String(want.accessible)}`;
    }
    if (got.password.length !== want.password.length) {
      return `item ${service} payload length ${got.password.length} != ${want.password.length}`;
    }
    if (got.password !== want.password) {
      return `item ${service} payload differs from model`;
    }
  }
  return null;
}

function bump(counters: Record<string, number>, key: string): void {
  counters[key] = (counters[key] ?? 0) + 1;
}

async function runStep(
  step: Step,
  model: ModelState,
  counters: Record<string, number>,
): Promise<StepResult> {
  const violations: string[] = [];
  let summary = '';

  switch (step.kind) {
    case 'save': {
      const variant = sessionVariant(step.variant);
      const raw = JSON.stringify(variant.session);
      if (variant.loadable !== (modelParse(raw) !== null)) {
        violations.push(
          `corpus claim wrong for ${variant.name}: loadable=${variant.loadable}`,
        );
      }
      let actual: boolean;
      try {
        actual = await savePersistedSession(variant.session);
      } catch (error) {
        violations.push(`savePersistedSession threw: ${String(error)}`);
        return { summary: 'save->throw', violations };
      }
      const expected = modelSave(model, raw);
      if (actual !== expected) {
        violations.push(`save returned ${actual}, model ${expected}`);
      }
      if (model.setMode !== 'ok') bump(counters, 'saveUnderKeychainFault');
      if (raw.length >= 1024 * 1024) bump(counters, 'saveOversized1Mb');
      summary = `save->${actual}`;
      break;
    }
    case 'load': {
      let actual: PersistedSession | null;
      try {
        actual = await loadPersistedSession();
      } catch (error) {
        violations.push(`loadPersistedSession threw: ${String(error)}`);
        return { summary: 'load->throw', violations };
      }
      const expected = modelLoad(model);
      if (digest(actual) !== digest(expected.session)) {
        violations.push(
          `load returned ${digest(actual)}, model ${digest(expected.session)}`,
        );
      }
      if (actual) {
        const keys = Object.keys(actual).sort();
        const allowed = [...PERSISTED_SESSION_KEYS];
        if (keys.join(',') !== allowed.join(',')) {
          violations.push(`load leaked/omitted fields: ${keys.join(',')}`);
        }
        if (
          actual.version !== 1 ||
          (actual.provider !== 'apple' && actual.provider !== 'google') ||
          typeof actual.canonicalAppUserId !== 'string' ||
          actual.canonicalAppUserId.length === 0 ||
          typeof actual.refreshToken !== 'string' ||
          actual.refreshToken.length === 0
        ) {
          violations.push(`load returned unusable session: ${digest(actual)}`);
        }
        if (
          (actual.email !== null && typeof actual.email !== 'string') ||
          (actual.displayName !== null &&
            typeof actual.displayName !== 'string')
        ) {
          violations.push('load returned non-normalised descriptor fields');
        }
        bump(counters, 'loadRestored');
      } else if (expected.discardAttempted) {
        if (keychainFake.store.has(VAULT_SERVICE) && model.resetMode === 'ok') {
          violations.push('malformed record was not discarded');
        }
        bump(counters, 'loadDiscardedMalformed');
      }
      if (({} as Record<string, unknown>)['vaultPolluted'] !== undefined) {
        violations.push('Object.prototype polluted by a vault record');
      }
      if (model.getMode !== 'ok') bump(counters, 'loadUnderKeychainFault');
      summary = `load->${digest(actual)}`;
      break;
    }
    case 'clear': {
      try {
        await clearPersistedSession();
      } catch (error) {
        violations.push(`clearPersistedSession threw: ${String(error)}`);
        return { summary: 'clear->throw', violations };
      }
      modelClear(model);
      if (model.resetMode !== 'ok') bump(counters, 'clearUnderKeychainFault');
      summary = 'clear->ok';
      break;
    }
    case 'corrupt': {
      // Another build / a partially written item: the payload appears in the
      // vault's own Keychain slot without going through the module.
      const raw = CORRUPT_RECORD_VARIANTS[step.variant] ?? '';
      const item: KeychainItem = {
        username: VAULT_ACCOUNT,
        password: raw,
        accessible: VAULT_ACCESSIBLE,
      };
      keychainFake.store.set(VAULT_SERVICE, { ...item });
      model.items.set(VAULT_SERVICE, { ...item });
      bump(counters, 'corruptRecordsPlanted');
      summary = `corrupt->${raw.length}b`;
      break;
    }
    case 'foreign-write': {
      keychainFake.store.set(FOREIGN_SERVICE, { ...FOREIGN_ITEM });
      model.items.set(FOREIGN_SERVICE, { ...FOREIGN_ITEM });
      summary = 'foreign-write->ok';
      break;
    }
    case 'fault': {
      if (step.op === 'set') {
        keychainFake.setMode = step.mode;
        model.setMode = step.mode;
      } else if (step.op === 'get') {
        keychainFake.getMode = step.mode;
        model.getMode = step.mode;
      } else {
        keychainFake.resetMode = step.mode;
        model.resetMode = step.mode;
      }
      summary = `fault->${step.mode}`;
      break;
    }
  }

  const mismatch = itemsEqual(keychainFake.store, model.items);
  if (mismatch) violations.push(mismatch);
  const foreign = keychainFake.store.get(FOREIGN_SERVICE);
  if (foreign && foreign.password !== FOREIGN_ITEM.password) {
    violations.push('an unrelated Keychain item was modified');
  }
  const vaultItem = keychainFake.store.get(VAULT_SERVICE);
  if (vaultItem && vaultItem.username !== VAULT_ACCOUNT) {
    violations.push(`vault item account is ${vaultItem.username}`);
  }
  if (vaultItem && vaultItem.accessible !== VAULT_ACCESSIBLE) {
    violations.push(
      `vault item accessibility is ${String(vaultItem.accessible)}`,
    );
  }
  for (const op of keychainFake.log) {
    if (op.service !== VAULT_SERVICE) {
      violations.push(
        `vault issued a Keychain op on service ${String(op.service)}`,
      );
    }
  }
  keychainFake.log.length = 0;
  return { summary, violations };
}

export async function runSteps(
  seed: number,
  steps: readonly Step[],
): Promise<SequenceResult> {
  keychainFake.reset();
  const model = initialModel();
  const trace: string[] = [];
  const violations: string[] = [];
  const counters: Record<string, number> = {};

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    const { summary, violations: stepViolations } = await runStep(
      step,
      model,
      counters,
    );
    trace.push(`${index}:${describeStep(step)}=>${summary}`);
    for (const violation of stepViolations) {
      violations.push(`step ${index} (${describeStep(step)}): ${violation}`);
    }
    if (stepViolations.length > 0) break;
  }

  // Terminal invariant: a healthy explicit sign-out always empties the vault.
  keychainFake.resetMode = 'ok';
  model.resetMode = 'ok';
  await clearPersistedSession();
  modelClear(model);
  if (keychainFake.store.has(VAULT_SERVICE)) {
    violations.push('vault item survived an explicit clearPersistedSession()');
  }
  trace.push(`final:clear=>${keychainFake.store.size}items`);

  return {
    seed,
    steps: steps.length,
    outcome: violations.length === 0 ? 'held' : 'violated',
    violations,
    traceHash: traceHash(trace),
    trace,
    counters,
  };
}

export async function runSequence(seed: number): Promise<SequenceResult> {
  return runSteps(seed, generateSequence(seed).steps);
}

/**
 * Delta-debugging shrink: drops steps while the sequence still violates an
 * invariant, so a failing seed is reported as a minimal step list.
 */
export async function shrink(
  seed: number,
  steps: readonly Step[],
): Promise<{ steps: Step[]; result: SequenceResult }> {
  let current = [...steps];
  let result = await runSteps(seed, current);
  if (result.outcome === 'held') return { steps: current, result };
  let progress = true;
  while (progress && current.length > 1) {
    progress = false;
    for (let index = 0; index < current.length; index += 1) {
      const candidate = current.filter((_, position) => position !== index);
      const candidateResult = await runSteps(seed, candidate);
      if (candidateResult.outcome === 'violated') {
        current = candidate;
        result = candidateResult;
        progress = true;
        break;
      }
    }
  }
  return { steps: current, result };
}
