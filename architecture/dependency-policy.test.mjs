import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';
import {
  deepImportFixture,
  dependencyEdgeFixtures,
  relativeDeepImportFixture,
} from './fixtures/dependency-edges.mjs';

const require = createRequire(import.meta.url);
const {createDependencyCruiserConfig} = require('./dependency-policy.cjs');

const matchesPattern = (pattern, value) => {
  if (pattern === undefined) return true;
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.some((candidate) => new RegExp(candidate).test(value));
};

const matchesSide = (constraint, edge, key) => {
  const value = edge[key];
  if (!matchesPattern(constraint.path, value)) return false;
  if (constraint.pathNot && matchesPattern(constraint.pathNot, value)) return false;
  if (
    constraint.dependencyTypes &&
    !constraint.dependencyTypes.some((type) => edge.dependencyTypes?.includes(type))
  )
    return false;
  if (
    constraint.couldNotResolve !== undefined &&
    constraint.couldNotResolve !== Boolean(edge.couldNotResolve)
  )
    return false;
  if (constraint.circular !== undefined && constraint.circular !== Boolean(edge.circular))
    return false;
  return true;
};

const violations = (fixture, edge) =>
  createDependencyCruiserConfig({workspaceRoot: '/workspace', ...fixture})
    .forbidden.filter(
      (rule) => matchesSide(rule.from, edge, 'from') && matchesSide(rule.to, edge, 'to'),
    )
    .map((rule) => rule.name);

test('the ten documented dependency edge classes have valid and invalid fixtures', () => {
  assert.equal(
    new Set(dependencyEdgeFixtures.slice(0, 10).map((fixture) => fixture.edgeClass)).size,
    10,
  );
  for (const fixture of dependencyEdgeFixtures) {
    assert.ok(
      violations(fixture, fixture.invalid).includes(fixture.expectedRule),
      `${fixture.edgeClass} invalid fixture`,
    );
    assert.ok(
      !violations(fixture, fixture.valid).includes(fixture.expectedRule),
      `${fixture.edgeClass} valid fixture`,
    );
  }
});

test('cross-package source and internal-alias imports are rejected', () => {
  assert.ok(
    violations(deepImportFixture, deepImportFixture.edge).includes(
      'no-unresolved-glint-deep-imports',
    ),
  );
  assert.ok(
    violations(relativeDeepImportFixture, relativeDeepImportFixture.edge).includes(
      'no-cross-package-source-imports',
    ),
  );
});

test('resolved third-party package exports are not treated as workspace deep imports', () => {
  assert.ok(
    !violations(relativeDeepImportFixture, {
      from: 'src/index.test.ts',
      to: '../../../../node_modules/.pnpm/@shipfox+vitest@1.2.1/node_modules/@shipfox/vitest/dist/vitest-export.js',
    }).includes('no-cross-package-source-imports'),
  );
});

test('DTO purity holds for packages nested deeper than one level under libs/api', () => {
  const nestedDto = {
    currentDirectory: '/workspace/libs/api/vcs/core-dto',
    currentPackage: {name: '@glint/api-vcs-core-dto', glint: {packageType: 'dto'}},
  };
  assert.ok(
    violations(nestedDto, {from: 'src/index.ts', to: '../github/src/index.ts'}).includes(
      'dto-only-depends-on-dto',
    ),
    'nested DTO importing a non-DTO sibling root must be rejected',
  );
  assert.ok(
    !violations(nestedDto, {from: 'src/index.ts', to: '../core-more-dto/src/index.ts'}).includes(
      'dto-only-depends-on-dto',
    ),
    'nested DTO importing another DTO sibling must be allowed',
  );
});

test('universal DTO packages reject Node built-ins', () => {
  const fixture = dependencyEdgeFixtures[0];
  assert.ok(
    violations(fixture, {
      from: 'src/index.ts',
      to: 'node:crypto',
      dependencyTypes: ['core'],
    }).includes('dto-no-node-builtins'),
  );
});

test('source cycles are rejected', () => {
  const fixture = dependencyEdgeFixtures[2];
  assert.ok(
    violations(fixture, {from: 'src/core/a.ts', to: 'src/core/b.ts', circular: true}).includes(
      'no-circular',
    ),
  );
});
