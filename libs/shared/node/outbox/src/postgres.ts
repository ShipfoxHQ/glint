import {fileURLToPath} from 'node:url';
import type {OrderedMigration, PostgresDatabase} from '@glint/node-database';
import {
  createPostgresOutbox,
  createPostgresOutboxTable,
  type PostgresOutbox,
  type PostgresOutboxTable,
  writeIdempotentOutboxEvent,
} from '@shipfox/node-outbox';
import {pgTableCreator} from 'drizzle-orm/pg-core';
import type {
  OutboxAcknowledgeResult,
  OutboxDelivery,
  OutboxEvent,
  OutboxHealth,
  OutboxRetryResult,
  TransactionalOutbox,
} from './types.js';

const pgTable = pgTableCreator((name) => `glint_${name}`);

export const postgresOutboxTable = createPostgresOutboxTable(pgTable);

export const POSTGRES_OUTBOX_MIGRATION: OrderedMigration = Object.freeze({
  name: 'outbox',
  directory: fileURLToPath(new URL('../drizzle', import.meta.url)),
});

interface StoredEventEnvelope<TPayload = unknown> {
  readonly correlationId?: string;
  readonly payload: TPayload;
  readonly traceParent?: string;
}

export interface PostgresTransactionalOutboxOptions {
  readonly clock?: () => Date;
  readonly database: PostgresDatabase;
  readonly maxAttempts?: number;
  readonly maxRetryDelayMs?: number;
  readonly table?: PostgresOutboxTable;
}

/** Adapts the published Shipfox PostgreSQL implementation to Glint's neutral outbox port. */
export class PostgresTransactionalOutbox implements TransactionalOutbox {
  readonly #clock: () => Date;
  readonly #database: PostgresDatabase;
  readonly #outbox: PostgresOutbox;
  readonly #table: PostgresOutboxTable;

  constructor(options: PostgresTransactionalOutboxOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#database = options.database;
    this.#table = options.table ?? postgresOutboxTable;
    this.#outbox = createPostgresOutbox({
      database: options.database.drizzle,
      table: this.#table,
      ...(options.maxAttempts === undefined ? {} : {maxAttempts: options.maxAttempts}),
      ...(options.maxRetryDelayMs === undefined ? {} : {maxRetryDelayMs: options.maxRetryDelayMs}),
    });
  }

  append<TPayload>(
    transaction: Parameters<TransactionalOutbox['append']>[0],
    event: OutboxEvent<TPayload>,
  ): Promise<{readonly status: 'created' | 'duplicate'}> {
    const payload: StoredEventEnvelope<TPayload> = {
      payload: event.payload,
      ...(event.correlationId ? {correlationId: event.correlationId} : {}),
      ...(event.traceParent ? {traceParent: event.traceParent} : {}),
    };
    return this.#database.useTransaction(transaction, (tx) =>
      writeIdempotentOutboxEvent(tx, this.#table, {
        idempotencyKey: event.id,
        type: event.topic,
        payload,
        createdAt: event.occurredAt,
        ...(event.availableAt ? {availableAt: event.availableAt} : {}),
      }),
    );
  }

  async claim(input: {
    readonly dispatcherId: string;
    readonly maximumEvents: number;
    readonly leaseDurationMs: number;
  }): Promise<readonly OutboxDelivery[]> {
    void input.dispatcherId;
    const claimed = await this.#outbox.claim<StoredEventEnvelope>({
      batchSize: input.maximumEvents,
      leaseDurationMs: input.leaseDurationMs,
      now: this.#clock(),
    });
    return claimed.map((delivery) => ({
      event: {
        id: delivery.idempotencyKey,
        topic: delivery.type,
        payload: delivery.payload.payload,
        occurredAt: delivery.createdAt,
        ...(delivery.payload.correlationId ? {correlationId: delivery.payload.correlationId} : {}),
        ...(delivery.payload.traceParent ? {traceParent: delivery.payload.traceParent} : {}),
      },
      attempts: delivery.attempts,
      deliveryId: delivery.id,
      leaseToken: delivery.leaseToken,
      leaseExpiresAt: delivery.leaseExpiresAt,
    }));
  }

  acknowledge(input: {
    readonly deliveryId: string;
    readonly leaseToken: string;
  }): Promise<OutboxAcknowledgeResult> {
    return this.#outbox.acknowledge({
      id: input.deliveryId,
      leaseToken: input.leaseToken,
      now: this.#clock(),
    });
  }

  retry(input: {
    readonly deliveryId: string;
    readonly leaseToken: string;
    readonly delayMs: number;
    readonly failure?: unknown;
  }): Promise<OutboxRetryResult> {
    return this.#outbox.retry({
      id: input.deliveryId,
      leaseToken: input.leaseToken,
      delayMs: input.delayMs,
      failure: input.failure ?? new Error('Outbox delivery requested a retry.'),
      now: this.#clock(),
    });
  }

  async health(): Promise<OutboxHealth> {
    const checkedAt = this.#clock();
    try {
      const health = await this.#outbox.health({now: checkedAt});
      return {
        status: 'ready',
        checkedAt: health.checkedAt,
        ...(health.oldestPendingAt ? {oldestPendingAt: health.oldestPendingAt} : {}),
        ...(health.oldestPendingAgeMs === undefined
          ? {}
          : {oldestPendingAgeMs: health.oldestPendingAgeMs}),
      };
    } catch (error) {
      return {
        status: 'unavailable',
        checkedAt,
        detail: error instanceof Error ? error.message : 'PostgreSQL outbox health query failed.',
      };
    }
  }
}
