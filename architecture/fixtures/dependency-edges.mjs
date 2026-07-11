const pkg = (packageType, extras = {}) => ({
  name: `@glint/${packageType}-fixture`,
  glint: {packageType, ...extras},
});

export const dependencyEdgeFixtures = [
  {
    edgeClass: 'DTO to non-DTO workspace package',
    expectedRule: 'dto-only-depends-on-dto',
    currentDirectory: '/workspace/libs/api/orders-dto',
    currentPackage: pkg('dto'),
    invalid: {from: 'src/index.ts', to: '../orders/src/index.ts'},
    valid: {from: 'src/index.ts', to: '../users-dto/src/index.ts'},
  },
  {
    edgeClass: 'client to backend or Node package',
    expectedRule: 'client-browser-no-backend-or-node-packages',
    currentDirectory: '/workspace/libs/client/orders',
    currentPackage: pkg('client', {environment: 'browser'}),
    invalid: {from: 'src/index.ts', to: '../../api/orders/src/index.ts'},
    valid: {from: 'src/index.ts', to: '../../api/orders-dto/src/index.ts'},
  },
  {
    edgeClass: 'backend core to its outer layers',
    expectedRule: 'backend-core-stays-independent',
    currentDirectory: '/workspace/libs/api/orders',
    currentPackage: pkg('backend-feature', {environment: 'node'}),
    invalid: {from: 'src/core/order.ts', to: 'src/db/order.ts'},
    valid: {from: 'src/presentation/routes.ts', to: 'src/core/order.ts'},
  },
  {
    edgeClass: 'feature to another feature internal',
    expectedRule: 'feature-no-other-feature-internals',
    currentDirectory: '/workspace/libs/api/orders',
    currentPackage: pkg('backend-feature', {environment: 'node'}),
    invalid: {from: 'src/presentation/routes.ts', to: '../users/src/db/users.ts'},
    valid: {from: 'src/presentation/routes.ts', to: '../users/src/index.ts'},
  },
  {
    edgeClass: 'shared package to feature',
    expectedRule: 'shared-no-feature-dependencies',
    currentDirectory: '/workspace/libs/shared/node/database',
    currentPackage: pkg('shared-node', {environment: 'node'}),
    invalid: {from: 'src/index.ts', to: '../../../api/orders/src/index.ts'},
    valid: {from: 'src/index.ts', to: '../queue/src/index.ts'},
  },
  {
    edgeClass: 'VCS core to GitHub provider',
    expectedRule: 'vcs-core-no-github-implementation',
    currentDirectory: '/workspace/libs/api/vcs/core',
    currentPackage: {
      name: '@glint/api-vcs-core',
      glint: {packageType: 'backend-feature', environment: 'node'},
    },
    invalid: {from: 'src/index.ts', to: '../github/src/index.ts'},
    valid: {from: 'src/index.ts', to: '../core-dto/src/index.ts'},
  },
  {
    edgeClass: 'compatibility adapter to database internal',
    expectedRule: 'compatibility-no-database-internals',
    currentDirectory: '/workspace/libs/api/compat/argos',
    currentPackage: pkg('compatibility', {environment: 'node'}),
    invalid: {from: 'src/index.ts', to: '../../orders/src/db/order.ts'},
    valid: {from: 'src/index.ts', to: '../../orders/src/index.ts'},
  },
  {
    edgeClass: 'app to package internal',
    expectedRule: 'apps-only-consume-package-exports',
    currentDirectory: '/workspace/apps/api',
    currentPackage: pkg('app', {environment: 'node'}),
    invalid: {from: 'src/index.ts', to: '../../libs/api/orders/src/core/order.ts'},
    valid: {from: 'src/index.ts', to: '../../libs/api/orders/src/index.ts'},
  },
  {
    edgeClass: 'browser package to Node built-in',
    expectedRule: 'browser-no-node-builtins',
    currentDirectory: '/workspace/apps/web',
    currentPackage: pkg('app', {environment: 'browser'}),
    invalid: {from: 'src/index.ts', to: 'node:fs', dependencyTypes: ['core']},
    valid: {from: 'src/index.ts', to: 'react', dependencyTypes: ['npm']},
  },
  {
    edgeClass: 'E2E suite to another suite',
    expectedRule: 'e2e-suite-no-other-suite',
    currentDirectory: '/workspace/e2e/suites/api/orders',
    currentPackage: pkg('e2e', {environment: 'node', e2eLayer: 'suite'}),
    invalid: {from: 'src/index.ts', to: '../projects/src/index.ts'},
    valid: {from: 'src/index.ts', to: '../../../core/src/index.ts'},
  },
  {
    edgeClass: 'E2E code to backend implementation',
    expectedRule: 'e2e-no-backend-implementations',
    currentDirectory: '/workspace/e2e/suites/api/orders',
    currentPackage: pkg('e2e', {environment: 'node', e2eLayer: 'suite'}),
    invalid: {from: 'src/index.ts', to: '../../../../libs/api/orders/src/index.ts'},
    valid: {from: 'src/index.ts', to: '../../../../libs/api/orders-dto/src/index.ts'},
  },
];

export const deepImportFixture = {
  currentDirectory: '/workspace/apps/api',
  currentPackage: pkg('app', {environment: 'node'}),
  edge: {from: 'src/index.ts', to: '@glint/api-orders/#core/order', couldNotResolve: true},
};

export const relativeDeepImportFixture = {
  currentDirectory: '/workspace/libs/client/orders',
  currentPackage: pkg('client', {environment: 'browser'}),
  edge: {from: 'src/index.ts', to: '../projects/src/internal.ts'},
};
