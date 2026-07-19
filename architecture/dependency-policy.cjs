const fs = require('node:fs');
const path = require('node:path');

const WORKSPACE_ROOT = path.resolve(__dirname, '..');

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const toPosixPath = (value) => value.split(path.sep).join('/');

const pathInside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const packageAt = (directory) => {
  const packagePath = path.join(directory, 'package.json');
  return fs.existsSync(packagePath)
    ? require(packagePath)
    : {name: '@glint/workspace', glint: {packageType: 'workspace'}};
};

const workspacePathPattern = (workspaceRoot, currentDirectory, workspacePath) => {
  const relative = toPosixPath(
    path.relative(currentDirectory, path.join(workspaceRoot, workspacePath)),
  );
  return `^${escapeRegExp(relative)}(?:/|$)`;
};

const workspacePaths = (workspaceRoot, currentDirectory, paths) =>
  paths.map((workspacePath) =>
    workspacePathPattern(workspaceRoot, currentDirectory, workspacePath),
  );

const DTO_PATH = '(?:^|/)[^/]+-dto/(?:src|dist)(?:/|$)';
const NODE_MODULES_PATH = '(?:^|/)node_modules(?:/|$)';
const SOURCE_PATH = '(?:^|/)(?:src|dist)/';
const PUBLIC_INDEX = [
  '^src/index\\.',
  '^dist/index\\.',
  '/src/index\\.',
  '/dist/index\\.',
  '^src/contract-test-kit\\.',
  '^dist/contract-test-kit\\.',
  '/src/contract-test-kit\\.',
  '/dist/contract-test-kit\\.',
];
const CROSS_PACKAGE_SOURCE_PATHS = Array.from({length: 8}, (_, upIndex) =>
  Array.from(
    {length: 8},
    (_, downIndex) =>
      `^${'\\.\\./'.repeat(upIndex + 1)}${'[^/]+/'.repeat(downIndex + 1)}(?:src|dist)/`,
  ),
).flat();

