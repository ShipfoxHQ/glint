export interface DatabaseTransaction {
  readonly id: string;
}

export interface TransactionOptions {
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
  readonly checkedAt: Date;
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

export class TransactionStateError extends Error {
  readonly code = 'transaction_not_active';

  constructor() {
    super('The transaction is no longer active');
    this.name = 'TransactionStateError';
  }
}
