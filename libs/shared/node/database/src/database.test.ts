import {databaseContractTests} from './contract-test-kit.js';
import {InMemoryDatabase} from './in-memory.js';

databaseContractTests('in-memory', () => {
  const database = new InMemoryDatabase();
  return {
    database,
    write: (transaction, key, value) => database.write(transaction, key, value),
    read: (key) => database.read<string>(key),
  };
});
