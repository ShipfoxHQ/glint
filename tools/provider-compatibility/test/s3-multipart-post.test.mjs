import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  MAX_UPLOAD_BYTES,
  REQUIRED_SIGNED_FIELDS,
  validateSignedReadUrl,
  validateSignedPost,
} from '../src/s3-multipart-post.mjs';

const fixture = JSON.parse(
  await readFile(
    new URL(
      '../../../libs/api/compat/argos-dto/fixtures/v1/signed-upload/multipart-post.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

test('selected S3 POST shape contains every field required by the pinned producer', () => {
  assert.deepEqual(Object.keys(fixture.responseItem.fields), REQUIRED_SIGNED_FIELDS);
  assert.doesNotThrow(() =>
    validateSignedPost({
      fields: fixture.responseItem.fields,
      url: 'https://bucket.s3.eu-central-1.amazonaws.com',
    }),
  );
  assert.equal(fixture.request.file.field, 'file');
  assert.equal(fixture.successStatus, 204);
  assert.equal(MAX_UPLOAD_BYTES, 8_388_608);
});

test('accepts only five-minute HTTPS signed reads', () => {
  assert.doesNotThrow(() =>
    validateSignedReadUrl('https://bucket.s3.eu-central-1.amazonaws.com/key?X-Amz-Expires=300'),
  );
  assert.throws(
    () => validateSignedReadUrl('http://bucket.invalid/key?X-Amz-Expires=300'),
    /must use HTTPS/,
  );
  assert.throws(
    () => validateSignedReadUrl('https://bucket.invalid/key?X-Amz-Expires=600'),
    /expire after five minutes/,
  );
});

test('rejects PUT-only, incomplete, or unconstrained signed operations', () => {
  assert.throws(
    () => validateSignedPost({fields: {key: 'object'}, url: 'https://uploads.invalid'}),
    /missing required fields/,
  );
  assert.throws(
    () => validateSignedPost({fields: fixture.responseItem.fields, url: 'http://uploads.invalid'}),
    /must use HTTPS/,
  );
  assert.throws(
    () =>
      validateSignedPost({
        fields: {...fixture.responseItem.fields, 'Content-Type': 'application/octet-stream'},
        url: 'https://uploads.invalid',
      }),
    /must constrain Content-Type/,
  );
});
