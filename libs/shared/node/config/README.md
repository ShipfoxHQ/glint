# Glint configuration

`@glint/node-config` defines the startup configuration boundary used by API, worker, and
migration processes.

Every package that reads environment variables owns one flat `src/config.ts` schema. Each key
must have a self-hoster-facing description, and sensitive keys are marked so their configured
values can be passed to the logging redactor. Call `loadEnvironment` in the composition root
before starting a server, worker, or migration runner.

```ts
import {
  defineEnvironmentSchema,
  environmentVariable,
  loadEnvironment,
  str,
} from '@glint/node-config';

const schema = defineEnvironmentSchema({
  DATABASE_URL: environmentVariable(str(), {
    description: 'PostgreSQL connection URL.',
    sensitive: true,
  }),
});

export const config = loadEnvironment(schema);
```

Invalid values are reported together with their descriptions. Sensitive values are never copied
into configuration errors.
