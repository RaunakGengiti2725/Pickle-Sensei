/**
 * why-did-you-render style render counter for jest + react-test-renderer.
 *
 * Installs a minimal React DevTools global hook BEFORE the renderer module
 * is evaluated (import this module first in a test file), then walks every
 * committed fiber tree from `onCommitFiberRoot` and tallies, per component
 * display name, how many function/class fibers actually performed work in
 * that commit (`fiber.flags & PerformedWork`). Fibers that React reused
 * without cloning are never visited (same traversal rule React DevTools
 * uses: recurse only where `next.child !== prev.child`), and cloned fibers
 * have their non-static flags reset by `createWorkInProgress`, so a tally
 * is exactly "this component's function body ran in this commit".
 *
 * `fiber.actualDuration` (profiler timer, present in the development
 * build) is summed as well so heavy synchronous render bodies show up
 * next to their counts.
 */

type Fiber = {
  tag: number;
  flags: number;
  type: unknown;
  elementType: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
  actualDuration?: number;
  memoizedProps: unknown;
};

type FiberRoot = { current: Fiber };

type DevtoolsHook = {
  supportsFiber: true;
  isDisabled: false;
  renderers: Map<number, unknown>;
  inject: (internals: unknown) => number;
  onCommitFiberRoot: (rendererId: number, root: FiberRoot) => void;
  onCommitFiberUnmount: () => void;
  onPostCommitFiberRoot: () => void;
  checkDCE: () => void;
  __pickleRenderCounter: true;
};

const FunctionComponent = 0;
const ClassComponent = 1;
const ForwardRef = 11;
const SimpleMemoComponent = 15;
const PerformedWork = 1;

export type CommitTally = {
  /** renders performed in this commit, keyed by component display name. */
  renders: Record<string, number>;
  /** first-mount renders (alternate === null) subset of `renders`. */
  mounts: Record<string, number>;
  /** summed `actualDuration` (ms, profiler timer) per component. */
  durationMs: Record<string, number>;
  /** renders per component INSTANCE (stable across the current/alternate
   * fiber pair) — the only number that can show one instance re-rendering
   * several times for a single state change. */
  instanceRenders: Map<
    number,
    { name: string; count: number; animated: boolean }
  >;
};

/** RN `Animated.createAnimatedComponent` wrappers re-render on every JS-driver
 * animation frame (`useNativeDriver: false`), together with the host
 * component they wrap (same element references below it bail out). Those
 * frames are legitimate per-tick renders, not renders per state change, so
 * the wrapper and its direct child are tallied separately (`animated: true`);
 * anything deeper is ordinary content and stays in the runaway population. */
function isAnimatedWrapper(name: string): boolean {
  return name.startsWith('Animated(') || name === 'AnimatedComponent';
}

const commits: CommitTally[] = [];
let injectCount = 0;
let nextInstanceId = 1;
const instanceIds = new WeakMap<Fiber, number>();

function instanceIdOf(fiber: Fiber): number {
  const known =
    instanceIds.get(fiber) ??
    (fiber.alternate ? instanceIds.get(fiber.alternate) : undefined);
  if (known !== undefined) {
    instanceIds.set(fiber, known);
    return known;
  }
  const id = nextInstanceId;
  nextInstanceId += 1;
  instanceIds.set(fiber, id);
  if (fiber.alternate) instanceIds.set(fiber.alternate, id);
  return id;
}

function nameOf(fiber: Fiber): string {
  const t = fiber.type as
    | { displayName?: string; name?: string; render?: { name?: string } }
    | string
    | null;
  if (typeof t === 'string') return t;
  if (t && typeof t === 'object' && fiber.tag === ForwardRef) {
    return (
      t.displayName ??
      (t.render && t.render.name
        ? `ForwardRef(${t.render.name})`
        : 'ForwardRef')
    );
  }
  if (typeof t === 'function') {
    const fn = t as { displayName?: string; name?: string };
    return fn.displayName ?? (fn.name || 'Anonymous');
  }
  return 'Unknown';
}

function isCountable(fiber: Fiber): boolean {
  return (
    fiber.tag === FunctionComponent ||
    fiber.tag === ClassComponent ||
    fiber.tag === ForwardRef ||
    fiber.tag === SimpleMemoComponent
  );
}

function bump(map: Record<string, number>, key: string, by = 1) {
  map[key] = (map[key] ?? 0) + by;
}

