import type {Database} from '@glint/node-database';
import {describe, expect, it} from '@shipfox/vitest/vi';
import type {TransactionalOutbox} from './types.js';

export interface OutboxContractHarness {
  readonly database: Database;
  readonly maxAttempts: number;
  readonly outbox: TransactionalOutbox;
  advanceBy(milliseconds: number): Promise<void> | void;
}

const event = {
  id: 'event-1',
  topic: 'build.finalized.v1',
  payload: {buildId: 'build-1'},
  occurredAt: new Date('2030-01-01T00:00:00Z'),
};

export function transactionalOutboxContractTests(
  name: string,
  createHarness: () => Promise<OutboxContractHarness> | OutboxContractHarness,
): void {
  describe(`${name} transactional-outbox contract`, () => {
    it('commits an event atomically with its surrounding database transaction', async () => {
      const {database, outbox} = await createHarness();
      await database.transaction((transaction) => outbox.append(transaction, event));
      await expect(
        outbox.claim({dispatcherId: 'dispatcher', maximumEvents: 1, leaseDurationMs: 1_000}),
      ).resolves.toHaveLength(1);
    });

    it('does not publish an event from a rolled-back transaction', async () => {
      const {database, outbox} = await createHarness();
      await expect(
        database.transaction(async (transaction) => {
          await outbox.append(transaction, event);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      await expect(
        outbox.claim({dispatcherId: 'dispatcher', maximumEvents: 1, leaseDurationMs: 1_000}),
      ).resolves.toEqual([]);
    });

    it('deduplicates event identity and redelivers after lease expiry', async () => {
      const {database, outbox, advanceBy} = await createHarness();
      await database.transaction(async (transaction) => {
        await expect(outbox.append(transaction, event)).resolves.toEqual({status: 'created'});
        await expect(outbox.append(transaction, event)).resolves.toEqual({status: 'duplicate'});
      });
      const [first] = await outbox.claim({
        dispatcherId: 'first',
        maximumEvents: 1,
        leaseDurationMs: 1_000,
      });
      await advanceBy(1_001);
      const [second] = await outbox.claim({
        dispatcherId: 'second',
        maximumEvents: 1,
        leaseDurationMs: 1_000,
      });
      expect(second?.event.id).toBe(first?.event.id);
      expect(second?.attempts).toBe(2);
    });

    it('acknowledges successful dispatch and exposes provider-neutral health', async () => {
      const {database, outbox, advanceBy} = await createHarness();
      await database.transaction((transaction) => outbox.append(transaction, event));
      await advanceBy(250);
      await expect(outbox.health()).resolves.toMatchObject({status: 'ready'});
      const [delivery] = await outbox.claim({
        dispatcherId: 'dispatcher',
        maximumEvents: 1,
        leaseDurationMs: 1_000,
      });
      if (!delivery) throw new Error('Expected an outbox delivery');
      await expect(outbox.acknowledge(delivery)).resolves.toEqual({status: 'acknowledged'});
      await expect(
        outbox.claim({dispatcherId: 'dispatcher', maximumEvents: 1, leaseDurationMs: 1_000}),
      ).resolves.toEqual([]);
    });

    it('ignores an out-of-order acknowledgement from an expired lease', async () => {
      const {database, outbox, advanceBy} = await createHarness();
      await database.transaction((transaction) => outbox.append(transaction, event));
      const [first] = await outbox.claim({
        dispatcherId: 'first',
        maximumEvents: 1,
        leaseDurationMs: 1_000,
      });
      if (!first) throw new Error('Expected a first delivery');
      await advanceBy(1_001);
      const [second] = await outbox.claim({
        dispatcherId: 'second',
        maximumEvents: 1,
        leaseDurationMs: 1_000,
      });
      if (!second) throw new Error('Expected a replacement delivery');

      await expect(outbox.acknowledge(first)).resolves.toEqual({status: 'stale'});
      await expect(
        outbox.retry({...first, delayMs: 100, failure: new Error('late retry')}),
      ).resolves.toEqual({status: 'stale'});
      await expect(outbox.acknowledge(second)).resolves.toEqual({status: 'acknowledged'});
    });

    it('schedules a retry without making the event visible early', async () => {
      const {database, outbox, advanceBy} = await createHarness();
      await database.transaction((transaction) => outbox.append(transaction, event));
      const [delivery] = await outbox.claim({
        dispatcherId: 'dispatcher',
        maximumEvents: 1,
        leaseDurationMs: 1_000,
      });
      if (!delivery) throw new Error('Expected an outbox delivery');

      await expect(
        outbox.retry({...delivery, delayMs: 500, failure: new Error('temporary')}),
      ).resolves.toMatchObject({status: 'retry-scheduled'});
      await expect(
        outbox.claim({dispatcherId: 'early', maximumEvents: 1, leaseDurationMs: 1_000}),
      ).resolves.toEqual([]);
      await advanceBy(500);
      const [retried] = await outbox.claim({
        dispatcherId: 'retry',
        maximumEvents: 1,
        leaseDurationMs: 1_000,
      });
      expect(retried?.attempts).toBe(2);
    });

    it('dead-letters an event after the bounded attempt count', async () => {
      const {database, maxAttempts, outbox} = await createHarness();
      await database.transaction((transaction) => outbox.append(transaction, event));

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const [delivery] = await outbox.claim({
          dispatcherId: `dispatcher-${attempt}`,
          maximumEvents: 1,
          leaseDurationMs: 1_000,
        });
        if (!delivery) throw new Error(`Expected delivery attempt ${attempt}`);
        const result = await outbox.retry({...delivery, delayMs: 0, failure: new Error('poison')});
        expect(result.status).toBe(attempt === maxAttempts ? 'dead-lettered' : 'retry-scheduled');
      }

      await expect(
        outbox.claim({dispatcherId: 'final', maximumEvents: 1, leaseDurationMs: 1_000}),
      ).resolves.toEqual([]);
    });
  });
}
