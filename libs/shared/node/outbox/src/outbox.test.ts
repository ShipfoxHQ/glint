import {InMemoryDatabase} from '@glint/node-database';
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
