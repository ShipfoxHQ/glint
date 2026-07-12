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

  it('rejects generated artifacts above the output ceiling', async () => {
    const engine = new DeterministicDiffEngine();
    await expect(
      engine.compare({
        base: image([1]),
        candidate: image([2]),
        configuration: {version: 'v1', threshold: 0.1, antiAlias: 'ignore'},
        limits: {...limits, maximumOutputBytes: 3},
      }),
    ).rejects.toMatchObject({code: 'generated_artifact_exceeded'});
  });
});