function walk(
  next: Fiber,
  prev: Fiber | null,
  tally: CommitTally,
  directChildOfAnimated: boolean,
): void {
  let animated = false;
  if (isCountable(next)) {
    const name = nameOf(next);
    animated = isAnimatedWrapper(name);
    if ((next.flags & PerformedWork) === PerformedWork) {
      bump(tally.renders, name);
      if (prev === null) bump(tally.mounts, name);
      if (typeof next.actualDuration === 'number') {
        bump(tally.durationMs, name, next.actualDuration);
      }
      const id = instanceIdOf(next);
      const entry = tally.instanceRenders.get(id);
      if (entry) entry.count += 1;
      else {
        tally.instanceRenders.set(id, {
          name,
          count: 1,
          animated: animated || directChildOfAnimated,
        });
      }
    }
  }
  if (prev === null) {
    for (let c = next.child; c; c = c.sibling) walk(c, null, tally, animated);
    return;
  }
  if (next.child !== prev.child) {
    for (let c = next.child; c; c = c.sibling) {
      walk(c, c.alternate, tally, animated);
    }
  }
}

function onCommitFiberRoot(_rendererId: number, root: FiberRoot) {
  const tally: CommitTally = {
    renders: {},
    mounts: {},
    durationMs: {},
    instanceRenders: new Map(),
  };
  const current = root.current;
  walk(current, current.alternate, tally, false);
  commits.push(tally);
}

function install(): void {
  const g = globalThis as typeof globalThis & {
    __REACT_DEVTOOLS_GLOBAL_HOOK__?: Partial<DevtoolsHook>;
  };
  const existing = g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (existing && existing.__pickleRenderCounter) return;
  if (existing) {
    throw new Error(
      'renderCounter: a different __REACT_DEVTOOLS_GLOBAL_HOOK__ is already installed',
    );
  }
  const hook: DevtoolsHook = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject: internals => {
      injectCount += 1;
      hook.renderers.set(injectCount, internals);
      return injectCount;
    },
    onCommitFiberRoot,
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
    checkDCE: () => {},
    __pickleRenderCounter: true,
  };
  g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
}

install();

/** True once a React renderer registered with the hook (i.e. the hook was
 * installed before `react-test-renderer` was evaluated). */
export function rendererInjected(): boolean {
  return injectCount > 0;
}

/** Number of commits observed since the counter was created/reset. */
export function commitCount(): number {
  return commits.length;
}

export function resetCommits(): void {
  commits.length = 0;
}

/** Aggregate of commits `[from, to)`. */
export function aggregate(
  from: number,
  to: number = commits.length,
): CommitTally {
  const out: CommitTally = {
    renders: {},
    mounts: {},
    durationMs: {},
    instanceRenders: new Map(),
  };
  for (let i = from; i < to; i += 1) {
    const c = commits[i];
    if (!c) continue;
    for (const [k, v] of Object.entries(c.renders)) bump(out.renders, k, v);
    for (const [k, v] of Object.entries(c.mounts)) bump(out.mounts, k, v);
    for (const [k, v] of Object.entries(c.durationMs))
      bump(out.durationMs, k, v);
    for (const [id, entry] of c.instanceRenders) {
      const existing = out.instanceRenders.get(id);
      if (existing) existing.count += entry.count;
      else out.instanceRenders.set(id, { ...entry });
    }
  }
  return out;
}

export type StepResult = {
  label: string;
  /** Replayable input that produced this step (seed, index, payload). */
  input: unknown;
  commits: number;
  /** renders per component (summed over instances) in this step. */
  renders: Record<string, number>;
  /** distinct instances of each component that rendered in this step. */
  instances: Record<string, number>;
  /** worst single-instance render count per component in this step, for
   * instances OUTSIDE Animated wrappers — the "renders per state change"
   * number the runaway threshold applies to. */
  maxPerInstance: Record<string, number>;
  /** same, for instances inside `Animated.createAnimatedComponent` wrappers
   * (JS-driver animation frames). */
  maxPerAnimatedInstance: Record<string, number>;
  /** total renders that happened inside Animated wrappers. */
  animatedRenders: number;
  durationMs: Record<string, number>;
  /** wall-clock time of the act() that drove the step. */
  wallMs: number;
  totalRenders: number;
  /** non-animated component whose single instance rendered the most. */
  max: { component: string; renders: number } | null;
};

