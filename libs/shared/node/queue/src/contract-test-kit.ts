import {describe, expect, it} from '@shipfox/vitest/vi';
import type {JobQueue} from './types.js';
import {MVP_JOB_QUEUE_POLICY} from './types.js';

export interface QueueContractHarness {
  readonly queue: JobQueue;
  advanceBy(milliseconds: number): Promise<void> | void;
}

const claimOne = async (queue: JobQueue, consumerId = 'consumer') => {
  const [delivery] = await queue.claim({
    consumerId,
    maximumJobs: 1,
    leaseDurationMs: MVP_JOB_QUEUE_POLICY.visibilityTimeoutMs,
  });
  if (!delivery) throw new Error('Expected one delivery');
  return delivery;
};

export function jobQueueContractTests(
  name: string,
  createHarness: () => Promise<QueueContractHarness> | QueueContractHarness,
): void {
  describe(`${name} job-queue contract`, () => {
    it('preserves deterministic identity when the same job is delivered more than once', async () => {
      const {queue} = await createHarness();
      await expect(
        queue.enqueue({id: 'job-1', name: 'verify', payload: {version: 1}}),
      ).resolves.toEqual({status: 'created'});
      await expect(
        queue.enqueue({id: 'job-1', name: 'verify', payload: {version: 1}}),
      ).resolves.toMatchObject({status: expect.stringMatching(/created|duplicate/)});
      const deliveries = await queue.claim({
        consumerId: 'consumer',
        maximumJobs: 2,
        leaseDurationMs: MVP_JOB_QUEUE_POLICY.visibilityTimeoutMs,
      });
      expect(deliveries.map(({job}) => job.id)).toEqual(['job-1', 'job-1']);
      expect(deliveries.map(({job}) => job.payload)).toEqual([{version: 1}, {version: 1}]);
    });

    it('acknowledges a delivery exactly once', async () => {
      const {queue, advanceBy} = await createHarness();
      await queue.enqueue({id: 'job-1', name: 'verify', payload: {}});
      const delivery = await claimOne(queue);
      await queue.acknowledge(delivery);
      await advanceBy(2_000);
      await expect(
        queue.claim({consumerId: 'other', maximumJobs: 1, leaseDurationMs: 1_000}),
      ).resolves.toEqual([]);
    });

    it('never returns more jobs than the requested claim bound', async () => {
      const {queue} = await createHarness();
      await Promise.all(
        ['job-1', 'job-2', 'job-3'].map((id) => queue.enqueue({id, name: 'verify', payload: {}})),
      );

      await expect(
        queue.claim({
          consumerId: 'bounded',
          maximumJobs: 2,
          leaseDurationMs: MVP_JOB_QUEUE_POLICY.visibilityTimeoutMs,
        }),
      ).resolves.toHaveLength(2);
    });

    it('rejects invalid attempts, schedules, leases, retries, and claim sizes consistently', async () => {
      const {queue} = await createHarness();
      await expect(
        queue.enqueue({id: 'invalid-attempts', maximumAttempts: 0, name: 'verify', payload: {}}),
      ).rejects.toMatchObject({code: 'queue_capability'});
      await expect(
        queue.enqueue({
          id: 'fractional-attempts',
          maximumAttempts: 1.5,
          name: 'verify',
          payload: {},
        }),
      ).rejects.toMatchObject({code: 'queue_capability'});
      await expect(
        queue.enqueue({
          availableAt: new Date(Number.NaN),
          id: 'invalid-date',
          name: 'verify',
          payload: {},
        }),
      ).rejects.toMatchObject({code: 'queue_capability'});
      await expect(
        queue.enqueue({
          availableAt: new Date(Date.UTC(2030, 0, 1, 0, 16)),
          id: 'invalid-delay',
          name: 'verify',
          payload: {},
        }),
      ).rejects.toMatchObject({code: 'queue_capability'});
      await expect(
        queue.claim({consumerId: 'consumer', leaseDurationMs: 0, maximumJobs: 1}),
      ).rejects.toMatchObject({code: 'queue_capability'});
      await expect(
        queue.claim({consumerId: 'consumer', leaseDurationMs: Number.NaN, maximumJobs: 1}),
      ).rejects.toMatchObject({code: 'queue_capability'});
      await expect(
        queue.claim({consumerId: 'consumer', leaseDurationMs: 1_000, maximumJobs: 11}),
      ).rejects.toMatchObject({code: 'queue_capability'});
      await expect(
        queue.claim({
          consumerId: 'consumer',
          leaseDurationMs: MVP_JOB_QUEUE_POLICY.maximumVisibilityMs + 1,
          maximumJobs: 1,
        }),
      ).rejects.toMatchObject({code: 'queue_capability'});

      const cyclicPayload: {self?: unknown} = {};
      cyclicPayload.self = cyclicPayload;
      await expect(
        queue.enqueue({id: 'invalid-payload', name: 'verify', payload: cyclicPayload}),
      ).rejects.toMatchObject({code: 'queue_capability'});

      await queue.enqueue({id: 'job-1', name: 'verify', payload: {}});
      const delivery = await claimOne(queue);
      await expect(
        queue.retry({...delivery, delayMs: -1, reason: 'invalid'}),
      ).rejects.toMatchObject({
        code: 'queue_capability',
      });
      await expect(
        queue.retry({...delivery, delayMs: Number.NaN, reason: 'invalid'}),
      ).rejects.toMatchObject({code: 'queue_capability'});
      await expect(
        queue.extendLease({...delivery, leaseDurationMs: Number.NaN}),
      ).rejects.toMatchObject({code: 'queue_capability'});
    });

    it('keeps an active lease exclusive to its consumer', async () => {
      const {queue} = await createHarness();
      await queue.enqueue({id: 'job-1', name: 'verify', payload: {}});
      await claimOne(queue, 'first');

      await expect(
        queue.claim({
          consumerId: 'second',
          maximumJobs: 1,
          leaseDurationMs: MVP_JOB_QUEUE_POLICY.visibilityTimeoutMs,
        }),
      ).resolves.toEqual([]);
    });

    it('extends a lease relative to now and redelivers after the extension expires', async () => {
      const {queue, advanceBy} = await createHarness();
      await queue.enqueue({id: 'job-1', name: 'verify', payload: {}});
      const delivery = await claimOne(queue);
      await advanceBy(1_000);
      const extendedUntil = await queue.extendLease({
        ...delivery,
        leaseDurationMs: 2_000,
      });
      await advanceBy(1_999);
      await expect(
        queue.claim({consumerId: 'early', maximumJobs: 1, leaseDurationMs: 1_000}),
      ).resolves.toEqual([]);
      await advanceBy(1);
      expect((await claimOne(queue, 'replacement')).attempt).toBe(2);
      expect(extendedUntil.getTime()).toBe(Date.UTC(2030, 0, 1, 0, 0, 3));
    });

    it('redelivers after an unacknowledged lease expires', async () => {
      const {queue, advanceBy} = await createHarness();
      await queue.enqueue({id: 'job-1', name: 'verify', payload: {}, correlationId: 'build-1'});
      const first = await claimOne(queue);
      await advanceBy(MVP_JOB_QUEUE_POLICY.visibilityTimeoutMs + 1);
      const second = await claimOne(queue, 'replacement');
      expect(second.job.id).toBe(first.job.id);
      expect(second.job.correlationId).toBe('build-1');
      expect(second.attempt).toBe(2);
      expect(second.deliveryId).not.toBe(first.deliveryId);
      await expect(queue.acknowledge(first)).rejects.toMatchObject({code: 'stale_delivery'});
      await expect(queue.retry({...first, delayMs: 0, reason: 'stale'})).rejects.toMatchObject({
        code: 'stale_delivery',
      });
      await expect(queue.extendLease({...first, leaseDurationMs: 1_000})).rejects.toMatchObject({
        code: 'stale_delivery',
      });
    });

    it('dead-letters a repeatedly crashing job after the configured attempt bound', async () => {
      const {queue, advanceBy} = await createHarness();
      await queue.enqueue({id: 'job-1', maximumAttempts: 2, name: 'verify', payload: {}});
      await claimOne(queue, 'first');
      await advanceBy(MVP_JOB_QUEUE_POLICY.visibilityTimeoutMs + 1);
      await claimOne(queue, 'second');
      await advanceBy(MVP_JOB_QUEUE_POLICY.visibilityTimeoutMs + 1);
      await expect(
        queue.claim({
          consumerId: 'third',
          leaseDurationMs: MVP_JOB_QUEUE_POLICY.visibilityTimeoutMs,
          maximumJobs: 1,
        }),
      ).resolves.toEqual([]);
      await expect(queue.listDeadLetters()).resolves.toEqual([
        expect.objectContaining({attempts: 2, reason: 'delivery attempts exhausted'}),
      ]);
    });

    it('defensively copies mutable scheduling and lease timestamps', async () => {
      const {queue, advanceBy} = await createHarness();
      const availableAt = new Date(Date.UTC(2030, 0, 1));
      await queue.enqueue({id: 'job-1', name: 'verify', payload: {}, availableAt});
      availableAt.setUTCFullYear(2040);

      const delivery = await claimOne(queue);
      delivery.leaseExpiresAt.setUTCFullYear(2000);
      await advanceBy(1);
      await expect(
        queue.claim({
          consumerId: 'second',
          maximumJobs: 1,
          leaseDurationMs: MVP_JOB_QUEUE_POLICY.visibilityTimeoutMs,
        }),
      ).resolves.toEqual([]);
    });

    it('applies retry delays and moves exhausted work to a redrivable dead letter', async () => {
      const {queue, advanceBy} = await createHarness();
      await queue.enqueue({id: 'job-1', name: 'verify', payload: {}, maximumAttempts: 2});
      const first = await claimOne(queue);
      await queue.retry({...first, delayMs: 1_000, reason: 'temporary'});
      await expect(
        queue.claim({consumerId: 'early', maximumJobs: 1, leaseDurationMs: 1_000}),
      ).resolves.toEqual([]);
      await advanceBy(1_000);
      const second = await claimOne(queue);
      await queue.retry({...second, delayMs: 0, reason: 'permanent'});
      const [deadLetter] = await queue.listDeadLetters();
      expect(deadLetter).toMatchObject({attempts: 2, reason: 'permanent'});
      if (!deadLetter) throw new Error('Expected a dead letter');
      await queue.redrive({deadLetterId: deadLetter.id});
      expect((await claimOne(queue)).attempt).toBe(1);
      await expect(queue.redrive({deadLetterId: 'missing'})).rejects.toMatchObject({
        code: 'dead_letter_not_found',
      });
    });

    it('reports provider-neutral readiness and queue age', async () => {
      const {queue, advanceBy} = await createHarness();
      await queue.enqueue({id: 'job-1', name: 'verify', payload: {}});
      await advanceBy(250);
      await expect(queue.health()).resolves.toMatchObject({status: 'ready', oldestJobAgeMs: 250});
    });

    it('does not promise enqueue ordering for delayed work', async () => {
      const {queue, advanceBy} = await createHarness();
      const delayedUntil = new Date(Date.UTC(2030, 0, 1, 0, 0, 1));
      await queue.enqueue({id: 'delayed', name: 'verify', payload: {}, availableAt: delayedUntil});
      await queue.enqueue({id: 'ready', name: 'verify', payload: {}});
      expect((await claimOne(queue)).job.id).toBe('ready');
      await advanceBy(1_000);
      expect((await claimOne(queue)).job.id).toBe('delayed');
    });
  });
}
