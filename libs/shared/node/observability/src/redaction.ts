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

const redacted = '[REDACTED]';
const sensitiveKey =
  /(?:authorization|cookie|credential|password|private[_-]?key|secret|signature|token|api[_-]?key)/i;
const signedQueryKey =
  /^(?:googleaccessid|policy|signature|sig|x-amz-(?:algorithm|credential|date|expires|security-token|signature|signedheaders))$/i;

export interface Redactor {
  redact<T>(value: T): T;
}

function redactUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }

  if (parsed.username || parsed.password) {
    parsed.username = redacted;
    parsed.password = redacted;
  }

  const signed = [...parsed.searchParams.keys()].some((key) => signedQueryKey.test(key));
  if (signed) {
    parsed.search = `?${redacted}`;
    parsed.hash = '';
    return parsed.toString();
  }

  for (const key of [...parsed.searchParams.keys()]) {
    if (sensitiveKey.test(key)) parsed.searchParams.set(key, redacted);
  }

  return parsed.toString();
}

function redactString(value: string, secrets: readonly string[]): string {
  let result = value.replace(/Bearer\s+[^\s,;]+/gi, `Bearer ${redacted}`);
  result = result.replace(
    /((?:set-)?cookie|x-hub-signature(?:-256)?)\s*[:=]\s*[^\r\n]+/gi,
    `$1: ${redacted}`,
  );
  result = result.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactUrl(url));

  for (const secret of secrets) {
    result = result.split(secret).join(redacted);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) result = result.split(encoded).join(redacted);
  }

  return result;
}

export function createRedactor(options: {readonly secrets?: readonly string[]} = {}): Redactor {
  const secrets = [...new Set(options.secrets?.filter((secret) => secret.length > 0) ?? [])].sort(
    (left, right) => right.length - left.length,
  );

  function visit(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === 'string') return redactString(value, secrets);
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof URL) return redactUrl(value.toString());
    if (value instanceof Date) return value.toISOString();
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (value instanceof Error) {
      return {
        cause: value.cause === undefined ? undefined : visit(value.cause, seen),
        message: redactString(value.message, secrets),
        name: value.name,
        stack: value.stack ? redactString(value.stack, secrets) : undefined,
      };
    }
    if (Array.isArray(value)) return value.map((item) => visit(item, seen));

    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveKey.test(key) ? redacted : visit(item, seen),
      ]),
    );
  }

  return {
    redact: <T>(value: T): T => visit(value, new WeakSet()) as T,
  };
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
    return redactor.redact({...options.correlations?.current(), ...input});
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
