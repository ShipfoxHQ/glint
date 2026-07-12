import {readFile} from 'node:fs/promises';
import {
  DeleteObjectCommand,
  GetBucketLocationCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {describe, expect, it} from '@shipfox/vitest/vi';
import {blobStoreContractTests} from './contract-test-kit.js';
import {S3BlobStore} from './s3.js';
import type {SignedUploadInput} from './types.js';
import {MVP_BLOB_SIGNING_POLICY, parseSha256Hex} from './types.js';

const NOW = new Date();
const ACCESS_KEY_ID = 'fixture-access-key';
const SECRET_ACCESS_KEY = 'fixture-secret-access-key';

interface MockS3Options {
  readonly omitHeadMetadata?: boolean;
  readonly headFailureStatus?: number;
  readonly healthFailureStatus?: number;
  readonly putConflictCount?: number;
}

interface MockObject {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly checksumSha256Base64: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly lastModified: Date;
}

const s3Error = (status: number) =>
  Object.assign(new Error(`S3 request failed with ${status}`), {
    $metadata: {httpStatusCode: status},
  });

const createStore = (options: MockS3Options = {}) => {
  const objects = new Map<string, MockObject>();
  let putConflictsRemaining = options.putConflictCount ?? 0;
  const client = new S3Client({
    region: 'eu-central-1',
    endpoint: 'https://s3.invalid',
    forcePathStyle: true,
    credentials: {accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY},
  });
  const mockClient = client as unknown as {
    send(command: unknown): Promise<unknown>;
  };
  mockClient.send = (command: unknown): Promise<unknown> =>
    Promise.resolve().then(() => {
      if (command instanceof PutObjectCommand) {
        const key = command.input.Key;
        if (!key || !(command.input.Body instanceof Uint8Array)) {
          throw new Error('Unexpected mock PutObject input');
        }
        if (putConflictsRemaining > 0) {
          putConflictsRemaining -= 1;
          throw s3Error(409);
        }
        if (objects.has(key) && command.input.IfNoneMatch === '*') throw s3Error(412);
        objects.set(key, {
          body: Uint8Array.from(command.input.Body),
          contentType: command.input.ContentType ?? 'application/octet-stream',
          checksumSha256Base64: command.input.ChecksumSHA256 ?? '',
          metadata: command.input.Metadata ?? {},
          lastModified: new Date(NOW),
        });
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const object = command.input.Key ? objects.get(command.input.Key) : undefined;
        if (!object) throw s3Error(404);
        return {
          Body: {transformToByteArray: async () => Uint8Array.from(object.body)},
        };
      }
      if (command instanceof HeadObjectCommand) {
        if (options.headFailureStatus) throw s3Error(options.headFailureStatus);
        const object = command.input.Key ? objects.get(command.input.Key) : undefined;
        if (!object) throw s3Error(404);
        return {
          ContentType: object.contentType,
          ContentLength: object.body.byteLength,
          ChecksumSHA256: object.checksumSha256Base64,
          Metadata: options.omitHeadMetadata ? {} : object.metadata,
          LastModified: object.lastModified,
        };
      }
      if (command instanceof DeleteObjectCommand) {
        if (command.input.Key) objects.delete(command.input.Key);
        return {};
      }
      if (command instanceof GetBucketLocationCommand) {
        if (options.healthFailureStatus) throw s3Error(options.healthFailureStatus);
        return {LocationConstraint: 'eu-central-1'};
      }
      throw new Error(`Unexpected S3 command: ${command?.constructor.name ?? 'unknown'}`);
    });

  return new S3BlobStore(
    {
      bucket: 'glint-fixture',
      region: 'eu-central-1',
      endpoint: 'https://s3.invalid',
      forcePathStyle: true,
      credentials: {accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY},
    },
    client,
    () => NOW,
  );
};

blobStoreContractTests('s3', createStore, () => NOW);

describe('S3BlobStore signed upload compatibility', () => {
  it('reproduces the sanitized Argos multipart POST field and file behavior', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL(
          '../../../../api/compat/argos-dto/fixtures/v1/signed-upload/multipart-post.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as {readonly responseItem: {readonly fields: Readonly<Record<string, string>>}};
    const signed = await createStore().signUpload({
      key: 'objects/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contentType: 'image/png',
      maximumBytes: MVP_BLOB_SIGNING_POLICY.maximumBytes,
      expiresAt: new Date(NOW.getTime() + MVP_BLOB_SIGNING_POLICY.expiresAfterMs),
      checksumSha256: parseSha256Hex('a'.repeat(64)),
    });

    expect(signed.fileField).toBe('file');
    expect(signed.method).toBe('POST');
    for (const field of Object.keys(fixture.responseItem.fields)) {
      expect(signed.fields).toHaveProperty(field);
    }
    expect(signed.fields.key).toBe(
      'objects/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(signed.fields['Content-Type']).toBe('image/png');
    expect(signed.fields['x-amz-server-side-encryption']).toBe('AES256');
    expect(JSON.stringify(signed)).not.toContain(SECRET_ACCESS_KEY);

    const policy = JSON.parse(
      Buffer.from(signed.fields.policy ?? '', 'base64').toString('utf8'),
    ) as {
      readonly expiration: string;
      readonly conditions: readonly unknown[];
    };
    expect(policy.conditions).toContainEqual({key: signed.fields.key});
    expect(policy.conditions).toContainEqual({'Content-Type': 'image/png'});
    expect(policy.conditions).toContainEqual([
      'content-length-range',
      1,
      MVP_BLOB_SIGNING_POLICY.maximumBytes,
    ]);
    expect(signed.fields['x-amz-checksum-algorithm']).toBe('SHA256');
    expect(signed.fields['x-amz-checksum-sha256']).toBe(
      Buffer.from('a'.repeat(64), 'hex').toString('base64'),
    );
    expect(
      Math.abs(new Date(policy.expiration).getTime() - signed.expiresAt.getTime()),
    ).toBeLessThanOrEqual(2_000);
  });

  it('requires a checksum before signing a content-immutable upload', async () => {
    await expect(
      createStore().signUpload({
        key: 'objects/fixture',
        contentType: 'image/png',
        maximumBytes: 1,
        expiresAt: new Date(NOW.getTime() + MVP_BLOB_SIGNING_POLICY.expiresAfterMs),
      } as unknown as SignedUploadInput),
    ).rejects.toMatchObject({code: 'blob_constraint_violation', constraint: 'checksum'});
  });

  it('uses provider checksum and timestamp fallbacks without swallowing provider failures', async () => {
    const fallbackStore = createStore({omitHeadMetadata: true});
    await fallbackStore.put({
      key: 'objects/fallback',
      body: Uint8Array.from([1, 2, 3]),
      contentType: 'image/png',
    });
    await expect(fallbackStore.head('objects/fallback')).resolves.toMatchObject({
      checksumSha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
      createdAt: NOW,
    });

    await expect(
      createStore({headFailureStatus: 503}).head('objects/failure'),
    ).rejects.toMatchObject({
      $metadata: {httpStatusCode: 503},
    });
    await expect(createStore({healthFailureStatus: 503}).health()).resolves.toMatchObject({
      status: 'unavailable',
    });
  });

  it('retries conditional write conflicts and bounds repeated failures', async () => {
    const input = {
      key: 'objects/conflict',
      body: Uint8Array.from([1]),
      contentType: 'image/png',
      checksumSha256: parseSha256Hex(
        '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a',
      ),
    };
    await expect(createStore({putConflictCount: 1}).put(input)).resolves.toEqual({
      status: 'created',
    });
    await expect(createStore({putConflictCount: 3}).put(input)).rejects.toMatchObject({
      $metadata: {httpStatusCode: 409},
    });
  });
});
