import {
  RAW_STRING_VARIANTS,
  RAW_VARIANT_NAMES,
  VAULT_RECORD_VARIANTS,
  KV_LOCAL_MODE_VARIANTS,
  KV_LAST_PROVIDER_VARIANTS,
  KV_LEGACY_SESSION_VARIANTS,
  PENDING_PROFILE_KV_VARIANTS,
} from '../../xc-harness/lifecycle-persistence/seeds';
import type { World } from './world';

/**
 * The fault catalog for the WelcomeScreen launch surface.
 *
 * Each entry is ONE injected fault: a named, replayable mutation of the
 * process edges the real App touches while it renders WelcomeScreen. A fault
 * declares which dependency it targets, which failure class it belongs to
 * (throw / reject / timeout / malformed / partial / slow / never-resolves),
 * how the harness can prove it was exercised, and whether the fault is
 * expected to trip the RootErrorBoundary (a synchronous throw from a
 * render-phase or effect-phase native call has no other place to land).
 *
 * `preferInstall` tells the seeded campaign which persisted-state shape
 * makes the fault reachable (a fetch fault is dead code on a fresh install
 * where nothing is ever fetched).
 */

export type Dependency =
  | 'keychain'
  | 'sqlite'
  | 'fetch'
  | 'google'
  | 'notifications'
  | 'appstate'
  | 'native-auth'
  | 'clock'
  | 'video';

export type FaultClass =
  'throw' | 'reject' | 'timeout' | 'malformed' | 'partial' | 'slow' | 'never';

export type InstallKind =
  | 'fresh'
  | 'signed-out-kv'
  | 'vault-valid'
  | 'vault-valid-no-profile'
  | 'last-provider-google';

export const INSTALL_KINDS: readonly InstallKind[] = [
  'fresh',
  'signed-out-kv',
  'vault-valid',
  'vault-valid-no-profile',
  'last-provider-google',
];

export interface Fault {
  id: string;
  dependency: Dependency;
  cls: FaultClass;
  apply: (world: World) => void;
  /** Counter name in World.callCounts() that must be > 0 for `exercised`. */
  exercisedBy: string | null;
  /** Installs on which the fault's target is actually reached at launch. */
  preferInstall: readonly InstallKind[];
  /** A synchronous throw from an effect: the only legal landing is the
   * RootErrorBoundary, which must show its retry control. */
  expectsBoundary?: boolean;
  /** The fault makes a dependency never settle. The lens still requires
   * the gate to leave its loading state within 60s. */
  neverSettles?: boolean;
}

const ANY_INSTALL = INSTALL_KINDS;
const VAULT_INSTALLS: readonly InstallKind[] = [
  'vault-valid',
  'vault-valid-no-profile',
];
const GOOGLE_INSTALLS: readonly InstallKind[] = ['last-provider-google'];
/** Installs whose launch never starts the session keeper / sync runtime:
 * those module singletons keep an AppState subscription for the process
 * lifetime, so a malformed subscription there would leak into the next
 * launch of the same Jest process instead of testing this unit. */
const SIGNED_OUT_INSTALLS: readonly InstallKind[] = [
  'fresh',
  'signed-out-kv',
  'last-provider-google',
];

const VAULT_SERVICE = 'com.picklesensei.auth.session';

function setVault(world: World, password: string): void {
  world.keychain.store.set(VAULT_SERVICE, { username: 'session', password });
}

const faults: Fault[] = [];
function add(fault: Fault): void {
  faults.push(fault);
}

// ─── Keychain ────────────────────────────────────────────────────────────────

