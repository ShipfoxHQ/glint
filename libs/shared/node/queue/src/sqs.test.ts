import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {describe, expect, it, vi} from '@shipfox/vitest/vi';
import {jobQueueContractTests} from './contract-test-kit.js';
import {SqsJobQueue} from './sqs.js';

const sourceQueueUrl = 'https://sqs.eu-central-1.amazonaws.com/123/glint';
const deadLetterQueueUrl = `${sourceQueueUrl}-dead`;

interface FakeMessage {
  readonly body: string;
  deleted: boolean;
  readonly id: string;
  receiptHandle?: string;
  receiveCount: number;
  visibleAt: number;
}

class FakeSqsClient {
  readonly queues = new Map<string, FakeMessage[]>([
    [sourceQueueUrl, []],
    [deadLetterQueueUrl, []],
  ]);
  available = true;
  #nextMessageId = 1;
  #nextReceiptHandle = 1;

  constructor(private readonly clock: () => number) {}

  async send(command: unknown): Promise<Record<string, unknown>> {
    await Promise.resolve();
    if (command instanceof SendMessageCommand) {
      const queue = this.#queue(command.input.QueueUrl);
      queue.push({
        body: command.input.MessageBody ?? '',
        deleted: false,
        id: `message-${this.#nextMessageId++}`,
        receiveCount: 0,
        visibleAt: this.clock() + (command.input.DelaySeconds ?? 0) * 1_000,
      });
      return {};
    }
    if (command instanceof ReceiveMessageCommand) {
      const queue = this.#queue(command.input.QueueUrl);
      const messages = queue
        .filter((message) => !message.deleted && message.visibleAt <= this.clock())
        .slice(0, command.input.MaxNumberOfMessages ?? 1)
        .map((message) => {
          message.receiveCount += 1;
          message.receiptHandle = `receipt-${this.#nextReceiptHandle++}`;
          message.visibleAt = this.clock() + (command.input.VisibilityTimeout ?? 30) * 1_000;
          return {
            Attributes: {
              ApproximateFirstReceiveTimestamp: String(this.clock()),
              ApproximateReceiveCount: String(message.receiveCount),
              SentTimestamp: String(this.clock()),
            },
            Body: message.body,
            MessageId: message.id,
            ReceiptHandle: message.receiptHandle,
          };
        });
      return {Messages: messages};
    }
    if (command instanceof DeleteMessageCommand) {
      const message = this.#message(command.input.QueueUrl, command.input.ReceiptHandle);
      message.deleted = true;
      return {};
    }
    if (command instanceof ChangeMessageVisibilityCommand) {
      const message = this.#message(command.input.QueueUrl, command.input.ReceiptHandle);
      message.visibleAt = this.clock() + (command.input.VisibilityTimeout ?? 0) * 1_000;
      return {};
    }
    if (command instanceof GetQueueAttributesCommand) {
      if (!this.available) throw new Error('SQS unavailable');
      this.#queue(command.input.QueueUrl);
      return {Attributes: {QueueArn: 'arn:aws:sqs:eu-central-1:123:glint'}};
    }
    throw new Error(`Unsupported SQS command: ${String(command)}`);
  }

  oldestVisibleAgeMs(): number | undefined {
    const oldest = this.#queue(sourceQueueUrl)
      .filter((message) => !message.deleted && message.visibleAt <= this.clock())
      .map((message) => {
        const parsed = JSON.parse(message.body) as {job?: {enqueuedAt?: string}};
        return parsed.job?.enqueuedAt ? Date.parse(parsed.job.enqueuedAt) : this.clock();
      })
      .sort((left, right) => left - right)[0];
    return oldest === undefined ? undefined : this.clock() - oldest;
  }

  #message(queueUrl: string | undefined, receiptHandle: string | undefined): FakeMessage {
    const message = this.#queue(queueUrl).find(
      (candidate) => !candidate.deleted && candidate.receiptHandle === receiptHandle,
    );
    if (!message) throw new Error('ReceiptHandleIsInvalid');
    return message;
  }

  #queue(queueUrl: string | undefined): FakeMessage[] {
    const queue = queueUrl ? this.queues.get(queueUrl) : undefined;
    if (!queue) throw new Error(`Unknown queue URL: ${queueUrl}`);
    return queue;
  }
}

