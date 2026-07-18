import {POSTGRES_OUTBOX_MIGRATION} from '@glint/node-outbox';
import {describe, expect, it} from '@shipfox/vitest/vi';
import {foundationModules} from './migrate.js';

describe('migration composition root', () => {
  it('declares the foundation migration as a one-shot capability', () => {
    expect(foundationModules).toEqual([
      {name: 'transactional-outbox', migrations: [POSTGRES_OUTBOX_MIGRATION]},
    ]);
  });
});
