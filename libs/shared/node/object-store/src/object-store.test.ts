import {describe, expect, it} from '@shipfox/vitest/vi';
import {blobStoreContractTests} from './contract-test-kit.js';
import {InMemoryBlobStore} from './in-memory.js';

blobStoreContractTests(
  'in-memory',
  () => new InMemoryBlobStore(() => new Date(0)),
  () => new Date(0),
);

describe('InMemoryBlobStore signed reads', () => {
  it('scopes its path-based signed URL to the requested key', async () => {
    const store = new InMemoryBlobStore(() => new Date(0));
    const signed = await store.signRead({
      key: 'tenant/source/hash',
      expiresAt: new Date(5 * 60 * 1_000),
    });

    expect(decodeURIComponent(new URL(signed.url).pathname)).toContain('tenant/source/hash');
  });

  it('reports explicitly configured unavailability', async () => {
    const store = new InMemoryBlobStore(() => new Date(0));
    store.setHealth({
      status: 'unavailable',
      checkedAt: new Date(0),
      detail: 'fixture unavailable',
    });

    await expect(store.health()).resolves.toMatchObject({
      status: 'unavailable',
      detail: 'fixture unavailable',
    });
  });
});
