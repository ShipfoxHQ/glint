export interface DatabaseTransaction {
  readonly id: string;
}

export interface IdentityTransactionContext {
  readonly identityId: string;
}

export interface TenantTransactionContext {
  readonly accountId: string;
}

interface TransactionBehaviorOptions {
  /**
   * `repeatable-read` provides a stable MVCC-style snapshot and must not block an independent
   * transaction from committing an update to data read by the snapshot.
   */
  readonly isolation?: 'read-committed' | 'repeatable-read' | 'serializable';
  readonly readOnly?: boolean;
  readonly statementTimeoutMs?: number;
}

/** A managed transaction is global, identity-scoped, or tenant-scoped, never a combination. */
export type TransactionOptions = TransactionBehaviorOptions &
  (
    | {readonly identity?: never; readonly tenant?: never}
    | {readonly identity: IdentityTransactionContext; readonly tenant?: never}
    | {readonly identity?: never; readonly tenant: TenantTransactionContext}
  );

export const MVP_DATABASE_POLICY = {
  statementTimeoutMs: 5_000,
} as const;

export interface DatabaseHealth {
  readonly status: 'ready' | 'unavailable';
  readonly checkedAtMs: number;
  readonly detail?: string;
}

export interface Database {
  transaction<T>(
    operation: (transaction: DatabaseTransaction) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
  /** Returns cached adapter state without opening a connection or waking a suspended database. */
  health(): Promise<DatabaseHealth>;
}

const MAX_POSTGRES_STATEMENT_TIMEOUT_MS = 2_147_483_647;

export function validateTransactionOptions(options: TransactionOptions): void {
  if (
    options.statementTimeoutMs !== undefined &&
    (!Number.isInteger(options.statementTimeoutMs) ||
      options.statementTimeoutMs < 1 ||
      options.statementTimeoutMs > MAX_POSTGRES_STATEMENT_TIMEOUT_MS)
  ) {
    throw new Error(
      `statementTimeoutMs must be an integer between 1 and ${MAX_POSTGRES_STATEMENT_TIMEOUT_MS}.`,
    );
  }
  const isolation: unknown = options.isolation;
  if (
    isolation !== undefined &&
    isolation !== 'read-committed' &&
    isolation !== 'repeatable-read' &&
    isolation !== 'serializable'
  ) {
    throw new Error(
      'Transaction isolation must be read-committed, repeatable-read, or serializable.',
    );
  }
  const readOnly: unknown = options.readOnly;
  if (readOnly !== undefined && typeof readOnly !== 'boolean') {
    throw new Error('Transaction readOnly must be a boolean.');
  }
  const identity: unknown = options.identity;
  const tenant: unknown = options.tenant;
  if (identity !== undefined && tenant !== undefined) {
    throw new Error('Transaction cannot combine identity and tenant contexts.');
  }
  if (identity !== undefined) {
    if (identity === null || typeof identity !== 'object' || !('identityId' in identity)) {
      throw new Error('Transaction identity must contain a non-empty identityId string.');
    }
    if (typeof identity.identityId !== 'string' || identity.identityId.trim().length === 0) {
      throw new Error('Transaction identity must contain a non-empty identityId string.');
    }
  }
  if (tenant !== undefined) {
    if (tenant === null || typeof tenant !== 'object' || !('accountId' in tenant)) {
      throw new Error('Transaction tenant must contain a non-empty accountId string.');
    }
    if (typeof tenant.accountId !== 'string' || tenant.accountId.trim().length === 0) {
      throw new Error('Transaction tenant must contain a non-empty accountId string.');
    }
  }
}

export class TransactionStateError extends Error {
  readonly code = 'transaction_not_active';

  constructor() {
    super('The transaction is no longer active');
    this.name = 'TransactionStateError';
  }
}

export class ReadOnlyTransactionError extends Error {
  readonly code = 'read_only_transaction';

  constructor() {
    super('Cannot write inside a read-only transaction');
    this.name = 'ReadOnlyTransactionError';
  }
}

export class StatementTimeoutError extends Error {
  readonly code = 'statement_timeout';

  constructor(readonly timeoutMs: number) {
    super(`Transaction exceeded its ${timeoutMs} ms statement timeout`);
    this.name = 'StatementTimeoutError';
  }
}
