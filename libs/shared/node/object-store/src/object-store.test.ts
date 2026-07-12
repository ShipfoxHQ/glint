import {describe, expect, it} from '@shipfox/vitest/vi';
import {blobStoreContractTests} from './contract-test-kit.js';
import {InMemoryBlobStore} from './in-memory.js';

blobStoreContractTests('in-memory', () => new InMemoryBlobStore(() => new Date(0)));

describe('InMemoryBlobStore signed reads', () => {
  it('scopes its path-based signed URL to the requested key', async () => {
    const store = new InMemoryBlobStore(() => new Date(0));
    const signed = await store.signRead({
      key: 'tenant/source/hash',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    });

    expect(decodeURIComponent(new URL(signed.url).pathname)).toContain('tenant/source/hash');
  });
});
