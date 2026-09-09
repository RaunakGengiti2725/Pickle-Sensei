import { NativeModules } from 'react-native';

import {
  OfflineWalletError,
  type OfflineWalletReceipt,
  discardCorruptOfflineWallet,
  loadOfflineWallet,
  replaceOfflineWallet,
} from '../src/native/offlineWallet';

/**
 * Adversarial probes for the JS half of the offline wallet bridge (W05-01,
 * candidate 1549b6aa). The native side is modelled by a small stateful fake
 * that follows the contract `OfflineWallet.swift` pins in
 * native/vision-core/Tests: it stores exactly what it is given, numbers writes
 * per owner, refuses a stale `expectedRevision` with `wallet.revision_conflict`
 * and answers `wallet.not_corrupt` from `discardCorruptWallet` while the
 * stored wallet verifies. `OfflineWalletAttackTests.swift` proves the
 * concrete native acceptances the fake reproduces here (a receipt payload
 * carrying a UTF-8 byte-order mark passes `OfflineWallet.validate`).
 */

const OWNER = '0f9d5a7e-3c1b-4a2d-9b8e-1c2d3e4f5a6b';

type NativeSlot = { PickleOfflineWallet?: unknown };

interface StoredWallet {
  revision: number;
  grants: { grantId: string; compactJws: string }[];
  receipts: { receiptId: string; kind: string; payloadJson: string }[];
}

function nativeRejection(code: string, message: string) {
  return Object.assign(new Error(message), { code, userInfo: {} });
}

class FakeNativeWallet {
  private stored: StoredWallet | null = null;
  private fence = 0;

  readonly loadWallet = jest.fn(async (ownerId: string) => {
    if (ownerId !== OWNER) {
      throw nativeRejection('wallet.invalid_owner', 'owner');
    }
    return this.stored === null ? null : { ownerId, ...this.stored };
  });

  readonly replaceWallet = jest.fn(
    async (
      ownerId: string,
      expectedRevision: number,
      contents: {
        grants: { grantId: string; compactJws: string }[];
        receipts: { receiptId: string; kind: string; payloadJson: string }[];
      },
    ) => {
      if (ownerId !== OWNER) {
        throw nativeRejection('wallet.invalid_owner', 'owner');
      }
      const current = this.stored?.revision ?? 0;
      if (current !== expectedRevision) {
        throw nativeRejection(
          'wallet.revision_conflict',
          `stored revision ${current} != expected ${expectedRevision}`,
        );
      }
      const revision = Math.max(current, this.fence) + 1;
      this.stored = {
        revision,
        grants: contents.grants.map(grant => ({ ...grant })),
        receipts: contents.receipts.map(receipt => ({ ...receipt })),
      };
      this.fence = revision;
      return { ownerId, ...this.stored };
    },
  );

  readonly clearWallet = jest.fn(
    async (ownerId: string, expectedRevision: number) => {
      const current = this.stored?.revision ?? 0;
      if (ownerId !== OWNER || current !== expectedRevision) {
        throw nativeRejection('wallet.revision_conflict', 'stale');
      }
      this.stored = null;
      return null;
    },
  );

  readonly discardCorruptWallet = jest.fn(async (ownerId: string) => {
    if (ownerId !== OWNER) {
      throw nativeRejection('wallet.invalid_owner', 'owner');
    }
    throw nativeRejection('wallet.not_corrupt', 'wallet verifies; use clear');
  });

  get walletRevision(): number {
    return this.stored?.revision ?? 0;
  }

  get receiptIds(): string[] {
    return this.stored?.receipts.map(receipt => receipt.receiptId) ?? [];
  }
}

let native: FakeNativeWallet;

beforeEach(() => {
  native = new FakeNativeWallet();
  (NativeModules as NativeSlot).PickleOfflineWallet = native;
});

afterAll(() => {
  delete (NativeModules as NativeSlot).PickleOfflineWallet;
});

async function settle<T>(
  promise: Promise<T>,
): Promise<{ value: T } | { error: unknown }> {
  return promise.then(
    value => ({ value }),
    (error: unknown) => ({ error }),
  );
}

const bomReceipt: OfflineWalletReceipt = {
  receiptId: 'receipt-bom',
  kind: 'result',
  payloadJson:
    '\uFEFF{"schemaVersion":"offline-result-receipt-v1","receiptId":"receipt-bom"}',
};

