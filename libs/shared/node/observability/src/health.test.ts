import {describe, expect, it} from '@shipfox/vitest/vi';
import {HealthRegistry} from './health.js';

describe('HealthRegistry', () => {
  it('keeps liveness process-local and reports dependency-aware readiness', async () => {
    let now = 0;
    const health = new HealthRegistry({clock: () => now++});
    health.registerReadinessCheck({name: 'database', check: () => undefined});
    health.registerReadinessCheck({
      name: 'queue',
      check: () => {
        throw new Error('Queue is unavailable.');
      },
    });

    expect(health.liveness().status).toBe('live');
    await expect(health.readiness()).resolves.toEqual(
      expect.objectContaining({
        checks: [
          expect.objectContaining({name: 'database', status: 'passed'}),
          expect.objectContaining({
            message: 'Queue is unavailable.',
            name: 'queue',
            status: 'failed',
          }),
        ],
        status: 'not_ready',
      }),
    );
  });

  it('supports clean shutdown liveness and unregistering readiness checks', async () => {
    const health = new HealthRegistry();
    const unregister = health.registerReadinessCheck({name: 'database', check: () => undefined});
    unregister();
    health.markNotLive('Process is shutting down.');

    expect(health.liveness()).toEqual(
      expect.objectContaining({reason: 'Process is shutting down.', status: 'not_live'}),
    );
    await expect(health.readiness()).resolves.toEqual(
      expect.objectContaining({checks: [], status: 'ready'}),
    );
  });

  it('rejects duplicate readiness names', () => {
    const health = new HealthRegistry();
    health.registerReadinessCheck({name: 'database', check: () => undefined});

    expect(() => health.registerReadinessCheck({name: 'database', check: () => undefined})).toThrow(
      'already registered',
    );
  });
});
