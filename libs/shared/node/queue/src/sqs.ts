import {createHash} from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {createQueueTelemetry} from './telemetry.js';
import type {DeadLetter, Job, JobDelivery, JobQueue, QueueHealth, QueueTelemetry} from './types.js';
import {
  DeadLetterNotFoundError,
  MVP_JOB_QUEUE_POLICY,
  QueueCapabilityError,
  StaleDeliveryError,
} from './types.js';

const MAXIMUM_TRACKED_DEAD_LETTERS = 1_000;

interface SerializedJob {
  readonly availableAt: string;
  readonly correlationId?: string;
  readonly enqueuedAt: string;
  readonly id: string;
  readonly maximumAttempts: number;
  readonly name: string;
  readonly payload: unknown;
  readonly traceParent?: string;
}

interface SourceEnvelope {
  readonly job: SerializedJob;
  readonly schemaVersion: 1;
}

interface DeadLetterEnvelope {
  readonly deadLetter: {
    readonly attempts: number;
    readonly failedAt: string;
    readonly job: SerializedJob;
    readonly reason: string;
  };
  readonly schemaVersion: 1;
}

interface ActiveLease {
  attempt: number;
  expiresAt: Date;
  readonly job: Job;
  readonly receiptHandle: string;
}

interface ListedDeadLetter {
  readonly deadLetter: DeadLetter;
  readonly receiptHandle: string;
}

export interface SqsJobQueueOptions {
  readonly client: SQSClient;
  readonly deadLetterQueueUrl: string;
  readonly getOldestJobAgeMs?: () => Promise<number | undefined>;
  readonly now?: () => Date;
  readonly queueName?: string;
  readonly queueUrl: string;
  readonly telemetry?: QueueTelemetry;
  readonly waitTimeSeconds?: number;
}

export class SqsJobQueue implements JobQueue {
  readonly #activeLeases = new Map<string, ActiveLease>();
  readonly #client: SQSClient;
  readonly #deadLetterQueueUrl: string;
  readonly #getOldestJobAgeMs: (() => Promise<number | undefined>) | undefined;
  readonly #listedDeadLetters = new Map<string, ListedDeadLetter>();
  readonly #now: () => Date;
  readonly #queueName: string;
  readonly #queueUrl: string;
  readonly #telemetry: QueueTelemetry;
  readonly #waitTimeSeconds: number;

  constructor(options: SqsJobQueueOptions) {
    this.#client = options.client;
    this.#deadLetterQueueUrl = options.deadLetterQueueUrl;
    this.#getOldestJobAgeMs = options.getOldestJobAgeMs;
    this.#now = options.now ?? (() => new Date());
    this.#queueName = options.queueName ?? 'sqs';
    this.#queueUrl = options.queueUrl;
    this.#telemetry = options.telemetry ?? createQueueTelemetry();
    const waitTimeSeconds = options.waitTimeSeconds ?? 20;
    if (!Number.isInteger(waitTimeSeconds) || waitTimeSeconds < 0 || waitTimeSeconds > 20) {
      throw new QueueCapabilityError(
        'Amazon SQS long polling must be a whole number from 0 to 20.',
      );
    }
    this.#waitTimeSeconds = waitTimeSeconds;
  }

