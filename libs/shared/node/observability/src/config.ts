import {
  bool,
  collectSensitiveValues,
  defineEnvironmentSchema,
  describeEnvironment,
  type EnvironmentFor,
  type EnvironmentVariableDescription,
  environmentVariable,
  loadEnvironment,
  port,
  str,
  url,
} from '@glint/node-config';

const observabilityEnvironmentSchema = defineEnvironmentSchema({
  GLINT_OBSERVABILITY_ENABLED: environmentVariable(bool({default: false}), {
    description: 'Starts Prometheus metrics and OpenTelemetry tracing when true.',
  }),
  LOG_FILE: environmentVariable(str({default: undefined}), {
    description: 'Optional file destination for structured logs.',
  }),
  LOG_LEVEL: environmentVariable(
    str({choices: ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'], default: 'info'}),
    {description: 'Minimum structured log level emitted by this process.'},
  ),
  LOG_PRETTY: environmentVariable(bool({default: false}), {
    description: 'Uses human-readable local log formatting when true.',
  }),
  LOG_STDOUT: environmentVariable(bool({default: true}), {
    description: 'Writes structured logs to standard output when true.',
  }),
  OTEL_DIAG_LOG_LEVEL: environmentVariable(
    str({choices: ['none', 'error', 'warn', 'info', 'debug', 'verbose', 'all'], default: 'none'}),
    {description: 'Controls diagnostic logging produced by the OpenTelemetry SDK.'},
  ),
  OTEL_INSTANCE_METRICS_PORT: environmentVariable(port({default: 9464}), {
    description: 'Port that exposes per-process Prometheus metrics.',
  }),
  OTEL_SERVICE_METRICS_PORT: environmentVariable(port({default: 9474}), {
    description: 'Port that exposes feature-owned Prometheus metrics.',
  }),
  OTEL_SERVICE_NAME: environmentVariable(str({default: undefined}), {
    description: 'Stable service name attached to metrics and traces.',
  }),
  TRACES_COLLECTOR_URL: environmentVariable(url({default: undefined}), {
    description: 'Optional OTLP HTTP endpoint. Trace export is disabled when unset.',
    sensitive: true,
  }),
});

type LoadedObservabilityEnvironment = EnvironmentFor<typeof observabilityEnvironmentSchema>;

export interface ObservabilityEnvironment {
  readonly GLINT_OBSERVABILITY_ENABLED: boolean;
  readonly LOG_FILE: string | undefined;
  readonly LOG_LEVEL: string;
  readonly LOG_PRETTY: boolean;
  readonly LOG_STDOUT: boolean;
  readonly OTEL_DIAG_LOG_LEVEL: string;
  readonly OTEL_INSTANCE_METRICS_PORT: number;
  readonly OTEL_SERVICE_METRICS_PORT: number;
  readonly OTEL_SERVICE_NAME: string | undefined;
  readonly TRACES_COLLECTOR_URL: string | undefined;
}

export function describeObservabilityEnvironment(): readonly EnvironmentVariableDescription[] {
  return describeEnvironment(observabilityEnvironmentSchema);
}

export function loadObservabilityEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ObservabilityEnvironment {
  return loadEnvironment(observabilityEnvironmentSchema, environment);
}

export function observabilityEnvironmentSecrets(
  environment: ObservabilityEnvironment,
): readonly string[] {
  return collectSensitiveValues(
    observabilityEnvironmentSchema,
    environment as LoadedObservabilityEnvironment,
  );
}
