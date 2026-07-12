export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

export interface DiffImage {
  readonly bytes: Uint8Array;
  readonly contentType: 'image/png';
  readonly dimensions: Dimensions;
  readonly checksumSha256: string;
}

export interface DiffLimits {
  readonly maximumEncodedBytes: number;
  readonly maximumDecodedPixels: number;
  readonly maximumWidth: number;
  readonly maximumHeight: number;
  readonly maximumOutputBytes: number;
  readonly timeoutMs: number;
}

export const MVP_DIFF_LIMITS: DiffLimits = {
  maximumEncodedBytes: 8 * 1024 * 1024,
  maximumDecodedPixels: 16_777_216,
  maximumWidth: 4_096,
  maximumHeight: 16_384,
  maximumOutputBytes: 8 * 1024 * 1024,
  timeoutMs: 5_000,
};

export interface DiffConfiguration {
  readonly version: string;
  /** Per-channel difference ratio from 0 (exact match) through 1 (maximum difference). */
  readonly threshold: number;
  readonly antiAlias: 'include' | 'ignore';
}

export interface DiffMaskArtifact {
  readonly bytes: Uint8Array;
  readonly contentType: 'image/png';
}

export type DiffResult =
  | {readonly status: 'unchanged'}
  | {
      readonly status: 'changed';
      readonly differentPixels: number;
      readonly differenceRatio: number;
      readonly width: number;
      readonly height: number;
      readonly mask: DiffMaskArtifact;
      readonly regions: readonly DimensionsRegion[];
    }
  | {
      readonly status: 'layout-changed';
      readonly base: Dimensions;
      readonly candidate: Dimensions;
      readonly mask?: DiffMaskArtifact;
    };

export interface DimensionsRegion extends Dimensions {
  readonly x: number;
  readonly y: number;
}

export interface DiffEngineHealth {
  readonly status: 'ready' | 'unavailable';
  readonly checkedAt: Date;
  readonly engine: string;
  readonly engineVersion: string;
  readonly detail?: string;
}

export interface DiffEngine {
  readonly identity: {readonly name: string; readonly version: string};
  compare(input: {
    readonly base: DiffImage;
    readonly candidate: DiffImage;
    readonly configuration: DiffConfiguration;
    readonly limits: DiffLimits;
    readonly signal?: AbortSignal;
  }): Promise<DiffResult>;
  health(): Promise<DiffEngineHealth>;
}

export class DiffInputError extends Error {
  constructor(
    readonly code:
      | 'encoded_bytes_exceeded'
      | 'decoded_pixels_exceeded'
      | 'dimensions_exceeded'
      | 'generated_artifact_exceeded'
      | 'comparison_timeout'
      | 'comparison_aborted',
    message: string,
  ) {
    super(message);
    this.name = 'DiffInputError';
  }
}
