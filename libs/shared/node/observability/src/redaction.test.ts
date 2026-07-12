import {REDACTION_PLACEHOLDER} from '@shipfox/redact';
import {describe, expect, it} from '@shipfox/vitest/vi';
import {CorrelationContextStore} from './correlation.js';
import {createRedactingLogger, type LogAttributes, type StructuredLogger} from './redaction.js';

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
  it('redacts configured secrets and their supported wire forms at the logger boundary', () => {
    const secret = 'configured-secret+/=with-enough-entropy';
    const wireForms = [
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString('base64'),
      Buffer.from(secret).toString('base64url'),
      Buffer.from(secret).toString('hex'),
      Buffer.from(secret).toString('hex').toUpperCase(),
    ];
    const entries: LogEntry[] = [];
    const logger = createRedactingLogger(memoryLogger(entries), {secrets: [secret]});

    logger.info(`Observed ${wireForms.join(' ')}`, {nested: {value: `prefix ${secret} suffix`}});

    const serialized = JSON.stringify(entries);
    for (const wireForm of wireForms) expect(serialized).not.toContain(wireForm);
    expect(serialized).toContain(REDACTION_PLACEHOLDER);
  });

  it('redacts signed URLs, OAuth fragments, authorization, cookies, and signatures', () => {
    const entries: LogEntry[] = [];
    const logger = createRedactingLogger(memoryLogger(entries));
    const signedUrl =
      'https://objects.example/assets/hash?X-Amz-Credential=credential&X-Amz-Signature=signature&X-Amz-Expires=300';
    logger.info(
      [
        'Authorization: Basic encoded-credentials',
        'Authorization: Bearer bearer-token',
        'Authorization: AWS4-HMAC-SHA256 signed-credentials',
        'Cookie: session=secret-session',
        'X-Hub-Signature-256: sha256=secret-signature',
        'token=plain-token signature=plain-signature',
        signedUrl,
        'https://example.com/callback#access_token=fragment-token&state=public',
        'postgres://db-user:db-password@example.com/glint',
      ].join('\n'),
    );
    const serialized = JSON.stringify(entries);

    expect(serialized).not.toContain('encoded-credentials');
    expect(serialized).not.toContain('bearer-token');
    expect(serialized).not.toContain('signed-credentials');
    expect(serialized).not.toContain('secret-session');
    expect(serialized).not.toContain('secret-signature');
    expect(serialized).not.toContain('fragment-token');
    expect(serialized).not.toContain('plain-token');
    expect(serialized).not.toContain('plain-signature');
    expect(serialized).not.toContain('db-user');
    expect(serialized).not.toContain('db-password');
    expect(serialized).not.toContain('X-Amz-Credential=credential');
    expect(serialized).not.toContain('X-Amz-Signature=signature');
    expect(serialized).toContain(REDACTION_PLACEHOLDER);
  });

  it('redacts nested URL and Error values without mutating or recursing through cycles', () => {
    const secret = 'configured-secret';
    const circular: {failure: Error; self?: unknown} = {
      failure: new Error(`Failed with ${secret}`),
    };
    circular.self = circular;
    const entries: LogEntry[] = [];
    const logger = createRedactingLogger(memoryLogger(entries), {secrets: [secret]});

    logger.error('Provider failed', {
      nested: {
        circular,
        databaseUrl: new URL(
          `postgres://db-user:db-password@example.com/${secret}?opaque=${secret}`,
        ),
      },
    });

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('db-user');
    expect(serialized).not.toContain('db-password');
    expect(serialized).toContain('"name":"Error"');
    expect(serialized).toContain('[Circular]');
    expect(serialized).toContain(REDACTION_PLACEHOLDER);
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
