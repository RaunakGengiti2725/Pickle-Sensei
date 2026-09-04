/**
 * Process-edge doubles for the rapid-interaction lens. Only what leaves the
 * JS process is scripted here: the native Apple sign-in module, the Google
 * Sign-In SDK object, `fetch`, plus observers for console errors and
 * unhandled promise rejections. Stores, hooks, screens and navigation route
 * components stay real.
 */
import type { BootstrapOutcome, ProviderOutcome } from './plan';

export const CANONICAL_ID = '7fc2c743-028f-4ec6-942c-a84508f3be38';
export const API_BASE = 'https://api.example.test';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const entry: Deferred<T> = {
    promise,
    settled: false,
    resolve: value => {
      entry.settled = true;
      resolve(value);
    },
    reject: reason => {
      entry.settled = true;
      reject(reason);
    },
  };
  return entry;
}

export interface ProviderCall {
  provider: 'apple' | 'google';
  outcome: ProviderOutcome;
  /** Fake-clock ms since burst start when the call was issued. */
  at: number;
  /** Other provider calls still pending when this one started. */
  inflightAtStart: number;
}

export interface BootstrapCall {
  outcome: BootstrapOutcome;
  at: number;
  inflightAtStart: number;
  provider: string | null;
}

function codedError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * One burst's scripted world. `now()` is injected so timestamps follow the
 * fake clock.
 */
export class ScriptedWorld {
  readonly providerCalls: ProviderCall[] = [];
  readonly bootstrapCalls: BootstrapCall[] = [];
  readonly otherRequests: string[] = [];
  private readonly pendingProvider: {
    call: ProviderCall;
    settle: () => void;
  }[] = [];
  private readonly pendingBootstrap: {
    call: BootstrapCall;
    settle: () => void;
  }[] = [];
  private providerInflight = 0;
  private bootstrapInflight = 0;
  maxProviderInflight = 0;
  maxBootstrapInflight = 0;
  private providerCursor = 0;
  private bootstrapCursor = 0;
  private tokenCounter = 0;
  /** Bearer/refresh strings handed out; must never reach SQLite kv. */
  readonly issuedSecrets: string[] = [];

  constructor(
    private readonly providerOutcomes: readonly ProviderOutcome[],
    private readonly bootstrapOutcomes: readonly BootstrapOutcome[],
    private readonly latency: 'deferred' | 'immediate',
    readonly now: () => number,
  ) {}

  /** Peeks the outcome the NEXT provider call will get (for missing-module). */
  nextProviderOutcome(): ProviderOutcome {
    return this.providerOutcomes[
      this.providerCursor % this.providerOutcomes.length
    ] as ProviderOutcome;
  }

  private takeProviderOutcome(): ProviderOutcome {
    const outcome = this.nextProviderOutcome();
    this.providerCursor += 1;
    return outcome;
  }

  /** Consumes the next outcome without a call (the native module is absent). */
  skipProviderOutcome(): void {
    this.providerCursor += 1;
  }

  private takeBootstrapOutcome(): BootstrapOutcome {
    const outcome = this.bootstrapOutcomes[
      this.bootstrapCursor % this.bootstrapOutcomes.length
    ] as BootstrapOutcome;
    this.bootstrapCursor += 1;
    return outcome;
  }

  get pendingProviderCount(): number {
    return this.pendingProvider.length;
  }

  get pendingBootstrapCount(): number {
    return this.pendingBootstrap.length;
  }

  successfulProviderCalls(): number {
    return this.providerCalls.filter(call => call.outcome === 'success').length;
  }

  /** Bootstraps that returned a durable session (refresh token to vault). */
  sessionBootstraps(): number {
    return this.bootstrapCalls.filter(call => call.outcome === 'ok-session')
      .length;
  }

  /**
   * Bootstraps that signed the user in at all: `ok-no-session` is the
   * documented pre-contract server (account, no session → the app bears the
   * provider token for this run and persists nothing).
   */
  acceptedBootstraps(): number {
    return this.bootstrapCalls.filter(
      call => call.outcome === 'ok-session' || call.outcome === 'ok-no-session',
    ).length;
  }

