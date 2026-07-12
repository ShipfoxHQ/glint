import {createHash} from 'node:crypto';
import {
  DeleteObjectCommand,
  GetBucketLocationCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {createPresignedPost} from '@aws-sdk/s3-presigned-post';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import type {
  BlobMetadata,
  BlobStore,
  BlobStoreHealth,
  PutBlobInput,
  SignedMultipartUpload,
  SignedRead,
  SignedUploadInput,
} from './types.js';
import {
  BlobChecksumMismatchError,
  parseSha256Hex,
  validateBlobKey,
  validateSignedReadInput,
  validateSignedUploadInput,
} from './types.js';

export interface S3BlobStoreConfig {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint?: string;
  readonly forcePathStyle?: boolean;
  readonly credentials?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
  };
}

const CHECKSUM_METADATA_KEY = 'glint-checksum-sha256';
const CREATED_AT_METADATA_KEY = 'glint-created-at';
const MAXIMUM_CONDITIONAL_WRITE_ATTEMPTS = 3;

const checksum = (body: Uint8Array) =>
  parseSha256Hex(createHash('sha256').update(body).digest('hex'));

const checksumBase64 = (checksumSha256: string): string =>
  Buffer.from(checksumSha256, 'hex').toString('base64');

const statusCodeOf = (error: unknown): number | undefined => {
  if (!(error instanceof Error) || !('$metadata' in error)) return undefined;
  const metadata = error.$metadata as {readonly httpStatusCode?: number};
  return metadata.httpStatusCode;
};

const isMissing = (error: unknown): boolean =>
  statusCodeOf(error) === 404 ||
  (error instanceof Error && (error.name === 'NoSuchKey' || error.name === 'NotFound'));

const normalizePostFields = (
  fields: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key === 'Content-Type' ? key : key.toLowerCase(),
      value,
    ]),
  );

export class S3BlobStore implements BlobStore {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #now: () => Date;

  constructor(config: S3BlobStoreConfig, client?: S3Client, now: () => Date = () => new Date()) {
    if (config.bucket.length === 0) throw new Error('bucket must not be empty');
    if (config.region.length === 0) throw new Error('region must not be empty');
    this.#bucket = config.bucket;
    this.#now = now;
    this.#client =
      client ??
      new S3Client({
        region: config.region,
        ...(config.endpoint ? {endpoint: config.endpoint} : {}),
        ...(config.forcePathStyle === undefined ? {} : {forcePathStyle: config.forcePathStyle}),
        ...(config.credentials ? {credentials: config.credentials} : {}),
      });
  }

  put(input: PutBlobInput): Promise<{readonly status: 'created' | 'already-exists'}> {
    return Promise.resolve().then(() => {
      validateBlobKey(input.key);
      const actual = checksum(input.body);
      if (input.checksumSha256 && input.checksumSha256 !== actual) {
        throw new BlobChecksumMismatchError(input.checksumSha256, actual);
      }
      return this.#putObject(input, actual, this.#now(), MAXIMUM_CONDITIONAL_WRITE_ATTEMPTS);
    });
  }

