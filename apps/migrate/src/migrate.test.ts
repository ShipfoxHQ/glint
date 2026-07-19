import {composeModules, selectCapabilities} from '@glint/node-module';
import {POSTGRES_OUTBOX_MIGRATION} from '@glint/node-outbox';
import {describe, expect, it} from '@shipfox/vitest/vi';
import {featureModules, foundationModules} from './migrate.js';

describe('migration composition root', () => {
  it('declares the foundation migration as a one-shot capability', () => {
    expect(foundationModules).toEqual([
      {name: 'transactional-outbox', migrations: [POSTGRES_OUTBOX_MIGRATION]},
    ]);
  });

  it('keeps feature migrations separate from shared foundation modules', () => {
    expect(featureModules).toEqual([
      {name: 'accounts', migrations: expect.any(Array)},
      {name: 'projects', migrations: expect.any(Array)},
    ]);
  });

  it('composes feature migrations after the shared transactional-outbox migration', () => {
    const composition = composeModules([...foundationModules, ...featureModules]);
    expect(
      selectCapabilities(composition, ['migrations']).migrations.map(({name}) => name),
    ).toEqual(['outbox', 'accounts', 'projects']);
  });
});
