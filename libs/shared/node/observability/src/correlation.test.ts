import {describe, expect, it} from '@shipfox/vitest/vi';
import {CorrelationContextStore, extractCorrelation, injectCorrelation} from './correlation.js';

describe('correlation context', () => {
  it('carries the same request, build, comparison, job, and account IDs into worker work', async () => {
    const apiContext = {
      accountId: 'account-1',
      buildId: 'build-1',
      comparisonId: 'comparison-1',
      jobId: 'job-1',
      requestId: 'request-1',
    };
    const jobAttributes = injectCorrelation(apiContext, {queue: 'diffs'});
    const workerContext = extractCorrelation(jobAttributes);
    const store = new CorrelationContextStore();

    await store.run(workerContext, async () => {
      await Promise.resolve();
      expect(store.current()).toEqual(apiContext);
    });
    expect(store.current()).toEqual({});
  });

  it('merges nested context and rejects values that can forge log lines', () => {
    const store = new CorrelationContextStore();

    store.run({requestId: 'request-1'}, () => {
      store.run({jobId: 'job-1'}, () => {
        expect(store.current()).toEqual({jobId: 'job-1', requestId: 'request-1'});
      });
    });
    expect(() => store.run({requestId: 'request-1\nforged'}, () => undefined)).toThrow(
      'Invalid requestId correlation value',
    );
  });
});
