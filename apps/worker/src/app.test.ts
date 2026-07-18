import type {Database} from '@glint/node-database';
import {InMemoryBlobStore} from '@glint/node-object-store';
import {InMemoryJobQueue} from '@glint/node-queue';
import {describe, expect, it, vi} from '@shipfox/vitest/vi';
import {createWorkerApp} from './app.js';

// The composition root only probes database readiness, so a ready health double keeps these
// wiring tests provider-neutral. Database behavior itself is covered by the PostgreSQL contract
// suites in @glint/node-database.
function readyDatabase(): Database {
  return {
    health: () => Promise.resolve({status: 'ready', checkedAtMs: 0}),
    transaction: () =>
      Promise.reject(new Error('Composition-root tests do not execute database transactions.')),
  };
}

describe('worker composition root', () => {
  it('reports runtime and adapter readiness', async () => {
    const odiffReady = vi.fn();
    const app = await createWorkerApp({
      database: readyDatabase(),
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
      database: readyDatabase(),
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

  it('starts declared worker subscribers and jobs', async () => {
    const subscriber = vi.fn();
    const job = vi.fn();
    const app = await createWorkerApp({
      database: readyDatabase(),
      blobStore: new InMemoryBlobStore(),
      queue: new InMemoryJobQueue(),
      odiffReady: vi.fn(),
      modules: [
        {
          name: 'fixture',
          subscribers: [{name: 'fixture.subscriber', value: subscriber}],
          jobs: [{name: 'fixture.job', value: job}],
        },
      ],
    });
    expect(subscriber).toHaveBeenCalledOnce();
    expect(job).toHaveBeenCalledOnce();
    await app.close();
  });
});
