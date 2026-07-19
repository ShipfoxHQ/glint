import {defineConfig, type UserConfigExport} from '@shipfox/vitest';

export default defineConfig(
  {resolve: {alias: {'@glint/node-database': '../../shared/node/database/src/index.ts'}}},
  import.meta.url,
) as UserConfigExport;
