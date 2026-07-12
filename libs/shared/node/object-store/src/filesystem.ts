import {createHash, createHmac, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {constants} from 'node:fs';
import {access, link, mkdir, readFile, unlink, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import type {
  BlobMetadata,
  BlobStore,
  BlobStoreHealth,
  PutBlobInput,
  Sha256Hex,
  SignedMultipartUpload,
  SignedRead,
  SignedUploadInput,
} from './types.js';
import {
  BlobChecksumMismatchError,
  BlobConstraintError,
  MVP_BLOB_SIGNING_POLICY,
  parseSha256Hex,
  validateBlobKey,
  validateSignedReadInput,
  validateSignedUploadInput,
} from './types.js';

interface StoredBlob {
  readonly body: Uint8Array;
  readonly metadata: BlobMetadata;
}

interface StoredBlobHeader {
  readonly key: string;
  readonly contentType: string;
  readonly size: number;
  readonly checksumSha256: string;
  readonly createdAt: string;
}

export interface FilesystemBlobStoreOptions {
  readonly rootDirectory: string;
  readonly publicBaseUrl: string;
  readonly signingSecret?: string | Uint8Array;
  readonly now?: () => Date;
}

const HEADER_LENGTH_BYTES = 4;
const MAXIMUM_MULTIPART_OVERHEAD_BYTES = 64 * 1_024;
const LOCAL_UPLOAD_FIELDS = {
  expiresAt: 'x-glint-expires-at',
  maximumBytes: 'x-glint-maximum-bytes',
  checksumSha256: 'x-glint-checksum-sha256',
  signature: 'x-glint-signature',
} as const;

const sha256 = (value: Uint8Array | string) =>
  parseSha256Hex(createHash('sha256').update(value).digest('hex'));

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const errorResponse = (status: number, code: string): Response =>
  Response.json({error: code}, {status});

export class FilesystemBlobStore implements BlobStore {
  readonly #rootDirectory: string;
  readonly #uploadUrl: URL;
  readonly #readUrl: URL;
  readonly #signingSecret: Uint8Array;
  readonly #now: () => Date;

  constructor(options: FilesystemBlobStoreOptions) {
    if (options.rootDirectory.length === 0) throw new Error('rootDirectory must not be empty');
    this.#rootDirectory = options.rootDirectory;
    const baseUrl = new URL(
      options.publicBaseUrl.endsWith('/') ? options.publicBaseUrl : `${options.publicBaseUrl}/`,
    );
    this.#uploadUrl = new URL('upload', baseUrl);
    this.#readUrl = new URL('read', baseUrl);
    this.#signingSecret =
      typeof options.signingSecret === 'string'
        ? Buffer.from(options.signingSecret)
        : Uint8Array.from(options.signingSecret ?? randomBytes(32));
    this.#now = options.now ?? (() => new Date());
  }

  async put(input: PutBlobInput): Promise<{readonly status: 'created' | 'already-exists'}> {
    validateBlobKey(input.key);
    const actual = sha256(input.body);
    if (input.checksumSha256 && input.checksumSha256 !== actual) {
      throw new BlobChecksumMismatchError(input.checksumSha256, actual);
    }

    const path = this.#pathFor(input.key);
    await mkdir(dirname(path), {recursive: true});
    const createdAt = this.#now();
    const header: StoredBlobHeader = {
      key: input.key,
      contentType: input.contentType,
      size: input.body.byteLength,
      checksumSha256: actual,
      createdAt: createdAt.toISOString(),
    };
    const headerBytes = Buffer.from(JSON.stringify(header));
    const envelope = Buffer.allocUnsafe(
      HEADER_LENGTH_BYTES + headerBytes.byteLength + input.body.byteLength,
    );
    envelope.writeUInt32BE(headerBytes.byteLength, 0);
    envelope.set(headerBytes, HEADER_LENGTH_BYTES);
    envelope.set(input.body, HEADER_LENGTH_BYTES + headerBytes.byteLength);

    const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, envelope, {flag: 'wx', mode: 0o600});
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
          return {status: 'already-exists'};
        }
        throw error;
      }
      return {status: 'created'};
    } finally {
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
    }
  }

  async read(key: string): Promise<Uint8Array | undefined> {
    return (await this.#load(key))?.body;
  }

  async head(key: string): Promise<BlobMetadata | undefined> {
    return (await this.#load(key))?.metadata;
  }

  async delete(key: string): Promise<void> {
    validateBlobKey(key);
    await unlink(this.#pathFor(key)).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }

  signUpload(input: SignedUploadInput): Promise<SignedMultipartUpload> {
    validateSignedUploadInput(input, this.#now());
    const expiresAt = input.expiresAt.toISOString();
    const checksumSha256 = input.checksumSha256;
    return Promise.resolve({
      method: 'POST',
      url: this.#uploadUrl.href,
      fields: {
        key: input.key,
        'Content-Type': input.contentType,
        [LOCAL_UPLOAD_FIELDS.expiresAt]: expiresAt,
        [LOCAL_UPLOAD_FIELDS.maximumBytes]: String(input.maximumBytes),
        [LOCAL_UPLOAD_FIELDS.checksumSha256]: checksumSha256,
        [LOCAL_UPLOAD_FIELDS.signature]: this.#sign(
          'upload',
          input.key,
          input.contentType,
          String(input.maximumBytes),
          expiresAt,
          checksumSha256,
        ),
      },
      fileField: 'file',
      expiresAt: new Date(input.expiresAt),
      constraints: {
        key: input.key,
        contentType: input.contentType,
        maximumBytes: input.maximumBytes,
        checksumSha256: input.checksumSha256,
      },
    });
  }

  signRead(input: {readonly key: string; readonly expiresAt: Date}): Promise<SignedRead> {
    validateSignedReadInput(input, this.#now());
    const expiresAt = input.expiresAt.toISOString();
    const url = new URL(this.#readUrl);
    url.searchParams.set('key', input.key);
    url.searchParams.set('expiresAt', expiresAt);
    url.searchParams.set('signature', this.#sign('read', input.key, expiresAt));
    return Promise.resolve({
      method: 'GET',
      key: input.key,
      url: url.href,
      headers: {},
      expiresAt: new Date(input.expiresAt),
    });
  }

  async health(): Promise<BlobStoreHealth> {
    try {
      await mkdir(this.#rootDirectory, {recursive: true});
      await access(this.#rootDirectory, constants.R_OK | constants.W_OK);
      return {status: 'ready', checkedAt: this.#now()};
    } catch {
      return {
        status: 'unavailable',
        checkedAt: this.#now(),
        detail: 'Local object-store directory is unavailable',
      };
    }
  }

  /** Executes the signed local upload/read URLs returned by this adapter. */
  handleSignedRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === this.#uploadUrl.pathname) {
      return this.#handleSignedUpload(request);
    }
    if (request.method === 'GET' && url.pathname === this.#readUrl.pathname) {
      return this.#handleSignedRead(url);
    }
    return Promise.resolve(errorResponse(404, 'signed_blob_operation_not_found'));
  }

  async #handleSignedUpload(request: Request): Promise<Response> {
    const declaredContentLength = request.headers.get('content-length');
    if (
      declaredContentLength !== null &&
      (!/^\d+$/.test(declaredContentLength) ||
        Number(declaredContentLength) >
          MVP_BLOB_SIGNING_POLICY.maximumBytes + MAXIMUM_MULTIPART_OVERHEAD_BYTES)
    ) {
      return errorResponse(413, 'blob_request_too_large');
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return errorResponse(400, 'invalid_multipart_upload');
    }
    const key = form.get('key');
    const contentType = form.get('Content-Type');
    const maximumBytes = form.get(LOCAL_UPLOAD_FIELDS.maximumBytes);
    const expiresAt = form.get(LOCAL_UPLOAD_FIELDS.expiresAt);
    const checksumSha256 = form.get(LOCAL_UPLOAD_FIELDS.checksumSha256);
    const signature = form.get(LOCAL_UPLOAD_FIELDS.signature);
    const file = form.get('file');
    if (
      typeof key !== 'string' ||
      typeof contentType !== 'string' ||
      typeof maximumBytes !== 'string' ||
      typeof expiresAt !== 'string' ||
      typeof checksumSha256 !== 'string' ||
      typeof signature !== 'string' ||
      !(file instanceof Blob)
    ) {
      return errorResponse(400, 'invalid_multipart_upload');
    }
    if (
      !this.#signatureMatches(
        signature,
        'upload',
        key,
        contentType,
        maximumBytes,
        expiresAt,
        checksumSha256,
      )
    ) {
      return errorResponse(403, 'invalid_blob_signature');
    }
    const expiry = new Date(expiresAt);
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= this.#now().getTime()) {
      return errorResponse(403, 'expired_blob_signature');
    }
    const maximum = Number(maximumBytes);
    if (!Number.isSafeInteger(maximum) || file.size > maximum) {
      return errorResponse(413, 'blob_size_constraint_violated');
    }
    if (file.type !== contentType) {
      return errorResponse(403, 'blob_content_type_constraint_violated');
    }
    let checksum: Sha256Hex;
    try {
      checksum = parseSha256Hex(checksumSha256);
      const result = await this.put({
        key,
        body: new Uint8Array(await file.arrayBuffer()),
        contentType,
        checksumSha256: checksum,
      });
      if (result.status === 'already-exists') {
        return errorResponse(409, 'blob_already_exists');
      }
    } catch (error) {
      if (error instanceof BlobChecksumMismatchError) {
        return errorResponse(403, 'blob_checksum_constraint_violated');
      }
      if (error instanceof BlobConstraintError) {
        return errorResponse(400, 'blob_constraint_violated');
      }
      return errorResponse(500, 'blob_store_unavailable');
    }
    return new Response(null, {status: 204});
  }

  async #handleSignedRead(url: URL): Promise<Response> {
    const key = url.searchParams.get('key');
    const expiresAt = url.searchParams.get('expiresAt');
    const signature = url.searchParams.get('signature');
    if (!key || !expiresAt || !signature) {
      return errorResponse(400, 'invalid_signed_blob_read');
    }
    if (!this.#signatureMatches(signature, 'read', key, expiresAt)) {
      return errorResponse(403, 'invalid_blob_signature');
    }
    const expiry = new Date(expiresAt);
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= this.#now().getTime()) {
      return errorResponse(403, 'expired_blob_signature');
    }
    const blob = await this.#load(key);
    if (!blob) return errorResponse(404, 'blob_not_found');
    return new Response(blob.body, {
      status: 200,
      headers: {
        'content-type': blob.metadata.contentType,
        'content-length': String(blob.metadata.size),
        etag: `"${blob.metadata.checksumSha256}"`,
      },
    });
  }

  async #load(key: string): Promise<StoredBlob | undefined> {
    validateBlobKey(key);
    let envelope: Buffer;
    try {
      envelope = await readFile(this.#pathFor(key));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (envelope.byteLength < HEADER_LENGTH_BYTES) throw new Error('Invalid local blob envelope');
    const headerLength = envelope.readUInt32BE(0);
    const bodyOffset = HEADER_LENGTH_BYTES + headerLength;
    if (bodyOffset > envelope.byteLength) throw new Error('Invalid local blob envelope');
    const header = JSON.parse(
      envelope.subarray(HEADER_LENGTH_BYTES, bodyOffset).toString('utf8'),
    ) as StoredBlobHeader;
    if (header.key !== key || header.size !== envelope.byteLength - bodyOffset) {
      throw new Error('Invalid local blob envelope');
    }
    return {
      body: Uint8Array.from(envelope.subarray(bodyOffset)),
      metadata: {
        key,
        contentType: header.contentType,
        size: header.size,
        checksumSha256: parseSha256Hex(header.checksumSha256),
        createdAt: new Date(header.createdAt),
      },
    };
  }

  #pathFor(key: string): string {
    const digest = createHash('sha256').update(key).digest('hex');
    return join(this.#rootDirectory, 'objects', digest.slice(0, 2), digest);
  }

  #sign(...parts: string[]): string {
    return createHmac('sha256', this.#signingSecret)
      .update(parts.join('\u0000'))
      .digest('base64url');
  }

  #signatureMatches(signature: string, ...parts: string[]): boolean {
    const expected = Buffer.from(this.#sign(...parts));
    const actual = Buffer.from(signature);
    return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
  }
}
