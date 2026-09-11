/**
 * First-run walkthrough store: raised once per ACCOUNT (owner-scoped kv),
 * durable record written BEFORE the overlay shows (crash-loop safety, same
 * rule as the celebration stores), unreadable/unwritable state skips rather
 * than risking a blocking overlay on every launch, a signed-out process never
 * raises it, an owner change drops a stale tour, and Settings replay never
 * re-arms the auto-show.
 */

const mockKvTable = new Map<string, string>();
let mockFailReads = false;
let mockFailWrites = false;
let mockWriteCount = 0;
let mockOnRead: (() => void) | null = null;

jest.mock('../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        if (mockFailReads) throw new Error('kv read failed');
        mockOnRead?.();
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        if (mockFailWrites) throw new Error('kv write failed');
        mockWriteCount += 1;
        mockKvTable.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

import {
  WALKTHROUGH_KV_NAMESPACE,
  WALKTHROUGH_SEEN_VALUE,
  useWalkthroughStore,
  walkthroughKeyForOwner,
} from '../src/walkthrough/walkthroughStore';
import { identifyCeremony } from '../src/flow/ceremonyRequest';
import { OWNER_SCOPED_KV_NAMESPACES } from '../src/data/repository';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';

const ACCOUNT_A = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  mockKvTable.clear();
  mockFailReads = false;
  mockFailWrites = false;
  mockWriteCount = 0;
  mockOnRead = null;
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useWalkthroughStore.setState({
    visible: false,
    queued: false,
    request: null,
  });
  setActiveDataOwner(ACCOUNT_A);
});

