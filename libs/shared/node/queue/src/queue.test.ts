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