  private issueProvider<T>(
    provider: 'apple' | 'google',
    body: (outcome: ProviderOutcome, d: Deferred<T>) => void,
  ): Promise<T> {
    const outcome = this.takeProviderOutcome();
    const call: ProviderCall = {
      provider,
      outcome,
      at: this.now(),
      inflightAtStart: this.providerInflight,
    };
    this.providerCalls.push(call);
    this.providerInflight += 1;
    this.maxProviderInflight = Math.max(
      this.maxProviderInflight,
      this.providerInflight,
    );
    const d = deferred<T>();
    const settle = () => {
      if (d.settled) return;
      this.providerInflight -= 1;
      body(outcome, d);
    };
    if (this.latency === 'immediate') {
      void Promise.resolve().then(settle);
    } else {
      this.pendingProvider.push({ call, settle });
    }
    return d.promise;
  }

  /** The native `PickleAuth` module handed to production code. */
  readonly appleNative = {
    signInWithApple: (): Promise<{
      user: string;
      identityToken: string | null;
      authorizationCode: string | null;
      email: string | null;
      givenName: string | null;
      familyName: string | null;
    }> =>
      this.issueProvider('apple', (outcome, d) => {
        switch (outcome) {
          case 'success':
            d.resolve({
              user: 'apple-sub-001',
              identityToken: `apple-id-token-${this.nextToken()}`,
              authorizationCode: `apple-auth-code-${this.nextToken()}`,
              email: 'pat@privaterelay.example',
              givenName: 'Pat',
              familyName: 'Player',
            });
            return;
          case 'cancel':
            d.reject(codedError('auth.canceled', 'Sign-in canceled.'));
            return;
          default:
            d.reject(codedError('auth.failed', `Apple failed (${outcome})`));
        }
      }),
  };

  /** The `GoogleSignin` object the SDK module mock exposes. */
  readonly google = {
    configure: (): void => {},
    hasPlayServices: async (): Promise<boolean> => {
      if (this.nextProviderOutcome() === 'play-services') {
        // Consume the outcome as a (failed) provider call so accounting holds.
        await this.issueProvider<never>('google', (_outcome, d) => {
          d.reject(codedError('PLAY_SERVICES_NOT_AVAILABLE', 'no play'));
        });
      }
      return true;
    },
    signIn: (): Promise<
      | {
          type: 'success';
          data: {
            idToken: string | null;
            user: {
              id: string;
              name: string | null;
              email: string;
              photo: null;
              familyName: string;
              givenName: string;
            };
            scopes: string[];
            serverAuthCode: null;
          };
        }
      | { type: 'cancelled'; data: null }
    > =>
      this.issueProvider('google', (outcome, d) => {
        switch (outcome) {
          case 'success':
            d.resolve({
              type: 'success',
              data: {
                idToken: `google-id-token-${this.nextToken()}`,
                user: {
                  id: 'google-uid-1',
                  name: 'Pat Player',
                  email: 'pat@gmail.example',
                  photo: null,
                  familyName: 'Player',
                  givenName: 'Pat',
                },
                scopes: [],
                serverAuthCode: null,
              },
            });
            return;
          case 'cancel':
            d.resolve({ type: 'cancelled', data: null });
            return;
          default:
            d.reject(
              codedError('SIGN_IN_FAILED', `Google failed (${outcome})`),
            );
        }
      }),
    signInSilently: async (): Promise<never> => {
      throw new Error('no silent google session (simulated)');
    },
    hasPreviousSignIn: (): boolean => false,
    signOut: async (): Promise<null> => null,
    revokeAccess: async (): Promise<null> => null,
  };

  private nextToken(): string {
    this.tokenCounter += 1;
    const token = `secret-${this.tokenCounter}-${this.now()}`;
    this.issuedSecrets.push(token);
    return token;
  }

