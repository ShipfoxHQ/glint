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

export class DeterministicDiffEngine implements DiffEngine {
  readonly identity = {name: 'deterministic-fake', version: '1'} as const;
  #healthStatus: DiffEngineHealth['status'] = 'ready';

  constructor(private readonly now: () => Date = () => new Date()) {}

  compare(input: {
    readonly base: DiffImage;
    readonly candidate: DiffImage;
    readonly configuration: DiffConfiguration;
    readonly limits: DiffLimits;
    readonly signal?: AbortSignal;
  }): Promise<DiffResult> {
    return Promise.resolve().then(() => {
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
      if (bytesEqual(input.base.bytes, input.candidate.bytes)) {
        return {status: 'unchanged'};
      }
      const {width, height} = input.candidate.dimensions;
      const mask = Uint8Array.from([137, 80, 78, 71]);
      if (mask.byteLength > input.limits.maximumOutputBytes) {
        throw new DiffInputError(
          'generated_artifact_exceeded',
          'Generated diff artifact exceeds the configured limit',
        );
      }
      return {
        status: 'changed',
        differentPixels: 1,
        differenceRatio: 1 / (width * height),
        width,
        height,
        mask: {bytes: mask, contentType: 'image/png'},
        regions: [{x: 0, y: 0, width: 1, height: 1}],
      };
    });
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
