declare const sha256HexBrand: unique symbol;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

/** A SHA-256 digest serialized as exactly 64 lowercase hexadecimal characters. */
export type Sha256Hex = string & {readonly [sha256HexBrand]: true};

export function parseSha256Hex(value: string): Sha256Hex {
  if (!SHA256_HEX_PATTERN.test(value)) throw new InvalidSha256HexError(value);
  return value as Sha256Hex;
}

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
  readonly checksumSha256: Sha256Hex;
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
    readonly checksumSha256: Sha256Hex;
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

const MAXIMUM_S3_KEY_BYTES = 1_024;

export function validateBlobKey(key: string): void {
  const segments = key.split('/');
  const containsControlCharacter = [...key].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || (code >= 127 && code <= 159);
  });
  if (
    key.length === 0 ||
    Buffer.byteLength(key, 'utf8') > MAXIMUM_S3_KEY_BYTES ||
    key.startsWith('/') ||
    key.endsWith('/') ||
    key.includes('\\') ||
    containsControlCharacter ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new BlobConstraintError('key', 'Blob keys must be safe, relative S3 object keys');
  }
}

export function validateSignedUploadInput(input: SignedUploadInput, now: Date): void {
  validateBlobKey(input.key);
  if (typeof input.checksumSha256 !== 'string' || !SHA256_HEX_PATTERN.test(input.checksumSha256)) {
    throw new BlobConstraintError(
      'checksum',
      'Signed uploads require a SHA-256 checksum to preserve content immutability',
    );
  }
  if (input.contentType !== MVP_BLOB_SIGNING_POLICY.contentType) {
    throw new BlobConstraintError(
      'content-type',
      `Signed uploads require ${MVP_BLOB_SIGNING_POLICY.contentType}`,
    );
  }
  if (
    !Number.isSafeInteger(input.maximumBytes) ||
    input.maximumBytes < 1 ||
    input.maximumBytes > MVP_BLOB_SIGNING_POLICY.maximumBytes
  ) {
    throw new BlobConstraintError(
      'size',
      `Signed uploads must allow between 1 and ${MVP_BLOB_SIGNING_POLICY.maximumBytes} bytes`,
    );
  }
  validateSignedExpiry(input.expiresAt, now);
}

export function validateSignedReadInput(
  input: {readonly key: string; readonly expiresAt: Date},
  now: Date,
): void {
  validateBlobKey(input.key);
  validateSignedExpiry(input.expiresAt, now);
}

function validateSignedExpiry(expiresAt: Date, now: Date): void {
  const expiresAtMs = expiresAt.getTime();
  const nowMs = now.getTime();
  const lifetimeMs = expiresAtMs - nowMs;
  if (
    !Number.isFinite(expiresAtMs) ||
    !Number.isFinite(nowMs) ||
    lifetimeMs <= 0 ||
    lifetimeMs > MVP_BLOB_SIGNING_POLICY.expiresAfterMs
  ) {
    throw new BlobConstraintError(
      'expiry',
      `Signed operations must expire within ${MVP_BLOB_SIGNING_POLICY.expiresAfterMs} milliseconds`,
    );
  }
}

export class BlobConstraintError extends Error {
  readonly code = 'blob_constraint_violation';

  constructor(
    readonly constraint: 'key' | 'content-type' | 'size' | 'expiry' | 'checksum',
    message: string,
  ) {
    super(message);
    this.name = 'BlobConstraintError';
  }
}

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

export class InvalidSha256HexError extends Error {
  readonly code = 'invalid_sha256_hex';

  constructor(readonly value: string) {
    super('SHA-256 digests must contain exactly 64 lowercase hexadecimal characters');
    this.name = 'InvalidSha256HexError';
  }
}
