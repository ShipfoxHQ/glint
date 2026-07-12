import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  argosAuthorizationHeaderSchema,
  argosCreateBuildBodySchema,
  argosCreateBuildResponseSchema,
  argosErrorResponseSchema,
  argosFinalizeBuildsBodySchema,
  argosFinalizeBuildsResponseSchema,
  argosProjectResponseSchema,
  argosSignedUploadSchema,
  argosSkippedBuildResponseSchema,
  argosUpdateBuildBodySchema,
  argosUpdateBuildResponseSchema,
} from '../dist/index.js';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workspaceRoot = resolve(packageRoot, '../../../..');
const fixturesRoot = join(packageRoot, 'fixtures/v1');
const recordingsRoot = join(workspaceRoot, 'tools/argos-protocol-recorder/recordings/v1');

async function fixture(relativePath) {
  return JSON.parse(await readFile(join(fixturesRoot, relativePath), 'utf8'));
}

test('golden HTTP fixtures satisfy the published DTO schemas', async () => {
  const project = await fixture('http/project.json');
  const normal = await fixture('http/normal-build.json');
  const skipped = await fixture('http/skipped-build.json');
  const update = await fixture('http/build-update.json');
  const finalize = await fixture('http/finalize.json');
  const errors = await fixture('http/errors.json');

  assert.doesNotThrow(() => argosProjectResponseSchema.parse(project.response.body));
  assert.doesNotThrow(() => argosProjectResponseSchema.parse(project.minimalResponse.body));
  assert.doesNotThrow(() => argosCreateBuildBodySchema.parse(normal.request.body));
  assert.doesNotThrow(() => argosCreateBuildResponseSchema.parse(normal.response.body));
  assert.doesNotThrow(() => argosCreateBuildBodySchema.parse(skipped.request.body));
  assert.doesNotThrow(() => argosSkippedBuildResponseSchema.parse(skipped.response.body));
  assert.doesNotThrow(() => argosUpdateBuildBodySchema.parse(update.request.body));
  assert.doesNotThrow(() => argosUpdateBuildResponseSchema.parse(update.response.body));
  assert.doesNotThrow(() => argosFinalizeBuildsBodySchema.parse(finalize.request.body));
  assert.doesNotThrow(() => argosFinalizeBuildsResponseSchema.parse(finalize.response.body));
  for (const value of Object.values(errors)) {
    assert.doesNotThrow(() => argosErrorResponseSchema.parse(value.body));
  }
  for (const value of [project, normal, skipped, update, finalize]) {
    assert.equal(value.request.headers.authorization, 'Bearer <40-character-token>');
  }
});

test('unknown producer fields survive parsing and do not expand the required subset', async () => {
  const normal = await fixture('http/normal-build.json');
  const parsed = argosCreateBuildBodySchema.parse(normal.request.body);
  assert.equal(parsed.ignoredFutureField, 'safe-to-ignore');
  assert.equal(parsed.subset, false);
});

test('Bearer authentication requires exactly 40 non-whitespace characters', () => {
  assert.equal(
    argosAuthorizationHeaderSchema.parse(`Bearer ${'a'.repeat(40)}`),
    `Bearer ${'a'.repeat(40)}`,
  );
  for (const value of [
    `Bearer ${'a'.repeat(39)}`,
    `Bearer ${'a'.repeat(41)}`,
    `Basic ${'a'.repeat(40)}`,
    `Bearer ${'a'.repeat(20)} ${'b'.repeat(19)}`,
    `Bearer ${'a'.repeat(40)}\n`,
  ]) {
    assert.throws(() => argosAuthorizationHeaderSchema.parse(value));
  }
});

test('required response and screenshot fields cannot be omitted', async () => {
  const normal = await fixture('http/normal-build.json');
  const update = await fixture('http/build-update.json');
  const createWithoutBuildId = structuredClone(normal.response.body);
  delete createWithoutBuildId.build.id;
  assert.throws(() => argosCreateBuildResponseSchema.parse(createWithoutBuildId));

  const updateWithoutMetadata = structuredClone(update.request.body);
  delete updateWithoutMetadata.screenshots[0].metadata;
  assert.throws(() => argosUpdateBuildBodySchema.parse(updateWithoutMetadata));
});

