import {instanceMetrics} from '@shipfox/node-opentelemetry';
import type {QueueTelemetry} from './types.js';

export const queueMetricNames = {
  deadLetters: 'glint_queue_dead_letters_total',
  deliveries: 'glint_queue_deliveries_total',
  enqueued: 'glint_queue_enqueued_total',
  queueAge: 'glint_queue_age_ms',
} as const;

export function createQueueTelemetry(): QueueTelemetry {
  const meter = instanceMetrics.getMeter('@glint/node-queue');
  const enqueued = meter.createCounter(queueMetricNames.enqueued);
  const deliveries = meter.createCounter(queueMetricNames.deliveries);
  const deadLetters = meter.createCounter(queueMetricNames.deadLetters);
  const queueAge = meter.createHistogram(queueMetricNames.queueAge, {unit: 'ms'});

  return {
    deadLettered: ({jobName, queue}) => deadLetters.add(1, {job_name: jobName, queue}),
    delivered: ({attempt, jobName, queue, queueAgeMs}) => {
      deliveries.add(1, {attempt, job_name: jobName, queue, redelivered: attempt > 1});
      queueAge.record(queueAgeMs, {job_name: jobName, queue});
    },
    enqueued: ({duplicate, queue}) => enqueued.add(1, {duplicate, queue}),
  };
}
