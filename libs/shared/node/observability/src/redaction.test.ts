import {describe, expect, it} from '@shipfox/vitest/vi';
import {CorrelationContextStore} from './correlation.js';
import {
  createRedactingLogger,
  createRedactor,
  type LogAttributes,
  type StructuredLogger,
} from './redaction.js';

interface LogEntry {
  readonly attributes: LogAttributes;
  readonly level: string;
  readonly message: string;
}

function memoryLogger(entries: LogEntry[], bindings: LogAttributes = {}): StructuredLogger {
  const write =
    (level: string) =>
    (message: string, attributes: LogAttributes = {}): void => {
      entries.push({attributes: {...bindings, ...attributes}, level, message});
    };

  return {
    child: (attributes) => memoryLogger(entries, {...bindings, ...attributes}),
    debug: write('debug'),
    error: write('error'),
    fatal: write('fatal'),
    info: write('info'),
    trace: write('trace'),
    warn: write('warn'),
  };
}

describe('redaction', () => {
  it('redacts configured secrets from structured values and messages', () => {
    const secret = 'database-password-with-enough-entropy';
    const redactor = createRedactor({secrets: [secret]});

    const output = redactor.redact({
      databaseUrl: `postgres://glint:${secret}@db/glint`,
      nested: {value: `prefix ${secret} suffix`},
      token: 'project-token',
    });
    const serialized = JSON.stringify(output);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('project-token');
    expect(serialized).toContain('[REDACTED]');
  });

  it('redacts every signed URL query field, cookies, signatures, and bearer tokens', () => {
    const redactor = createRedactor();
    const signedUrl =
      'https://objects.example/assets/hash?X-Amz-Credential=credential&X-Amz-Signature=signature&X-Amz-Expires=300';
    const output = redactor.redact({
      authorization: 'Bearer project-token',
      cookie: 'session=secret-session',
      signedUrl,
      webhookSignature: 'sha256=secret-signature',
    });
    const serialized = JSON.stringify(output);

    expect(serialized).not.toContain('credential');
    expect(serialized).not.toContain('secret-session');
    expect(serialized).not.toContain('secret-signature');
    expect(serialized).not.toContain('project-token');
    expect(serialized).toContain('[REDACTED]');
  });

  it('redacts URL fragments, authorization schemes, and free-form token pairs', () => {
    const redactor = createRedactor();
    const output = redactor.redact([
      'https://example.com/callback#access_token=fragment-token&state=public',
      'Authorization: Basic encoded-credentials',
      'Authorization: AWS4-HMAC-SHA256 signed-credentials',
      'token=plain-token signature=plain-signature',
    ]);
    const serialized = JSON.stringify(output);

    expect(serialized).not.toContain('fragment-token');
    expect(serialized).not.toContain('encoded-credentials');
    expect(serialized).not.toContain('signed-credentials');
    expect(serialized).not.toContain('plain-token');
    expect(serialized).not.toContain('plain-signature');
    expect(serialized).toContain('[REDACTED]');
  });

  it('redacts credentials and configured secrets inside non-HTTP URL objects', () => {
    const secret = 'configured-secret';
    const redactor = createRedactor({secrets: [secret]});
    const output = redactor.redact(
      new URL(`postgres://db-user:db-password@example.com/${secret}?opaque=${secret}`),
    );

    expect(output).not.toContain('db-user');
    expect(output).not.toContain('db-password');
    expect(output).not.toContain(secret);
  });

  it('redacts logger messages and attributes before delegating', () => {
    const secret = 'configured-secret';
    const entries: LogEntry[] = [];
    const logger = createRedactingLogger(memoryLogger(entries), {secrets: [secret]});

    logger.info(`Using ${secret}`, {
      authorization: 'Basic encoded-credentials',
      endpoint: `https://example.com/callback#access_token=fragment-token`,
    });

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('encoded-credentials');
    expect(serialized).not.toContain('fragment-token');
    expect(serialized).toContain('[REDACTED]');
  });

  it('adds the active API or worker correlation IDs to every log record', () => {
    const entries: LogEntry[] = [];
    const correlations = new CorrelationContextStore();
    const logger = createRedactingLogger(memoryLogger(entries), {correlations});

    correlations.run({accountId: 'account-1', jobId: 'job-1', requestId: 'request-1'}, () => {
      logger.info('Comparison started', {comparisonId: 'comparison-1'});
    });

    expect(entries).toEqual([
      {
        attributes: {
          accountId: 'account-1',
          comparisonId: 'comparison-1',
          jobId: 'job-1',
          requestId: 'request-1',
        },
        level: 'info',
        message: 'Comparison started',
      },
    ]);
  });
});
