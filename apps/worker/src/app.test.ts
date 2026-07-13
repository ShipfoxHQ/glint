import {InMemoryDatabase} from '@glint/node-database';
import {InMemoryBlobStore} from '@glint/node-object-store';
import {InMemoryJobQueue} from '@glint/node-queue';
import {describe, expect, it, vi} from '@shipfox/vitest/vi';
import {createWorkerApp} from './app.js';

describe('worker composition root', () => {
  it('reports runtime and adapter readiness', async () => {
    const odiffReady = vi.fn();
    const app = await createWorkerApp({
      database: new InMemoryDatabase(),
      blobStore: new InMemoryBlobStore(),
      queue: new InMemoryJobQueue(),
      odiffReady,
    });
    expect((await app.inject({method: 'GET', url: '/live'})).statusCode).toBe(200);
    expect((await app.inject({method: 'GET', url: '/ready'})).statusCode).toBe(200);
    expect(odiffReady).toHaveBeenCalledOnce();
    await app.close();
  });

  it('rejects readiness when the pinned ODiff check fails', async () => {
    const app = await createWorkerApp({
      database: new InMemoryDatabase(),
      blobStore: new InMemoryBlobStore(),
      queue: new InMemoryJobQueue(),
      odiffReady: () => {
        throw new Error('ODiff version mismatch.');
      },
    });
    const response = await app.inject({method: 'GET', url: '/ready'});
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({status: 'not_ready'});
    await app.close();
  });
});
