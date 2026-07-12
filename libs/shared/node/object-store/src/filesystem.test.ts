import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from '@shipfox/vitest/vi';
import {blobStoreContractTests} from './contract-test-kit.js';
import {FilesystemBlobStore} from './filesystem.js';
import {MVP_BLOB_SIGNING_POLICY, parseSha256Hex} from './types.js';

const NOW = new Date('2026-07-12T00:00:00.000Z');
const SIGNING_SECRET = 'local-test-signing-secret';
const temporaryDirectories: string[] = [];

const createStore = async (now: () => Date = () => NOW) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'glint-object-store-'));
  temporaryDirectories.push(rootDirectory);
  return new FilesystemBlobStore({
    rootDirectory,
    publicBaseUrl: 'http://object-store.local',
    signingSecret: SIGNING_SECRET,
    now,
  });
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, {recursive: true})),
  );
});

blobStoreContractTests('filesystem', createStore, () => NOW);

describe('FilesystemBlobStore signed operations', () => {
  it('accepts the recorded multipart field ordering and serves signed reads', async () => {
    const store = await createStore();
    const body = Uint8Array.from([1, 2, 3]);
    const signedUpload = await store.signUpload({
      key: 'objects/fixture',
      contentType: 'image/png',
      maximumBytes: body.byteLength,
      expiresAt: new Date(NOW.getTime() + MVP_BLOB_SIGNING_POLICY.expiresAfterMs),
      checksumSha256: parseSha256Hex(
        '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
      ),
    });
    const form = new FormData();
    for (const [key, value] of Object.entries(signedUpload.fields)) form.append(key, value);
    form.append('file', new Blob([body], {type: 'image/png'}), 'fixture.png');

    await expect(
      store.handleSignedRequest(
        new Request(signedUpload.url, {
          method: 'POST',
          body: form,
          headers: {'content-length': '1'},
        }),
      ),
    ).resolves.toMatchObject({status: 204});

    const duplicateForm = new FormData();
    for (const [key, value] of Object.entries(signedUpload.fields))
      duplicateForm.append(key, value);
    duplicateForm.append('file', new Blob([body], {type: 'image/png'}), 'fixture.png');
    const duplicate = await store.handleSignedRequest(
      new Request(signedUpload.url, {
        method: 'POST',
        body: duplicateForm,
        headers: {'content-length': '1'},
      }),
    );
    expect({status: duplicate.status, body: await duplicate.json()}).toEqual({
      status: 409,
      body: {error: 'blob_already_exists'},
    });

    const signedRead = await store.signRead({
      key: 'objects/fixture',
      expiresAt: new Date(NOW.getTime() + MVP_BLOB_SIGNING_POLICY.expiresAfterMs),
    });
    const response = await store.handleSignedRequest(new Request(signedRead.url));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
  });

  it('rejects expired, oversized, and content-type-violating requests', async () => {
    let currentTime = new Date(NOW);
    const store = await createStore(() => currentTime);
    const signedUpload = await store.signUpload({
      key: 'objects/fixture',
      contentType: 'image/png',
      maximumBytes: 2,
      expiresAt: new Date(NOW.getTime() + 1_000),
      checksumSha256: parseSha256Hex(
        '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a',
      ),
    });
    const requestWith = (body: Blob) => {
      const form = new FormData();
      for (const [key, value] of Object.entries(signedUpload.fields)) form.append(key, value);
      form.append('file', body, 'fixture.png');
      return new Request(signedUpload.url, {
        method: 'POST',
        body: form,
        headers: {'content-length': '1'},
      });
    };
    const execute = async (body: Blob) => {
      const response = await store.handleSignedRequest(requestWith(body));
      return {status: response.status, body: await response.json()};
    };

    await expect(
      execute(new Blob([Uint8Array.from([1, 2, 3])], {type: 'image/png'})),
    ).resolves.toEqual({status: 413, body: {error: 'blob_size_constraint_violated'}});
    await expect(execute(new Blob([Uint8Array.from([1])], {type: 'image/jpeg'}))).resolves.toEqual({
      status: 403,
      body: {error: 'blob_content_type_constraint_violated'},
    });

    currentTime = new Date(NOW.getTime() + 1_001);
    await expect(execute(new Blob([Uint8Array.from([1])], {type: 'image/png'}))).resolves.toEqual({
      status: 403,
      body: {error: 'expired_blob_signature'},
    });
  });

  it('returns server errors for storage failures and rejects declared oversized bodies early', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'glint-object-store-blocked-'));
    temporaryDirectories.push(parent);
    const blockedRoot = join(parent, 'not-a-directory');
    await writeFile(blockedRoot, 'blocked');
    const store = new FilesystemBlobStore({
      rootDirectory: blockedRoot,
      publicBaseUrl: 'http://object-store.local',
      signingSecret: SIGNING_SECRET,
      now: () => NOW,
    });
    const signedUpload = await store.signUpload({
      key: 'objects/fixture',
      contentType: 'image/png',
      maximumBytes: 1,
      expiresAt: new Date(NOW.getTime() + 1_000),
      checksumSha256: parseSha256Hex(
        '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a',
      ),
    });
    const request = (contentLength: number | null = 1) => {
      const form = new FormData();
      for (const [key, value] of Object.entries(signedUpload.fields)) form.append(key, value);
      form.append('file', new Blob([Uint8Array.from([1])], {type: 'image/png'}), 'fixture.png');
      return new Request(signedUpload.url, {
        method: 'POST',
        body: form,
        ...(contentLength === null ? {} : {headers: {'content-length': String(contentLength)}}),
      });
    };

    const storageFailure = await store.handleSignedRequest(request());
    expect({status: storageFailure.status, body: await storageFailure.json()}).toEqual({
      status: 500,
      body: {error: 'blob_store_unavailable'},
    });

    const oversized = await store.handleSignedRequest(
      request(MVP_BLOB_SIGNING_POLICY.maximumBytes + 128 * 1_024),
    );
    expect({status: oversized.status, body: await oversized.json()}).toEqual({
      status: 413,
      body: {error: 'blob_request_too_large'},
    });
    const missingLength = await store.handleSignedRequest(request(null));
    expect({status: missingLength.status, body: await missingLength.json()}).toEqual({
      status: 411,
      body: {error: 'blob_content_length_required'},
    });
    await expect(store.health()).resolves.toMatchObject({status: 'unavailable'});
  });

  it('rejects corrupted local envelopes instead of returning partial data', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'glint-object-store-corrupt-'));
    temporaryDirectories.push(rootDirectory);
    const key = 'objects/corrupt';
    const digest = createHash('sha256').update(key).digest('hex');
    const objectDirectory = join(rootDirectory, 'objects', digest.slice(0, 2));
    await mkdir(objectDirectory, {recursive: true});
    await writeFile(join(objectDirectory, digest), Uint8Array.from([0, 0, 1]));
    const store = new FilesystemBlobStore({
      rootDirectory,
      publicBaseUrl: 'http://object-store.local',
      signingSecret: SIGNING_SECRET,
      now: () => NOW,
    });

    await expect(store.read(key)).rejects.toThrow('Invalid local blob envelope');

    const signedRead = await store.signRead({
      key,
      expiresAt: new Date(NOW.getTime() + 1_000),
    });
    const response = await store.handleSignedRequest(new Request(signedRead.url));
    expect({status: response.status, body: await response.json()}).toEqual({
      status: 500,
      body: {error: 'blob_store_unavailable'},
    });
  });

  it('rejects explicitly empty signing secrets', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'glint-object-store-secret-'));
    temporaryDirectories.push(rootDirectory);
    const options = {
      rootDirectory,
      publicBaseUrl: 'http://object-store.local',
      now: () => NOW,
    };

    expect(() => new FilesystemBlobStore({...options, signingSecret: ''})).toThrow(
      'signingSecret must not be empty',
    );
    expect(() => new FilesystemBlobStore({...options, signingSecret: new Uint8Array()})).toThrow(
      'signingSecret must not be empty',
    );
  });
});
