import {defineConfig, type UserConfigExport} from '@shipfox/vitest';

// The test script uses production exports because @shipfox/node-outbox's development export
// references package source files that are not published.
export default defineConfig(
  {
    test: {environment: 'node'},
    resolve: {alias: {'@glint/node-database': '../../libs/shared/node/database/src/index.ts'}},
  },
  import.meta.url,
) as UserConfigExport;