add({
  id: 'kc.get.throw-sync',
  dependency: 'keychain',
  cls: 'throw',
  apply: w => {
    w.keychain.faults.get = { kind: 'throw' };
  },
  exercisedBy: 'keychainGet',
  preferInstall: ANY_INSTALL,
});
add({
  id: 'kc.get.reject',
  dependency: 'keychain',
  cls: 'reject',
  apply: w => {
    w.keychain.faults.get = {
      kind: 'reject',
      message: 'errSecInteractionNotAllowed',
    };
  },
  exercisedBy: 'keychainGet',
  preferInstall: ANY_INSTALL,
});
add({
  id: 'kc.get.never',
  dependency: 'keychain',
  cls: 'never',
  apply: w => {
    w.keychain.faults.get = { kind: 'never' };
  },
  exercisedBy: 'keychainGet',
  preferInstall: ANY_INSTALL,
  neverSettles: true,
});
add({
  id: 'kc.get.slow-3s',
  dependency: 'keychain',
  cls: 'slow',
  apply: w => {
    w.keychain.faults.get = { kind: 'slow', delayMs: 3_000 };
  },
  exercisedBy: 'keychainGet',
  preferInstall: ANY_INSTALL,
});
add({
  id: 'kc.get.slow-12s',
  dependency: 'keychain',
  cls: 'timeout',
  apply: w => {
    w.keychain.faults.get = { kind: 'slow', delayMs: 12_000 };
  },
  exercisedBy: 'keychainGet',
  preferInstall: ANY_INSTALL,
});
add({
  id: 'kc.get.slow-45s',
  dependency: 'keychain',
  cls: 'timeout',
  apply: w => {
    w.keychain.faults.get = { kind: 'slow', delayMs: 45_000 };
  },
  exercisedBy: 'keychainGet',
  preferInstall: ANY_INSTALL,
});
for (const [name, value] of Object.entries({
  'empty-object': {},
  'password-number': { username: 'session', password: 42 },
  'password-null': { username: 'session', password: null },
  'boolean-true': true,
  null: null,
  string: 'not-an-item',
  array: [],
})) {
  add({
    id: `kc.get.shape-${name}`,
    dependency: 'keychain',
    cls: 'malformed',
    apply: w => {
      w.keychain.faults.get = { kind: 'return', value };
    },
    exercisedBy: 'keychainGet',
    preferInstall: ANY_INSTALL,
  });
}
add({
  id: 'kc.reset.reject',
  dependency: 'keychain',
  cls: 'reject',
  apply: w => {
    setVault(w, RAW_STRING_VARIANTS['not-json']);
    w.keychain.faults.reset = { kind: 'reject' };
  },
  exercisedBy: 'keychainReset',
  preferInstall: ANY_INSTALL,
});
add({
  id: 'kc.reset.never',
  dependency: 'keychain',
  cls: 'never',
  apply: w => {
    setVault(w, RAW_STRING_VARIANTS['truncated-json']);
    w.keychain.faults.reset = { kind: 'never' };
  },
  exercisedBy: 'keychainReset',
  preferInstall: ANY_INSTALL,
  neverSettles: true,
});
add({
  id: 'kc.set.reject',
  dependency: 'keychain',
  cls: 'reject',
  apply: w => {
    w.keychain.faults.set = { kind: 'reject', message: 'errSecDiskFull' };
  },
  exercisedBy: 'keychainSet',
  preferInstall: VAULT_INSTALLS,
});
add({
  id: 'kc.set.never',
  dependency: 'keychain',
  cls: 'never',
  apply: w => {
    w.keychain.faults.set = { kind: 'never' };
  },
  exercisedBy: 'keychainSet',
  preferInstall: VAULT_INSTALLS,
  neverSettles: true,
});
add({
  id: 'kc.module-broken',
  dependency: 'keychain',
  cls: 'throw',
  apply: w => {
    w.keychain.faults.moduleBroken = true;
  },
  exercisedBy: null,
  preferInstall: ANY_INSTALL,
});
// Malformed persisted vault records: raw string corruptions and structured
// field mutations, each installed as the Keychain password.
for (const name of RAW_VARIANT_NAMES) {
  const raw = RAW_STRING_VARIANTS[name];
  if (raw === null) continue;
  add({
    id: `kc.vault.raw-${name}`,
    dependency: 'keychain',
    cls: 'malformed',
    apply: w => setVault(w, raw),
    exercisedBy: 'keychainGet',
    preferInstall: ANY_INSTALL,
  });
}
for (const name of [
  'version-0',
  'version-2-future',
  'version-string-1',
  'version-missing',
  'provider-guest',
  'provider-facebook',
  'provider-missing',
  'provider-number',
  'canonical-missing',
  'canonical-empty',
  'canonical-number',
  'canonical-not-uuid',
  'canonical-nil-uuid',
  'refresh-missing',
  'refresh-empty',
  'refresh-number',
  'refresh-whitespace',
  'refresh-huge',
  'email-object',
  'displayName-huge',
  'proto-pollution',
]) {
  const record = VAULT_RECORD_VARIANTS[name];
  if (record === undefined) throw new Error(`unknown vault variant ${name}`);
  add({
    id: `kc.vault.record-${name}`,
    dependency: 'keychain',
    cls: 'partial',
    apply: w => setVault(w, record),
    exercisedBy: 'keychainGet',
    preferInstall: ANY_INSTALL,
  });
}

