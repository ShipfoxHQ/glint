import {fileURLToPath} from 'node:url';
import {defineConfig, type UserConfigExport} from '@shipfox/vitest';
export default defineConfig(
  {
    resolve: {
      alias: {
        '@glint/node-database': fileURLToPath(new URL('../database/src/index.ts', import.meta.url)),
      },
    },
  },
  import.meta.url,
) as UserConfigExport;
