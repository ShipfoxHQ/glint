import {inflateSync} from 'node:zlib';
import {describe, expect, it} from '@shipfox/vitest/vi';
import type {DiffEngine, DiffImage, DiffLimits} from './types.js';

export interface DiffEngineContractHarness {
  readonly engine: DiffEngine;
  readonly identical: {readonly base: DiffImage; readonly candidate: DiffImage};
  readonly changed: {readonly base: DiffImage; readonly candidate: DiffImage};
  readonly layoutChanged: {readonly base: DiffImage; readonly candidate: DiffImage};
  readonly limits: DiffLimits;
}

const configuration = {version: 'contract-v1', threshold: 0.1, antiAlias: 'ignore'} as const;
const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

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

const expectValidPng = (bytes: Uint8Array, width: number, height: number): void => {
  expect(bytes.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: {readonly type: string; readonly data: Uint8Array}[] = [];
  let offset = PNG_SIGNATURE.byteLength;
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) throw new Error('Truncated PNG chunk');
    const length = view.getUint32(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.byteLength) throw new Error('Truncated PNG chunk data');
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, dataStart));
    expect(view.getUint32(dataEnd)).toBe(crc32(bytes.subarray(offset + 4, dataEnd)));
    chunks.push({type, data: bytes.subarray(dataStart, dataEnd)});
    offset = dataEnd + 4;
  }

  expect(offset).toBe(bytes.byteLength);
  expect(chunks[0]?.type).toBe('IHDR');
  expect(chunks[0]?.data.byteLength).toBe(13);
  expect(view.getUint32(16)).toBe(width);
  expect(view.getUint32(20)).toBe(height);
  expect(chunks.at(-1)?.type).toBe('IEND');
  expect(chunks.at(-1)?.data.byteLength).toBe(0);
  const imageData = chunks.filter(({type}) => type === 'IDAT').map(({data}) => Buffer.from(data));
  expect(imageData.length).toBeGreaterThan(0);
  expect(() => inflateSync(Buffer.concat(imageData))).not.toThrow();
};

const withDimensions = (
  image: DiffImage,
  dimensions: Partial<DiffImage['dimensions']>,
): DiffImage => ({...image, dimensions: {...image.dimensions, ...dimensions}});

export function diffEngineContractTests(
  name: string,
  createHarness: () => Promise<DiffEngineContractHarness> | DiffEngineContractHarness,
): void {
  describe(`${name} diff-engine contract`, () => {
    it('reports exact equality as unchanged', async () => {
      const {engine, identical, limits} = await createHarness();
      await expect(engine.compare({...identical, configuration, limits})).resolves.toEqual({
        status: 'unchanged',
      });
    });

    it('returns deterministic changed pixels, mask, and regions', async () => {
      const {engine, changed, limits} = await createHarness();
      const first = await engine.compare({...changed, configuration, limits});
      const second = await engine.compare({...changed, configuration, limits});
      expect(first).toEqual(second);
      expect(first).toMatchObject({
        status: 'changed',
        width: changed.candidate.dimensions.width,
        height: changed.candidate.dimensions.height,
      });
      if (first.status !== 'changed') throw new Error('Expected a changed result');
      expect(first.differentPixels).toBeGreaterThan(0);
      expect(first.differenceRatio).toBeGreaterThan(0);
      expect(first.mask.bytes.byteLength).toBeGreaterThan(0);
      expectValidPng(first.mask.bytes, first.width, first.height);
      expect(first.regions.length).toBeGreaterThan(0);
    });

    it('reports dimension changes explicitly', async () => {
      const {engine, layoutChanged, limits} = await createHarness();
      await expect(
        engine.compare({...layoutChanged, configuration, limits}),
      ).resolves.toMatchObject({
        status: 'layout-changed',
        base: layoutChanged.base.dimensions,
        candidate: layoutChanged.candidate.dimensions,
      });
    });

    it('enforces encoded input, decoded pixel, and dimension limits', async () => {
      const {engine, changed, limits} = await createHarness();

      await expect(
        engine.compare({
          ...changed,
          configuration,
          limits: {...limits, maximumEncodedBytes: 0},
        }),
      ).rejects.toMatchObject({code: 'encoded_bytes_exceeded'});
      await expect(
        engine.compare({
          ...changed,
          configuration,
          limits: {...limits, maximumDecodedPixels: 0},
        }),
      ).rejects.toMatchObject({code: 'decoded_pixels_exceeded'});
      for (const images of [
        {
          base: withDimensions(changed.base, {width: limits.maximumWidth + 1}),
          candidate: changed.candidate,
        },
        {
          base: changed.base,
          candidate: withDimensions(changed.candidate, {width: limits.maximumWidth + 1}),
        },
        {
          base: withDimensions(changed.base, {height: limits.maximumHeight + 1}),
          candidate: changed.candidate,
        },
        {
          base: changed.base,
          candidate: withDimensions(changed.candidate, {height: limits.maximumHeight + 1}),
        },
      ]) {
        await expect(engine.compare({...images, configuration, limits})).rejects.toMatchObject({
          code: 'dimensions_exceeded',
        });
      }
    });

    it('rejects non-positive image dimensions', async () => {
      const {engine, changed, limits} = await createHarness();
      for (const images of [
        {base: withDimensions(changed.base, {width: 0}), candidate: changed.candidate},
        {base: changed.base, candidate: withDimensions(changed.candidate, {width: 0})},
        {base: withDimensions(changed.base, {height: 0}), candidate: changed.candidate},
        {base: changed.base, candidate: withDimensions(changed.candidate, {height: 0})},
      ]) {
        await expect(engine.compare({...images, configuration, limits})).rejects.toMatchObject({
          code: 'dimensions_exceeded',
        });
      }
    });

    it('rejects generated artifacts above the configured output limit', async () => {
      const {engine, changed, limits} = await createHarness();
      await expect(
        engine.compare({
          ...changed,
          configuration,
          limits: {...limits, maximumOutputBytes: 0},
        }),
      ).rejects.toMatchObject({code: 'generated_artifact_exceeded'});
    });

    it('reports the concrete engine identity through a provider-neutral health shape', async () => {
      const {engine} = await createHarness();
      await expect(engine.health()).resolves.toMatchObject({
        status: 'ready',
        engine: engine.identity.name,
        engineVersion: engine.identity.version,
      });
    });
  });
}
