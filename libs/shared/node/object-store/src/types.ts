/** A SHA-256 digest serialized as exactly 64 lowercase hexadecimal characters. */
export type Sha256Hex = string;

export interface BlobMetadata {
  readonly key: string;
  readonly contentType: string;
  readonly size: number;
  readonly checksumSha256: Sha256Hex;
  readonly createdAt: Date;
}

export interface PutBlobInput {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly checksumSha256?: Sha256Hex;
}

export interface SignedUploadInput {
  readonly key: string;
  readonly contentType: string;
  readonly maximumBytes: number;
  readonly expiresAt: Date;
  readonly checksumSha256?: Sha256Hex;
}

export interface SignedMultipartUpload {
  readonly method: 'POST';
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly fileField: 'file';
  readonly expiresAt: Date;
  readonly constraints: {
    readonly key: string;
    readonly contentType: string;
    readonly maximumBytes: number;
    readonly checksumSha256?: Sha256Hex;
  };
}

export interface SignedRead {
  readonly method: 'GET';
  readonly key: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface BlobStoreHealth {
  readonly status: 'ready' | 'unavailable';
  readonly checkedAt: Date;
  readonly detail?: string;
}

export interface BlobStore {
  put(input: PutBlobInput): Promise<{readonly status: 'created' | 'already-exists'}>;
  read(key: string): Promise<Uint8Array | undefined>;
  head(key: string): Promise<BlobMetadata | undefined>;
  delete(key: string): Promise<void>;
  signUpload(input: SignedUploadInput): Promise<SignedMultipartUpload>;
  signRead(input: {readonly key: string; readonly expiresAt: Date}): Promise<SignedRead>;
  health(): Promise<BlobStoreHealth>;
}

export const MVP_BLOB_SIGNING_POLICY = {
  contentType: 'image/png',
  maximumBytes: 8 * 1024 * 1024,
  expiresAfterMs: 5 * 60 * 1_000,
} as const;

export class BlobChecksumMismatchError extends Error {
  readonly code = 'blob_checksum_mismatch';

  constructor(
    readonly expected: Sha256Hex,
    readonly actual: Sha256Hex,
  ) {
    super(`Blob checksum mismatch: expected ${expected}, received ${actual}`);
    this.name = 'BlobChecksumMismatchError';
  }
}
