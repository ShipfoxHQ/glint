import {randomUUID} from 'node:crypto';
import type {DatabaseTransaction, InMemoryDatabase} from '@glint/node-database';
import type {OutboxDelivery, OutboxEvent, OutboxHealth, TransactionalOutbox} from './types.js';

interface StoredEvent {
  readonly event: OutboxEvent;
  attempts: number;
  state: 'pending' | 'leased' | 'dispatched' | 'dead-lettered';
  deliveryId?: string;
  leaseToken?: string;
  leaseExpiresAt?: Date;
  availableAt: Date;
}

const storageKey = 'glint:outbox:events';

export interface InMemoryTransactionalOutboxOptions {
  readonly clock?: () => Date;
  readonly createDeliveryId?: () => string;
  readonly database: InMemoryDatabase;
  readonly maxAttempts?: number;
  readonly maxRetryDelayMs?: number;
}

export class InMemoryTransactionalOutbox implements TransactionalOutbox {
  readonly #clock: () => Date;
  readonly #createDeliveryId: () => string;
  readonly #database: InMemoryDatabase;
  readonly #maxAttempts: number;
  readonly #maxRetryDelayMs: number;

  constructor(options: InMemoryTransactionalOutboxOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#createDeliveryId = options.createDeliveryId ?? randomUUID;
    this.#database = options.database;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? 30 * 60 * 1_000;
    assertPositiveInteger(this.#maxAttempts, 'maxAttempts');
    assertNonNegativeInteger(this.#maxRetryDelayMs, 'maxRetryDelayMs');
  }

  append<TPayload>(
    transaction: DatabaseTransaction,
    event: OutboxEvent<TPayload>,
  ): Promise<{readonly status: 'created' | 'duplicate'}> {
    const events = this.#events(transaction);
    if (events.some((stored) => stored.event.id === event.id)) {
      return Promise.resolve({status: 'duplicate'} as const);
    }
    events.push({
      event: structuredClone(event),
      attempts: 0,
      state: 'pending',
      availableAt: new Date(event.availableAt ?? event.occurredAt),
    });
    this.#database.write(transaction, storageKey, events);
    return Promise.resolve({status: 'created'} as const);
  }

  claim(input: {
    readonly dispatcherId: string;
    readonly maximumEvents: number;
    readonly leaseDurationMs: number;
  }): Promise<readonly OutboxDelivery[]> {
    return this.#database.transaction((transaction) => {
      const now = this.#clock();
      const events = this.#events(transaction);
      const deliveries: OutboxDelivery[] = [];
      for (const stored of events) {
        if (deliveries.length >= input.maximumEvents) break;
        if (stored.state === 'leased' && stored.leaseExpiresAt && stored.leaseExpiresAt <= now) {
          this.#clearLease(stored);
          stored.state = stored.attempts >= this.#maxAttempts ? 'dead-lettered' : 'pending';
        }
        if (stored.state !== 'pending' || stored.availableAt > now) continue;
        stored.attempts += 1;
        stored.state = 'leased';
        stored.deliveryId = this.#createDeliveryId();
        stored.leaseToken = `${input.dispatcherId}:${stored.deliveryId}`;
        stored.leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);
        deliveries.push(this.#delivery(stored));
      }
      this.#database.write(transaction, storageKey, events);
      return Promise.resolve(deliveries);
    });
  }

  async acknowledge(input: {readonly deliveryId: string; readonly leaseToken: string}) {
    const updated = await this.#updateDelivery(input, (stored) => {
      stored.state = 'dispatched';
    });
    return {status: updated ? ('acknowledged' as const) : ('stale' as const)};
  }

  async retry(input: {
    readonly deliveryId: string;
    readonly leaseToken: string;
    readonly delayMs: number;
    readonly failure?: unknown;
  }) {
    assertNonNegativeInteger(input.delayMs, 'delayMs');
    const nextAttemptAt = new Date(
      this.#clock().getTime() + Math.min(input.delayMs, this.#maxRetryDelayMs),
    );
    let deadLettered = false;
    const updated = await this.#updateDelivery(input, (stored) => {
      deadLettered = stored.attempts >= this.#maxAttempts;
      stored.state = deadLettered ? 'dead-lettered' : 'pending';
      if (!deadLettered) stored.availableAt = nextAttemptAt;
    });
    if (!updated) return {status: 'stale' as const};
    return deadLettered
      ? {status: 'dead-lettered' as const}
      : {status: 'retry-scheduled' as const, nextAttemptAt};
  }

  health(): Promise<OutboxHealth> {
    const now = this.#clock();
    const oldestPendingAt = this.#events()
      .filter((stored) => stored.state === 'pending' || stored.state === 'leased')
      .map((stored) => stored.event.occurredAt)
      .sort((left, right) => left.getTime() - right.getTime())[0];
    return Promise.resolve({
      status: 'ready',
      checkedAt: new Date(now),
      ...(oldestPendingAt
        ? {
            oldestPendingAt: new Date(oldestPendingAt),
            oldestPendingAgeMs: now.getTime() - oldestPendingAt.getTime(),
          }
        : {}),
    });
  }

  #events(transaction?: DatabaseTransaction): StoredEvent[] {
    return this.#database.read<StoredEvent[]>(storageKey, transaction) ?? [];
  }

  #updateDelivery(
    input: {readonly deliveryId: string; readonly leaseToken: string},
    update: (stored: StoredEvent) => void,
  ): Promise<boolean> {
    return this.#database.transaction((transaction) => {
      const events = this.#events(transaction);
      const stored = events.find((candidate) => candidate.deliveryId === input.deliveryId);
      if (
        stored?.state !== 'leased' ||
        stored.leaseToken !== input.leaseToken ||
        !stored.leaseExpiresAt ||
        stored.leaseExpiresAt <= this.#clock()
      ) {
        return Promise.resolve(false);
      }
      update(stored);
      this.#clearLease(stored);
      this.#database.write(transaction, storageKey, events);
      return Promise.resolve(true);
    });
  }

  #delivery(stored: StoredEvent): OutboxDelivery {
    if (!stored.deliveryId || !stored.leaseToken || !stored.leaseExpiresAt) {
      throw new Error('Invariant: leased outbox event is missing delivery metadata');
    }
    return {
      event: structuredClone(stored.event),
      attempts: stored.attempts,
      deliveryId: stored.deliveryId,
      leaseToken: stored.leaseToken,
      leaseExpiresAt: new Date(stored.leaseExpiresAt),
    };
  }

  #clearLease(stored: StoredEvent): void {
    delete stored.deliveryId;
    delete stored.leaseToken;
    delete stored.leaseExpiresAt;
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}
