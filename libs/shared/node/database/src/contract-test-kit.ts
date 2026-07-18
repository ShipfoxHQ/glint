import {describe, expect, it} from '@shipfox/vitest/vi';
import type {Database, DatabaseTransaction} from './types.js';
import {MVP_DATABASE_POLICY} from './types.js';

export interface DatabaseContractHarness {
  readonly database: Database;
  write(transaction: DatabaseTransaction, key: string, value: string): Promise<void> | void;
  read(
    transaction: DatabaseTransaction,
    key: string,
  ): Promise<string | undefined> | string | undefined;
}

export function databaseContractTests(
  name: string,
  createHarness: () => Promise<DatabaseContractHarness> | DatabaseContractHarness,
): void {
  describe(`${name} database contract`, () => {
    it('commits all work and returns the operation result', async () => {
      const harness = await createHarness();
      const result = await harness.database.transaction(
        async (transaction) => {
          await harness.write(transaction, 'committed', 'yes');
          return 'result';
        },
        {
          statementTimeoutMs: MVP_DATABASE_POLICY.statementTimeoutMs,
          tenant: {accountId: 'account-1'},
        },
      );

      expect(result).toBe('result');
      await expect(
        harness.database.transaction(
          (transaction) => Promise.resolve(harness.read(transaction, 'committed')),
          {tenant: {accountId: 'account-1'}},
        ),
      ).resolves.toBe('yes');
    });

    it('rolls back all work when the operation fails', async () => {
      const harness = await createHarness();
      await expect(
        harness.database.transaction(async (transaction) => {
          await harness.write(transaction, 'rolled-back', 'no');
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');

      await expect(
        harness.database.transaction((transaction) =>
          Promise.resolve(harness.read(transaction, 'rolled-back')),
        ),
      ).resolves.toBeUndefined();
    });

    it('keeps identity-scoped work after commit and removes it on rollback', async () => {
      const harness = await createHarness();
      await harness.database.transaction(
        (transaction) => Promise.resolve(harness.write(transaction, 'bootstrap', 'committed')),
        {identity: {identityId: 'identity-1'}},
      );
      await expect(
        harness.database.transaction(
          (transaction) => Promise.resolve(harness.read(transaction, 'bootstrap')),
          {identity: {identityId: 'identity-1'}},
        ),
      ).resolves.toBe('committed');

      await expect(
        harness.database.transaction(
          async (transaction) => {
            await harness.write(transaction, 'rollback', 'no');
            throw new Error('identity rollback');
          },
          {identity: {identityId: 'identity-1'}},
        ),
      ).rejects.toThrow('identity rollback');
      await expect(
        harness.database.transaction(
          (transaction) => Promise.resolve(harness.read(transaction, 'rollback')),
          {identity: {identityId: 'identity-1'}},
        ),
      ).resolves.toBeUndefined();
    });

    it('enforces read-only transactions', async () => {
      const harness = await createHarness();
      await expect(
        harness.database.transaction(
          (transaction) => Promise.resolve(harness.write(transaction, 'forbidden', 'value')),
          {readOnly: true},
        ),
      ).rejects.toMatchObject({code: 'read_only_transaction'});
    });

    it('enforces read-only transactions in identity scope', async () => {
      const harness = await createHarness();
      await expect(
        harness.database.transaction(
          (transaction) => Promise.resolve(harness.write(transaction, 'forbidden', 'value')),
          {identity: {identityId: 'identity-1'}, readOnly: true},
        ),
      ).rejects.toMatchObject({code: 'read_only_transaction'});
    });

    it.each([
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2_147_483_648,
    ])('rejects invalid statement timeout %s before running the transaction', async (statementTimeoutMs) => {
      await expect(harnessTransaction(createHarness, {statementTimeoutMs})).rejects.toThrow(
        'statementTimeoutMs must be an integer between 1 and 2147483647.',
      );
    });

    it('rejects blank tenant identities before running the transaction', async () => {
      await expect(harnessTransaction(createHarness, {tenant: {accountId: '   '}})).rejects.toThrow(
        'Transaction tenant must contain a non-empty accountId string.',
      );
    });

    it('rejects blank identity contexts before running the transaction', async () => {
      await expect(
        harnessTransaction(createHarness, {
          identity: {identityId: '   '},
        } as unknown as Parameters<Database['transaction']>[1]),
      ).rejects.toThrow('Transaction identity must contain a non-empty identityId string.');
    });

    it.each([
      [{tenant: null}, 'Transaction tenant must contain a non-empty accountId string.'],
      [{identity: null}, 'Transaction identity must contain a non-empty identityId string.'],
      [
        {identity: {identityId: 'identity-1'}, tenant: {accountId: 'account-1'}},
        'Transaction cannot combine identity and tenant contexts.',
      ],
      [
        {isolation: 'read-uncommitted'},
        'Transaction isolation must be read-committed, repeatable-read, or serializable.',
      ],
      [{readOnly: 'false'}, 'Transaction readOnly must be a boolean.'],
    ])('rejects invalid runtime transaction options %#', async (options, expected) => {
      await expect(
        harnessTransaction(
          createHarness,
          options as unknown as Parameters<Database['transaction']>[1],
        ),
      ).rejects.toThrow(expected);
    });

    it('keeps tenant-scoped values isolated', async () => {
      const harness = await createHarness();
      for (const [accountId, value] of [
        ['account-1', 'one'],
        ['account-2', 'two'],
      ] as const) {
        await harness.database.transaction(
          (transaction) => Promise.resolve(harness.write(transaction, 'shared-key', value)),
          {tenant: {accountId}},
        );
      }
      await expect(
        harness.database.transaction(
          (transaction) => Promise.resolve(harness.read(transaction, 'shared-key')),
          {tenant: {accountId: 'account-1'}},
        ),
      ).resolves.toBe('one');
      await expect(
        harness.database.transaction(
          (transaction) => Promise.resolve(harness.read(transaction, 'shared-key')),
          {tenant: {accountId: 'account-2'}},
        ),
      ).resolves.toBe('two');
    });

    it('isolates identity scope from global, other identities, and tenant scope', async () => {
      const harness = await createHarness();
      await harness.database.transaction(
        (transaction) =>
          Promise.resolve(harness.write(transaction, 'identity-shared-key', 'identity-one')),
        {identity: {identityId: 'identity-1'}},
      );
      await expect(
        harness.database.transaction(
          (transaction) => Promise.resolve(harness.read(transaction, 'identity-shared-key')),
          {identity: {identityId: 'identity-2'}},
        ),
      ).resolves.toBeUndefined();
      await expect(
        harness.database.transaction((transaction) =>
          Promise.resolve(harness.read(transaction, 'identity-shared-key')),
        ),
      ).resolves.toBeUndefined();
      await expect(
        harness.database.transaction(
          (transaction) => Promise.resolve(harness.read(transaction, 'identity-shared-key')),
          {tenant: {accountId: 'account-1'}},
        ),
      ).resolves.toBeUndefined();
    });

    it('provides repeatable reads from a transaction snapshot', async () => {
      const harness = await createHarness();
      await harness.database.transaction((transaction) =>
        Promise.resolve(harness.write(transaction, 'snapshot', 'before')),
      );

      let signalReaderStarted: () => void = () => undefined;
      const readerStarted = new Promise<void>((resolve) => {
        signalReaderStarted = resolve;
      });
      let signalWriterCommitted: () => void = () => undefined;
      let signalWriterFailed: (error: unknown) => void = () => undefined;
      const writerCommitted = new Promise<void>((resolve, reject) => {
        signalWriterCommitted = resolve;
        signalWriterFailed = reject;
      });

      const reader = harness.database.transaction(
        async (transaction) => {
          expect(await harness.read(transaction, 'snapshot')).toBe('before');
          signalReaderStarted();
          await writerCommitted;
          expect(await harness.read(transaction, 'snapshot')).toBe('before');
        },
        {isolation: 'repeatable-read'},
      );
      const writer = (async () => {
        await readerStarted;
        try {
          await harness.database.transaction((transaction) =>
            Promise.resolve(harness.write(transaction, 'snapshot', 'after')),
          );
          signalWriterCommitted();
        } catch (error) {
          signalWriterFailed(error);
          throw error;
        }
      })();

      await Promise.all([reader, writer]);
    });

    it('provides repeatable reads from an identity-scoped transaction snapshot', async () => {
      const harness = await createHarness();
      await harness.database.transaction(
        (transaction) => Promise.resolve(harness.write(transaction, 'snapshot', 'before')),
        {identity: {identityId: 'identity-1'}},
      );
      let signalReaderStarted: () => void = () => undefined;
      const readerStarted = new Promise<void>((resolve) => {
        signalReaderStarted = resolve;
      });
      let signalWriterCommitted: () => void = () => undefined;
      const writerCommitted = new Promise<void>((resolve) => {
        signalWriterCommitted = resolve;
      });
      const reader = harness.database.transaction(
        async (transaction) => {
          expect(await harness.read(transaction, 'snapshot')).toBe('before');
          signalReaderStarted();
          await writerCommitted;
          expect(await harness.read(transaction, 'snapshot')).toBe('before');
        },
        {identity: {identityId: 'identity-1'}, isolation: 'repeatable-read'},
      );
      const writer = (async () => {
        await readerStarted;
        await harness.database.transaction(
          (transaction) => Promise.resolve(harness.write(transaction, 'snapshot', 'after')),
          {identity: {identityId: 'identity-1'}},
        );
        signalWriterCommitted();
      })();
      await Promise.all([reader, writer]);
    });

    it('provides a provider-neutral readiness result', async () => {
      const harness = await createHarness();
      await expect(harness.database.health()).resolves.toMatchObject({status: 'ready'});
    });
  });
}

async function harnessTransaction(
  createHarness: () => Promise<DatabaseContractHarness> | DatabaseContractHarness,
  options: Parameters<Database['transaction']>[1],
): Promise<void> {
  const harness = await createHarness();
  await harness.database.transaction(() => {
    throw new Error('Transaction operation must not run for invalid options.');
  }, options);
}
