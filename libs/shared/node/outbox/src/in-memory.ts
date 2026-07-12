import type {DatabaseTransaction, InMemoryDatabase} from '@glint/node-database';
import type {OutboxDelivery, OutboxEvent, OutboxHealth, TransactionalOutbox} from './types.js';

interface StoredEvent {
  readonly event: OutboxEvent;
  attempts: number;
  state: 'pending' | 'leased' | 'dispatched';
  deliveryId?: string;
  leaseToken?: string;
  leaseExpiresAt?: Date;
  availableAt: Date;
}

const storageKey = 'glint:outbox:events';

export class InMemoryTransactionalOutbox implements TransactionalOutbox {
  #nextDeliveryId = 1;

  constructor(
    private readonly database: InMemoryDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  append<TPayload>(transaction: DatabaseTransaction, event: OutboxEvent<TPayload>) {
    const events = this.#events(transaction);
    if (events.some((stored) => stored.event.id === event.id)) {
      return Promise.resolve({status: 'duplicate'} as const);
    }
    events.push({
      event: structuredClone(event),
      attempts: 0,
      state: 'pending',
      availableAt: event.availableAt ?? event.occurredAt,
    });
    this.database.write(transaction, storageKey, events);
    return Promise.resolve({status: 'created'} as const);
  }

  claim(input: {
    readonly dispatcherId: string;
    readonly maximumEvents: number;
    readonly leaseDurationMs: number;
  }): Promise<readonly OutboxDelivery[]> {
    return this.database.transaction((transaction) => {
      const now = this.now();
      const events = this.#events(transaction);
      const deliveries: OutboxDelivery[] = [];
      for (const stored of events) {
        if (deliveries.length >= input.maximumEvents) break;
        if (stored.state === 'leased' && stored.leaseExpiresAt && stored.leaseExpiresAt <= now) {
          stored.state = 'pending';
        }
        if (stored.state !== 'pending' || stored.availableAt > now) continue;
        stored.attempts += 1;
        stored.state = 'leased';
        stored.deliveryId = `outbox-delivery-${this.#nextDeliveryId++}`;
        stored.leaseToken = `${input.dispatcherId}:${stored.deliveryId}`;
        stored.leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);
        deliveries.push(this.#delivery(stored));
      }
      this.database.write(transaction, storageKey, events);
      return Promise.resolve(deliveries);
    });
  }

  async acknowledge(input: {readonly deliveryId: string; readonly leaseToken: string}) {
    await this.#updateDelivery(input, (stored) => {
      stored.state = 'dispatched';
    });
  }

  async retry(input: {
    readonly deliveryId: string;
    readonly leaseToken: string;
    readonly delayMs: number;
  }) {
    await this.#updateDelivery(input, (stored) => {
      stored.state = 'pending';
      stored.availableAt = new Date(this.now().getTime() + input.delayMs);
    });
  }

  health(): Promise<OutboxHealth> {
    const now = this.now();
    const oldestPendingAt = this.#events()
      .filter((stored) => stored.state !== 'dispatched')
      .map((stored) => stored.event.occurredAt)
      .sort((left, right) => left.getTime() - right.getTime())[0];
    return Promise.resolve({
      status: 'ready',
      checkedAt: now,
      ...(oldestPendingAt
        ? {oldestPendingAt, oldestPendingAgeMs: now.getTime() - oldestPendingAt.getTime()}
        : {}),
    });
  }

  #events(transaction?: DatabaseTransaction): StoredEvent[] {
    return this.database.read<StoredEvent[]>(storageKey, transaction) ?? [];
  }

  async #updateDelivery(
    input: {readonly deliveryId: string; readonly leaseToken: string},
    update: (stored: StoredEvent) => void,
  ): Promise<void> {
    await this.database.transaction((transaction) => {
      const events = this.#events(transaction);
      const stored = events.find((candidate) => candidate.deliveryId === input.deliveryId);
      if (
        stored?.state !== 'leased' ||
        stored.leaseToken !== input.leaseToken ||
        !stored.leaseExpiresAt ||
        stored.leaseExpiresAt <= this.now()
      ) {
        throw new Error(`Outbox delivery ${input.deliveryId} is stale`);
      }
      update(stored);
      delete stored.leaseExpiresAt;
      this.database.write(transaction, storageKey, events);
      return Promise.resolve();
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
      leaseExpiresAt: stored.leaseExpiresAt,
    };
  }
}
