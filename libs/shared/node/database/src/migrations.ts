import {createHash} from 'node:crypto';
import {runMigrations} from '@shipfox/node-drizzle';
import type {PostgresDrizzleDatabase} from './postgres.js';

export interface OrderedMigration {
  /** Stable module or foundation name used to isolate Drizzle migration history. */
  readonly name: string;
  /** Filesystem directory containing the module's Drizzle migration journal and SQL files. */
  readonly directory: string;
}

/**
 * Runs module-owned migrations sequentially in the already-composed dependency order.
 * This function is intentionally separate from database creation and request startup.
 */
export async function runOrderedMigrations(
  database: PostgresDrizzleDatabase,
  migrations: readonly OrderedMigration[],
): Promise<void> {
  const names = new Set<string>();
  const normalizedMigrations = migrations.map((migration) => ({
    ...migration,
    normalizedName: normalizeMigrationName(migration.name),
  }));
  for (const migration of normalizedMigrations) {
    if (names.has(migration.normalizedName)) {
      throw new Error(`Duplicate migration module "${migration.name}".`);
    }
    names.add(migration.normalizedName);
  }
  for (const migration of normalizedMigrations) {
    await runMigrations(
      database,
      migration.directory,
      migrationTableName(migration.normalizedName),
    );
  }
}

export function migrationTableName(moduleName: string): string {
  const normalized = normalizeMigrationName(moduleName);
  const slug = normalized
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '')
    .slice(0, 32);
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 10);
  return `glint_${slug || 'module'}_${digest}_migrations`;
}

function normalizeMigrationName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!normalized) throw new Error('A migration module name is required.');
  return normalized;
}