function createHarness() {
  let now = Date.UTC(2030, 0, 1);
  const client = new FakeSqsClient(() => now);
  return {
    client,
    queue: new SqsJobQueue({
      client: client as unknown as SQSClient,
      deadLetterQueueUrl,
      getOldestJobAgeMs: () => Promise.resolve(client.oldestVisibleAgeMs()),
      now: () => new Date(now),
      queueUrl: sourceQueueUrl,
    }),
    advanceBy: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

jobQueueContractTests('Amazon SQS Standard', createHarness);

describe('Amazon SQS adapter', () => {
  it('propagates correlation and W3C trace context in the provider-neutral job envelope', async () => {
    const {queue} = createHarness();
    await queue.enqueue({
      correlationId: 'build-1',
      id: 'job-1',
      name: 'verify',
      payload: {},
      traceParent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
    const [delivery] = await queue.claim({
      consumerId: 'worker',
      leaseDurationMs: 90_000,
      maximumJobs: 1,
    });
    expect(delivery?.job).toMatchObject({
      correlationId: 'build-1',
      traceParent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
  });

  it('reports an unavailable dependency without throwing from readiness', async () => {
    const {client, queue} = createHarness();
    client.available = false;
    await expect(queue.health()).resolves.toMatchObject({
      detail: 'SQS unavailable',
      status: 'unavailable',
    });
  });

  it('keeps queue readiness available when the supplementary age reader fails', async () => {
    const {client} = createHarness();
    const queue = new SqsJobQueue({
      client: client as unknown as SQSClient,
      deadLetterQueueUrl,
      getOldestJobAgeMs: () => Promise.reject(new Error('CloudWatch unavailable')),
      queueUrl: sourceQueueUrl,
    });
    await expect(queue.health()).resolves.toMatchObject({status: 'ready'});
  });

  it('rejects schedules beyond the managed queue capability', async () => {
    const {queue} = createHarness();
    await expect(
      queue.enqueue({
        availableAt: new Date(Date.UTC(2030, 0, 1, 0, 16)),
        id: 'job-1',
        name: 'verify',
        payload: {},
      }),
    ).rejects.toMatchObject({code: 'queue_capability'});
  });

  it('reports SQS enqueue, delivery age, and explicit dead-letter telemetry', async () => {
    let now = Date.UTC(2030, 0, 1);
    const client = new FakeSqsClient(() => now);
    const telemetry = {
      deadLettered: vi.fn(),
      delivered: vi.fn(),
      enqueued: vi.fn(),
    };
    const queue = new SqsJobQueue({
      client: client as unknown as SQSClient,
      deadLetterQueueUrl,
      now: () => new Date(now),
      queueName: 'jobs',
      queueUrl: sourceQueueUrl,
      telemetry,
    });
    await queue.enqueue({id: 'job-1', maximumAttempts: 1, name: 'verify', payload: {}});
    now += 250;
    const [delivery] = await queue.claim({
      consumerId: 'worker',
      leaseDurationMs: 1_000,
      maximumJobs: 1,
    });
    if (!delivery) throw new Error('Expected delivery');
    await queue.retry({...delivery, delayMs: 0, reason: 'permanent'});

    expect(telemetry.enqueued).toHaveBeenCalledWith({duplicate: false, queue: 'jobs'});
    expect(telemetry.delivered).toHaveBeenCalledWith({
      attempt: 1,
      jobName: 'verify',
      queue: 'jobs',
      queueAgeMs: 250,
    });
    expect(telemetry.deadLettered).toHaveBeenCalledWith({jobName: 'verify', queue: 'jobs'});
  });

  it('fails cross-process per-message redrive instead of reporting false success', async () => {
    const {client, queue} = createHarness();
    await queue.enqueue({id: 'job-1', maximumAttempts: 1, name: 'verify', payload: {}});
    const [delivery] = await queue.claim({
      consumerId: 'worker',
      leaseDurationMs: 1_000,
      maximumJobs: 1,
    });
    if (!delivery) throw new Error('Expected delivery');
    await queue.retry({...delivery, delayMs: 0, reason: 'permanent'});
    const [deadLetter] = await queue.listDeadLetters();
    if (!deadLetter) throw new Error('Expected dead letter');

    const otherProcess = new SqsJobQueue({
      client: client as unknown as SQSClient,
      deadLetterQueueUrl,
      queueUrl: sourceQueueUrl,
    });
    await expect(otherProcess.redrive({deadLetterId: deadLetter.id})).rejects.toMatchObject({
      code: 'dead_letter_not_found',
    });
  });

  it('rejects non-JSON payloads and malformed queue envelopes explicitly', async () => {
    const {client, queue} = createHarness();
    const payload: {self?: unknown} = {};
    payload.self = payload;
    await expect(queue.enqueue({id: 'job-1', name: 'verify', payload})).rejects.toMatchObject({
      code: 'queue_capability',
    });
    client.queues.get(sourceQueueUrl)?.push({
      body: '{}',
      deleted: false,
      id: 'invalid',
      receiveCount: 0,
      visibleAt: Date.UTC(2030, 0, 1),
    });
    await expect(
      queue.claim({consumerId: 'worker', leaseDurationMs: 1_000, maximumJobs: 1}),
    ).rejects.toThrow('Unsupported Amazon SQS job envelope');
  });
});
