import {fileURLToPath} from 'node:url';
import type {OrderedMigration} from '@glint/node-database';
import type {GlintModule} from '@glint/node-module';

export const PROJECTS_MIGRATION: OrderedMigration = Object.freeze({
  name: 'projects',
  directory: fileURLToPath(new URL('../drizzle', import.meta.url)),
});
export const projectsModule: GlintModule = {name: 'projects', migrations: [PROJECTS_MIGRATION]};
