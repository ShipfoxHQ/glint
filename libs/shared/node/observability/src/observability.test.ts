import {instanceMetrics, trace} from '@shipfox/node-opentelemetry';
import {describe, expect, it, vi} from '@shipfox/vitest/vi';
import {loadObservabilityEnvironment} from './config.js';

describe('observability adapters', () => {
  it('validates the flat observability environment before startup', () => {
    expect(() =>
      loadObservabilityEnvironment({
        GLINT_OBSERVABILITY_ENABLED: 'true',
        OTEL_INSTANCE_METRICS_PORT: 'not-a-port',
      }),
    ).toThrow('OTEL_INSTANCE_METRICS_PORT');
  });

  it('defaults to disabled without starting a telemetry provider', () => {
    expect(loadObservabilityEnvironment({}).GLINT_OBSERVABILITY_ENABLED).toBe(false);
  });

  it('uses the Shipfox-exported OpenTelemetry APIs as safe no-ops before startup', () => {
    const callback = vi.fn();
    const counter = instanceMetrics.getMeter('glint-test').createCounter('test_total');

    counter.add(1);
    trace.getTracer('glint-test').startActiveSpan('test', (span) => {
      callback();
      span.end();
    });

    expect(callback).toHaveBeenCalledOnce();
  });
});
