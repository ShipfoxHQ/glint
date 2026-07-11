import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {findWorkspaceCycle, readWorkspaceGraph} from './check-workspace-graph.mjs';

const withWorkspace = async (packages, callback) => {
  const root = await mkdtemp(path.join(tmpdir(), 'glint-workspace-'));
  try {
    for (const [directory, manifest] of Object.entries(packages)) {
      const packageDirectory = path.join(root, directory);
      await mkdir(packageDirectory, {recursive: true});
      await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify(manifest));
    }
    await callback(root);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
};

test('workspace graph cycles are rejected with the complete cycle', async () => {
  await withWorkspace(
    {
      'libs/api/a': {name: '@glint/a', dependencies: {'@glint/b': 'workspace:*'}},
      'libs/api/b': {name: '@glint/b', dependencies: {'@glint/a': 'workspace:*'}},
    },
    async (root) =>
      assert.deepEqual(findWorkspaceCycle(await readWorkspaceGraph(root)), [
        '@glint/a',
        '@glint/b',
        '@glint/a',
      ]),
  );
});

test('workspace dependencies must use workspace:*', async () => {
  await withWorkspace(
    {
      'libs/api/a': {name: '@glint/a', dependencies: {'@glint/b': '^1.0.0'}},
      'libs/api/b': {name: '@glint/b'},
    },
    async (root) =>
      assert.rejects(readWorkspaceGraph(root), /must declare @glint\/b as workspace:\*/),
  );
});
