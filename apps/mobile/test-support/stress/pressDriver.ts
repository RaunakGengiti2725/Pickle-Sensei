/**
 * Drives a rendered `Pressable` through its REAL responder handlers
 * (`onResponderGrant` / `onResponderMove` / `onResponderRelease` /
 * `onResponderTerminate` / `onClick`) exactly as the RN responder system
 * would, so `Pressability`'s state machine, its long-press and
 * min-press-duration timers and `measure()` region logic all run under the
 * test's fake timers. Calling `props.onPress` directly would skip all of that
 * and could not reproduce a finger that is still down while the tree
 * re-renders.
 */
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';

export interface Touch {
  pageX: number;
  pageY: number;
}

export interface FakeResponderEvent {
  nativeEvent: {
    changedTouches: Array<
      Touch & {
        identifier: number;
        locationX: number;
        locationY: number;
        timestamp: number;
      }
    >;
    touches: Array<Touch & { identifier: number }>;
    pageX: number;
    pageY: number;
    locationX: number;
    locationY: number;
    identifier: number;
    timestamp: number;
    target: number;
  };
  currentTarget: {
    measure: (
      cb: (
        x: number,
        y: number,
        w: number,
        h: number,
        pageX: number,
        pageY: number,
      ) => void,
    ) => void;
  };
  target: unknown;
  timeStamp: number;
  persist: () => void;
  stopPropagation: () => void;
  preventDefault: () => void;
  isDefaultPrevented: () => boolean;
}

export const PILL_REGION = { x: 0, y: 0, w: 44, h: 44, pageX: 100, pageY: 400 };

export function responderEvent(
  touch: Touch = {
    pageX: PILL_REGION.pageX + 22,
    pageY: PILL_REGION.pageY + 22,
  },
  identifier = 1,
): FakeResponderEvent {
  const currentTarget = {
    measure: (
      cb: (
        x: number,
        y: number,
        w: number,
        h: number,
        pageX: number,
        pageY: number,
      ) => void,
    ) =>
      cb(
        PILL_REGION.x,
        PILL_REGION.y,
        PILL_REGION.w,
        PILL_REGION.h,
        PILL_REGION.pageX,
        PILL_REGION.pageY,
      ),
  };
  const now = Date.now();
  return {
    nativeEvent: {
      changedTouches: [
        { ...touch, identifier, locationX: 22, locationY: 22, timestamp: now },
      ],
      touches: [{ ...touch, identifier }],
      pageX: touch.pageX,
      pageY: touch.pageY,
      locationX: 22,
      locationY: 22,
      identifier,
      timestamp: now,
      target: 1,
    },
    currentTarget,
    target: currentTarget,
    timeStamp: now,
    persist: () => {},
    stopPropagation: () => {},
    preventDefault: () => {},
    isDefaultPrevented: () => false,
  };
}

/** The host View a `Pressable` renders — the node carrying responder props. */
export function findPressableHost(
  renderer: ReactTestRenderer,
  testID: string,
): ReactTestInstance | null {
  const hosts = renderer.root.findAll(
    node =>
      node.props.testID === testID &&
      typeof node.props.onResponderGrant === 'function' &&
      typeof node.type === 'string',
  );
  return hosts[0] ?? null;
}

export function findAllPressableHosts(
  renderer: ReactTestRenderer,
): ReactTestInstance[] {
  return renderer.root.findAll(
    node =>
      typeof node.props.onResponderGrant === 'function' &&
      typeof node.type === 'string',
  );
}

export function grant(host: ReactTestInstance, touch?: Touch): void {
  const event = responderEvent(touch);
  (host.props.onStartShouldSetResponder as () => boolean)();
  (host.props.onResponderGrant as (e: FakeResponderEvent) => void)(event);
}

export function move(host: ReactTestInstance, touch: Touch): void {
  (host.props.onResponderMove as (e: FakeResponderEvent) => void)(
    responderEvent(touch),
  );
}

export function release(host: ReactTestInstance, touch?: Touch): void {
  (host.props.onResponderRelease as (e: FakeResponderEvent) => void)(
    responderEvent(touch),
  );
}

export function terminate(host: ReactTestInstance): void {
  (host.props.onResponderTerminate as (e: FakeResponderEvent) => void)(
    responderEvent(),
  );
}

/** Accessibility activation (VoiceOver double-tap) — bypasses the responder. */
export function click(host: ReactTestInstance): void {
  const event = responderEvent();
  (host.props.onClick as (e: FakeResponderEvent) => void)(event);
}

/** A complete tap: down then up on the same host. */
export function tap(host: ReactTestInstance, touch?: Touch): void {
  grant(host, touch);
  release(host, touch);
}

/** A touch that slides off the target before lifting — must NOT press. */
export const OFF_TARGET: Touch = { pageX: 900, pageY: 900 };
