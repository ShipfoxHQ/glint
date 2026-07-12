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
  readonly detail?: string;
  readonly oldestPendingAt?: Date;
  readonly oldestPendingAgeMs?: number;
}

export type OutboxAcknowledgeResult =
  | {readonly status: 'acknowledged'}
  | {readonly status: 'stale'};

export type OutboxRetryResult =
  | {readonly status: 'retry-scheduled'; readonly nextAttemptAt: Date}
  | {readonly status: 'dead-lettered'}
  | {readonly status: 'stale'};

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
  acknowledge(input: {
    readonly deliveryId: string;
    readonly leaseToken: string;
  }): Promise<OutboxAcknowledgeResult>;
  retry(input: {
    readonly deliveryId: string;
    readonly leaseToken: string;
    readonly delayMs: number;
    readonly failure?: unknown;
  }): Promise<OutboxRetryResult>;
  health(): Promise<OutboxHealth>;
}