test('signed upload fixture preserves every opaque multipart field and appends file', async () => {
  const value = await fixture('signed-upload/multipart-post.json');
  assert.doesNotThrow(() => argosSignedUploadSchema.parse(value.responseItem));
  assert.deepEqual(Object.keys(value.request.fields), Object.keys(value.responseItem.fields));
  assert.equal(value.request.file.field, 'file');
  assert.equal(value.request.file.contentType, 'image/png');
  assert.equal(value.successStatus, 204);
  assert.equal(value.producerRetryCount, 0);
});

test('fixture manifest covers every sanitized recorder scenario and pinned producer', async () => {
  const manifest = await fixture('manifest.json');
  const recordingNames = (await readdir(recordingsRoot))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
  assert.deepEqual(Object.keys(manifest.scenarios).sort(), recordingNames);
  assert.equal(manifest.producerVersions['@argos-ci/cli'], '5.0.5');
  assert.equal(manifest.producerVersions['@argos-ci/playwright'], '7.0.6');
  assert.equal(manifest.producerVersions['@argos-ci/storybook'], '6.0.7');
});

test('all sanitized recorder exchanges satisfy the route contract', async () => {
  const names = (await readdir(recordingsRoot)).filter((name) => name.endsWith('.json'));
  for (const name of names) {
    const recording = JSON.parse(await readFile(join(recordingsRoot, name), 'utf8'));
    for (const exchange of recording.exchanges) {
      const {method, path, body} = exchange.request;
      if (method === 'GET' && path === '/v2/project') {
        const responseSchema =
          exchange.response.status < 400 ? argosProjectResponseSchema : argosErrorResponseSchema;
        assert.doesNotThrow(
          () => responseSchema.parse(exchange.response.body),
          `${name} project response`,
        );
      } else if (method === 'POST' && path === '/v2/builds') {
        assert.doesNotThrow(() => argosCreateBuildBodySchema.parse(body), `${name} create body`);
        const responseSchema =
          exchange.response.status >= 400
            ? argosErrorResponseSchema
            : body.skipped
              ? argosSkippedBuildResponseSchema
              : argosCreateBuildResponseSchema;
        assert.doesNotThrow(
          () => responseSchema.parse(exchange.response.body),
          `${name} create response`,
        );
      } else if (method === 'PUT' && path.startsWith('/v2/builds/')) {
        assert.doesNotThrow(() => argosUpdateBuildBodySchema.parse(body), `${name} update body`);
        const responseSchema =
          exchange.response.status < 400
            ? argosUpdateBuildResponseSchema
            : argosErrorResponseSchema;
        assert.doesNotThrow(
          () => responseSchema.parse(exchange.response.body),
          `${name} update response`,
        );
      } else if (method === 'POST' && path === '/v2/builds/finalize') {
        assert.doesNotThrow(
          () => argosFinalizeBuildsBodySchema.parse(body),
          `${name} finalize body`,
        );
        const responseSchema =
          exchange.response.status < 400
            ? argosFinalizeBuildsResponseSchema
            : argosErrorResponseSchema;
        assert.doesNotThrow(
          () => responseSchema.parse(exchange.response.body),
          `${name} finalize response`,
        );
      } else if (exchange.response.status >= 400) {
        assert.doesNotThrow(
          () => argosErrorResponseSchema.parse(exchange.response.body),
          `${name} error response`,
        );
      }
    }
  }
});

test('OpenAPI publishes only the recorded /v2 surface and documents permissive fields', async () => {
  const openapi = await readFile(join(packageRoot, 'openapi/v2.yaml'), 'utf8');
  for (const path of [
    '/v2/project:',
    '/v2/builds:',
    '/v2/builds/{buildId}:',
    '/v2/builds/finalize:',
  ]) {
    assert.match(openapi, new RegExp(path.replace(/[{}]/g, '\\$&')));
  }
  assert.doesNotMatch(openapi, /\/v2\/baseline/);
  assert.match(openapi, /Exactly 40 non-whitespace token characters/);
  assert.match(openapi, /additionalProperties: true/);
  assert.match(openapi, /x-argos-request-id/);
  assert.match(openapi, /x-argos-retry-attempt/);
  assert.match(openapi, /anyOf:/);
});
