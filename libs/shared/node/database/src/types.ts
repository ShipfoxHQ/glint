export interface DatabaseTransaction {
  readonly id: string;
}

export interface TransactionOptions {
  /**
   * `repeatable-read` provides a stable MVCC-style snapshot and must not block an independent
   * transaction from committing an update to data read by the snapshot.
   */
  readonly isolation?: 'read-committed' | 'repeatable-read' | 'serializable';
  readonly readOnly?: boolean;
  readonly statementTimeoutMs?: number;
  readonly tenant?: {readonly accountId: string};
}

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

export function validateTransactionOptions(options: TransactionOptions): void {
  if (
    options.statementTimeoutMs !== undefined &&
    (!Number.isInteger(options.statementTimeoutMs) || options.statementTimeoutMs < 1)
  ) {
    throw new Error('statementTimeoutMs must be a positive integer.');
  }
  if (
    options.tenant &&
    (typeof options.tenant.accountId !== 'string' || options.tenant.accountId.trim().length === 0)
  ) {
    throw new Error('Transaction tenant accountId must be a non-empty string.');
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
