import {describe, expect, it} from '@shipfox/vitest/vi';
import {
  collectMigrationDirectories,
  composeModules,
  type GlintCapabilityTypes,
  type GlintModule,
  type ModuleCompositionError,
  selectCapabilities,
} from './index.js';

function capability(name: string): {name: string; value: string};
function capability<T>(name: string, value: T): {name: string; value: T};
function capability(name: string, value: unknown = name) {
  return {name, value};
}

interface TestCapabilityTypes extends GlintCapabilityTypes {
  readonly routes: {readonly method: string};
  readonly auth: string;
  readonly publishers: string;
  readonly subscribers: string;
  readonly jobs: {readonly queue: string};
  readonly metrics: string;
}

describe('composeModules', () => {
  it('composes valid modules in dependency order and preserves declaration order', () => {
    const modules: GlintModule[] = [
      {
        name: 'builds',
        dependencies: ['assets'],
        routes: [capability('builds.create')],
        jobs: [capability('builds.finalize')],
      },
      {name: 'accounts', auth: [capability('accounts.session')]},
      {
        name: 'assets',
        dependencies: ['accounts'],
        migrations: [
          {name: 'assets.schema', directory: '/modules/assets/drizzle'},
          {name: 'assets.rls', directory: '/modules/assets/drizzle-rls'},
        ],
      },
    ];

    const composition = composeModules(modules);

    expect(composition.modules.map((module) => module.name)).toEqual([
      'accounts',
      'assets',
      'builds',
    ]);
    expect(composition.capabilities.routes.map((route) => route.name)).toEqual(['builds.create']);
    expect(collectMigrationDirectories(composition)).toEqual([
      '/modules/assets/drizzle',
      '/modules/assets/drizzle-rls',
    ]);
  });

  it('lets each app select only the capabilities it starts', () => {
    const composition = composeModules<TestCapabilityTypes>([
      {
        name: 'builds',
        routes: [capability('builds.read', {method: 'GET'})],
        auth: [capability('builds.token')],
        publishers: [capability('builds.events')],
        subscribers: [capability('builds.results')],
        jobs: [capability('builds.finalize', {queue: 'builds'})],
        metrics: [capability('builds.metrics')],
        migrations: [{name: 'builds.schema', directory: '/modules/builds/drizzle'}],
      },
    ]);

    const api = selectCapabilities(composition, ['routes', 'auth', 'publishers']);
    const worker = selectCapabilities(composition, ['subscribers', 'jobs', 'metrics']);
    const migrate = selectCapabilities(composition, ['migrations']);

    expect(Object.keys(api)).toEqual(['routes', 'auth', 'publishers']);
    expect(Object.keys(worker)).toEqual(['subscribers', 'jobs', 'metrics']);
    expect(Object.keys(migrate)).toEqual(['migrations']);
    expect(api.routes[0]?.name).toBe('builds.read');
    expect(api.routes[0]?.value.method).toBe('GET');
    expect(worker.jobs[0]?.name).toBe('builds.finalize');
    expect(worker.jobs[0]?.value.queue).toBe('builds');
    expect(migrate.migrations[0]?.directory).toBe('/modules/builds/drizzle');
  });

  it('collects each migration directory once in dependency-first order', () => {
    const composition = composeModules([
      {
        name: 'builds',
        dependencies: ['assets'],
        migrations: [
          {name: 'builds.schema', directory: '/modules/shared/drizzle'},
          {name: 'builds.views', directory: '/modules/builds/drizzle'},
        ],
      },
      {
        name: 'assets',
        migrations: [{name: 'assets.schema', directory: '/modules/shared/drizzle'}],
      },
    ]);

    expect(collectMigrationDirectories(composition)).toEqual([
      '/modules/shared/drizzle',
      '/modules/builds/drizzle',
    ]);
  });

  it('rejects duplicate module names', () => {
    expect(() => composeModules([{name: 'assets'}, {name: 'assets'}])).toThrowError(
      expect.objectContaining<Partial<ModuleCompositionError>>({code: 'duplicate_module'}),
    );
  });

  it('rejects duplicate capability names within the same capability kind', () => {
    expect(() =>
      composeModules([
        {name: 'assets', jobs: [capability('verify')]},
        {name: 'diffs', jobs: [capability('verify')]},
      ]),
    ).toThrowError(
      expect.objectContaining<Partial<ModuleCompositionError>>({code: 'duplicate_capability'}),
    );
  });

  it('allows the same capability name in different capability kinds', () => {
    expect(() =>
      composeModules([
        {
          name: 'builds',
          routes: [capability('builds.process')],
          jobs: [capability('builds.process')],
        },
      ]),
    ).not.toThrow();
  });

  it('rejects missing dependencies', () => {
    expect(() => composeModules([{name: 'builds', dependencies: ['assets']}])).toThrowError(
      expect.objectContaining<Partial<ModuleCompositionError>>({code: 'missing_dependency'}),
    );
  });

  it('reports the complete dependency cycle', () => {
    expect(() =>
      composeModules([
        {name: 'accounts', dependencies: ['projects']},
        {name: 'projects', dependencies: ['builds']},
        {name: 'builds', dependencies: ['accounts']},
      ]),
    ).toThrowError(
      expect.objectContaining<Partial<ModuleCompositionError>>({
        code: 'dependency_cycle',
        details: {cycle: ['accounts', 'projects', 'builds', 'accounts']},
      }),
    );
  });

  it('keeps independent modules stable while moving dependencies before dependents', () => {
    const composition = composeModules([
      {name: 'compat', dependencies: ['builds']},
      {name: 'accounts'},
      {name: 'builds', dependencies: ['assets']},
      {name: 'assets'},
      {name: 'observability'},
    ]);

    expect(composition.modules.map((module) => module.name)).toEqual([
      'assets',
      'builds',
      'compat',
      'accounts',
      'observability',
    ]);
  });
});
