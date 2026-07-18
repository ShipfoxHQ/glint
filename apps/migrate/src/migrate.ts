import type {PostgresDatabase} from '@glint/node-database';
import {runOrderedMigrations} from '@glint/node-database';
import {composeModules, type GlintModule, selectCapabilities} from '@glint/node-module';
import {POSTGRES_OUTBOX_MIGRATION} from '@glint/node-outbox';

export const foundationModules: readonly GlintModule[] = [
  {
    name: 'transactional-outbox',
    migrations: [POSTGRES_OUTBOX_MIGRATION],
  },
];

export async function migrate(
  database: Pick<PostgresDatabase, 'drizzle'>,
  modules: readonly GlintModule[] = foundationModules,
): Promise<readonly string[]> {
  const composition = composeModules(modules);
  const {migrations} = selectCapabilities(composition, ['migrations']);
  await runOrderedMigrations(database.drizzle, migrations);
  return migrations.map(({name}) => name);
}