  async enqueue<TPayload>(input: {
    readonly availableAt?: Date;
    readonly correlationId?: string;
    readonly id: string;
    readonly maximumAttempts?: number;
    readonly name: string;
    readonly payload: TPayload;
    readonly traceParent?: string;
  }): Promise<{readonly status: 'created' | 'duplicate'}> {
    const maximumAttempts = input.maximumAttempts ?? MVP_JOB_QUEUE_POLICY.maximumAttempts;
    if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1) {
      throw new QueueCapabilityError('A job must allow at least one delivery attempt.');
    }
    const now = this.#now();
    const requestedAvailableAt = input.availableAt ?? now;
    if (Number.isNaN(requestedAvailableAt.getTime())) {
      throw new QueueCapabilityError('A job availability timestamp must be valid.');
    }
    const delaySeconds = secondsCeiling(requestedAvailableAt.getTime() - now.getTime());
    if (delaySeconds * 1_000 > MVP_JOB_QUEUE_POLICY.maximumEnqueueDelayMs) {
      throw new QueueCapabilityError('Amazon SQS supports enqueue delays of at most 15 minutes.');
    }
    const job: Job = {
      availableAt: new Date(now.getTime() + delaySeconds * 1_000),
      enqueuedAt: new Date(now),
      id: input.id,
      maximumAttempts,
      name: input.name,
      payload: cloneJson(input.payload),
      ...(input.correlationId ? {correlationId: input.correlationId} : {}),
      ...(input.traceParent ? {traceParent: input.traceParent} : {}),
    };
    await this.#client.send(
      new SendMessageCommand({
        DelaySeconds: delaySeconds,
        MessageBody: serializeSource(job),
        QueueUrl: this.#queueUrl,
      }),
    );
    this.#telemetry.enqueued({duplicate: false, queue: this.#queueName});
    return {status: 'created'};
  }

  async claim(input: {
    readonly consumerId: string;
    readonly leaseDurationMs: number;
    readonly maximumJobs: number;
  }): Promise<readonly JobDelivery[]> {
    if (input.maximumJobs <= 0) return [];
    if (!Number.isInteger(input.maximumJobs)) {
      throw new QueueCapabilityError('A claim size must be a whole number.');
    }
    if (input.maximumJobs > MVP_JOB_QUEUE_POLICY.maximumClaimBatchSize) {
      throw new QueueCapabilityError('A claim can return at most 10 jobs.');
    }
    this.#sweepExpiredLeases();
    const visibilityTimeout = visibilitySeconds(input.leaseDurationMs);
    const result = await this.#client.send(
      new ReceiveMessageCommand({
        MaxNumberOfMessages: input.maximumJobs,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'SentTimestamp'],
        QueueUrl: this.#queueUrl,
        VisibilityTimeout: visibilityTimeout,
        WaitTimeSeconds: this.#waitTimeSeconds,
      }),
    );
    const now = this.#now();
    const deliveries: JobDelivery[] = [];
    for (const message of result.Messages ?? []) {
      if (!message.Body || !message.MessageId || !message.ReceiptHandle) {
        throw new Error('Amazon SQS returned a message without a body, ID, or receipt handle.');
      }
      const job = parseSource(message.Body);
      const attempt = positiveInteger(message.Attributes?.ApproximateReceiveCount, 1);
      if (attempt > job.maximumAttempts) {
        await this.#moveToDeadLetter({
          attempts: job.maximumAttempts,
          job,
          reason: 'delivery attempts exhausted',
          receiptHandle: message.ReceiptHandle,
        });
        continue;
      }
      const deliveryId = `sqs:${message.MessageId}:${receiptDigest(message.ReceiptHandle)}`;
      const expiresAt = new Date(now.getTime() + visibilityTimeout * 1_000);
      this.#activeLeases.set(deliveryId, {
        attempt,
        expiresAt,
        job,
        receiptHandle: message.ReceiptHandle,
      });
      const delivery: JobDelivery = {
        attempt,
        deliveryId,
        job: structuredClone(job),
        leaseExpiresAt: new Date(expiresAt),
        leaseToken: message.ReceiptHandle,
      };
      deliveries.push(delivery);
      this.#telemetry.delivered({
        attempt,
        jobName: job.name,
        queue: this.#queueName,
        queueAgeMs: Math.max(0, now.getTime() - job.enqueuedAt.getTime()),
      });
    }
    return deliveries;
  }

  async acknowledge(input: {
    readonly deliveryId: string;
    readonly leaseToken: string;
  }): Promise<void> {
    const lease = this.#leased(input);
    await this.#client.send(
      new DeleteMessageCommand({QueueUrl: this.#queueUrl, ReceiptHandle: lease.receiptHandle}),
    );
    this.#activeLeases.delete(input.deliveryId);
  }

  async retry(input: {
    readonly delayMs: number;
    readonly deliveryId: string;
    readonly leaseToken: string;
    readonly reason: string;
  }): Promise<void> {
    const lease = this.#leased(input);
    if (lease.attempt >= lease.job.maximumAttempts) {
      await this.#moveToDeadLetter({
        attempts: lease.attempt,
        job: lease.job,
        reason: input.reason,
        receiptHandle: lease.receiptHandle,
      });
      this.#activeLeases.delete(input.deliveryId);
      return;
    }
    await this.#client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.#queueUrl,
        ReceiptHandle: lease.receiptHandle,
        VisibilityTimeout: visibilitySeconds(input.delayMs, true),
      }),
    );
    this.#activeLeases.delete(input.deliveryId);
  }

  async extendLease(input: {
    readonly deliveryId: string;
    readonly leaseDurationMs: number;
    readonly leaseToken: string;
  }): Promise<Date> {
    const lease = this.#leased(input);
    const durationSeconds = visibilitySeconds(input.leaseDurationMs);
    await this.#client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.#queueUrl,
        ReceiptHandle: lease.receiptHandle,
        VisibilityTimeout: durationSeconds,
      }),
    );
    lease.expiresAt = new Date(this.#now().getTime() + durationSeconds * 1_000);
    return new Date(lease.expiresAt);
  }

  async listDeadLetters(input?: {readonly maximumJobs?: number}): Promise<readonly DeadLetter[]> {
    const result = await this.#client.send(
      new ReceiveMessageCommand({
        MaxNumberOfMessages: Math.min(
          Math.max(input?.maximumJobs ?? MVP_JOB_QUEUE_POLICY.maximumClaimBatchSize, 1),
          MVP_JOB_QUEUE_POLICY.maximumClaimBatchSize,
        ),
        MessageSystemAttributeNames: [
          'ApproximateFirstReceiveTimestamp',
          'ApproximateReceiveCount',
        ],
        QueueUrl: this.#deadLetterQueueUrl,
        VisibilityTimeout: 0,
        WaitTimeSeconds: 0,
      }),
    );
    const deadLetters: DeadLetter[] = [];
    for (const message of result.Messages ?? []) {
      if (!message.Body || !message.MessageId || !message.ReceiptHandle) continue;
      const deadLetter = parseDeadLetter(
        message.Body,
        message.MessageId,
        message.Attributes?.ApproximateFirstReceiveTimestamp,
      );
      this.#listedDeadLetters.set(deadLetter.id, {
        deadLetter,
        receiptHandle: message.ReceiptHandle,
      });
      if (this.#listedDeadLetters.size > MAXIMUM_TRACKED_DEAD_LETTERS) {
        const oldestId = this.#listedDeadLetters.keys().next().value;
        if (oldestId) this.#listedDeadLetters.delete(oldestId);
      }
      deadLetters.push(structuredClone(deadLetter));
    }
    return deadLetters;
  }

  async redrive(input: {readonly deadLetterId: string}): Promise<void> {
    const listed = this.#listedDeadLetters.get(input.deadLetterId);
    if (!listed) throw new DeadLetterNotFoundError(input.deadLetterId);
    const job: Job = {
      ...structuredClone(listed.deadLetter.job),
      availableAt: this.#now(),
    };
    await this.#client.send(
      new SendMessageCommand({MessageBody: serializeSource(job), QueueUrl: this.#queueUrl}),
    );
    await this.#client.send(
      new DeleteMessageCommand({
        QueueUrl: this.#deadLetterQueueUrl,
        ReceiptHandle: listed.receiptHandle,
      }),
    );
    this.#listedDeadLetters.delete(input.deadLetterId);
  }

  async health(): Promise<QueueHealth> {
    const checkedAt = this.#now();
    try {
      await this.#client.send(
        new GetQueueAttributesCommand({AttributeNames: ['QueueArn'], QueueUrl: this.#queueUrl}),
      );
    } catch (error) {
      return {
        checkedAt,
        detail: error instanceof Error ? error.message : 'Amazon SQS readiness check failed.',
        status: 'unavailable',
      };
    }
    let oldestJobAgeMs: number | undefined;
    try {
      oldestJobAgeMs = await this.#getOldestJobAgeMs?.();
    } catch {
      oldestJobAgeMs = undefined;
    }
    return {
      checkedAt,
      status: 'ready',
      ...(oldestJobAgeMs === undefined
        ? {}
        : {
            oldestAvailableAt: new Date(checkedAt.getTime() - oldestJobAgeMs),
            oldestJobAgeMs,
          }),
    };
  }

  #leased(input: {readonly deliveryId: string; readonly leaseToken: string}): ActiveLease {
    const lease = this.#activeLeases.get(input.deliveryId);
    if (lease && lease.expiresAt.getTime() <= this.#now().getTime()) {
      this.#activeLeases.delete(input.deliveryId);
      throw new StaleDeliveryError(input.deliveryId);
    }
    if (!lease || lease.receiptHandle !== input.leaseToken) {
      throw new StaleDeliveryError(input.deliveryId);
    }
    return lease;
  }

  #sweepExpiredLeases(): void {
    const now = this.#now().getTime();
    for (const [deliveryId, lease] of this.#activeLeases) {
      if (lease.expiresAt.getTime() <= now) this.#activeLeases.delete(deliveryId);
    }
  }

  async #moveToDeadLetter(input: {
    readonly attempts: number;
    readonly job: Job;
    readonly reason: string;
    readonly receiptHandle: string;
  }): Promise<void> {
    const failedAt = this.#now();
    const envelope: DeadLetterEnvelope = {
      deadLetter: {
        attempts: input.attempts,
        failedAt: failedAt.toISOString(),
        job: serializeJob(input.job),
        reason: input.reason,
      },
      schemaVersion: 1,
    };
    await this.#client.send(
      new SendMessageCommand({
        MessageBody: JSON.stringify(envelope),
        QueueUrl: this.#deadLetterQueueUrl,
      }),
    );
    await this.#client.send(
      new DeleteMessageCommand({QueueUrl: this.#queueUrl, ReceiptHandle: input.receiptHandle}),
    );
    this.#telemetry.deadLettered({jobName: input.job.name, queue: this.#queueName});
  }
}