afterAll(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('walkthroughStore', () => {
  it('keys the seen record by account and registers the namespace for deletion purge', () => {
    expect(walkthroughKeyForOwner(ACCOUNT_A)).toBe(
      `walkthrough.complete:${ACCOUNT_A}`,
    );
    expect(OWNER_SCOPED_KV_NAMESPACES).toContain(WALKTHROUGH_KV_NAMESPACE);
  });

  it('shows on the account’s first main-app landing and persists its record first', async () => {
    await useWalkthroughStore.getState().maybeShowFirstRun();

    const state = useWalkthroughStore.getState();
    expect(state.visible).toBe(true);
    expect(mockKvTable.get(walkthroughKeyForOwner(ACCOUNT_A))).toBe(
      WALKTHROUGH_SEEN_VALUE,
    );
    expect(identifyCeremony(state.request!).ownerKey).toBe(ACCOUNT_A);
  });

  it('never shows again for an account whose record exists', async () => {
    mockKvTable.set(walkthroughKeyForOwner(ACCOUNT_A), WALKTHROUGH_SEEN_VALUE);

    await useWalkthroughStore.getState().maybeShowFirstRun();

    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(mockWriteCount).toBe(0);
  });

  it('a NEW account on the same phone gets its own tour', async () => {
    // Account A already toured this device.
    mockKvTable.set(walkthroughKeyForOwner(ACCOUNT_A), WALKTHROUGH_SEEN_VALUE);
    await useWalkthroughStore.getState().maybeShowFirstRun();
    expect(useWalkthroughStore.getState().visible).toBe(false);

    // Sign out, sign in as B.
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    setActiveDataOwner(ACCOUNT_B);
    await useWalkthroughStore.getState().maybeShowFirstRun();

    const state = useWalkthroughStore.getState();
    expect(state.visible).toBe(true);
    expect(identifyCeremony(state.request!).ownerKey).toBe(ACCOUNT_B);
    expect(mockKvTable.get(walkthroughKeyForOwner(ACCOUNT_B))).toBe(
      WALKTHROUGH_SEEN_VALUE,
    );
    // A's record is untouched: B's tour never rewrote another account's key.
    expect(mockKvTable.get(walkthroughKeyForOwner(ACCOUNT_A))).toBe(
      WALKTHROUGH_SEEN_VALUE,
    );
    expect(mockWriteCount).toBe(1);
  });

  it('the same account signing back in does not tour twice', async () => {
    await useWalkthroughStore.getState().maybeShowFirstRun();
    useWalkthroughStore.getState().dismiss();

    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    setActiveDataOwner(ACCOUNT_A);
    await useWalkthroughStore.getState().maybeShowFirstRun();

    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(mockWriteCount).toBe(1);
  });

  it('a signed-out process never raises or records the tour', async () => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);

    await useWalkthroughStore.getState().maybeShowFirstRun();

    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(mockKvTable.size).toBe(0);
  });

  it('guest use is its own bucket, separate from every account', async () => {
    setActiveDataOwner(GUEST_DATA_OWNER);

    await useWalkthroughStore.getState().maybeShowFirstRun();

    expect(useWalkthroughStore.getState().visible).toBe(true);
    expect(mockKvTable.has(walkthroughKeyForOwner(GUEST_DATA_OWNER))).toBe(
      true,
    );
    expect(mockKvTable.has(walkthroughKeyForOwner(ACCOUNT_A))).toBe(false);
  });

  it('drops a tour still showing when the account changes, so the newcomer is evaluated on its own', async () => {
    await useWalkthroughStore.getState().maybeShowFirstRun();
    expect(useWalkthroughStore.getState().visible).toBe(true);

    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    expect(useWalkthroughStore.getState()).toMatchObject({
      visible: false,
      queued: false,
      request: null,
    });

    setActiveDataOwner(ACCOUNT_B);
    await useWalkthroughStore.getState().maybeShowFirstRun();
    expect(useWalkthroughStore.getState().visible).toBe(true);
    expect(
      identifyCeremony(useWalkthroughStore.getState().request!).ownerKey,
    ).toBe(ACCOUNT_B);
  });

  it('an account change mid-evaluation neither records nor raises for the account that left', async () => {
    mockOnRead = () => {
      mockOnRead = null;
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    };

    await useWalkthroughStore.getState().maybeShowFirstRun();

    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(mockKvTable.has(walkthroughKeyForOwner(ACCOUNT_A))).toBe(false);
    expect(mockWriteCount).toBe(0);
  });

  it('stays dismissed for the rest of the session after Skip/Got it', async () => {
    await useWalkthroughStore.getState().maybeShowFirstRun();
    useWalkthroughStore.getState().dismiss();

    await useWalkthroughStore.getState().maybeShowFirstRun();

    expect(useWalkthroughStore.getState().visible).toBe(false);
  });

  it('skips silently when the record cannot be read', async () => {
    mockFailReads = true;

    await useWalkthroughStore.getState().maybeShowFirstRun();

    expect(useWalkthroughStore.getState().visible).toBe(false);
  });

  it('does not show when the record cannot be persisted (no replay loops)', async () => {
    mockFailWrites = true;

    await useWalkthroughStore.getState().maybeShowFirstRun();

    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(mockKvTable.has(walkthroughKeyForOwner(ACCOUNT_A))).toBe(false);
  });

  it('serializes concurrent landings into one show and one record write', async () => {
    await Promise.all([
      useWalkthroughStore.getState().maybeShowFirstRun(),
      useWalkthroughStore.getState().maybeShowFirstRun(),
      useWalkthroughStore.getState().maybeShowFirstRun(),
    ]);

    expect(useWalkthroughStore.getState().visible).toBe(true);
    expect(mockWriteCount).toBe(1);
  });

  it('replay shows the tour for the active account without touching the durable record', () => {
    useWalkthroughStore.getState().replay();

    const state = useWalkthroughStore.getState();
    expect(state.visible).toBe(true);
    expect(identifyCeremony(state.request!).ownerKey).toBe(ACCOUNT_A);
    expect(mockWriteCount).toBe(0);

    useWalkthroughStore.getState().dismiss();
    expect(useWalkthroughStore.getState().visible).toBe(false);
  });
});
