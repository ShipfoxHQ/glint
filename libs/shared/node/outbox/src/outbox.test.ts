import {InMemoryDatabase} from '@glint/node-database';
import {expect, it} from '@shipfox/vitest/vi';
import {transactionalOutboxContractTests} from './contract-test-kit.js';
import {InMemoryTransactionalOutbox} from './in-memory.js';

transactionalOutboxContractTests('in-memory', () => {
  let now = Date.parse('2030-01-01T00:00:00Z');
  const database = new InMemoryDatabase();
  return {
    database,
    outbox: new InMemoryTransactionalOutbox(database, () => new Date(now)),
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
  const firstOutbox = new InMemoryTransactionalOutbox(database, () => now, ids);
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

  const secondOutbox = new InMemoryTransactionalOutbox(database, () => now, ids);
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
