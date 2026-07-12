export interface Job<TPayload = unknown> {
  readonly id: string;
  readonly name: string;
  readonly payload: TPayload;
  readonly enqueuedAt: Date;
  readonly availableAt: Date;
  readonly maximumAttempts: number;
  readonly correlationId?: string;
  readonly traceParent?: string;
}

export interface JobDelivery<TPayload = unknown> {
  readonly job: Job<TPayload>;
  readonly attempt: number;
  readonly deliveryId: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
}

export interface DeadLetter<TPayload = unknown> {
  readonly id: string;
  readonly job: Job<TPayload>;
  readonly attempts: number;
  readonly failedAt: Date;
  readonly reason: string;
}

export interface QueueHealth {
  readonly status: 'ready' | 'unavailable';
  readonly checkedAt: Date;
  readonly oldestAvailableAt?: Date;
  readonly oldestJobAgeMs?: number;
  readonly detail?: string;
}

export interface QueueTelemetry {
  enqueued(input: {readonly duplicate: boolean; readonly queue: string}): void;
  delivered(input: {
    readonly attempt: number;
    readonly jobName: string;
    readonly queue: string;
    readonly queueAgeMs: number;
  }): void;
  deadLettered(input: {readonly jobName: string; readonly queue: string}): void;
}

export interface JobQueue {
  enqueue<TPayload>(input: {
    readonly id: string;
    readonly name: string;
    readonly payload: TPayload;
    readonly availableAt?: Date;
    readonly maximumAttempts?: number;
    readonly correlationId?: string;
    readonly traceParent?: string;
  }): Promise<{readonly status: 'created' | 'duplicate'}>;
  claim(input: {
    readonly consumerId: string;
    readonly maximumJobs: number;
    readonly leaseDurationMs: number;
  }): Promise<readonly JobDelivery[]>;
  acknowledge(input: {readonly deliveryId: string; readonly leaseToken: string}): Promise<void>;
  retry(input: {
    readonly deliveryId: string;
    readonly leaseToken: string;
    readonly delayMs: number;
    readonly reason: string;
  }): Promise<void>;
  extendLease(input: {
    readonly deliveryId: string;
    readonly leaseToken: string;
    readonly leaseDurationMs: number;
  }): Promise<Date>;
  listDeadLetters(input?: {readonly maximumJobs?: number}): Promise<readonly DeadLetter[]>;
  redrive(input: {readonly deadLetterId: string}): Promise<void>;
  health(): Promise<QueueHealth>;
}

export const MVP_JOB_QUEUE_POLICY = {
  visibilityTimeoutMs: 90_000,
  maximumAttempts: 5,
  maximumClaimBatchSize: 10,
  maximumEnqueueDelayMs: 15 * 60 * 1_000,
  maximumVisibilityMs: 12 * 60 * 60 * 1_000,
  timingGranularityMs: 1_000,
  sourceRetentionMs: 4 * 24 * 60 * 60 * 1_000,
  deadLetterRetentionMs: 14 * 24 * 60 * 60 * 1_000,
  queueAgeWarningMs: 60_000,
  queueAgeCriticalMs: 300_000,
} as const;

export class StaleDeliveryError extends Error {
  readonly code = 'stale_delivery';

  constructor(readonly deliveryId: string) {
    super(`Delivery ${deliveryId} is no longer leased by this consumer`);
    this.name = 'StaleDeliveryError';
  }
}

export class QueueCapabilityError extends Error {
  readonly code = 'queue_capability';

  constructor(message: string) {
    super(message);
    this.name = 'QueueCapabilityError';
  }
}

export class DeadLetterNotFoundError extends Error {
  readonly code = 'dead_letter_not_found';

  constructor(readonly deadLetterId: string) {
    super(`Dead letter ${deadLetterId} is not available to redrive`);
    this.name = 'DeadLetterNotFoundError';
  }
}
