/**
 * XC journey harness — an in-process native-stack stand-in.
 *
 * The real `RootNavigator` needs `NavigationContainer` + `react-native-screens`
 * host views that do not exist under react-test-renderer, so this module
 * keeps a route stack with the same mutation semantics the screens rely on
 * (`navigate` pops-to-existing-or-pushes, `replace`, `goBack`, `popToTop`) and
 * mounts EVERY route in the stack — exactly like a native stack keeps the
 * screens below the focused one alive — so effects on a lower screen keep
 * running while a higher one is shown. Every mutation is journaled with the
 * resulting stack so a scenario can assert the navigation trace verbatim.
 *
 * `useNavigation()` / `useRoute()` are served from React context by the
 * `@react-navigation/native` mock registered in harness.tsx.
 */
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { View } from 'react-native';
import type { RootStackParams } from '../../src/navigation/params';

export type RouteName = keyof RootStackParams;

export interface HarnessRoute {
  key: string;
  name: RouteName;
  params: unknown;
}

export type NavOp =
  | 'navigate'
  | 'push'
  | 'replace'
  | 'goBack'
  | 'popToTop'
  | 'popTo'
  | 'setParams';

export interface NavEvent {
  seq: number;
  op: NavOp;
  from: RouteName;
  name?: RouteName;
  params?: unknown;
  stackAfter: RouteName[];
}

export interface HarnessNavigation {
  navigate(name: RouteName, params?: unknown): void;
  push(name: RouteName, params?: unknown): void;
  replace(name: RouteName, params?: unknown): void;
  goBack(): void;
  popToTop(): void;
  popTo(name: RouteName, params?: unknown): void;
  setParams(params: unknown): void;
  canGoBack(): boolean;
  isFocused(): boolean;
  addListener(event: string, callback: () => void): () => void;
  getState(): { index: number; routes: HarnessRoute[] };
}

