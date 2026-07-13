import {
  createPostgresDatabase,
  databaseEnvironmentSecrets,
  loadDatabaseEnvironment,
} from '@glint/node-database';
import {
  createGlintLogger,
  loadObservabilityEnvironment,
  observabilityEnvironmentSecrets,
} from '@glint/node-observability';
import {migrate} from './migrate.js';

const databaseEnvironment = loadDatabaseEnvironment();
const observabilityEnvironment = loadObservabilityEnvironment();
const logger = await createGlintLogger({
  secrets: [
    ...databaseEnvironmentSecrets(databaseEnvironment),
    ...observabilityEnvironmentSecrets(observabilityEnvironment),
  ],
});
const database = await createPostgresDatabase({environment: databaseEnvironment, logger});

try {
  const migrations = await migrate(database);
  logger.info('Migration process completed.', {migrations});
  process.stdout.write(`${JSON.stringify({status: 'complete', migrations})}\n`);
} finally {
  await database.close();
}