// ─── SQLite ──────────────────────────────────────────────────────────────────

add({
  id: 'db.open.throw',
  dependency: 'sqlite',
  cls: 'throw',
  apply: w => {
    w.db.inner.faults.openThrows = 'SQLITE_CANTOPEN (simulated)';
  },
  exercisedBy: null,
  preferInstall: ANY_INSTALL,
});
add({
  id: 'db.all.throw',
  dependency: 'sqlite',
  cls: 'reject',
  apply: w => {
    w.db.inner.faults.allThrow = 'SQLITE_IOERR (simulated)';
  },
  exercisedBy: 'dbExecute',
  preferInstall: ANY_INSTALL,
});
add({
  id: 'db.execute.never',
  dependency: 'sqlite',
  cls: 'never',
  apply: w => {
    w.db.extra.execute = { kind: 'never' };
  },
  exercisedBy: 'dbExecute',
  preferInstall: ANY_INSTALL,
  neverSettles: true,
});
add({
  id: 'db.execute.slow-2s',
  dependency: 'sqlite',
  cls: 'slow',
  apply: w => {
    w.db.extra.execute = { kind: 'slow', delayMs: 2_000 };
  },
  exercisedBy: 'dbExecute',
  preferInstall: ANY_INSTALL,
});
add({
  id: 'db.execute.slow-10s',
  dependency: 'sqlite',
  cls: 'timeout',
  apply: w => {
    w.db.extra.execute = { kind: 'slow', delayMs: 10_000 };
  },
  exercisedBy: 'dbExecute',
  preferInstall: ANY_INSTALL,
});
add({
  id: 'db.kv-read.local-mode.never',
  dependency: 'sqlite',
  cls: 'never',
  apply: w => {
    w.db.extra.execute = { kind: 'never' };
    w.db.extra.executeFor = /SELECT value FROM kv/;
  },
  exercisedBy: 'dbExecute',
  preferInstall: ANY_INSTALL,
  neverSettles: true,
});
for (const key of [
  'auth.session',
  'auth.local-mode',
  'auth.last-provider',
  'onboarding.pending-profile',
]) {
  add({
    id: `db.kv-read.${key}.throw`,
    dependency: 'sqlite',
    cls: 'reject',
    apply: w => {
      w.db.inner.faults.kvGetThrows = new Set([key]);
    },
    exercisedBy: 'dbExecute',
    preferInstall: ANY_INSTALL,
  });
}
add({
  id: 'db.kv-write.auth.session.throw',
  dependency: 'sqlite',
  cls: 'reject',
  apply: w => {
    w.db.inner.kv.set(
      'auth.session',
      KV_LEGACY_SESSION_VARIANTS['legacy-token-blob'] as string,
    );
    w.db.inner.faults.kvSetThrows = new Set(['auth.session']);
  },
  exercisedBy: 'dbExecute',
  preferInstall: ANY_INSTALL,
});
add({
  id: 'db.local_shot.throw',
  dependency: 'sqlite',
  cls: 'reject',
  apply: w => {
    w.db.inner.faults.sqlThrows = /local_shot/;
  },
  exercisedBy: 'dbExecute',
  preferInstall: ANY_INSTALL,
});
add({
  id: 'db.close.throw',
  dependency: 'sqlite',
  cls: 'throw',
  apply: w => {
    w.db.extra.closeThrows = true;
  },
  exercisedBy: 'dbExecute',
  preferInstall: ANY_INSTALL,
});
for (const [name, value] of Object.entries({
  'rows-undefined': { rows: undefined },
  'rows-null': { rows: null },
  'rows-string': { rows: 'nope' },
  'row-empty-object': { rows: [{}] },
  'row-value-number': { rows: [{ value: 42 }] },
  'row-value-null': { rows: [{ value: null }] },
  'row-value-object': { rows: [{ value: { nested: true } }] },
  'result-undefined': undefined,
  'result-null': null,
})) {
  add({
    id: `db.kv-read.shape-${name}`,
    dependency: 'sqlite',
    cls: 'malformed',
    apply: w => {
      w.db.extra.malformedFor = /SELECT value FROM kv/;
      w.db.extra.malformedValue = value;
    },
    exercisedBy: 'dbExecute',
    preferInstall: ANY_INSTALL,
  });
}
// Malformed persisted kv values the launch reads.
for (const [name, value] of Object.entries(KV_LOCAL_MODE_VARIANTS)) {
  if (value === null || name === 'valid-guest') continue;
  add({
    id: `db.kv.local-mode.${name}`,
    dependency: 'sqlite',
    cls: 'malformed',
    apply: w => {
      w.db.inner.kv.set('auth.local-mode', value);
    },
    exercisedBy: 'dbExecute',
    preferInstall: ANY_INSTALL,
  });
}
for (const [name, value] of Object.entries(KV_LAST_PROVIDER_VARIANTS)) {
  if (value === null || name === 'valid-google') continue;
  add({
    id: `db.kv.last-provider.${name}`,
    dependency: 'sqlite',
    cls: 'malformed',
    apply: w => {
      w.db.inner.kv.set('auth.last-provider', value);
    },
    exercisedBy: 'dbExecute',
    preferInstall: ['fresh', 'signed-out-kv'],
  });
}
for (const [name, value] of Object.entries(KV_LEGACY_SESSION_VARIANTS)) {
  if (value === null) continue;
  add({
    id: `db.kv.legacy-session.${name}`,
    dependency: 'sqlite',
    cls: 'malformed',
    apply: w => {
      w.db.inner.kv.set('auth.session', value);
    },
    exercisedBy: 'dbExecute',
    preferInstall: ANY_INSTALL,
  });
}
for (const [name, value] of Object.entries(PENDING_PROFILE_KV_VARIANTS)) {
  if (value === null) continue;
  add({
    id: `db.kv.pending-profile.${name}`,
    dependency: 'sqlite',
    cls: 'malformed',
    apply: w => {
      w.db.inner.kv.set('onboarding.pending-profile', value);
    },
    exercisedBy: 'dbExecute',
    preferInstall: ANY_INSTALL,
  });
}

