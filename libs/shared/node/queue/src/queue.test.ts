import {describe, expect, it, vi} from '@shipfox/vitest/vi';
import {jobQueueContractTests} from './contract-test-kit.js';
import {InMemoryJobQueue} from './in-memory.js';

jobQueueContractTests('in-memory', () => {
  let now = Date.UTC(2030, 0, 1);
  return {
    queue: new InMemoryJobQueue(() => new Date(now)),
    advanceBy: (milliseconds) => {
      now += milliseconds;
    },
  };
});

describe('queue telemetry', () => {
  it('reports enqueue, delivery age, redelivery, and dead-letter transitions', async () => {
    let now = Date.UTC(2030, 0, 1);
    const telemetry = {
      deadLettered: vi.fn(),
      delivered: vi.fn(),
      enqueued: vi.fn(),
    };
    const queue = new InMemoryJobQueue(() => new Date(now), telemetry);
    await queue.enqueue({id: 'job-1', maximumAttempts: 2, name: 'verify', payload: {}});
    now += 250;
    const [first] = await queue.claim({consumerId: 'one', leaseDurationMs: 1_000, maximumJobs: 1});
    if (!first) throw new Error('Expected first delivery');
    now += 1_001;
    const [second] = await queue.claim({consumerId: 'two', leaseDurationMs: 1_000, maximumJobs: 1});
    if (!second) throw new Error('Expected second delivery');
    await queue.retry({...second, delayMs: 0, reason: 'permanent'});

    expect(telemetry.enqueued).toHaveBeenCalledWith({duplicate: false, queue: 'in-memory'});
    expect(telemetry.delivered).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({attempt: 1, queueAgeMs: 250}),
    );
    expect(telemetry.delivered).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({attempt: 2, queueAgeMs: 1_251}),
    );
    expect(telemetry.deadLettered).toHaveBeenCalledWith({jobName: 'verify', queue: 'in-memory'});
  });
});
