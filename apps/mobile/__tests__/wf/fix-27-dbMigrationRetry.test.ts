import type { LocalDb } from '../../src/data/db';

const mockExecuteSync = jest.fn();
const mockExecute = jest.fn();
const mockClose = jest.fn();
const mockOpen = jest.fn(() => ({
  executeSync: mockExecuteSync,
  execute: mockExecute,
  close: mockClose,
}));

jest.mock('@op-engineering/op-sqlite', () => ({ open: mockOpen }));

function loadGetDb(): () => LocalDb {
  let getDb: (() => LocalDb) | null = null;
  jest.isolateModules(() => {
    getDb =
      jest.requireActual<typeof import('../../src/data/db')>(
        '../../src/data/db',
      ).getDb;
  });
  if (!getDb) {
    throw new Error('db module did not load');
  }
  return getDb;
}

describe('getDb migration failure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecuteSync.mockReset();
    mockExecuteSync.mockReturnValue({ rows: [] });
    mockExecute.mockResolvedValue({ rows: [] });
  });

  it('does not cache a handle whose migrations threw and retries on the next call', () => {
    const getDb = loadGetDb();
    mockExecuteSync.mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });

    expect(() => getDb()).toThrow('disk I/O error');
    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(mockClose).toHaveBeenCalledTimes(1);
    const statementsAfterFailure = mockExecuteSync.mock.calls.length;

    expect(() => getDb()).not.toThrow();
    expect(mockOpen).toHaveBeenCalledTimes(2);
    expect(mockExecuteSync.mock.calls.length).toBeGreaterThan(
      statementsAfterFailure + 1,
    );
    expect(mockExecuteSync).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS kv'),
    );
    expect(mockExecuteSync).toHaveBeenCalledWith('COMMIT');
  });

  it('rolls back and releases the handle when the account-schema migration throws', () => {
    const getDb = loadGetDb();
    mockExecuteSync.mockImplementation((sql: string) => {
      if (sql === 'COMMIT') {
        throw new Error('database is locked');
      }
      return { rows: [] };
    });

    expect(() => getDb()).toThrow('database is locked');
    expect(mockExecuteSync).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClose).toHaveBeenCalledTimes(1);

    mockExecuteSync.mockImplementation(() => ({ rows: [] }));
    expect(() => getDb()).not.toThrow();
    expect(mockOpen).toHaveBeenCalledTimes(2);
  });

  it('still throws the migration error when closing the failed handle also throws', () => {
    const getDb = loadGetDb();
    mockExecuteSync.mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });
    mockClose.mockImplementationOnce(() => {
      throw new Error('close failed');
    });

    expect(() => getDb()).toThrow('disk I/O error');
    expect(() => getDb()).not.toThrow();
    expect(mockOpen).toHaveBeenCalledTimes(2);
  });

  it('reuses one migrated handle across calls once migrations succeed', () => {
    const getDb = loadGetDb();
    getDb();
    getDb();
    expect(mockOpen).toHaveBeenCalledTimes(1);
  });
});
