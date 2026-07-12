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
    it('deduplicates deterministic job identities without replacing the first payload', async () => {
      const {queue} = await createHarness();
      await expect(
        queue.enqueue({id: 'job-1', name: 'verify', payload: {version: 1}}),
      ).resolves.toEqual({status: 'created'});
      await expect(
        queue.enqueue({id: 'job-1', name: 'verify', payload: {version: 2}}),
      ).resolves.toEqual({status: 'duplicate'});
      expect((await claimOne(queue)).job.payload).toEqual({version: 1});
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
      await queue.retry({...first, delayMs: 500, reason: 'temporary'});
      await expect(
        queue.claim({consumerId: 'early', maximumJobs: 1, leaseDurationMs: 1_000}),
      ).resolves.toEqual([]);
      await advanceBy(500);
      const second = await claimOne(queue);
      await queue.retry({...second, delayMs: 0, reason: 'permanent'});
      const [deadLetter] = await queue.listDeadLetters();
      expect(deadLetter).toMatchObject({attempts: 2, reason: 'permanent'});
      if (!deadLetter) throw new Error('Expected a dead letter');
      await queue.redrive({deadLetterId: deadLetter.id});
      expect((await claimOne(queue)).attempt).toBe(1);
    });

    it('reports provider-neutral readiness and queue age', async () => {
      const {queue, advanceBy} = await createHarness();
      await queue.enqueue({id: 'job-1', name: 'verify', payload: {}});
      await advanceBy(250);
      await expect(queue.health()).resolves.toMatchObject({status: 'ready', oldestJobAgeMs: 250});
    });
  });
}
