import {createHash} from 'node:crypto';
import type {
  BlobMetadata,
  BlobStore,
  BlobStoreHealth,
  PutBlobInput,
  SignedMultipartUpload,
  SignedRead,
  SignedUploadInput,
} from './types.js';
import {BlobChecksumMismatchError} from './types.js';

interface StoredBlob {
  readonly body: Uint8Array;
  readonly metadata: BlobMetadata;
}

const checksum = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');
const encodeKey = (key: string) => encodeURIComponent(key).replaceAll('%2F', '/');

export class InMemoryBlobStore implements BlobStore {
  readonly #blobs = new Map<string, StoredBlob>();
  #health: BlobStoreHealth = {status: 'ready', checkedAt: new Date(0)};

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly publicBaseUrl = 'https://blob-store.invalid',
  ) {}

  put(input: PutBlobInput): Promise<{readonly status: 'created' | 'already-exists'}> {
    if (this.#blobs.has(input.key)) {
      return Promise.resolve({status: 'already-exists'});
    }
    const actual = checksum(input.body);
    if (input.checksumSha256 && input.checksumSha256 !== actual) {
      throw new BlobChecksumMismatchError(input.checksumSha256, actual);
    }
    this.#blobs.set(input.key, {
      body: Uint8Array.from(input.body),
      metadata: {
        key: input.key,
        contentType: input.contentType,
        size: input.body.byteLength,
        checksumSha256: actual,
        createdAt: this.now(),
      },
    });
    return Promise.resolve({status: 'created'});
  }

  read(key: string): Promise<Uint8Array | undefined> {
    const blob = this.#blobs.get(key);
    return Promise.resolve(blob ? Uint8Array.from(blob.body) : undefined);
  }

  head(key: string): Promise<BlobMetadata | undefined> {
    const metadata = this.#blobs.get(key)?.metadata;
    return Promise.resolve(metadata ? {...metadata} : undefined);
  }

  delete(key: string): Promise<void> {
    this.#blobs.delete(key);
    return Promise.resolve();
  }

  signUpload(input: SignedUploadInput): Promise<SignedMultipartUpload> {
    return Promise.resolve({
      method: 'POST',
      url: `${this.publicBaseUrl}/upload`,
      fields: {key: input.key, 'Content-Type': input.contentType},
      fileField: 'file',
      expiresAt: input.expiresAt,
      constraints: {
        key: input.key,
        contentType: input.contentType,
        maximumBytes: input.maximumBytes,
        ...(input.checksumSha256 ? {checksumSha256: input.checksumSha256} : {}),
      },
    });
  }

  signRead(input: {readonly key: string; readonly expiresAt: Date}): Promise<SignedRead> {
    return Promise.resolve({
      method: 'GET',
      url: `${this.publicBaseUrl}/read/${encodeKey(input.key)}`,
      headers: {},
      expiresAt: input.expiresAt,
    });
  }

  health(): Promise<BlobStoreHealth> {
    return Promise.resolve({...this.#health});
  }

  setHealth(health: BlobStoreHealth): void {
    this.#health = {...health};
  }
}