function secondsCeiling(milliseconds: number): number {
  return Math.max(0, Math.ceil(milliseconds / 1_000));
}

function visibilitySeconds(milliseconds: number, allowZero = false): number {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new QueueCapabilityError('Amazon SQS visibility must be finite and non-negative.');
  }
  const seconds = secondsCeiling(milliseconds);
  if ((!allowZero && seconds === 0) || seconds * 1_000 > MVP_JOB_QUEUE_POLICY.maximumVisibilityMs) {
    throw new QueueCapabilityError('Amazon SQS visibility must be between 1 second and 12 hours.');
  }
  return seconds;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function receiptDigest(receiptHandle: string): string {
  return createHash('sha256').update(receiptHandle).digest('hex').slice(0, 16);
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

function serializeJob(job: Job): SerializedJob {
  return {
    availableAt: job.availableAt.toISOString(),
    enqueuedAt: job.enqueuedAt.toISOString(),
    id: job.id,
    maximumAttempts: job.maximumAttempts,
    name: job.name,
    payload: cloneJson(job.payload),
    ...(job.correlationId ? {correlationId: job.correlationId} : {}),
    ...(job.traceParent ? {traceParent: job.traceParent} : {}),
  };
}

function serializeSource(job: Job): string {
  const envelope: SourceEnvelope = {job: serializeJob(job), schemaVersion: 1};
  return JSON.stringify(envelope);
}

function parseSource(body: string): Job {
  const envelope = JSON.parse(body) as Partial<SourceEnvelope>;
  if (envelope.schemaVersion !== 1 || !envelope.job) {
    throw new Error('Unsupported Amazon SQS job envelope.');
  }
  return parseJob(envelope.job);
}

function parseJob(job: SerializedJob): Job {
  if (
    typeof job.id !== 'string' ||
    typeof job.name !== 'string' ||
    !Number.isInteger(job.maximumAttempts) ||
    job.maximumAttempts < 1
  ) {
    throw new Error('Invalid Amazon SQS job envelope.');
  }
  const enqueuedAt = new Date(job.enqueuedAt);
  const availableAt = new Date(job.availableAt);
  if (Number.isNaN(enqueuedAt.getTime()) || Number.isNaN(availableAt.getTime())) {
    throw new Error('Invalid Amazon SQS job timestamps.');
  }
  return {
    availableAt,
    enqueuedAt,
    id: job.id,
    maximumAttempts: job.maximumAttempts,
    name: job.name,
    payload: cloneJson(job.payload),
    ...(job.correlationId ? {correlationId: job.correlationId} : {}),
    ...(job.traceParent ? {traceParent: job.traceParent} : {}),
  };
}

function parseDeadLetter(
  body: string,
  messageId: string,
  firstReceivedTimestamp: string | undefined,
): DeadLetter {
  const envelope = JSON.parse(body) as Partial<SourceEnvelope & DeadLetterEnvelope>;
  if (envelope.deadLetter) {
    return {
      attempts: envelope.deadLetter.attempts,
      failedAt: new Date(envelope.deadLetter.failedAt),
      id: `dead-letter:${messageId}`,
      job: parseJob(envelope.deadLetter.job),
      reason: envelope.deadLetter.reason,
    };
  }
  if (envelope.job) {
    const job = parseJob(envelope.job);
    const firstReceivedAt = Number.parseInt(firstReceivedTimestamp ?? '', 10);
    return {
      attempts: job.maximumAttempts,
      failedAt: new Date(Number.isFinite(firstReceivedAt) ? firstReceivedAt : job.enqueuedAt),
      id: `dead-letter:${messageId}`,
      job,
      reason: 'delivery attempts exhausted',
    };
  }
  throw new Error('Unsupported Amazon SQS dead-letter envelope.');
}
