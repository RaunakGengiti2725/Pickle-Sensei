import type {
  NavigationContainerRefWithCurrent,
  ParamListBase,
} from '@react-navigation/native';

/**
 * `RootNavigator` keeps its `navigationRef` module-private. To observe the
 * REAL navigation state (current route, canGoBack) without changing
 * production code, the stress test wraps `createNavigationContainerRef` so
 * the ref the production navigator creates is also visible here:
 *
 *   jest.mock('@react-navigation/native', () => {
 *     const actual = jest.requireActual('@react-navigation/native');
 *     const capture = require('../../testing/stress/navigationRefCapture');
 *     return {
 *       ...actual,
 *       createNavigationContainerRef: (...args) =>
 *         capture.registerNavigationRef(actual.createNavigationContainerRef(...args)),
 *     };
 *   });
 */
type AnyRef = NavigationContainerRefWithCurrent<ParamListBase>;

const refs: AnyRef[] = [];

export function registerNavigationRef<T extends AnyRef>(ref: T): T {
  refs.push(ref);
  return ref;
}

/** The live container ref (the last one created that is ready). */
export function liveNavigationRef(): AnyRef | null {
  for (let i = refs.length - 1; i >= 0; i -= 1) {
    const ref = refs[i]!;
    if (ref.isReady()) return ref;
  }
  return null;
}

export function currentRouteName(): string {
  const ref = liveNavigationRef();
  if (!ref) return 'not-ready';
  return ref.getCurrentRoute()?.name ?? 'none';
}
