import {createQueueTelemetry} from './telemetry.js';
import type {DeadLetter, Job, JobDelivery, JobQueue, QueueHealth, QueueTelemetry} from './types.js';
import {
  DeadLetterNotFoundError,
  MVP_JOB_QUEUE_POLICY,
  QueueCapabilityError,
  StaleDeliveryError,
} from './types.js';

interface QueueRecord {
  readonly job: Job;
  attempts: number;
  state: 'available' | 'leased' | 'acknowledged' | 'dead-letter';
  deliveryId?: string;
  leaseToken?: string;
  leaseExpiresAt?: Date;
  deadLetter?: DeadLetter;
}

export class InMemoryJobQueue implements JobQueue {
  readonly #records = new Map<string, QueueRecord>();
  readonly #telemetry: QueueTelemetry;
  #nextRecordId = 1;
  #nextDeliveryId = 1;
  #healthStatus: QueueHealth['status'] = 'ready';

  constructor(
    private readonly now: () => Date = () => new Date(),
    telemetry: QueueTelemetry = createQueueTelemetry(),
  ) {
    this.#telemetry = telemetry;
  }

  enqueue<TPayload>(input: {
    readonly id: string;
    readonly name: string;
    readonly payload: TPayload;
    readonly availableAt?: Date;
    readonly maximumAttempts?: number;
    readonly correlationId?: string;
    readonly traceParent?: string;
  }): Promise<{readonly status: 'created' | 'duplicate'}> {
    return Promise.resolve().then(() => {
      const now = this.now();
      const maximumAttempts = input.maximumAttempts ?? MVP_JOB_QUEUE_POLICY.maximumAttempts;
      if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1) {
        throw new QueueCapabilityError('A job must allow at least one delivery attempt.');
      }
      const requestedAvailableAt = input.availableAt ?? now;
      if (Number.isNaN(requestedAvailableAt.getTime())) {
        throw new QueueCapabilityError('A job availability timestamp must be valid.');
      }
      const delayMs = Math.max(0, requestedAvailableAt.getTime() - now.getTime());
      if (delayMs > MVP_JOB_QUEUE_POLICY.maximumEnqueueDelayMs) {
        throw new QueueCapabilityError('The queue supports enqueue delays of at most 15 minutes.');
      }
      this.#records.set(`record-${this.#nextRecordId++}`, {
        job: {
          id: input.id,
          name: input.name,
          payload: cloneJson(input.payload),
          enqueuedAt: new Date(now),
          availableAt: new Date(now.getTime() + roundDuration(delayMs)),
          maximumAttempts,
          ...(input.correlationId ? {correlationId: input.correlationId} : {}),
          ...(input.traceParent ? {traceParent: input.traceParent} : {}),
        },
        attempts: 0,
        state: 'available',
      });
      this.#telemetry.enqueued({duplicate: false, queue: 'in-memory'});
      return {status: 'created' as const};
    });
  }

  claim(input: {
    readonly consumerId: string;
    readonly maximumJobs: number;
    readonly leaseDurationMs: number;
  }): Promise<readonly JobDelivery[]> {
    return Promise.resolve().then(() => {
      if (input.maximumJobs <= 0) return [];
      if (!Number.isInteger(input.maximumJobs)) {
        throw new QueueCapabilityError('A claim size must be a whole number.');
      }
      if (input.leaseDurationMs <= 0) {
        throw new QueueCapabilityError('A delivery lease must be at least one second.');
      }
      if (input.leaseDurationMs > MVP_JOB_QUEUE_POLICY.maximumVisibilityMs) {
        throw new QueueCapabilityError('A delivery lease cannot exceed 12 hours.');
      }
      if (input.maximumJobs > MVP_JOB_QUEUE_POLICY.maximumClaimBatchSize) {
        throw new QueueCapabilityError('A claim can return at most 10 jobs.');
      }
      const now = this.now();
      const deliveries: JobDelivery[] = [];
      for (const record of this.#records.values()) {
        if (deliveries.length >= input.maximumJobs) break;
        if (record.state === 'leased' && record.leaseExpiresAt && record.leaseExpiresAt <= now) {
          record.state = 'available';
        }
        if (record.state !== 'available' || record.job.availableAt > now) continue;
        if (record.attempts >= record.job.maximumAttempts) {
          this.#moveToDeadLetter(record, 'delivery attempts exhausted');
          continue;
        }
        record.attempts += 1;
        record.state = 'leased';
        record.deliveryId = `delivery-${this.#nextDeliveryId++}`;
        record.leaseToken = `${input.consumerId}:${record.deliveryId}`;
        record.leaseExpiresAt = new Date(now.getTime() + roundDuration(input.leaseDurationMs));
        const delivery = this.#delivery(record);
        deliveries.push(delivery);
        this.#telemetry.delivered({
          attempt: delivery.attempt,
          jobName: delivery.job.name,
          queue: 'in-memory',
          queueAgeMs: Math.max(0, now.getTime() - delivery.job.enqueuedAt.getTime()),
        });
      }
      return deliveries;
    });
  }

  acknowledge(input: {readonly deliveryId: string; readonly leaseToken: string}) {
    return Promise.resolve().then(() => {
      const record = this.#leasedRecord(input);
      record.state = 'acknowledged';
      delete record.leaseExpiresAt;
    });
  }

  retry(input: {
    readonly deliveryId: string;
    readonly leaseToken: string;
    readonly delayMs: number;
    readonly reason: string;
  }) {
    return Promise.resolve().then(() => {
      if (input.delayMs < 0) {
        throw new QueueCapabilityError('A retry delay cannot be negative.');
      }
      if (input.delayMs > MVP_JOB_QUEUE_POLICY.maximumVisibilityMs) {
        throw new QueueCapabilityError('A retry delay cannot exceed 12 hours.');
      }
      const record = this.#leasedRecord(input);
      if (record.attempts >= record.job.maximumAttempts) {
        this.#moveToDeadLetter(record, input.reason);
        return;
      }
      record.state = 'available';
      delete record.leaseExpiresAt;
      Object.assign(record.job, {
        availableAt: new Date(this.now().getTime() + roundDuration(input.delayMs, true)),
      });
    });
  }

  extendLease(input: {
    readonly deliveryId: string;
    readonly leaseToken: string;
    readonly leaseDurationMs: number;
  }): Promise<Date> {
    return Promise.resolve().then(() => {
      if (input.leaseDurationMs <= 0) {
        throw new QueueCapabilityError('A delivery lease must be at least one second.');
      }
      if (input.leaseDurationMs > MVP_JOB_QUEUE_POLICY.maximumVisibilityMs) {
        throw new QueueCapabilityError('A delivery lease cannot exceed 12 hours.');
      }
      const record = this.#leasedRecord(input);
      record.leaseExpiresAt = new Date(this.now().getTime() + roundDuration(input.leaseDurationMs));
      return new Date(record.leaseExpiresAt);
    });
  }

  listDeadLetters(input?: {readonly maximumJobs?: number}): Promise<readonly DeadLetter[]> {
    return Promise.resolve(
      [...this.#records.values()]
        .flatMap((record) => (record.deadLetter ? [structuredClone(record.deadLetter)] : []))
        .slice(0, input?.maximumJobs ?? 100),
    );
  }

  redrive(input: {readonly deadLetterId: string}): Promise<void> {
    return Promise.resolve().then(() => {
      const record = [...this.#records.values()].find(
        (candidate) => candidate.deadLetter?.id === input.deadLetterId,
      );
      if (!record) throw new DeadLetterNotFoundError(input.deadLetterId);
      record.state = 'available';
      record.attempts = 0;
      delete record.deadLetter;
      Object.assign(record.job, {availableAt: this.now()});
    });
  }

  health(): Promise<QueueHealth> {
    const now = this.now();
    const oldestAvailableAt = [...this.#records.values()]
      .filter((record) => record.state === 'available' && record.job.availableAt <= now)
      .map((record) => record.job.availableAt)
      .sort((left, right) => left.getTime() - right.getTime())[0];
    return Promise.resolve({
      status: this.#healthStatus,
      checkedAt: now,
      ...(oldestAvailableAt
        ? {
            oldestAvailableAt: new Date(oldestAvailableAt),
            oldestJobAgeMs: now.getTime() - oldestAvailableAt.getTime(),
          }
        : {}),
    });
  }

  setHealthStatus(status: QueueHealth['status']): void {
    this.#healthStatus = status;
  }

  #leasedRecord(input: {readonly deliveryId: string; readonly leaseToken: string}): QueueRecord {
    const now = this.now();
    const record = [...this.#records.values()].find(
      (candidate) => candidate.deliveryId === input.deliveryId,
    );
    if (
      record?.state !== 'leased' ||
      record.leaseToken !== input.leaseToken ||
      !record.leaseExpiresAt ||
      record.leaseExpiresAt <= now
    ) {
      throw new StaleDeliveryError(input.deliveryId);
    }
    return record;
  }

  #delivery(record: QueueRecord): JobDelivery {
    if (!record.deliveryId || !record.leaseToken || !record.leaseExpiresAt) {
      throw new Error('Invariant: leased record is missing delivery metadata');
    }
    return {
      job: structuredClone(record.job),
      attempt: record.attempts,
      deliveryId: record.deliveryId,
      leaseToken: record.leaseToken,
      leaseExpiresAt: new Date(record.leaseExpiresAt),
    };
  }

  #moveToDeadLetter(record: QueueRecord, reason: string): void {
    const failedAt = this.now();
    record.state = 'dead-letter';
    delete record.leaseExpiresAt;
    record.deadLetter = {
      id: `dead-letter:${record.deliveryId ?? record.job.id}`,
      job: structuredClone(record.job),
      attempts: record.attempts,
      failedAt,
      reason,
    };
    this.#telemetry.deadLettered({jobName: record.job.name, queue: 'in-memory'});
  }
}

function roundDuration(milliseconds: number, allowZero = false): number {
  if (allowZero && milliseconds === 0) return 0;
  return (
    Math.ceil(milliseconds / MVP_JOB_QUEUE_POLICY.timingGranularityMs) *
    MVP_JOB_QUEUE_POLICY.timingGranularityMs
  );
}

function cloneJson<T>(value: T): T {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
      throw new QueueCapabilityError('Job payload must be JSON serializable.');
    return JSON.parse(serialized) as T;
  } catch (error) {
    if (error instanceof QueueCapabilityError) throw error;
    throw new QueueCapabilityError('Job payload must be JSON serializable.');
  }
}
