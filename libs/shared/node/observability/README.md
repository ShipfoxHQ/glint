# Glint observability

`@glint/node-observability` contains the Glint-specific policy missing from the shared Shipfox
telemetry packages: logger wiring, fixed correlation names, and health checks.

Use `@shipfox/node-opentelemetry` directly for meters, tracers, context propagation, startup, and
shutdown. Its exported OpenTelemetry API is provider-neutral and behaves as a no-op until a
composition root starts instrumentation. `GLINT_OBSERVABILITY_ENABLED` defaults to `false`, so
local processes do not start metrics listeners or exporters unless explicitly configured.

Use `createGlintLogger` where logs are emitted. It delegates to Shipfox's trace-aware logger and
adds Glint's correlation bindings and redaction policy.

Correlation fields are `requestId`, `buildId`, `comparisonId`, `jobId`, and `accountId`.
`injectCorrelation` and `extractCorrelation` carry the same fields across HTTP or job attributes;
`CorrelationContextStore` keeps them attached across asynchronous work so every log record can
include them.

The logger delegates secret, wire-form, URL, and structured-value sanitization to the published
`@shipfox/redact` package. Applications should pass `collectSensitiveValues` output from every
loaded configuration schema into the observability logger. Consumers that need lower-level
redaction outside logging should import those primitives directly from `@shipfox/redact`.
