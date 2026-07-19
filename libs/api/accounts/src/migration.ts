import {fileURLToPath} from 'node:url';
import type {OrderedMigration} from '@glint/node-database';
import type {GlintModule} from '@glint/node-module';

export const ACCOUNTS_MIGRATION: OrderedMigration = Object.freeze({
  name: 'accounts',
  directory: fileURLToPath(new URL('../drizzle', import.meta.url)),
});
export const accountsModule: GlintModule = {name: 'accounts', migrations: [ACCOUNTS_MIGRATION]};