// ─── fetch / API ─────────────────────────────────────────────────────────────

add({
  id: 'fetch.undefined',
  dependency: 'fetch',
  cls: 'throw',
  apply: w => {
    w.server.fetchFault = 'undefined';
  },
  exercisedBy: null,
  preferInstall: VAULT_INSTALLS,
});
add({
  id: 'fetch.throw-sync',
  dependency: 'fetch',
  cls: 'throw',
  apply: w => {
    w.server.fetchFault = 'throw-sync';
  },
  exercisedBy: 'fetch',
  preferInstall: VAULT_INSTALLS,
});
add({
  id: 'fetch.never',
  dependency: 'fetch',
  cls: 'never',
  apply: w => {
    w.server.fetchFault = 'never';
  },
  exercisedBy: 'fetch',
  preferInstall: VAULT_INSTALLS,
  neverSettles: true,
});
add({
  id: 'fetch.non-response',
  dependency: 'fetch',
  cls: 'malformed',
  apply: w => {
    w.server.fetchFault = 'non-response';
  },
  exercisedBy: 'fetch',
  preferInstall: VAULT_INSTALLS,
});
add({
  id: 'fetch.json-throws',
  dependency: 'fetch',
  cls: 'malformed',
  apply: w => {
    w.server.fetchFault = 'json-throws';
  },
  exercisedBy: 'fetch',
  preferInstall: VAULT_INSTALLS,
});
add({
  id: 'fetch.text-throws',
  dependency: 'fetch',
  cls: 'malformed',
  apply: w => {
    w.server.fetchFault = 'text-throws';
  },
  exercisedBy: 'fetch',
  preferInstall: VAULT_INSTALLS,
});
const REFRESH_CLASS: Record<string, FaultClass> = {
  'refuse-401': 'reject',
  'refuse-403': 'reject',
  'error-500': 'reject',
  'error-429': 'reject',
  network: 'reject',
  hang: 'never',
  'malformed-200': 'malformed',
  'partial-200': 'partial',
  'empty-body-200': 'malformed',
  'status-0': 'malformed',
};
for (const [mode, cls] of Object.entries(REFRESH_CLASS)) {
  add({
    id: `fetch.refresh.${mode}`,
    dependency: 'fetch',
    cls,
    apply: w => {
      w.server.refreshMode = mode as typeof w.server.refreshMode;
    },
    exercisedBy: 'fetch',
    preferInstall: VAULT_INSTALLS,
    neverSettles: mode === 'hang',
  });
}
for (const latencyMs of [3_000, 9_000, 14_000]) {
  add({
    id: `fetch.refresh.slow-${latencyMs / 1000}s`,
    dependency: 'fetch',
    cls: latencyMs > 8_000 ? 'timeout' : 'slow',
    apply: w => {
      w.server.latencyMs = latencyMs;
    },
    exercisedBy: 'fetch',
    preferInstall: VAULT_INSTALLS,
  });
}

