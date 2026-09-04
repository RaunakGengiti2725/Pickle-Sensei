/**
 * Mutation self-check for the api.ts concurrency stress harness: each case
 * loads the harness against a deliberately broken api.ts / apiSession.ts
 * (via jest.doMock + isolateModules) and asserts the campaign flags the
 * injected defect under the expected invariant within a bounded seed range.
 * A harness that cannot see these defects would make the campaign's green
 * result worthless, so this suite guards the guard.
 */
import type { IterationResult } from '../../test-support/stress/apiClientConcurrencyHarness';

type Harness =
  typeof import('../../test-support/stress/apiClientConcurrencyHarness');
type ApiModule = typeof import('../../src/data/api');
type SessionModule = typeof import('../../src/account/apiSession');

const API_PATH = '../../src/data/api';
const SESSION_PATH = '../../src/account/apiSession';
const HARNESS_PATH = '../../test-support/stress/apiClientConcurrencyHarness';
const SEED_BUDGET = 60;

function loadHarnessWith(mutate: () => void): Harness {
  let harness: Harness | undefined;
  jest.isolateModules(() => {
    mutate();
    harness = jest.requireActual(HARNESS_PATH) as Harness;
  });
  return harness!;
}

async function firstViolation(
  harness: Harness,
  invariant: string,
): Promise<{ seed: number; result: IterationResult } | null> {
  for (let seed = 1; seed <= SEED_BUDGET; seed++) {
    const result = await harness.runIteration(seed);
    if (result.failures.some(f => f.invariant === invariant)) {
      return { seed, result };
    }
  }
  return null;
}

afterEach(() => {
  jest.resetModules();
  jest.dontMock(API_PATH);
  jest.dontMock(SESSION_PATH);
});

describe('stress harness self-check (mutants must be caught)', () => {
  it('catches a client that retries reserve() on 5xx (double spend / one_fetch)', async () => {
    const harness = loadHarnessWith(() => {
      jest.doMock(API_PATH, () => {
        const actual = jest.requireActual(API_PATH) as ApiModule;
        const createAnalysisPermitClient: ApiModule['createAnalysisPermitClient'] =
          config => {
            const real = actual.createAnalysisPermitClient(config);
            return {
              ...real,
              reserve: async key => {
                try {
                  return await real.reserve(key);
                } catch (error) {
                  if (error instanceof actual.ApiError && error.status >= 500) {
                    return real.reserve(key);
                  }
                  throw error;
                }
              },
            };
          };
        return { ...actual, createAnalysisPermitClient };
      });
    });
    const hit = await firstViolation(harness, 'one_fetch');
    expect(hit).not.toBeNull();
    expect(
      hit!.result.failures.find(f => f.invariant === 'one_fetch')!.detail,
    ).toMatch(/second fetch|unattributed fetch/);
  });

  it('catches unauthorized reporting that ignores bearer currency', async () => {
    const harness = loadHarnessWith(() => {
      jest.doMock(SESSION_PATH, () => {
        const actual = jest.requireActual(SESSION_PATH) as SessionModule;
        let listener: Parameters<
          SessionModule['setApiUnauthorizedListener']
        >[0] = null;
        return {
          ...actual,
          setApiUnauthorizedListener: (
            next: Parameters<SessionModule['setApiUnauthorizedListener']>[0],
          ) => {
            listener = next;
            actual.setApiUnauthorizedListener(next);
          },
          // Mutant: reports whatever bearer was rejected, even if replaced.
          reportApiUnauthorized: (bearerToken: string) => {
            const session = actual.getApiSession();
            listener?.({
              ...(session ?? {
                apiBaseUrl: '',
                canonicalAppUserId: '',
                provider: 'apple' as const,
              }),
              bearerToken,
            });
          },
        };
      });
    });
    const hit = await firstViolation(harness, 'unauthorized');
    expect(hit).not.toBeNull();
  });

  it('catches a client that clears its timeout timer late (unbounded body)', async () => {
    const harness = loadHarnessWith(() => {
      jest.doMock(API_PATH, () => {
        const actual = jest.requireActual(API_PATH) as ApiModule;
        const createTransport: ApiModule['createTransport'] = config => {
          const real = actual.createTransport(config);
          return {
            ...real,
            // Mutant: swallows the timeout and hangs forever instead.
            syncShots: shots =>
              real.syncShots(shots).catch(error => {
                if (
                  error instanceof actual.ApiError &&
                  error.code === 'network.timeout'
                ) {
                  return new Promise<never>(() => undefined);
                }
                throw error;
              }),
          };
        };
        return { ...actual, createTransport };
      });
    });
    const hit = await firstViolation(harness, 'bounded');
    expect(hit).not.toBeNull();
    expect(
      hit!.result.failures.find(f => f.invariant === 'bounded')!.detail,
    ).toMatch(/still pending/);
  });

  it('catches cross-talk between concurrent reserve() calls (isolation)', async () => {
    const harness = loadHarnessWith(() => {
      jest.doMock(API_PATH, () => {
        const actual = jest.requireActual(API_PATH) as ApiModule;
        let last: Awaited<
          ReturnType<
            ReturnType<ApiModule['createAnalysisPermitClient']>['reserve']
          >
        > | null = null;
        const createAnalysisPermitClient: ApiModule['createAnalysisPermitClient'] =
          config => {
            const real = actual.createAnalysisPermitClient(config);
            return {
              ...real,
              // Mutant: a shared "latest permit" cache leaks across calls.
              reserve: async key => {
                const mine = await real.reserve(key);
                const result = last ?? mine;
                last = mine;
                return result;
              },
            };
          };
        return { ...actual, createAnalysisPermitClient };
      });
    });
    const hit = await firstViolation(harness, 'isolation');
    expect(hit).not.toBeNull();
  });

  it('catches a transport that bears whichever account is signed in (token_once)', async () => {
    const harness = loadHarnessWith(() => {
      jest.doMock(API_PATH, () => {
        const actual = jest.requireActual(API_PATH) as ApiModule;
        const session = jest.requireActual(SESSION_PATH) as SessionModule;
        // Mutant: ignores the configured account and sends the CURRENT
        // session's bearer — after a re-login as another account the wire
        // carries that account's token for the first account's rows.
        const createTransport: ApiModule['createTransport'] = config =>
          actual.createTransport({
            baseUrl: config.baseUrl,
            get token() {
              return session.getApiSession()?.bearerToken ?? config.token;
            },
          });
        return { ...actual, createTransport };
      });
    });
    const hit = await firstViolation(harness, 'token_once');
    expect(hit).not.toBeNull();
  });

  it('catches a client that fetches outside the call (deferred request)', async () => {
    const harness = loadHarnessWith(() => {
      jest.doMock(API_PATH, () => {
        const actual = jest.requireActual(API_PATH) as ApiModule;
        const createTransport: ApiModule['createTransport'] = config => {
          const real = actual.createTransport(config);
          return {
            ...real,
            finalizeSession: id =>
              new Promise<void>((resolve, reject) => {
                setTimeout(() => {
                  real.finalizeSession(id).then(resolve, reject);
                }, 1);
              }),
          };
        };
        return { ...actual, createTransport };
      });
    });
    const hit = await firstViolation(harness, 'one_fetch');
    expect(hit).not.toBeNull();
    expect(
      hit!.result.failures.find(f => f.invariant === 'one_fetch')!.detail,
    ).toMatch(/unattributed fetch/);
  });
});
