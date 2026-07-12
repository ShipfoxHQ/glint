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

    it('enforces read-only transactions', async () => {
      const harness = await createHarness();
      await expect(
        harness.database.transaction(
          (transaction) => Promise.resolve(harness.write(transaction, 'forbidden', 'value')),
          {readOnly: true},
        ),
      ).rejects.toMatchObject({code: 'read_only_transaction'});
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

    it('provides repeatable reads from a transaction snapshot', async () => {
      const harness = await createHarness();
      await harness.database.transaction((transaction) =>
        Promise.resolve(harness.write(transaction, 'snapshot', 'before')),
      );
      await harness.database.transaction(
        async (outer) => {
          expect(await harness.read(outer, 'snapshot')).toBe('before');
          await harness.database.transaction((inner) =>
            Promise.resolve(harness.write(inner, 'snapshot', 'after')),
          );
          expect(await harness.read(outer, 'snapshot')).toBe('before');
        },
        {isolation: 'repeatable-read'},
      );
    });

    it('provides a provider-neutral readiness result', async () => {
      const harness = await createHarness();
      await expect(harness.database.health()).resolves.toMatchObject({status: 'ready'});
    });
  });
}