// ─── Google Sign-In (legacy silent restore) ──────────────────────────────────

add({
  id: 'google.module-broken',
  dependency: 'google',
  cls: 'throw',
  apply: w => {
    w.google.faults.moduleBroken = true;
  },
  exercisedBy: null,
  preferInstall: GOOGLE_INSTALLS,
});
add({
  id: 'google.configure.throw',
  dependency: 'google',
  cls: 'throw',
  apply: w => {
    w.google.faults.configure = 'throw';
  },
  exercisedBy: 'googleConfigure',
  preferInstall: GOOGLE_INSTALLS,
});
add({
  id: 'google.hasPreviousSignIn.throw',
  dependency: 'google',
  cls: 'throw',
  apply: w => {
    w.google.faults.hasPreviousSignIn = 'throw';
  },
  exercisedBy: 'googleHasPreviousSignIn',
  preferInstall: GOOGLE_INSTALLS,
});
add({
  id: 'google.hasPreviousSignIn.garbage',
  dependency: 'google',
  cls: 'malformed',
  apply: w => {
    w.google.faults.hasPreviousSignIn = 'return-garbage';
    w.google.faults.signInSilently = { kind: 'return', value: undefined };
  },
  exercisedBy: 'googleHasPreviousSignIn',
  preferInstall: GOOGLE_INSTALLS,
});
add({
  id: 'google.signInSilently.reject',
  dependency: 'google',
  cls: 'reject',
  apply: w => {
    w.google.faults.hasPreviousSignIn = 'true';
    w.google.faults.signInSilently = {
      kind: 'reject',
      message: 'SIGN_IN_REQUIRED',
    };
  },
  exercisedBy: 'googleSignInSilently',
  preferInstall: GOOGLE_INSTALLS,
});
add({
  id: 'google.signInSilently.never',
  dependency: 'google',
  cls: 'never',
  apply: w => {
    w.google.faults.hasPreviousSignIn = 'true';
    w.google.faults.signInSilently = { kind: 'never' };
  },
  exercisedBy: 'googleSignInSilently',
  preferInstall: GOOGLE_INSTALLS,
  neverSettles: true,
});
add({
  id: 'google.signInSilently.slow-12s',
  dependency: 'google',
  cls: 'timeout',
  apply: w => {
    w.google.faults.hasPreviousSignIn = 'true';
    w.google.faults.signInSilently = { kind: 'slow', delayMs: 12_000 };
  },
  exercisedBy: 'googleSignInSilently',
  preferInstall: GOOGLE_INSTALLS,
});
for (const [name, value] of Object.entries({
  undefined: undefined,
  null: null,
  'type-missing': {},
  'success-data-null': { type: 'success', data: null },
  'success-idToken-null': {
    type: 'success',
    data: { idToken: null, user: { name: 'Pat', email: 'p@x.test' } },
  },
  'success-user-missing': { type: 'success', data: { idToken: 'id-token' } },
  cancelled: { type: 'cancelled' },
  'no-saved-credential': { type: 'noSavedCredentialFound' },
})) {
  add({
    id: `google.signInSilently.shape-${name}`,
    dependency: 'google',
    cls: 'malformed',
    apply: w => {
      w.google.faults.hasPreviousSignIn = 'true';
      w.google.faults.signInSilently = { kind: 'return', value };
    },
    exercisedBy: 'googleSignInSilently',
    preferInstall: GOOGLE_INSTALLS,
  });
}

