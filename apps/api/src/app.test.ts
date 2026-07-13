import {InMemoryDatabase} from '@glint/node-database';
import {InMemoryBlobStore} from '@glint/node-object-store';
import {InMemoryJobQueue} from '@glint/node-queue';
import {describe, expect, it} from '@shipfox/vitest/vi';
import {createApiApp} from './app.js';

describe('API composition root', () => {
  it('reports liveness and dependency-aware readiness', async () => {
    const app = await createApiApp({
      database: new InMemoryDatabase(),
      blobStore: new InMemoryBlobStore(),
      queue: new InMemoryJobQueue(),
    });
    expect((await app.inject({method: 'GET', url: '/live'})).statusCode).toBe(200);
    expect((await app.inject({method: 'GET', url: '/ready'})).statusCode).toBe(200);
    await app.close();
  });

  it('starts only declared module routes', async () => {
    const app = await createApiApp({
      database: new InMemoryDatabase(),
      blobStore: new InMemoryBlobStore(),
      queue: new InMemoryJobQueue(),
      modules: [
        {
          name: 'fixture',
          routes: [
            {
              name: 'fixture',
              value: (server) => {
                server.get('/fixture', () => ({ok: true}));
              },
            },
          ],
        },
      ],
    });
    expect((await app.inject({method: 'GET', url: '/fixture'})).json()).toEqual({ok: true});
    await app.close();
  });
});
