# Diff-engine port

`@glint/api-diffs` owns provider-neutral diff inputs, measured safety limits, engine/config identity,
and the unchanged, changed, and layout-changed result model. Encoded bytes and decoded dimensions
are explicit so workers can enforce the E0 benchmark limits before invoking a native engine.

Adapters should run `diffEngineContractTests` from `@glint/api-diffs/contract-test-kit` with their
engine-specific golden fixtures. `DeterministicDiffEngine` provides a lightweight fake for feature
tests; it is not a pixel-comparison implementation.

`MVP_DIFF_LIMITS` follows the approved Lambda worker envelope: 8 MiB encoded inputs and outputs,
16,777,216 decoded pixels, width 4,096, height 16,384, and a five-second engine deadline. Changing
one of these limits requires new measurements.
