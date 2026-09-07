import { AppState } from 'react-native';
import { getApiSession, subscribeToApiSession } from '../account/apiSession';
import {
  canonicalDataOwner,
  captureDataOwnerContext,
  getActiveDataOwner,
  isDataOwnerContextCurrent,
} from '../data/accountScope';
import {
  createBillingLifecycleCallback,
  selectBillingReconciliationRetryAtMs,
  useAccessStore,
} from '../state/accessStore';

const MIN_DELAY_MS = 1_000;
const MAX_DELAY_MS = 2_147_483_647;
let stopCurrent: (() => void) | null = null;

export function stopBillingLifecycle(): void {
  stopCurrent?.();
  stopCurrent = null;
}

export function startBillingLifecycle(owner: string): void {
  stopBillingLifecycle();
  const canonicalOwner = canonicalDataOwner(owner);
  if (
    getActiveDataOwner() !== canonicalOwner ||
    getApiSession()?.canonicalAppUserId !== canonicalOwner
  )
    return;

  const context = captureDataOwnerContext();
  const reconcile = createBillingLifecycleCallback(canonicalOwner);
  let closed = false;
  let active = AppState.currentState === 'active';
  let inFlight = false;
  let initial = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerGeneration = 0;

  const live = () =>
    !closed &&
    isDataOwnerContextCurrent(context) &&
    getApiSession()?.canonicalAppUserId === canonicalOwner;

  const cancelTimer = () => {
    timerGeneration += 1;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const close = () => {
    if (closed) return;
    closed = true;
    cancelTimer();
    subscription.remove();
    unsubscribeAccess();
    unsubscribeSession();
    if (stopCurrent === close) stopCurrent = null;
  };

  const schedule = () => {
    cancelTimer();
    if (!live()) {
      close();
      return;
    }
    const state = useAccessStore.getState();
    if (
      !active ||
      inFlight ||
      state.status === 'loading' ||
      state.operation !== 'idle'
    )
      return;
    const retryAt = initial ? 0 : selectBillingReconciliationRetryAtMs(state);
    if (retryAt === null || !Number.isFinite(retryAt)) return;
    const scheduledGeneration = timerGeneration;
    timer = setTimeout(
      () => {
        if (scheduledGeneration !== timerGeneration) return;
        timer = null;
        void run();
      },
      Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, retryAt - Date.now())),
    );
  };

  const run = async () => {
    if (!live()) {
      close();
      return;
    }
    const state = useAccessStore.getState();
    if (
      !active ||
      inFlight ||
      state.status === 'loading' ||
      state.operation !== 'idle'
    )
      return;
    const retryAt = selectBillingReconciliationRetryAtMs(state);
    if (
      !initial &&
      (retryAt === null || !Number.isFinite(retryAt) || retryAt > Date.now())
    ) {
      schedule();
      return;
    }
    cancelTimer();
    initial = false;
    inFlight = true;
    try {
      await reconcile();
    } catch {
      return;
    } finally {
      inFlight = false;
      schedule();
    }
  };

  const unsubscribeAccess = useAccessStore.subscribe(state => {
    if (
      state.status === 'idle' &&
      state.operation === 'idle' &&
      state.fulfilmentStatus === 'unchecked'
    )
      close();
    else schedule();
  });
  const unsubscribeSession = subscribeToApiSession(() => {
    if (!live()) close();
  });
  const subscription = AppState.addEventListener('change', nextState => {
    if (!live()) {
      close();
      return;
    }
    const nextActive = nextState === 'active';
    if (nextActive === active) return;
    active = nextActive;
    if (active) void run();
    else cancelTimer();
  });
  stopCurrent = close;
  if (active) void run();
}
