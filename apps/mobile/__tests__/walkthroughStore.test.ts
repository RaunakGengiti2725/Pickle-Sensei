/**
 * First-run walkthrough store: raised once per device, durable record written
 * BEFORE the overlay shows (crash-loop safety, same rule as the celebration
 * stores), unreadable/unwritable state skips rather than risking a blocking
 * overlay on every launch, and Settings replay never re-arms the auto-show.
 */

const mockKvTable = new Map<string, string>();
let mockFailReads = false;
let mockFailWrites = false;
let mockWriteCount = 0;

jest.mock('../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        if (mockFailReads) throw new Error('kv read failed');
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
  WALKTHROUGH_KV_KEY,
  WALKTHROUGH_SEEN_VALUE,
  useWalkthroughStore,
} from '../src/walkthrough/walkthroughStore';

beforeEach(() => {
  mockKvTable.clear();
  mockFailReads = false;
  mockFailWrites = false;
  mockWriteCount = 0;
  useWalkthroughStore.setState({ visible: false });
});

describe('walkthroughStore', () => {
  it('shows on the first main-app landing and persists the device record first', async () => {
    await useWalkthroughStore.getState().maybeShowFirstRun();

    expect(useWalkthroughStore.getState().visible).toBe(true);
    expect(mockKvTable.get(WALKTHROUGH_KV_KEY)).toBe(WALKTHROUGH_SEEN_VALUE);
  });

  it('never shows again once the device record exists', async () => {
    mockKvTable.set(WALKTHROUGH_KV_KEY, WALKTHROUGH_SEEN_VALUE);

    await useWalkthroughStore.getState().maybeShowFirstRun();

    expect(useWalkthroughStore.getState().visible).toBe(false);
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
    expect(mockKvTable.has(WALKTHROUGH_KV_KEY)).toBe(false);
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

  it('replay shows the tour without touching the durable record', () => {
    useWalkthroughStore.getState().replay();

    expect(useWalkthroughStore.getState().visible).toBe(true);
    expect(mockWriteCount).toBe(0);

    useWalkthroughStore.getState().dismiss();
    expect(useWalkthroughStore.getState().visible).toBe(false);
  });
});
