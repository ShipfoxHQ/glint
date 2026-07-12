import type {DatabaseTransaction} from '@glint/node-database';

export interface OutboxEvent<TPayload = unknown> {
  readonly id: string;
  readonly topic: string;
  readonly payload: TPayload;
  readonly occurredAt: Date;
  readonly availableAt?: Date;
  readonly correlationId?: string;
  readonly traceParent?: string;
}

export interface OutboxDelivery<TPayload = unknown> {
  readonly event: OutboxEvent<TPayload>;
  readonly attempts: number;
  readonly deliveryId: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
}

export interface OutboxHealth {
  readonly status: 'ready' | 'unavailable';
  readonly checkedAt: Date;
  readonly oldestPendingAt?: Date;
  readonly oldestPendingAgeMs?: number;
}

export interface TransactionalOutbox {
  append<TPayload>(
    transaction: DatabaseTransaction,
    event: OutboxEvent<TPayload>,
  ): Promise<{readonly status: 'created' | 'duplicate'}>;
  claim(input: {
    readonly dispatcherId: string;
    readonly maximumEvents: number;
    readonly leaseDurationMs: number;
  }): Promise<readonly OutboxDelivery[]>;
  acknowledge(input: {readonly deliveryId: string; readonly leaseToken: string}): Promise<void>;
  retry(input: {
    readonly deliveryId: string;
    readonly leaseToken: string;
    readonly delayMs: number;
  }): Promise<void>;
  health(): Promise<OutboxHealth>;
}
