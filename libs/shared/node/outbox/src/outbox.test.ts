import {InMemoryDatabase} from '@glint/node-database';
import {expect, it} from '@shipfox/vitest/vi';
import {transactionalOutboxContractTests} from './contract-test-kit.js';
import {InMemoryTransactionalOutbox} from './in-memory.js';

transactionalOutboxContractTests('in-memory', () => {
  let now = Date.parse('2030-01-01T00:00:00Z');
  const database = new InMemoryDatabase();
  return {
    database,
    outbox: new InMemoryTransactionalOutbox({database, clock: () => new Date(now)}),
    advanceBy: (milliseconds) => {
      now += milliseconds;
    },
  };
});

it('keeps delivery identities unique when the outbox is recreated', async () => {
  const database = new InMemoryDatabase();
  const now = new Date('2030-01-01T00:00:00Z');
  let nextId = 1;
  const ids = () => `delivery-${nextId++}`;
  const firstOutbox = new InMemoryTransactionalOutbox({
    database,
    clock: () => now,
    createDeliveryId: ids,
  });
  await database.transaction((transaction) =>
    firstOutbox.append(transaction, {
      id: 'event-1',
      topic: 'test.v1',
      payload: {},
      occurredAt: now,
    }),
  );
  const [first] = await firstOutbox.claim({
    dispatcherId: 'first',
    maximumEvents: 1,
    leaseDurationMs: 1_000,
  });
  if (!first) throw new Error('Expected first delivery');
  await expect(firstOutbox.acknowledge(first)).resolves.toEqual({status: 'acknowledged'});

  const secondOutbox = new InMemoryTransactionalOutbox({
    database,
    clock: () => now,
    createDeliveryId: ids,
  });
  await database.transaction((transaction) =>
    secondOutbox.append(transaction, {
      id: 'event-2',
      topic: 'test.v1',
      payload: {},
      occurredAt: now,
    }),
  );
  const [second] = await secondOutbox.claim({
    dispatcherId: 'second',
    maximumEvents: 1,
    leaseDurationMs: 1_000,
  });
  if (!second) throw new Error('Expected second delivery');
  expect(second.deliveryId).not.toBe(first.deliveryId);
  await expect(secondOutbox.acknowledge(second)).resolves.toEqual({status: 'acknowledged'});
});

it('exposes pending age from in-memory state', async () => {
  const database = new InMemoryDatabase();
  let now = Date.parse('2030-01-01T00:00:00Z');
  const outbox = new InMemoryTransactionalOutbox({database, clock: () => new Date(now)});
  await database.transaction((transaction) =>
    outbox.append(transaction, {
      id: 'pending-event',
      topic: 'test.v1',
      payload: {},
      occurredAt: new Date(now),
    }),
  );

  now += 250;

  await expect(outbox.health()).resolves.toMatchObject({
    status: 'ready',
    oldestPendingAgeMs: 250,
  });
});

it('dead-letters an exhausted lease', async () => {
  const database = new InMemoryDatabase();
  let now = new Date('2030-01-01T00:00:00Z');
  const outbox = new InMemoryTransactionalOutbox({
    database,
    clock: () => now,
    maxAttempts: 1,
  });
  await database.transaction((transaction) =>
    outbox.append(transaction, {
      id: 'expired-event',
      topic: 'test.v1',
      payload: {},
      occurredAt: now,
    }),
  );
  await expect(
    outbox.claim({dispatcherId: 'first', maximumEvents: 1, leaseDurationMs: 50}),
  ).resolves.toHaveLength(1);
  now = new Date(now.getTime() + 51);
  await expect(
    outbox.claim({dispatcherId: 'second', maximumEvents: 1, leaseDurationMs: 50}),
  ).resolves.toEqual([]);
});

it('bounds in-memory retry delays like the PostgreSQL adapter', async () => {
  const database = new InMemoryDatabase();
  const now = new Date('2030-01-01T00:00:00Z');
  const outbox = new InMemoryTransactionalOutbox({
    database,
    clock: () => now,
    maxAttempts: 2,
    maxRetryDelayMs: 100,
  });
  await database.transaction((transaction) =>
    outbox.append(transaction, {
      id: 'bounded-retry',
      topic: 'test.v1',
      payload: {},
      occurredAt: now,
    }),
  );
  const [delivery] = await outbox.claim({
    dispatcherId: 'first',
    maximumEvents: 1,
    leaseDurationMs: 1_000,
  });
  if (!delivery) throw new Error('Expected bounded retry delivery');
  await expect(outbox.retry({...delivery, delayMs: 500})).resolves.toEqual({
    status: 'retry-scheduled',
    nextAttemptAt: new Date(now.getTime() + 100),
  });
});
