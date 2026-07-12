import type {Database, DatabaseHealth, DatabaseTransaction, TransactionOptions} from './types.js';
import {TransactionStateError} from './types.js';

const deleted = Symbol('deleted');
type PendingValue = unknown | typeof deleted;

class InMemoryTransaction implements DatabaseTransaction {
  readonly changes = new Map<string, PendingValue>();
  active = true;

  constructor(readonly id: string) {}
}

export class InMemoryDatabase implements Database {
  readonly #values = new Map<string, unknown>();
  #nextTransactionId = 1;
  #health: DatabaseHealth = {status: 'ready', checkedAt: new Date(0)};

  async transaction<T>(
    operation: (transaction: DatabaseTransaction) => Promise<T>,
    _options?: TransactionOptions,
  ): Promise<T> {
    const transaction = new InMemoryTransaction(`transaction-${this.#nextTransactionId++}`);
    try {
      const result = await operation(transaction);
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
    return Promise.resolve({...this.#health});
  }

  setHealth(health: DatabaseHealth): void {
    this.#health = {...health};
  }

  read<T>(key: string, transaction?: DatabaseTransaction): T | undefined {
    if (transaction) {
      const active = this.#activeTransaction(transaction);
      if (active.changes.has(key)) {
        const value = active.changes.get(key);
        return value === deleted ? undefined : (structuredClone(value) as T);
      }
    }
    const value = this.#values.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  write<T>(transaction: DatabaseTransaction, key: string, value: T): void {
    this.#activeTransaction(transaction).changes.set(key, structuredClone(value));
  }

  delete(transaction: DatabaseTransaction, key: string): void {
    this.#activeTransaction(transaction).changes.set(key, deleted);
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
}