export class JourneyStack {
  routes: HarnessRoute[];
  readonly events: NavEvent[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly navigations = new Map<string, HarnessNavigation>();
  private keySeq = 0;

  constructor(initial: Array<{ name: RouteName; params?: unknown }>) {
    if (initial.length === 0)
      throw new Error('JourneyStack needs a root route');
    this.routes = initial.map(r => this.makeRoute(r.name, r.params));
  }

  private makeRoute(name: RouteName, params: unknown): HarnessRoute {
    this.keySeq += 1;
    return { key: `${name}-${this.keySeq}`, name, params: params ?? undefined };
  }

  names(): RouteName[] {
    return this.routes.map(r => r.name);
  }

  top(): HarnessRoute {
    const route = this.routes[this.routes.length - 1];
    if (!route) throw new Error('JourneyStack is empty');
    return route;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private commit(
    op: NavOp,
    from: RouteName,
    next: HarnessRoute[],
    detail: { name?: RouteName; params?: unknown } = {},
  ) {
    this.routes = next;
    this.events.push({
      seq: this.events.length + 1,
      op,
      from,
      ...detail,
      stackAfter: this.names(),
    });
    for (const listener of this.listeners) listener();
  }

  navigationFor(route: HarnessRoute): HarnessNavigation {
    const existing = this.navigations.get(route.key);
    if (existing) return existing;
    const navigation: HarnessNavigation = {
      navigate: (name, params) => {
        const index = this.routes.findIndex(r => r.name === name);
        if (index >= 0) {
          const kept = this.routes.slice(0, index + 1);
          const target = kept[index]!;
          kept[index] = params === undefined ? target : { ...target, params };
          this.commit('navigate', route.name, kept, { name, params });
          return;
        }
        this.commit(
          'navigate',
          route.name,
          [...this.routes, this.makeRoute(name, params)],
          { name, params },
        );
      },
      push: (name, params) => {
        this.commit(
          'push',
          route.name,
          [...this.routes, this.makeRoute(name, params)],
          { name, params },
        );
      },
      replace: (name, params) => {
        const index = this.routes.findIndex(r => r.key === route.key);
        const next = [...this.routes];
        const replacement = this.makeRoute(name, params);
        if (index >= 0) next[index] = replacement;
        else next[next.length - 1] = replacement;
        this.commit('replace', route.name, next, { name, params });
      },
      goBack: () => {
        if (this.routes.length <= 1) {
          this.commit('goBack', route.name, this.routes);
          return;
        }
        const index = this.routes.findIndex(r => r.key === route.key);
        const next =
          index > 0
            ? this.routes.slice(0, index)
            : this.routes.slice(0, this.routes.length - 1);
        this.commit('goBack', route.name, next);
      },
      popToTop: () => {
        this.commit('popToTop', route.name, this.routes.slice(0, 1));
      },
      popTo: (name, params) => {
        const index = this.routes.findIndex(r => r.name === name);
        if (index < 0) {
          this.commit(
            'popTo',
            route.name,
            [...this.routes.slice(0, -1), this.makeRoute(name, params)],
            { name, params },
          );
          return;
        }
        const kept = this.routes.slice(0, index + 1);
        if (params !== undefined) kept[index] = { ...kept[index]!, params };
        this.commit('popTo', route.name, kept, { name, params });
      },
      setParams: params => {
        const next = this.routes.map(r =>
          r.key === route.key
            ? {
                ...r,
                params: { ...(r.params as object), ...(params as object) },
              }
            : r,
        );
        this.commit('setParams', route.name, next, { params });
      },
      canGoBack: () => {
        return this.routes.length > 1;
      },
      isFocused: () => {
        return this.top().key === route.key;
      },
      addListener: () => {
        return () => {};
      },
      getState: () => {
        return { index: this.routes.length - 1, routes: this.routes };
      },
    };
    this.navigations.set(route.key, navigation);
    return navigation;
  }
}

export const RouteContext = createContext<{
  stack: JourneyStack;
  route: HarnessRoute;
} | null>(null);

export function useHarnessRoute(): {
  stack: JourneyStack;
  route: HarnessRoute;
} {
  const value = useContext(RouteContext);
  if (!value) {
    throw new Error(
      'useNavigation()/useRoute() called outside the XC journey stack host',
    );
  }
  return value;
}

/** Re-renders the caller on every stack mutation and reports focus. */
export function useHarnessFocused(): boolean {
  const { stack, route } = useHarnessRoute();
  const [, setVersion] = useState(0);
  useEffect(() => stack.subscribe(() => setVersion(v => v + 1)), [stack]);
  return stack.top().key === route.key;
}

/** `useFocusEffect` semantics: run when focused, clean up when blurred. */
export function useHarnessFocusEffect(effect: () => void | (() => void)): void {
  const focused = useHarnessFocused();
  useEffect(() => {
    if (!focused) return undefined;
    return effect();
  }, [focused, effect]);
}

/** Route components receive the same `{ navigation, route }` props a native
 * stack passes; hook-based screens read them from context instead. */
export type RouteComponent = React.ComponentType<{
  navigation: HarnessNavigation;
  route: HarnessRoute;
}>;

export type RouteRegistry = Partial<Record<RouteName, RouteComponent>>;

function MissingRoute({ name }: { name: RouteName }): React.JSX.Element {
  throw new Error(`XC journey host has no component registered for ${name}`);
}

function RouteFrame(props: {
  stack: JourneyStack;
  route: HarnessRoute;
  focused: boolean;
  registry: RouteRegistry;
}) {
  const { stack, route, focused, registry } = props;
  const value = useMemo(() => ({ stack, route }), [stack, route]);
  const Screen = registry[route.name];
  return (
    <RouteContext.Provider value={value}>
      <View
        testID={`xc-route-${route.name}`}
        accessibilityState={{ selected: focused }}
      >
        {Screen ? (
          <Screen navigation={stack.navigationFor(route)} route={route} />
        ) : (
          <MissingRoute name={route.name} />
        )}
      </View>
    </RouteContext.Provider>
  );
}

let currentStack: JourneyStack | null = null;

/** The stack the next `HarnessStackNavigator` mount will host. */
export function installJourneyStack(stack: JourneyStack | null): void {
  currentStack = stack;
}

/** Drop-in for `createNativeStackNavigator().Navigator`: collects the
 * `<Stack.Screen name component />` children the REAL RootNavigator declares
 * and hosts them on the installed journey stack. */
export function HarnessStackNavigator(props: {
  children?: React.ReactNode;
}): React.JSX.Element {
  const stack = currentStack;
  if (!stack) {
    throw new Error(
      'HarnessStackNavigator mounted before installJourneyStack(stack)',
    );
  }
  const registry: RouteRegistry = {};
  React.Children.forEach(props.children, child => {
    if (!React.isValidElement(child)) return;
    const screenProps = child.props as {
      name?: RouteName;
      component?: RouteComponent;
    };
    if (screenProps.name && screenProps.component) {
      registry[screenProps.name] = screenProps.component;
    }
  });
  return <StackHost stack={stack} registry={registry} />;
}

/**
 * Mounts every route in the stack (lowest first), each wrapped in a View
 * whose testID names the route, so `findAll` can address a specific screen.
 */
export function StackHost(props: {
  stack: JourneyStack;
  registry: RouteRegistry;
}) {
  const { stack, registry } = props;
  const [, setVersion] = useState(0);
  useEffect(() => stack.subscribe(() => setVersion(v => v + 1)), [stack]);
  const routes = stack.routes;
  return (
    <View testID="xc-stack-host">
      {routes.map((route, index) => (
        <RouteFrame
          key={route.key}
          stack={stack}
          route={route}
          focused={index === routes.length - 1}
          registry={registry}
        />
      ))}
    </View>
  );
}
