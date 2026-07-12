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
