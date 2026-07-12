/** A provider-owned value identified at the composition boundary. */
export interface NamedCapability<T = unknown> {
  readonly name: string;
  readonly value: T;
}

/** A module-owned migration directory. The migrate app decides when to run it. */
export interface ModuleMigration {
  readonly name: string;
  readonly directory: string;
}

/** Provider-specific values carried by each runtime capability kind. */
export interface GlintCapabilityTypes {
  readonly routes: unknown;
  readonly auth: unknown;
  readonly publishers: unknown;
  readonly subscribers: unknown;
  readonly jobs: unknown;
  readonly metrics: unknown;
}

/**
 * Declarative capabilities exported by a backend feature package.
 *
 * Capability values stay opaque here: HTTP, auth, queue, outbox, and metrics
 * providers own their concrete contracts. This package only validates and orders
 * declarations for composition roots.
 */
export interface GlintModule<TCapabilities extends GlintCapabilityTypes = GlintCapabilityTypes> {
  readonly name: string;
  readonly dependencies?: readonly string[];
  readonly routes?: readonly NamedCapability<TCapabilities['routes']>[];
  readonly auth?: readonly NamedCapability<TCapabilities['auth']>[];
  readonly publishers?: readonly NamedCapability<TCapabilities['publishers']>[];
  readonly subscribers?: readonly NamedCapability<TCapabilities['subscribers']>[];
  readonly jobs?: readonly NamedCapability<TCapabilities['jobs']>[];
  readonly metrics?: readonly NamedCapability<TCapabilities['metrics']>[];
  readonly migrations?: readonly ModuleMigration[];
}

export interface ModuleCapabilities<
  TCapabilities extends GlintCapabilityTypes = GlintCapabilityTypes,
> {
  readonly routes: readonly NamedCapability<TCapabilities['routes']>[];
  readonly auth: readonly NamedCapability<TCapabilities['auth']>[];
  readonly publishers: readonly NamedCapability<TCapabilities['publishers']>[];
  readonly subscribers: readonly NamedCapability<TCapabilities['subscribers']>[];
  readonly jobs: readonly NamedCapability<TCapabilities['jobs']>[];
  readonly metrics: readonly NamedCapability<TCapabilities['metrics']>[];
  readonly migrations: readonly ModuleMigration[];
}

export type CapabilityKind = keyof ModuleCapabilities;

export interface GlintComposition<
  TCapabilities extends GlintCapabilityTypes = GlintCapabilityTypes,
> {
  readonly modules: readonly GlintModule<TCapabilities>[];
  readonly capabilities: ModuleCapabilities<TCapabilities>;
}

export type ModuleCompositionErrorCode =
  | 'duplicate_module'
  | 'duplicate_capability'
  | 'missing_dependency'
  | 'dependency_cycle';

export class ModuleCompositionError extends Error {
  public constructor(
    public readonly code: ModuleCompositionErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'ModuleCompositionError';
  }
}
