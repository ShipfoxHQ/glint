import {inflateSync} from 'node:zlib';
import {describe, expect, it} from '@shipfox/vitest/vi';
import {diffEngineContractTests} from './contract-test-kit.js';
import {DeterministicDiffEngine} from './in-memory.js';
import type {DiffImage} from './types.js';
import {MVP_DIFF_LIMITS} from './types.js';

const image = (bytes: readonly number[], width = 2, height = 2): DiffImage => ({
  bytes: Uint8Array.from(bytes),
  contentType: 'image/png',
  dimensions: {width, height},
  checksumSha256: bytes.join('').padEnd(64, '0').slice(0, 64),
});
const limits = MVP_DIFF_LIMITS;

diffEngineContractTests('deterministic fake', () => ({
  engine: new DeterministicDiffEngine(() => new Date(0)),
  identical: {base: image([1]), candidate: image([1])},
  changed: {base: image([1]), candidate: image([2])},
  layoutChanged: {base: image([1], 2, 2), candidate: image([2], 3, 2)},
  limits,
}));

describe('DeterministicDiffEngine limits', () => {
  it('rejects encoded inputs before comparison', async () => {
    const engine = new DeterministicDiffEngine();
    await expect(
      engine.compare({
        base: image([1, 2]),
        candidate: image([1]),
        configuration: {version: 'v1', threshold: 0.1, antiAlias: 'ignore'},
        limits: {...limits, maximumEncodedBytes: 1},
      }),
    ).rejects.toMatchObject({code: 'encoded_bytes_exceeded'});
  });

  it('returns a complete PNG mask artifact', async () => {
    const engine = new DeterministicDiffEngine();
    const result = await engine.compare({
      base: image([1]),
      candidate: image([2]),
      configuration: {version: 'v1', threshold: 0.1, antiAlias: 'ignore'},
      limits,
    });
    if (result.status !== 'changed') throw new Error('Expected a changed result');
    expect(result.mask.bytes.subarray(0, 8)).toEqual(
      Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    const view = new DataView(
      result.mask.bytes.buffer,
      result.mask.bytes.byteOffset,
      result.mask.bytes.byteLength,
    );
    expect(view.getUint32(16)).toBe(result.width);
    expect(view.getUint32(20)).toBe(result.height);

    const idatLength = view.getUint32(33);
    expect(new TextDecoder().decode(result.mask.bytes.subarray(37, 41))).toBe('IDAT');
    const scanlines = inflateSync(result.mask.bytes.subarray(41, 41 + idatLength));
    expect([...scanlines.subarray(0, 5)]).toEqual([0, 255, 0, 0, 255]);
    expect(new TextDecoder().decode(result.mask.bytes.subarray(-8, -4))).toBe('IEND');
  });
});