  /** The `fetch` handed to production code. */
  readonly fetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url === `${API_BASE}/v1/account/bootstrap`) {
      const auth = new Headers(init?.headers).get('Authorization');
      const provider = auth?.includes('apple')
        ? 'apple'
        : auth?.includes('google')
          ? 'google'
          : null;
      const outcome = this.takeBootstrapOutcome();
      const call: BootstrapCall = {
        outcome,
        at: this.now(),
        inflightAtStart: this.bootstrapInflight,
        provider,
      };
      this.bootstrapCalls.push(call);
      this.bootstrapInflight += 1;
      this.maxBootstrapInflight = Math.max(
        this.maxBootstrapInflight,
        this.bootstrapInflight,
      );
      const d = deferred<Response>();
      const settle = () => {
        if (d.settled) return;
        this.bootstrapInflight -= 1;
        switch (outcome) {
          case 'ok-session':
            d.resolve(
              jsonResponse(200, {
                user: { id: CANONICAL_ID, email: 'pat@example.com' },
                onboardingState: 'complete',
                session: {
                  accessToken: `access-${this.nextToken()}`,
                  refreshToken: `refresh-${this.nextToken()}`,
                  expiresAt: Math.floor(Date.now() / 1000) + 3600,
                },
              }),
            );
            return;
          case 'ok-no-session':
            d.resolve(
              jsonResponse(200, {
                user: { id: CANONICAL_ID, email: 'pat@example.com' },
                onboardingState: 'complete',
              }),
            );
            return;
          case 'malformed':
            d.resolve(jsonResponse(200, { nope: true }));
            return;
          case '401':
            d.resolve(jsonResponse(401, { error: 'rejected' }));
            return;
          case '500':
            d.resolve(jsonResponse(500, { error: 'boom' }));
            return;
          case 'network':
            d.reject(new TypeError('Network request failed'));
        }
      };
      if (this.latency === 'immediate') {
        void Promise.resolve().then(settle);
      } else {
        this.pendingBootstrap.push({ call, settle });
      }
      return d.promise;
    }
    // Anything else the signed-in app fires (canonical profile read, sync,
    // access refresh, keeper) is recorded and answered generically — never a
    // failure of THIS lens. `/v1/me` answers "no server profile yet" so an
    // unprofiled account lands on in-account onboarding, like a fresh user.
    this.otherRequests.push(url.replace(API_BASE, ''));
    if (url === `${API_BASE}/v1/me`) {
      return Promise.resolve(
        jsonResponse(200, {
          user: { id: CANONICAL_ID },
          onboardingState: 'pending',
          profile: null,
        }),
      );
    }
    return Promise.resolve(jsonResponse(404, { error: 'not scripted' }));
  };

  /** Settles the oldest pending provider call. Returns false if none. */
  resolveProvider(): boolean {
    const next = this.pendingProvider.shift();
    if (!next) return false;
    next.settle();
    return true;
  }

  resolveBootstrap(): boolean {
    const next = this.pendingBootstrap.shift();
    if (!next) return false;
    next.settle();
    return true;
  }

  /** Settles everything still pending (terminal drain). */
  drain(): number {
    let settled = 0;
    while (this.resolveProvider()) settled += 1;
    while (this.resolveBootstrap()) settled += 1;
    return settled;
  }
}

// ─── Observers ───────────────────────────────────────────────────────────────

interface NodeProcessEvents {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
}
declare const process: NodeProcessEvents;

export interface Observed {
  consoleErrors: string[];
  consoleWarnings: string[];
  unhandledRejections: string[];
}

function formatArgs(args: unknown[]): string {
  return args
    .map(arg =>
      arg instanceof Error
        ? `${arg.name}: ${arg.message}`
        : typeof arg === 'string'
          ? arg
          : JSON.stringify(arg),
    )
    .join(' ')
    .slice(0, 400);
}

/**
 * Captures console.error / console.warn and unhandled rejections for the
 * duration of a burst. Install once per suite; call `begin()` per burst.
 */
export class Observer {
  private current: Observed = {
    consoleErrors: [],
    consoleWarnings: [],
    unhandledRejections: [],
  };
  private readonly originalError = console.error;
  private readonly originalWarn = console.warn;
  private readonly onRejection = (reason: unknown) => {
    this.current.unhandledRejections.push(formatArgs([reason]));
  };

  install(): void {
    console.error = (...args: unknown[]) => {
      this.current.consoleErrors.push(formatArgs(args));
    };
    console.warn = (...args: unknown[]) => {
      this.current.consoleWarnings.push(formatArgs(args));
    };
    process.on('unhandledRejection', this.onRejection);
  }

  uninstall(): void {
    console.error = this.originalError;
    console.warn = this.originalWarn;
    process.off('unhandledRejection', this.onRejection);
  }

  begin(): void {
    this.current = {
      consoleErrors: [],
      consoleWarnings: [],
      unhandledRejections: [],
    };
  }

  snapshot(): Observed {
    return {
      consoleErrors: [...this.current.consoleErrors],
      consoleWarnings: [...this.current.consoleWarnings],
      unhandledRejections: [...this.current.unhandledRejections],
    };
  }
}
