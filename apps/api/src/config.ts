import {
  defineEnvironmentSchema,
  type EnvironmentFor,
  environmentVariable,
  host,
  loadEnvironment,
  port,
  str,
  url,
} from '@glint/node-config';

const schema = defineEnvironmentSchema({
  GLINT_API_HOST: environmentVariable(host({default: '127.0.0.1'}), {
    description: 'Interface used by the local API listener.',
  }),
  GLINT_API_PORT: environmentVariable(port({default: 3001}), {
    description: 'TCP port used by the local API listener.',
  }),
  GLINT_OBJECT_STORE_ACCESS_KEY_ID: environmentVariable(str({default: 'local-glint'}), {
    description: 'Object-store access key.',
    sensitive: true,
  }),
  GLINT_OBJECT_STORE_BUCKET: environmentVariable(str({default: 'glint'}), {
    description: 'Private object-store bucket name.',
  }),
  GLINT_OBJECT_STORE_ENDPOINT: environmentVariable(url({default: 'http://127.0.0.1:9000'}), {
    description: 'S3-compatible object-store endpoint.',
  }),
  GLINT_OBJECT_STORE_REGION: environmentVariable(str({default: 'local'}), {
    description: 'S3-compatible object-store region.',
  }),
  GLINT_OBJECT_STORE_SECRET_ACCESS_KEY: environmentVariable(str({default: 'local-glint-secret'}), {
    description: 'Object-store secret access key.',
    sensitive: true,
  }),
});

export type ApiEnvironment = EnvironmentFor<typeof schema>;

export function loadApiEnvironment(environment: NodeJS.ProcessEnv = process.env): ApiEnvironment {
  return loadEnvironment(schema, environment);
}
