/**
 * Wraps zustand's `createStore` so every store created in the process reports
 * live subscriptions through `globalThis.__zustandActiveSubscriptions`. Used
 * from a `jest.mock('zustand/vanilla', ...)` factory; behaviour is otherwise
 * the real implementation.
 */

interface SubscribableStore {
  subscribe: (listener: unknown) => () => void;
}

type CreateStoreFn = (createState: unknown) => SubscribableStore;

const counter = globalThis as { __zustandActiveSubscriptions?: number };

function bump(delta: number): void {
  counter.__zustandActiveSubscriptions =
    (counter.__zustandActiveSubscriptions ?? 0) + delta;
}

function instrument(api: SubscribableStore): SubscribableStore {
  const subscribe = api.subscribe;
  api.subscribe = (listener: unknown) => {
    bump(1);
    const unsubscribe = subscribe(listener);
    let done = false;
    return () => {
      if (!done) {
        done = true;
        bump(-1);
      }
      unsubscribe();
    };
  };
  return api;
}

export function instrumentedCreateStore(realCreate: unknown): unknown {
  counter.__zustandActiveSubscriptions ??= 0;
  const create = realCreate as CreateStoreFn;
  return (createState?: unknown) =>
    createState === undefined
      ? (state: unknown) => instrument(create(state))
      : instrument(create(createState));
}
