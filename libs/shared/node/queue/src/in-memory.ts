import type {DeadLetter, Job, JobDelivery, JobQueue, QueueHealth} from './types.js';
import {MVP_JOB_QUEUE_POLICY, StaleDeliveryError} from './types.js';

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
  #nextDeliveryId = 1;
  #healthStatus: QueueHealth['status'] = 'ready';

  constructor(private readonly now: () => Date = () => new Date()) {}

  enqueue<TPayload>(input: {
    readonly id: string;
    readonly name: string;
    readonly payload: TPayload;
    readonly availableAt?: Date;
    readonly maximumAttempts?: number;
    readonly correlationId?: string;
    readonly traceParent?: string;
  }): Promise<{readonly status: 'created' | 'duplicate'}> {
    if (this.#records.has(input.id)) {
      return Promise.resolve({status: 'duplicate'});
    }
    const now = this.now();
    this.#records.set(input.id, {
      job: {
        id: input.id,
        name: input.name,
        payload: structuredClone(input.payload),
        enqueuedAt: now,
        availableAt: input.availableAt ?? now,
        maximumAttempts: input.maximumAttempts ?? MVP_JOB_QUEUE_POLICY.maximumAttempts,
        ...(input.correlationId ? {correlationId: input.correlationId} : {}),
        ...(input.traceParent ? {traceParent: input.traceParent} : {}),
      },
      attempts: 0,
      state: 'available',
    });
    return Promise.resolve({status: 'created'});
  }

  claim(input: {
    readonly consumerId: string;
    readonly maximumJobs: number;
    readonly leaseDurationMs: number;
  }): Promise<readonly JobDelivery[]> {
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
      record.leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);
      deliveries.push(this.#delivery(record));
    }
    return Promise.resolve(deliveries);
  }

  acknowledge(input: {readonly deliveryId: string; readonly leaseToken: string}) {
    const record = this.#leasedRecord(input);
    record.state = 'acknowledged';
    delete record.leaseExpiresAt;
    return Promise.resolve();
  }

  retry(input: {
    readonly deliveryId: string;
    readonly leaseToken: string;
    readonly delayMs: number;
    readonly reason: string;
  }) {
    const record = this.#leasedRecord(input);
    if (record.attempts >= record.job.maximumAttempts) {
      this.#moveToDeadLetter(record, input.reason);
      return Promise.resolve();
    }
    record.state = 'available';
    delete record.leaseExpiresAt;
    Object.assign(record.job, {availableAt: new Date(this.now().getTime() + input.delayMs)});
    return Promise.resolve();
  }

  extendLease(input: {
    readonly deliveryId: string;
    readonly leaseToken: string;
    readonly leaseDurationMs: number;
  }): Promise<Date> {
    const record = this.#leasedRecord(input);
    record.leaseExpiresAt = new Date(this.now().getTime() + input.leaseDurationMs);
    return Promise.resolve(record.leaseExpiresAt);
  }

  listDeadLetters(input?: {readonly maximumJobs?: number}): Promise<readonly DeadLetter[]> {
    return Promise.resolve(
      [...this.#records.values()]
        .flatMap((record) => (record.deadLetter ? [structuredClone(record.deadLetter)] : []))
        .slice(0, input?.maximumJobs ?? 100),
    );
  }

  redrive(input: {readonly deadLetterId: string}): Promise<void> {
    const record = [...this.#records.values()].find(
      (candidate) => candidate.deadLetter?.id === input.deadLetterId,
    );
    if (!record) return Promise.resolve();
    record.state = 'available';
    record.attempts = 0;
    delete record.deadLetter;
    Object.assign(record.job, {availableAt: this.now()});
    return Promise.resolve();
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
        ? {oldestAvailableAt, oldestJobAgeMs: now.getTime() - oldestAvailableAt.getTime()}
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
      leaseExpiresAt: record.leaseExpiresAt,
    };
  }

  #moveToDeadLetter(record: QueueRecord, reason: string): void {
    const failedAt = this.now();
    record.state = 'dead-letter';
    delete record.leaseExpiresAt;
    record.deadLetter = {
      id: `dead-letter:${record.job.id}`,
      job: structuredClone(record.job),
      attempts: record.attempts,
      failedAt,
      reason,
    };
  }
}
