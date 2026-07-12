import type {Database, DatabaseHealth, DatabaseTransaction, TransactionOptions} from './types.js';
import {
  ReadOnlyTransactionError,
  StatementTimeoutError,
  TransactionStateError,
  validateTransactionOptions,
} from './types.js';

const deleted = Symbol('deleted');
type PendingValue = unknown | typeof deleted;

class InMemoryTransaction implements DatabaseTransaction {
  readonly changes = new Map<string, PendingValue>();
  active = true;

  constructor(
    readonly id: string,
    readonly options: TransactionOptions,
    readonly snapshot?: Map<string, unknown>,
  ) {}
}

export class InMemoryDatabase implements Database {
  readonly #values = new Map<string, unknown>();
  #nextTransactionId = 1;
  #health: DatabaseHealth = {status: 'ready', checkedAtMs: 0};

  async transaction<T>(
    operation: (transaction: DatabaseTransaction) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    validateTransactionOptions(options);
    const transactionOptions = structuredClone(options);
    const snapshot =
      transactionOptions.isolation && transactionOptions.isolation !== 'read-committed'
        ? this.#cloneValues()
        : undefined;
    const transaction = new InMemoryTransaction(
      `transaction-${this.#nextTransactionId++}`,
      transactionOptions,
      snapshot,
    );
    try {
      const result = await this.#withTimeout(
        operation(transaction),
        transactionOptions.statementTimeoutMs,
      );
      for (const [key, value] of transaction.changes) {
        if (value === deleted) {
          this.#values.delete(key);
        } else {
          this.#values.set(key, structuredClone(value));
        }
      }
      return result;
    } finally {
      transaction.active = false;
    }
  }

  health(): Promise<DatabaseHealth> {
    return Promise.resolve(structuredClone(this.#health));
  }

  setHealth(health: DatabaseHealth): void {
    this.#health = structuredClone(health);
  }

  read<T>(key: string, transaction?: DatabaseTransaction): T | undefined {
    let active: InMemoryTransaction | undefined;
    if (transaction) {
      active = this.#activeTransaction(transaction);
      const storageKey = this.#storageKey(key, active);
      if (active.changes.has(storageKey)) {
        const value = active.changes.get(storageKey);
        return value === deleted ? undefined : (structuredClone(value) as T);
      }
    }
    const storageKey = this.#storageKey(key, active);
    const value = (active?.snapshot ?? this.#values).get(storageKey);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  write<T>(transaction: DatabaseTransaction, key: string, value: T): void {
    const active = this.#activeTransaction(transaction);
    if (active.options.readOnly) throw new ReadOnlyTransactionError();
    active.changes.set(this.#storageKey(key, active), structuredClone(value));
  }

  delete(transaction: DatabaseTransaction, key: string): void {
    const active = this.#activeTransaction(transaction);
    if (active.options.readOnly) throw new ReadOnlyTransactionError();
    active.changes.set(this.#storageKey(key, active), deleted);
  }

  clear(): void {
    this.#values.clear();
  }

  #activeTransaction(transaction: DatabaseTransaction): InMemoryTransaction {
    if (!(transaction instanceof InMemoryTransaction) || !transaction.active) {
      throw new TransactionStateError();
    }
    return transaction;
  }

  #cloneValues(): Map<string, unknown> {
    return new Map([...this.#values].map(([key, value]) => [key, structuredClone(value)] as const));
  }

  #storageKey(key: string, transaction?: InMemoryTransaction): string {
    return `${transaction?.options.tenant?.accountId ?? 'global'}\u0000${key}`;
  }

  async #withTimeout<T>(operation: Promise<T>, timeoutMs?: number): Promise<T> {
    if (timeoutMs === undefined) return operation;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new StatementTimeoutError(timeoutMs)), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
