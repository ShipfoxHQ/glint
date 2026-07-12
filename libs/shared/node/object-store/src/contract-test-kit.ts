import {describe, expect, it} from '@shipfox/vitest/vi';
import type {BlobStore, SignedUploadInput} from './types.js';
import {MVP_BLOB_SIGNING_POLICY, parseSha256Hex, validateSignedReadInput} from './types.js';

const SHA256_123 = parseSha256Hex(
  '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
);

export function blobStoreContractTests(
  name: string,
  createStore: () => Promise<BlobStore> | BlobStore,
  now: () => Date = () => new Date(),
): void {
  describe(`${name} blob-store contract`, () => {
    it('stores immutable bytes and returns complete metadata', async () => {
      const store = await createStore();
      const original = Uint8Array.from([1, 2, 3]);
      await expect(
        store.put({key: 'tenant/source/hash', body: original, contentType: 'image/png'}),
      ).resolves.toEqual({status: 'created'});
      original[0] = 9;

      await expect(
        store.put({
          key: 'tenant/source/hash',
          body: Uint8Array.from([4]),
          contentType: 'image/png',
        }),
      ).resolves.toEqual({status: 'already-exists'});
      expect(await store.read('tenant/source/hash')).toEqual(Uint8Array.from([1, 2, 3]));
      expect(await store.head('tenant/source/hash')).toMatchObject({
        key: 'tenant/source/hash',
        contentType: 'image/png',
        size: 3,
      });
    });

    it('uses lowercase hexadecimal SHA-256 checksums consistently', async () => {
      const store = await createStore();
      await store.put({
        key: 'checksum-match',
        body: Uint8Array.from([1, 2, 3]),
        contentType: 'image/png',
        checksumSha256: SHA256_123,
      });
      await expect(store.head('checksum-match')).resolves.toMatchObject({
        checksumSha256: SHA256_123,
      });
      await expect(
        store.put({
          key: 'checksum-mismatch',
          body: Uint8Array.from([1, 2, 3]),
          contentType: 'image/png',
          checksumSha256: parseSha256Hex('0'.repeat(64)),
        }),
      ).rejects.toMatchObject({code: 'blob_checksum_mismatch'});
      await expect(
        store.put({
          key: 'checksum-match',
          body: Uint8Array.from([4]),
          contentType: 'image/png',
          checksumSha256: SHA256_123,
        }),
      ).rejects.toMatchObject({code: 'blob_checksum_mismatch'});
      expect(() => parseSha256Hex(SHA256_123.toUpperCase())).toThrowError(
        expect.objectContaining({code: 'invalid_sha256_hex'}),
      );
    });

    it('deletes idempotently without exposing a listing capability', async () => {
      const store = await createStore();
      await store.put({key: 'delete-me', body: Uint8Array.from([1]), contentType: 'image/png'});
      await store.delete('delete-me');
      await store.delete('delete-me');
      expect(await store.read('delete-me')).toBeUndefined();
      expect('list' in store).toBe(false);
    });

    it('signs constrained multipart uploads compatible with direct producer uploads', async () => {
      const store = await createStore();
      const expiresAt = new Date(now().getTime() + MVP_BLOB_SIGNING_POLICY.expiresAfterMs);
      const signed = await store.signUpload({
        key: 'tenant/source/hash',
        contentType: MVP_BLOB_SIGNING_POLICY.contentType,
        maximumBytes: MVP_BLOB_SIGNING_POLICY.maximumBytes,
        expiresAt,
        checksumSha256: SHA256_123,
      });
      expect(signed).toMatchObject({
        method: 'POST',
        fileField: 'file',
        expiresAt,
        constraints: {
          key: 'tenant/source/hash',
          contentType: 'image/png',
          maximumBytes: MVP_BLOB_SIGNING_POLICY.maximumBytes,
          checksumSha256: SHA256_123,
        },
      });
      expect(signed.fields.key).toBe('tenant/source/hash');
      expect(signed.fields['Content-Type']).toBe('image/png');
    });

    it('signs bounded reads and reports readiness', async () => {
      const store = await createStore();
      const expiresAt = new Date(now().getTime() + MVP_BLOB_SIGNING_POLICY.expiresAfterMs);
      const signed = await store.signRead({key: 'tenant/source/hash', expiresAt});
      expect(signed).toMatchObject({
        method: 'GET',
        key: 'tenant/source/hash',
        expiresAt,
      });
      await expect(store.health()).resolves.toMatchObject({status: 'ready'});
    });

    it('rejects unsafe keys and invalid signed-operation constraints deterministically', async () => {
      const store = await createStore();
      const validExpiry = new Date(now().getTime() + MVP_BLOB_SIGNING_POLICY.expiresAfterMs);
      const expectConstraint = (operation: () => Promise<unknown>) =>
        expect(Promise.resolve().then(operation)).rejects.toMatchObject({
          code: 'blob_constraint_violation',
        });

      await expectConstraint(() =>
        store.put({key: '../escape', body: Uint8Array.from([1]), contentType: 'image/png'}),
      );
      for (const checksumSha256 of ['A'.repeat(64), 'a'.repeat(63), 'not-a-checksum']) {
        await expectConstraint(() =>
          store.signUpload({
            key: 'tenant/source/hash',
            contentType: MVP_BLOB_SIGNING_POLICY.contentType,
            maximumBytes: MVP_BLOB_SIGNING_POLICY.maximumBytes,
            expiresAt: validExpiry,
            checksumSha256,
          } as unknown as SignedUploadInput),
        );
      }
      for (const key of [
        '/absolute',
        'back\\slash',
        `control-${String.fromCharCode(0x80)}`,
        'a'.repeat(1_025),
      ]) {
        await expectConstraint(() =>
          store.put({key, body: Uint8Array.from([1]), contentType: 'image/png'}),
        );
      }
      await expect(
        store.put({
          key: 'a'.repeat(1_024),
          body: Uint8Array.from([1]),
          contentType: 'image/png',
        }),
      ).resolves.toEqual({status: 'created'});
      await expectConstraint(() =>
        store.signUpload({
          key: 'tenant/source/hash',
          contentType: 'image/jpeg',
          maximumBytes: MVP_BLOB_SIGNING_POLICY.maximumBytes,
          expiresAt: validExpiry,
          checksumSha256: SHA256_123,
        }),
      );
      expect(() =>
        validateSignedReadInput(
          {key: 'tenant/source/hash', expiresAt: validExpiry},
          new Date(Number.NaN),
        ),
      ).toThrowError(expect.objectContaining({code: 'blob_constraint_violation'}));
      await expectConstraint(() =>
        store.signUpload({
          key: 'tenant/source/hash',
          contentType: MVP_BLOB_SIGNING_POLICY.contentType,
          maximumBytes: MVP_BLOB_SIGNING_POLICY.maximumBytes + 1,
          expiresAt: validExpiry,
          checksumSha256: SHA256_123,
        }),
      );
      await expectConstraint(() =>
        store.signRead({key: 'tenant/source/hash', expiresAt: new Date(now().getTime())}),
      );
      await expectConstraint(() =>
        store.signRead({
          key: 'tenant/source/hash',
          expiresAt: new Date(now().getTime() + MVP_BLOB_SIGNING_POLICY.expiresAfterMs + 1),
        }),
      );
    });
  });
}
