import {describe, expect, it} from '@shipfox/vitest/vi';
import type {Database, DatabaseTransaction} from './types.js';
import {MVP_DATABASE_POLICY} from './types.js';

export interface DatabaseContractHarness {
  readonly database: Database;
  write(transaction: DatabaseTransaction, key: string, value: string): Promise<void> | void;
  read(key: string): Promise<string | undefined> | string | undefined;
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
      expect(await harness.read('committed')).toBe('yes');
    });

    it('rolls back all work when the operation fails', async () => {
      const harness = await createHarness();
      await expect(
        harness.database.transaction(async (transaction) => {
          await harness.write(transaction, 'rolled-back', 'no');
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');

      expect(await harness.read('rolled-back')).toBeUndefined();
    });

    it('provides a provider-neutral readiness result', async () => {
      const harness = await createHarness();
      await expect(harness.database.health()).resolves.toMatchObject({status: 'ready'});
    });
  });
}