export function stepResult(
  label: string,
  input: unknown,
  fromCommit: number,
  wallMs: number,
): StepResult {
  const agg = aggregate(fromCommit);
  let max: StepResult['max'] = null;
  let total = 0;
  for (const n of Object.values(agg.renders)) total += n;
  const instances: Record<string, number> = {};
  const maxPerInstance: Record<string, number> = {};
  const maxPerAnimatedInstance: Record<string, number> = {};
  let animatedRenders = 0;
  for (const { name, count, animated } of agg.instanceRenders.values()) {
    bump(instances, name);
    if (animated) {
      animatedRenders += count;
      if ((maxPerAnimatedInstance[name] ?? 0) < count) {
        maxPerAnimatedInstance[name] = count;
      }
      continue;
    }
    if ((maxPerInstance[name] ?? 0) < count) maxPerInstance[name] = count;
    if (!max || count > max.renders) max = { component: name, renders: count };
  }
  const durationMs: Record<string, number> = {};
  for (const [k, v] of Object.entries(agg.durationMs)) {
    durationMs[k] = Math.round(v * 1000) / 1000;
  }
  return {
    label,
    input,
    commits: commits.length - fromCommit,
    renders: agg.renders,
    instances,
    maxPerInstance,
    maxPerAnimatedInstance,
    animatedRenders,
    durationMs,
    wallMs: Math.round(wallMs * 1000) / 1000,
    totalRenders: total,
    max,
  };
}

/**
 * Runs `drive` (which must wrap its state changes in `act`) and returns the
 * render tally attributable to it.
 */
export async function measureStep(
  label: string,
  input: unknown,
  drive: () => Promise<void> | void,
): Promise<StepResult> {
  const from = commits.length;
  const t0 = Date.now();
  await drive();
  const wall = Date.now() - t0;
  return stepResult(label, input, from, wall);
}

export type StepSummary = {
  label: string;
  steps: number;
  /** per component: renders across all steps, the max summed renders in
   * any single step, and the worst single-instance count in any step. */
  perComponent: Record<
    string,
    {
      total: number;
      maxPerStep: number;
      meanPerStep: number;
      maxPerInstancePerStep: number;
    }
  >;
  commitsTotal: number;
  commitsMaxPerStep: number;
  wallMsTotal: number;
  wallMsMaxPerStep: number;
  /** steps in which ONE non-animated instance of a component rendered more
   * than `threshold` times. */
  runaway: {
    index: number;
    label: string;
    component: string;
    renders: number;
    input: unknown;
  }[];
  /** steps in which one instance INSIDE an Animated wrapper rendered more
   * than `threshold` times (JS-driver animation frames — reported, not
   * counted as runaway). */
  animationFrames: {
    index: number;
    label: string;
    component: string;
    renders: number;
  }[];
};

export function summarize(
  label: string,
  steps: readonly StepResult[],
  threshold: number,
): StepSummary {
  const perComponent: StepSummary['perComponent'] = {};
  const runaway: StepSummary['runaway'] = [];
  const animationFrames: StepSummary['animationFrames'] = [];
  let commitsTotal = 0;
  let commitsMax = 0;
  let wallTotal = 0;
  let wallMax = 0;
  steps.forEach((step, index) => {
    commitsTotal += step.commits;
    commitsMax = Math.max(commitsMax, step.commits);
    wallTotal += step.wallMs;
    wallMax = Math.max(wallMax, step.wallMs);
    for (const [component, n] of Object.entries(step.renders)) {
      const entry = perComponent[component] ?? {
        total: 0,
        maxPerStep: 0,
        meanPerStep: 0,
        maxPerInstancePerStep: 0,
      };
      entry.total += n;
      entry.maxPerStep = Math.max(entry.maxPerStep, n);
      const perInstance = step.maxPerInstance[component] ?? 0;
      entry.maxPerInstancePerStep = Math.max(
        entry.maxPerInstancePerStep,
        perInstance,
      );
      perComponent[component] = entry;
      if (perInstance > threshold) {
        runaway.push({
          index,
          label: step.label,
          component,
          renders: perInstance,
          input: step.input,
        });
      }
    }
    for (const [component, n] of Object.entries(step.maxPerAnimatedInstance)) {
      if (n > threshold) {
        animationFrames.push({
          index,
          label: step.label,
          component,
          renders: n,
        });
      }
    }
  });
  for (const entry of Object.values(perComponent)) {
    entry.meanPerStep = Math.round((entry.total / steps.length) * 1000) / 1000;
  }
  return {
    label,
    steps: steps.length,
    perComponent,
    commitsTotal,
    commitsMaxPerStep: commitsMax,
    wallMsTotal: Math.round(wallTotal * 1000) / 1000,
    wallMsMaxPerStep: Math.round(wallMax * 1000) / 1000,
    runaway,
    animationFrames,
  };
}
