import {createRedactor} from '@shipfox/redact';
import type {CorrelationContextStore} from './correlation.js';

export type LogAttributes = Readonly<Record<string, unknown>>;

export interface StructuredLogger {
  child(attributes: LogAttributes): StructuredLogger;
  debug(message: string, attributes?: LogAttributes): void;
  error(message: string, attributes?: LogAttributes): void;
  fatal(message: string, attributes?: LogAttributes): void;
  info(message: string, attributes?: LogAttributes): void;
  trace(message: string, attributes?: LogAttributes): void;
  warn(message: string, attributes?: LogAttributes): void;
}

export function createRedactingLogger(
  delegate: StructuredLogger,
  options: {
    readonly correlations?: CorrelationContextStore;
    readonly secrets?: readonly string[];
  } = {},
): StructuredLogger {
  const redactor = createRedactor({...(options.secrets ? {secrets: options.secrets} : {})});

  function attributes(input: LogAttributes = {}): LogAttributes {
    return redactor.redact({...options.correlations?.current(), ...input}) as LogAttributes;
  }

  return {
    child: (bindings) =>
      createRedactingLogger(delegate.child(attributes(bindings)), {
        ...(options.correlations ? {correlations: options.correlations} : {}),
        ...(options.secrets ? {secrets: options.secrets} : {}),
      }),
    debug: (message, input) => delegate.debug(redactor.redact(message), attributes(input)),
    error: (message, input) => delegate.error(redactor.redact(message), attributes(input)),
    fatal: (message, input) => delegate.fatal(redactor.redact(message), attributes(input)),
    info: (message, input) => delegate.info(redactor.redact(message), attributes(input)),
    trace: (message, input) => delegate.trace(redactor.redact(message), attributes(input)),
    warn: (message, input) => delegate.warn(redactor.redact(message), attributes(input)),
  };
}

type ShipfoxLoggerFactory = typeof import('@shipfox/node-opentelemetry')['logger'];

function structuredShipfoxLogger(
  logger: ShipfoxLoggerFactory,
  bindings: LogAttributes = {},
): StructuredLogger {
  const write =
    (level: 'debug' | 'error' | 'fatal' | 'info' | 'trace' | 'warn') =>
    (message: string, attributes: LogAttributes = {}): void => {
      logger()[level]({...bindings, ...attributes}, message);
    };

  return {
    child: (attributes) => structuredShipfoxLogger(logger, {...bindings, ...attributes}),
    debug: write('debug'),
    error: write('error'),
    fatal: write('fatal'),
    info: write('info'),
    trace: write('trace'),
    warn: write('warn'),
  };
}

export async function createGlintLogger(
  options: {
    readonly correlations?: CorrelationContextStore;
    readonly secrets?: readonly string[];
  } = {},
): Promise<StructuredLogger> {
  const {logger} = await import('@shipfox/node-opentelemetry');
  return createRedactingLogger(structuredShipfoxLogger(logger), options);
}
