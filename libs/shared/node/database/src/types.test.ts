import {describe, expect, it} from '@shipfox/vitest/vi';
import type {TransactionOptions} from './types.js';
import {validateTransactionOptions} from './types.js';

// Type-level guard: a managed transaction is global, identity-scoped, or tenant-scoped, never a
// combination. These assertions fail the type check if the mutual exclusivity ever regresses.
const identityOnly: TransactionOptions = {identity: {identityId: 'identity-1'}};
const tenantOnly: TransactionOptions = {tenant: {accountId: 'account-1'}};
void [identityOnly, tenantOnly];

// @ts-expect-error Identity and tenant scopes must remain mutually exclusive.
const invalidCombinedScope: TransactionOptions = {
  identity: {identityId: 'identity-1'},
  tenant: {accountId: 'account-1'},
};
void invalidCombinedScope;

// Provider-neutral runtime contract, exercised here without a database so the guarantees keep a
// fast feedback loop. The PostgreSQL contract suite proves the adapter enforces them end to end.
describe('validateTransactionOptions', () => {
  it('accepts global, identity, and tenant scopes', () => {
    expect(() => validateTransactionOptions({})).not.toThrow();
    expect(() => validateTransactionOptions({identity: {identityId: 'identity-1'}})).not.toThrow();
    expect(() => validateTransactionOptions({tenant: {accountId: 'account-1'}})).not.toThrow();
  });

  it('rejects combining identity and tenant scopes', () => {
    expect(() =>
      validateTransactionOptions({
        identity: {identityId: 'identity-1'},
        tenant: {accountId: 'account-1'},
      } as unknown as TransactionOptions),
    ).toThrow('Transaction cannot combine identity and tenant contexts.');
  });

  it('rejects blank identity and tenant contexts', () => {
    expect(() => validateTransactionOptions({identity: {identityId: '   '}})).toThrow(
      'Transaction identity must contain a non-empty identityId string.',
    );
    expect(() => validateTransactionOptions({tenant: {accountId: '   '}})).toThrow(
      'Transaction tenant must contain a non-empty accountId string.',
    );
  });

  it('rejects invalid isolation and readOnly options', () => {
    expect(() =>
      validateTransactionOptions({isolation: 'read-uncommitted'} as unknown as TransactionOptions),
    ).toThrow('Transaction isolation must be read-committed, repeatable-read, or serializable.');
    expect(() =>
      validateTransactionOptions({readOnly: 'false'} as unknown as TransactionOptions),
    ).toThrow('Transaction readOnly must be a boolean.');
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2_147_483_648,
  ])('rejects invalid statement timeout %s', (statementTimeoutMs) => {
    expect(() => validateTransactionOptions({statementTimeoutMs})).toThrow(
      'statementTimeoutMs must be an integer between 1 and 2147483647.',
    );
  });
});