// ─── Notifications (permissions + scheduler native module) ───────────────────

add({
  id: 'notifee.getTriggerIds.reject',
  dependency: 'notifications',
  cls: 'reject',
  apply: w => {
    w.notifee.faults.getTriggerNotificationIds = { kind: 'reject' };
  },
  exercisedBy: 'notifeeGetTriggerIds',
  preferInstall: ANY_INSTALL,
});
add({
  id: 'notifee.getTriggerIds.throw',
  dependency: 'notifications',
  cls: 'throw',
  apply: w => {
    w.notifee.faults.getTriggerNotificationIds = { kind: 'throw' };
  },
  exercisedBy: 'notifeeGetTriggerIds',
  preferInstall: ANY_INSTALL,
});
add({
  id: 'notifee.getTriggerIds.never',
  dependency: 'notifications',
  cls: 'never',
  apply: w => {
    w.notifee.faults.getTriggerNotificationIds = { kind: 'never' };
  },
  exercisedBy: 'notifeeGetTriggerIds',
  preferInstall: ANY_INSTALL,
  neverSettles: true,
});
add({
  id: 'notifee.getTriggerIds.slow-20s',
  dependency: 'notifications',
  cls: 'timeout',
  apply: w => {
    w.notifee.faults.getTriggerNotificationIds = {
      kind: 'slow',
      delayMs: 20_000,
    };
  },
  exercisedBy: 'notifeeGetTriggerIds',
  preferInstall: ANY_INSTALL,
});
for (const [name, value] of Object.entries({
  null: null,
  undefined: undefined,
  string: 'pickle-sensei.reminder-1',
  'array-of-numbers': [1, 2, 3],
  'array-with-null': [null, 'pickle-sensei.reminder-1'],
})) {
  add({
    id: `notifee.getTriggerIds.shape-${name}`,
    dependency: 'notifications',
    cls: 'malformed',
    apply: w => {
      w.notifee.faults.getTriggerNotificationIds = { kind: 'return', value };
    },
    exercisedBy: 'notifeeGetTriggerIds',
    preferInstall: ANY_INSTALL,
  });
}
add({
  id: 'notifee.cancel.reject',
  dependency: 'notifications',
  cls: 'reject',
  apply: w => {
    w.notifee.faults.cancelTriggerNotification = { kind: 'reject' };
  },
  exercisedBy: 'notifeeCancel',
  preferInstall: ANY_INSTALL,
});
add({
  id: 'notifee.cancel.never',
  dependency: 'notifications',
  cls: 'never',
  apply: w => {
    w.notifee.faults.cancelTriggerNotification = { kind: 'never' };
  },
  exercisedBy: 'notifeeCancel',
  preferInstall: ANY_INSTALL,
  neverSettles: true,
});
add({
  id: 'notifee.permission.reject',
  dependency: 'notifications',
  cls: 'reject',
  apply: w => {
    w.notifee.faults.getNotificationSettings = { kind: 'reject' };
  },
  exercisedBy: 'notifeeGetSettings',
  preferInstall: VAULT_INSTALLS,
});
add({
  id: 'notifee.permission.never',
  dependency: 'notifications',
  cls: 'never',
  apply: w => {
    w.notifee.faults.getNotificationSettings = { kind: 'never' };
  },
  exercisedBy: 'notifeeGetSettings',
  preferInstall: VAULT_INSTALLS,
  neverSettles: true,
});
add({
  id: 'notifee.permission.shape-string',
  dependency: 'notifications',
  cls: 'malformed',
  apply: w => {
    w.notifee.faults.getNotificationSettings = {
      kind: 'return',
      value: { authorizationStatus: 'yes' },
    };
  },
  exercisedBy: 'notifeeGetSettings',
  preferInstall: VAULT_INSTALLS,
});
add({
  id: 'notifee.permission.shape-undefined',
  dependency: 'notifications',
  cls: 'malformed',
  apply: w => {
    w.notifee.faults.getNotificationSettings = {
      kind: 'return',
      value: undefined,
    };
  },
  exercisedBy: 'notifeeGetSettings',
  preferInstall: VAULT_INSTALLS,
});

