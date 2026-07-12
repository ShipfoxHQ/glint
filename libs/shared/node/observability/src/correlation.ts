import {AsyncLocalStorage} from 'node:async_hooks';

export const correlationKeys = [
  'requestId',
  'buildId',
  'comparisonId',
  'jobId',
  'accountId',
] as const;

export type CorrelationKey = (typeof correlationKeys)[number];
export type CorrelationContext = Readonly<Partial<Record<CorrelationKey, string>>>;
export type CorrelationCarrier = Readonly<Record<string, string | undefined>>;

const headers: Readonly<Record<CorrelationKey, string>> = {
  accountId: 'x-glint-account-id',
  buildId: 'x-glint-build-id',
  comparisonId: 'x-glint-comparison-id',
  jobId: 'x-glint-job-id',
  requestId: 'x-glint-request-id',
};

function normalize(context: CorrelationContext): CorrelationContext {
  const result: Partial<Record<CorrelationKey, string>> = {};

  for (const key of correlationKeys) {
    const value = context[key];
    if (value === undefined) continue;
    if (value.length === 0 || value.length > 256 || /[\r\n]/.test(value)) {
      throw new Error(`Invalid ${key} correlation value.`);
    }
    result[key] = value;
  }

  return Object.freeze(result);
}

export class CorrelationContextStore {
  readonly #storage = new AsyncLocalStorage<CorrelationContext>();

  current(): CorrelationContext {
    return this.#storage.getStore() ?? {};
  }

  run<T>(context: CorrelationContext, callback: () => T): T {
    return this.#storage.run(normalize({...this.current(), ...context}), callback);
  }
}

export function injectCorrelation(
  context: CorrelationContext,
  carrier: CorrelationCarrier = {},
): CorrelationCarrier {
  const result: Record<string, string | undefined> = {...carrier};

  for (const key of correlationKeys) {
    const value = context[key];
    if (value !== undefined) result[headers[key]] = value;
  }

  return result;
}

export function extractCorrelation(carrier: CorrelationCarrier): CorrelationContext {
  const lowerCaseCarrier = Object.fromEntries(
    Object.entries(carrier).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const result: Partial<Record<CorrelationKey, string>> = {};

  for (const key of correlationKeys) {
    const value = lowerCaseCarrier[headers[key]];
    if (value !== undefined) result[key] = value;
  }

  return normalize(result);
}
