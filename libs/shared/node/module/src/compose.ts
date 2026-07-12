import {
  type CapabilityKind,
  type GlintCapabilityTypes,
  type GlintComposition,
  type GlintModule,
  type ModuleCapabilities,
  ModuleCompositionError,
  type ModuleMigration,
  type NamedCapability,
} from './types.js';

const capabilityKinds = [
  'routes',
  'auth',
  'publishers',
  'subscribers',
  'jobs',
  'metrics',
  'migrations',
] as const satisfies readonly CapabilityKind[];

/** Validate declarations and return modules in deterministic dependency-first order. */
export function composeModules<TCapabilities extends GlintCapabilityTypes = GlintCapabilityTypes>(
  modules: readonly GlintModule<TCapabilities>[],
): GlintComposition<TCapabilities> {
  const modulesByName = indexModules(modules);
  validateCapabilities(modules);
  validateDependencies(modules, modulesByName);

  const orderedModules = orderModules(modules, modulesByName);
  return {
    modules: orderedModules,
    capabilities: collectCapabilities(orderedModules),
  };
}

/** Select only the capabilities an API, worker, or other composition root starts. */
export function selectCapabilities<
  TCapabilities extends GlintCapabilityTypes,
  const K extends readonly CapabilityKind[],
>(
  composition: GlintComposition<TCapabilities>,
  kinds: K,
): Pick<ModuleCapabilities<TCapabilities>, K[number]> {
  const selected: Partial<ModuleCapabilities<TCapabilities>> = {};
  const seen = new Set<CapabilityKind>();

  for (const kind of kinds) {
    if (seen.has(kind)) continue;
    seen.add(kind);
    Object.assign(selected, {[kind]: composition.capabilities[kind]});
  }

  return selected as Pick<ModuleCapabilities<TCapabilities>, K[number]>;
}

/** Collect module-owned migration directories without executing them. */
export function collectMigrationDirectories<TCapabilities extends GlintCapabilityTypes>(
  composition: GlintComposition<TCapabilities>,
): readonly string[] {
  return composition.capabilities.migrations.map((migration) => migration.directory);
}

function indexModules<TCapabilities extends GlintCapabilityTypes>(
  modules: readonly GlintModule<TCapabilities>[],
): ReadonlyMap<string, GlintModule<TCapabilities>> {
  const modulesByName = new Map<string, GlintModule<TCapabilities>>();

  for (const module of modules) {
    const existing = modulesByName.get(module.name);
    if (existing) {
      throw new ModuleCompositionError(
        'duplicate_module',
        `Duplicate module name "${module.name}".`,
        {moduleName: module.name},
      );
    }
    modulesByName.set(module.name, module);
  }

  return modulesByName;
}

function validateCapabilities(modules: readonly GlintModule[]): void {
  const ownersByKind = new Map<CapabilityKind, Map<string, string>>();

  for (const module of modules) {
    for (const kind of capabilityKinds) {
      for (const capability of module[kind] ?? []) {
        const owners = ownersByKind.get(kind) ?? new Map<string, string>();
        const existingOwner = owners.get(capability.name);
        if (existingOwner !== undefined) {
          throw new ModuleCompositionError(
            'duplicate_capability',
            `Duplicate ${kind} capability "${capability.name}" in modules "${existingOwner}" and "${module.name}".`,
            {
              capabilityKind: kind,
              capabilityName: capability.name,
              modules: [existingOwner, module.name],
            },
          );
        }
        owners.set(capability.name, module.name);
        ownersByKind.set(kind, owners);
      }
    }
  }
}

function validateDependencies(
  modules: readonly GlintModule[],
  modulesByName: ReadonlyMap<string, GlintModule>,
): void {
  for (const module of modules) {
    for (const dependency of module.dependencies ?? []) {
      if (modulesByName.has(dependency)) continue;
      throw new ModuleCompositionError(
        'missing_dependency',
        `Module "${module.name}" depends on missing module "${dependency}".`,
        {moduleName: module.name, dependency},
      );
    }
  }
}

function orderModules<TCapabilities extends GlintCapabilityTypes>(
  modules: readonly GlintModule<TCapabilities>[],
  modulesByName: ReadonlyMap<string, GlintModule<TCapabilities>>,
): readonly GlintModule<TCapabilities>[] {
  const ordered: GlintModule<TCapabilities>[] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];

  const visit = (module: GlintModule<TCapabilities>): void => {
    if (visited.has(module.name)) return;
    if (active.has(module.name)) {
      const cycleStart = path.indexOf(module.name);
      const cycle = [...path.slice(cycleStart), module.name];
      throw new ModuleCompositionError(
        'dependency_cycle',
        `Module dependency cycle: ${cycle.join(' -> ')}.`,
        {cycle},
      );
    }

    active.add(module.name);
    path.push(module.name);
    for (const dependencyName of module.dependencies ?? []) {
      const dependency = modulesByName.get(dependencyName);
      if (dependency) visit(dependency);
    }
    path.pop();
    active.delete(module.name);
    visited.add(module.name);
    ordered.push(module);
  };

  for (const module of modules) visit(module);
  return ordered;
}

function collectCapabilities<TCapabilities extends GlintCapabilityTypes>(
  modules: readonly GlintModule<TCapabilities>[],
): ModuleCapabilities<TCapabilities> {
  const capabilities: {
    routes: NamedCapability<TCapabilities['routes']>[];
    auth: NamedCapability<TCapabilities['auth']>[];
    publishers: NamedCapability<TCapabilities['publishers']>[];
    subscribers: NamedCapability<TCapabilities['subscribers']>[];
    jobs: NamedCapability<TCapabilities['jobs']>[];
    metrics: NamedCapability<TCapabilities['metrics']>[];
    migrations: ModuleMigration[];
  } = {
    routes: [],
    auth: [],
    publishers: [],
    subscribers: [],
    jobs: [],
    metrics: [],
    migrations: [],
  };

  for (const module of modules) {
    capabilities.routes.push(...(module.routes ?? []));
    capabilities.auth.push(...(module.auth ?? []));
    capabilities.publishers.push(...(module.publishers ?? []));
    capabilities.subscribers.push(...(module.subscribers ?? []));
    capabilities.jobs.push(...(module.jobs ?? []));
    capabilities.metrics.push(...(module.metrics ?? []));
    capabilities.migrations.push(...(module.migrations ?? []));
  }

  return capabilities;
}