describe('offline wallet bridge under attack', () => {
  it('refuses a receipt payload JS cannot parse back before it reaches native', async () => {
    // Native `isJsonObject` (JSONSerialization) accepts a UTF-8 BOM; JS
    // `JSON.parse` does not. The wrapper must refuse it with a typed failure
    // instead of letting native commit a wallet the wrapper then cannot read.
    const outcome = await settle(
      replaceOfflineWallet(OWNER, 0, { grants: [], receipts: [bomReceipt] }),
    );
    expect('error' in outcome).toBe(true);
    if ('error' in outcome) {
      expect(outcome.error).toBeInstanceOf(OfflineWalletError);
      expect((outcome.error as OfflineWalletError).failure).toBe(
        'invalid_receipt',
      );
    }
    expect(native.replaceWallet).not.toHaveBeenCalled();
    expect(native.walletRevision).toBe(0);
  });

  it('never wedges: a wallet native verified and committed stays loadable and clearable from JS', async () => {
    // What the candidate does today when the BOM receipt gets through:
    // native writes revision 1 and resolves, replace rejects bridge_contract,
    // and afterwards load rejects bridge_contract while discard says
    // not_corrupt — the unsent receipt is unreachable from JS.
    const replaced = await settle(
      replaceOfflineWallet(OWNER, 0, { grants: [], receipts: [bomReceipt] }),
    );
    if ('value' in replaced) {
      expect(replaced.value.revision).toBe(1);
      return;
    }
    // The wrapper rejected. Then native must not have committed anything:
    expect(native.walletRevision).toBe(0);
    expect(native.receiptIds).toEqual([]);
    const loaded = await settle(loadOfflineWallet(OWNER));
    expect('value' in loaded && loaded.value === null).toBe(true);
    const discarded = await settle(discardCorruptOfflineWallet(OWNER));
    expect('error' in discarded).toBe(true);
  });

  it('double submit: two concurrent replaces on one revision commit exactly one and conflict the other', async () => {
    const [first, second] = await Promise.all([
      settle(
        replaceOfflineWallet(OWNER, 0, {
          grants: [],
          receipts: [
            { receiptId: 'receipt-first', kind: 'result', payloadJson: '{}' },
          ],
        }),
      ),
      settle(
        replaceOfflineWallet(OWNER, 0, {
          grants: [],
          receipts: [
            { receiptId: 'receipt-second', kind: 'result', payloadJson: '{}' },
          ],
        }),
      ),
    ]);
    const outcomes = [first, second];
    const winners = outcomes.filter(outcome => 'value' in outcome);
    const losers = outcomes.filter(outcome => 'error' in outcome);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loser = losers[0];
    if (loser && 'error' in loser) {
      expect(loser.error).toBeInstanceOf(OfflineWalletError);
      expect((loser.error as OfflineWalletError).failure).toBe(
        'revision_conflict',
      );
    }
    expect(native.walletRevision).toBe(1);
    expect(native.receiptIds).toHaveLength(1);
    const reloaded = await loadOfflineWallet(OWNER);
    expect(reloaded?.revision).toBe(1);
    expect(reloaded?.receipts.map(receipt => receipt.receiptId)).toEqual(
      native.receiptIds,
    );
  });

  it('replay: a snapshot with a revision that already went out is not accepted twice by the wrapper', async () => {
    // The wrapper hands `revision` straight back to callers as the next
    // `expectedRevision`. A stale snapshot replayed against native must be
    // refused by native, and the wrapper must surface it typed — never as a
    // fresh commit.
    const one = await replaceOfflineWallet(OWNER, 0, {
      grants: [],
      receipts: [{ receiptId: 'r-1', kind: 'result', payloadJson: '{}' }],
    });
    expect(one.revision).toBe(1);
    const two = await replaceOfflineWallet(OWNER, one.revision, {
      grants: [],
      receipts: [{ receiptId: 'r-2', kind: 'result', payloadJson: '{}' }],
    });
    expect(two.revision).toBe(2);
    const replayed = await settle(
      replaceOfflineWallet(OWNER, one.revision, {
        grants: [],
        receipts: [{ receiptId: 'r-1', kind: 'result', payloadJson: '{}' }],
      }),
    );
    expect('error' in replayed).toBe(true);
    if ('error' in replayed) {
      expect((replayed.error as OfflineWalletError).failure).toBe(
        'revision_conflict',
      );
    }
    expect(native.receiptIds).toEqual(['r-2']);
  });
});
