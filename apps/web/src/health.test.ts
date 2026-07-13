import {describe, expect, it, vi} from '@shipfox/vitest/vi';
import {webReadiness} from './health.js';

describe('web readiness', () => {
  it('tracks API readiness', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {status: 200}));
    await expect(webReadiness('http://api.test', request)).resolves.toEqual({status: 'ready'});
  });

  it('fails closed when the API cannot be reached', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    await expect(webReadiness('http://api.test', request)).resolves.toEqual({
      status: 'not_ready',
    });
  });
});
