import {expect, it} from '@shipfox/vitest/vi';
import {databaseContractTests} from './contract-test-kit.js';
import {InMemoryDatabase} from './in-memory.js';
import type {TransactionOptions} from './types.js';

const identityOnly: TransactionOptions = {identity: {identityId: 'identity-1'}};
const tenantOnly: TransactionOptions = {tenant: {accountId: 'account-1'}};
void [identityOnly, tenantOnly];

// @ts-expect-error Identity and tenant scopes must remain mutually exclusive.
const invalidCombinedScope: TransactionOptions = {
  identity: {identityId: 'identity-1'},
  tenant: {accountId: 'account-1'},
};
void invalidCombinedScope;

databaseContractTests('in-memory', () => {
  const database = new InMemoryDatabase();
  return {
    database,
    write: (transaction, key, value) => database.write(transaction, key, value),
    read: (transaction, key) => database.read<string>(key, transaction),
  };
});

it('prevents late in-memory timeout work from committing through an inactive handle', async () => {
  const database = new InMemoryDatabase();
  let releaseLateWork: () => void = () => undefined;
  const lateWork = new Promise<void>((resolve) => {
    releaseLateWork = resolve;
  });
  let lateError: unknown;

  await expect(
    database.transaction(
      async (transaction) => {
        await lateWork;
        try {
          database.write(transaction, 'late', 'value');
        } catch (error) {
          lateError = error;
        }
      },
      {identity: {identityId: 'identity-1'}, statementTimeoutMs: 5},
    ),
  ).rejects.toMatchObject({code: 'statement_timeout'});
  releaseLateWork();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(lateError).toMatchObject({code: 'transaction_not_active'});
  await expect(
    database.transaction((transaction) =>
      Promise.resolve(database.read<string>('late', transaction)),
    ),
  ).resolves.toBeUndefined();
});
