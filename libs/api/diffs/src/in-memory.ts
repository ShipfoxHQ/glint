import {once} from 'node:events';
import {finished} from 'node:stream/promises';
import {createDeflate} from 'node:zlib';
import type {
  DiffConfiguration,
  DiffEngine,
  DiffEngineHealth,
  DiffImage,
  DiffLimits,
  DiffResult,
} from './types.js';
import {DiffInputError} from './types.js';

const bytesEqual = (left: Uint8Array, right: Uint8Array) =>
  left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_CONTAINER_BYTES = PNG_SIGNATURE.byteLength + 25 + 12 + 12;

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])), 8 + data.byteLength);
  return Uint8Array.from(chunk);
};

const createDifferenceMask = async (
  width: number,
  height: number,
  maximumOutputBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> => {
  const maximumCompressedBytes = maximumOutputBytes - PNG_CONTAINER_BYTES;
  if (maximumCompressedBytes < 0) {
    throw new DiffInputError(
      'generated_artifact_exceeded',
      'Generated diff artifact exceeds the configured limit',
    );
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;

  const firstScanline = Buffer.alloc(width * 4 + 1);
  firstScanline[1] = 255;
  firstScanline[4] = 255;
  const emptyScanline = Buffer.alloc(width * 4 + 1);

  const deflate = createDeflate();
  const compressedChunks: Buffer[] = [];
  let compressedBytes = 0;
  deflate.on('data', (chunk: Buffer) => {
    compressedBytes += chunk.byteLength;
    if (compressedBytes > maximumCompressedBytes) {
      deflate.destroy(
        new DiffInputError(
          'generated_artifact_exceeded',
          'Generated diff artifact exceeds the configured limit',
        ),
      );
      return;
    }
    compressedChunks.push(chunk);
  });
  const compressionFinished = finished(deflate);

  const writeScanline = async (scanline: Uint8Array): Promise<void> => {
    if (signal?.aborted) {
      throw new DiffInputError('comparison_aborted', 'Comparison was aborted');
    }
    if (!deflate.write(scanline)) await once(deflate, 'drain');
  };

  try {
    await writeScanline(firstScanline);
    for (let row = 1; row < height; row++) await writeScanline(emptyScanline);
    deflate.end();
    await compressionFinished;
  } catch (error) {
    deflate.destroy();
    await compressionFinished.catch(() => undefined);
    throw error;
  }

  const compressed = Buffer.concat(compressedChunks, compressedBytes);

  return Uint8Array.from(
    Buffer.concat([
      Buffer.from(PNG_SIGNATURE),
      Buffer.from(pngChunk('IHDR', header)),
      Buffer.from(pngChunk('IDAT', compressed)),
      Buffer.from(pngChunk('IEND', new Uint8Array())),
    ]),
  );
};

export class DeterministicDiffEngine implements DiffEngine {
  readonly identity = {name: 'deterministic-fake', version: '1'} as const;
  #healthStatus: DiffEngineHealth['status'] = 'ready';

  constructor(private readonly now: () => Date = () => new Date()) {}

  async compare(input: {
    readonly base: DiffImage;
    readonly candidate: DiffImage;
    readonly configuration: DiffConfiguration;
    readonly limits: DiffLimits;
    readonly signal?: AbortSignal;
  }): Promise<DiffResult> {
    if (input.signal?.aborted) {
      throw new DiffInputError('comparison_aborted', 'Comparison was aborted');
    }
    this.#validate(input.base, input.limits);
    this.#validate(input.candidate, input.limits);
    if (
      input.base.dimensions.width !== input.candidate.dimensions.width ||
      input.base.dimensions.height !== input.candidate.dimensions.height
    ) {
      return {
        status: 'layout-changed',
        base: {...input.base.dimensions},
        candidate: {...input.candidate.dimensions},
      };
    }
    if (bytesEqual(input.base.bytes, input.candidate.bytes)) return {status: 'unchanged'};

    const {width, height} = input.candidate.dimensions;
    const mask = await createDifferenceMask(
      width,
      height,
      input.limits.maximumOutputBytes,
      input.signal,
    );
    return {
      status: 'changed',
      differentPixels: 1,
      differenceRatio: 1 / (width * height),
      width,
      height,
      mask: {bytes: mask, contentType: 'image/png'},
      regions: [{x: 0, y: 0, width: 1, height: 1}],
    };
  }

  health(): Promise<DiffEngineHealth> {
    return Promise.resolve({
      status: this.#healthStatus,
      checkedAt: this.now(),
      engine: this.identity.name,
      engineVersion: this.identity.version,
    });
  }

  setHealthStatus(status: DiffEngineHealth['status']): void {
    this.#healthStatus = status;
  }

  #validate(image: DiffImage, limits: DiffLimits): void {
    if (image.bytes.byteLength > limits.maximumEncodedBytes) {
      throw new DiffInputError(
        'encoded_bytes_exceeded',
        'Encoded image exceeds the configured limit',
      );
    }
    if (
      image.dimensions.width <= 0 ||
      image.dimensions.height <= 0 ||
      image.dimensions.width > limits.maximumWidth ||
      image.dimensions.height > limits.maximumHeight
    ) {
      throw new DiffInputError(
        'dimensions_exceeded',
        'Image dimensions exceed the configured limit',
      );
    }
    if (image.dimensions.width * image.dimensions.height > limits.maximumDecodedPixels) {
      throw new DiffInputError(
        'decoded_pixels_exceeded',
        'Decoded image exceeds the configured limit',
      );
    }
  }
}