const createDependencyCruiserConfig = ({
  workspaceRoot = WORKSPACE_ROOT,
  currentDirectory = process.cwd(),
  currentPackage = packageAt(currentDirectory),
} = {}) => {
  const packageType = currentPackage.glint?.packageType;
  const environment = currentPackage.glint?.environment;
  const workspaceArea = (paths) => workspacePaths(workspaceRoot, currentDirectory, paths);
  const apiPaths = workspaceArea(['libs/api']);
  const allWorkspacePaths = workspaceArea(['apps', 'libs', 'e2e']);
  const isDto = packageType === 'dto' || currentPackage.name?.endsWith('-dto');
  const isClient = packageType === 'client';
  const isBrowser = environment === 'browser' || isClient;
  const isFeature = ['backend-feature', 'provider', 'compatibility'].includes(packageType);
  const isShared =
    packageType === 'shared-node' ||
    pathInside(path.join(workspaceRoot, 'libs/shared'), currentDirectory);
  const isCompatibility =
    packageType === 'compatibility' ||
    pathInside(path.join(workspaceRoot, 'libs/api/compat'), currentDirectory);
  const isVcsCore =
    currentPackage.name === '@glint/api-vcs-core' ||
    path.resolve(currentDirectory) === path.join(workspaceRoot, 'libs/api/vcs/core');
  const isApp =
    packageType === 'app' || pathInside(path.join(workspaceRoot, 'apps'), currentDirectory);
  const e2eLayer = currentPackage.glint?.e2eLayer;
  const isE2e =
    packageType === 'e2e' || pathInside(path.join(workspaceRoot, 'e2e'), currentDirectory);
  const isBelowE2eSuites = pathInside(path.join(workspaceRoot, 'e2e/suites'), currentDirectory);

  const forbidden = [
    {
      name: 'no-circular',
      comment: 'Source and workspace package dependency graphs must remain acyclic.',
      severity: 'error',
      from: {},
      to: {circular: true},
    },
    {
      name: 'no-unresolved-glint-deep-imports',
      comment:
        'Workspace packages are consumed through declared exports, never source or internal aliases.',
      severity: 'error',
      from: {},
      to: {
        couldNotResolve: true,
        path: '^@glint/.+/(?:src|dist|#(?:core|db|presentation|jobs)|core|db|presentation|jobs)(?:/|$)',
      },
    },
    {
      name: 'no-cross-package-source-imports',
      comment:
        'Workspace packages consume another package root, never its source or dist files directly.',
      severity: 'error',
      from: {path: '^(?:src|test)(?:/|$)'},
      to: {
        path: [...CROSS_PACKAGE_SOURCE_PATHS, '^@glint/[^/]+/(?:src|dist)(?:/|$)'],
        pathNot: [...PUBLIC_INDEX, NODE_MODULES_PATH],
      },
    },
  ];

  if (isDto) {
    forbidden.push(
      {
        name: 'dto-only-depends-on-dto',
        comment:
          'DTO production code may only depend on DTO workspace packages and pure third-party schema libraries.',
        severity: 'error',
        from: {path: '^(?:src|test)(?:/|$)'},
        to: {
          path: [...CROSS_PACKAGE_SOURCE_PATHS, '^@glint/[^/]+/(?:src|dist)(?:/|$)'],
          pathNot: [DTO_PATH, NODE_MODULES_PATH],
        },
      },
      {
        name: 'dto-no-node-builtins',
        comment: 'Universal DTO packages cannot import Node built-ins.',
        severity: 'error',
        from: {path: '^(?:src|test)(?:/|$)'},
        to: {dependencyTypes: ['core']},
      },
    );
  }

  if (isBrowser) {
    forbidden.push({
      name: 'client-browser-no-backend-or-node-packages',
      comment:
        'Client and browser packages may consume DTO and client public surfaces, never backend implementations or Node packages.',
      severity: 'error',
      from: {path: '^(?:src|test)(?:/|$)'},
      to: {
        path: [...apiPaths, ...workspaceArea(['libs/shared/node', 'apps'])],
        pathNot: [DTO_PATH, NODE_MODULES_PATH],
      },
    });
  }

  if (isFeature) {
    forbidden.push(
      {
        name: 'backend-core-stays-independent',
        comment:
          'Feature core code cannot depend on database, presentation, jobs, or concrete provider implementations.',
        severity: 'error',
        from: {path: '^src/core(?:/|$)'},
        to: {
          path: ['^src/(?:db|presentation|jobs)(?:/|$)', ...workspaceArea(['libs/api/vcs/github'])],
        },
      },
      {
        name: 'feature-no-other-feature-internals',
        comment:
          "Features consume another feature's package root, never its db, presentation, or source internals.",
        severity: 'error',
        from: {path: '^(?:src|test)(?:/|$)'},
        to: {
          path: apiPaths.map((prefix) => `${prefix}.*${SOURCE_PATH}`),
          pathNot: [...PUBLIC_INDEX, NODE_MODULES_PATH],
        },
      },
    );
  }

  if (isShared) {
    forbidden.push({
      name: 'shared-no-feature-dependencies',
      comment: 'Shared primitives cannot depend on API or client feature packages.',
      severity: 'error',
      from: {path: '^(?:src|test)(?:/|$)'},
      to: {path: workspaceArea(['libs/api', 'libs/client'])},
    });
  }

  if (isVcsCore) {
    forbidden.push({
      name: 'vcs-core-no-github-implementation',
      comment: 'The provider-neutral VCS core cannot depend on the GitHub adapter.',
      severity: 'error',
      from: {path: '^(?:src|test)(?:/|$)'},
      to: {path: workspaceArea(['libs/api/vcs/github'])},
    });
  }

  if (isCompatibility) {
    forbidden.push({
      name: 'compatibility-no-database-internals',
      comment:
        'Compatibility adapters map through public services and cannot query feature database internals.',
      severity: 'error',
      from: {path: '^(?:src|test)(?:/|$)'},
      to: {
        path: [
          ...apiPaths.map((prefix) => `${prefix}.*(?:^|/)src/db(?:/|$)`),
          '(?:^|/)src/db(?:/|$)',
        ],
      },
    });
  }

  if (isApp) {
    forbidden.push({
      name: 'apps-only-consume-package-exports',
      comment:
        'Apps compose package roots and cannot import package source, #core, #db, or #presentation internals.',
      severity: 'error',
      from: {path: '^src(?:/|$)'},
      to: {
        path: [
          ...allWorkspacePaths.map((prefix) => `${prefix}.*${SOURCE_PATH}`),
          '^@glint/.+/(?:src|dist|#(?:core|db|presentation|jobs)|core|db|presentation|jobs)(?:/|$)',
        ],
        pathNot: [...PUBLIC_INDEX, NODE_MODULES_PATH],
      },
    });
  }

  if (isBrowser) {
    forbidden.push({
      name: 'browser-no-node-builtins',
      comment: 'Browser packages cannot import Node built-ins.',
      severity: 'error',
      from: {path: '^(?:src|test)(?:/|$)'},
      to: {dependencyTypes: ['core']},
    });
  }

  if (isE2e) {
    forbidden.push({
      name: 'e2e-no-backend-implementations',
      comment:
        'E2E code consumes DTOs and public setup helpers, never backend implementation packages.',
      severity: 'error',
      from: {path: '^(?:src|test|tests)(?:/|$)|^playwright\\.config\\.ts$'},
      to: {path: apiPaths, pathNot: DTO_PATH},
    });
  }

  if (e2eLayer === 'suite') {
    forbidden.push({
      name: 'e2e-suite-no-other-suite',
      comment: 'An E2E suite cannot depend on another suite.',
      severity: 'error',
      from: {path: '^(?:src|test|tests)(?:/|$)'},
      to: {
        path: isBelowE2eSuites
          ? ['^\\.\\./[^./][^/]*/', '^\\.\\./\\.\\./(?:api|client|flow)(?:/|$)']
          : workspaceArea(['e2e/suites']),
      },
    });
  }

  return {
    forbidden,
    options: {
      doNotFollow: {path: 'node_modules'},
      tsPreCompilationDeps: 'specify',
      enhancedResolveOptions: {
        exportsFields: ['exports'],
        conditionNames: ['import', 'require', 'node', 'default', 'development'],
        mainFields: ['module', 'main', 'types'],
      },
    },
  };
};

module.exports = {createDependencyCruiserConfig};