  async #putObject(
    input: PutBlobInput,
    actual: ReturnType<typeof checksum>,
    createdAt: Date,
    attemptsRemaining: number,
  ): Promise<{readonly status: 'created' | 'already-exists'}> {
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
          ChecksumSHA256: checksumBase64(actual),
          IfNoneMatch: '*',
          ServerSideEncryption: 'AES256',
          Metadata: {
            [CHECKSUM_METADATA_KEY]: actual,
            [CREATED_AT_METADATA_KEY]: createdAt.toISOString(),
          },
        }),
      );
      return {status: 'created'};
    } catch (error) {
      if (statusCodeOf(error) === 412) return {status: 'already-exists'};
      if (statusCodeOf(error) === 409 && attemptsRemaining > 1) {
        return this.#putObject(input, actual, createdAt, attemptsRemaining - 1);
      }
      throw error;
    }
  }

  async read(key: string): Promise<Uint8Array | undefined> {
    validateBlobKey(key);
    try {
      const response = await this.#client.send(
        new GetObjectCommand({Bucket: this.#bucket, Key: key}),
      );
      return response.Body
        ? Uint8Array.from(await response.Body.transformToByteArray())
        : undefined;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async head(key: string): Promise<BlobMetadata | undefined> {
    validateBlobKey(key);
    try {
      const response = await this.#client.send(
        new HeadObjectCommand({Bucket: this.#bucket, Key: key, ChecksumMode: 'ENABLED'}),
      );
      const checksumSha256 = response.Metadata?.[CHECKSUM_METADATA_KEY]
        ? parseSha256Hex(response.Metadata[CHECKSUM_METADATA_KEY])
        : response.ChecksumSHA256
          ? parseSha256Hex(Buffer.from(response.ChecksumSHA256, 'base64').toString('hex'))
          : undefined;
      if (
        response.ContentType === undefined ||
        response.ContentLength === undefined ||
        checksumSha256 === undefined
      ) {
        throw new Error('S3 object metadata is incomplete');
      }
      const createdAtValue = response.Metadata?.[CREATED_AT_METADATA_KEY];
      const createdAt = createdAtValue ? new Date(createdAtValue) : response.LastModified;
      if (!createdAt || !Number.isFinite(createdAt.getTime())) {
        throw new Error('S3 object creation time is missing');
      }
      return {
        key,
        contentType: response.ContentType,
        size: response.ContentLength,
        checksumSha256,
        createdAt: new Date(createdAt),
      };
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    validateBlobKey(key);
    await this.#client.send(new DeleteObjectCommand({Bucket: this.#bucket, Key: key}));
  }

  async signUpload(input: SignedUploadInput): Promise<SignedMultipartUpload> {
    const now = this.#now();
    validateSignedUploadInput(input, now);
    const expiresIn = Math.ceil((input.expiresAt.getTime() - now.getTime()) / 1_000);
    const checksumFields = {
      'x-amz-checksum-algorithm': 'SHA256',
      'x-amz-checksum-sha256': checksumBase64(input.checksumSha256),
      [`x-amz-meta-${CHECKSUM_METADATA_KEY}`]: input.checksumSha256,
    };
    const fields = {
      key: input.key,
      'Content-Type': input.contentType,
      'x-amz-server-side-encryption': 'AES256',
      ...checksumFields,
    };
    const signed = await createPresignedPost(this.#client, {
      Bucket: this.#bucket,
      Key: input.key,
      Expires: expiresIn,
      Fields: fields,
      Conditions: [
        {key: input.key},
        {'Content-Type': input.contentType},
        {'x-amz-server-side-encryption': 'AES256'},
        ['content-length-range', 1, input.maximumBytes],
        ...Object.entries(checksumFields).map(([key, value]) => ({[key]: value})),
      ],
    });
    return {
      method: 'POST',
      url: signed.url,
      fields: normalizePostFields(signed.fields),
      fileField: 'file',
      expiresAt: new Date(input.expiresAt),
      constraints: {
        key: input.key,
        contentType: input.contentType,
        maximumBytes: input.maximumBytes,
        checksumSha256: input.checksumSha256,
      },
    };
  }

  async signRead(input: {readonly key: string; readonly expiresAt: Date}): Promise<SignedRead> {
    const now = this.#now();
    validateSignedReadInput(input, now);
    const expiresIn = Math.ceil((input.expiresAt.getTime() - now.getTime()) / 1_000);
    const url = await getSignedUrl(
      this.#client,
      new GetObjectCommand({Bucket: this.#bucket, Key: input.key}),
      {expiresIn},
    );
    return {
      method: 'GET',
      key: input.key,
      url,
      headers: {},
      expiresAt: new Date(input.expiresAt),
    };
  }

  async health(): Promise<BlobStoreHealth> {
    const checkedAt = this.#now();
    try {
      await this.#client.send(new GetBucketLocationCommand({Bucket: this.#bucket}));
      return {status: 'ready', checkedAt};
    } catch {
      return {
        status: 'unavailable',
        checkedAt,
        detail: 'S3 object store is unavailable',
      };
    }
  }
}

export const createS3BlobStore = (config: S3BlobStoreConfig): BlobStore => new S3BlobStore(config);