// ─── AppState / native auth module / clock ───────────────────────────────────

add({
  id: 'appstate.addListener.throw',
  dependency: 'appstate',
  cls: 'throw',
  apply: w => {
    w.runtime.appStateAddListenerThrows = true;
  },
  exercisedBy: null,
  preferInstall: ANY_INSTALL,
  expectsBoundary: true,
});
add({
  id: 'appstate.addListener.returns-undefined',
  dependency: 'appstate',
  cls: 'malformed',
  apply: w => {
    w.runtime.appStateAddListenerReturnsUndefined = true;
  },
  exercisedBy: null,
  preferInstall: SIGNED_OUT_INSTALLS,
});
add({
  id: 'native-auth.pickleauth-missing',
  dependency: 'native-auth',
  cls: 'throw',
  apply: w => {
    w.runtime.pickleAuthMissing = true;
  },
  exercisedBy: null,
  preferInstall: ANY_INSTALL,
});
add({
  id: 'clock.date-now-nan',
  dependency: 'clock',
  cls: 'malformed',
  apply: w => {
    w.runtime.clockNaN = true;
  },
  exercisedBy: null,
  preferInstall: ANY_INSTALL,
});

export const FAULTS: readonly Fault[] = faults;
export const FAULT_BY_ID = new Map(faults.map(f => [f.id, f]));

/** Faults that can be layered: at most one per dependency, no two `never`s. */
export function compatible(a: Fault, b: Fault): boolean {
  if (a.dependency === b.dependency) return false;
  return true;
}
