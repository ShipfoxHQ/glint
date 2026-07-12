import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const WORKSPACE_AREAS = ['apps', 'libs', 'e2e', 'tools'];

const findPackageFiles = async (root) => {
  const packageFiles = [];
  const visit = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, {withFileTypes: true});
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === 'package.json')) {
      packageFiles.push(path.join(directory, 'package.json'));
      return;
    }
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules',
        )
        .map((entry) => visit(path.join(directory, entry.name))),
    );
  };
  await Promise.all(WORKSPACE_AREAS.map((area) => visit(path.join(root, area))));
  return packageFiles.sort();
};

export const readWorkspaceGraph = async (root) => {
  const packages = new Map();
  for (const packageFile of await findPackageFiles(root)) {
    const manifest = JSON.parse(await readFile(packageFile, 'utf8'));
    if (!manifest.name) throw new Error(`${path.relative(root, packageFile)} has no package name`);
    if (packages.has(manifest.name))
      throw new Error(`Duplicate workspace package name: ${manifest.name}`);
    packages.set(manifest.name, {manifest, packageFile});
  }

  const graph = new Map([...packages].map(([name]) => [name, []]));
  for (const [name, {manifest, packageFile}] of packages) {
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    };
    for (const [dependency, version] of Object.entries(dependencies)) {
      if (!packages.has(dependency)) continue;
      if (version !== 'workspace:*') {
        throw new Error(
          `${path.relative(root, packageFile)} must declare ${dependency} as workspace:* (found ${version})`,
        );
      }
      graph.get(name).push(dependency);
    }
  }
  return graph;
};

export const findWorkspaceCycle = (graph) => {
  const visited = new Set();
  const active = new Set();
  const stack = [];
  const visit = (name) => {
    if (active.has(name)) return [...stack.slice(stack.indexOf(name)), name];
    if (visited.has(name)) return null;
    visited.add(name);
    active.add(name);
    stack.push(name);
    for (const dependency of graph.get(name) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    active.delete(name);
    return null;
  };
  for (const name of graph.keys()) {
    const cycle = visit(name);
    if (cycle) return cycle;
  }
  return null;
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const graph = await readWorkspaceGraph(root);
  const cycle = findWorkspaceCycle(graph);
  if (cycle) throw new Error(`Workspace dependency cycle: ${cycle.join(' -> ')}`);
  process.stdout.write(`Workspace dependency graph is acyclic (${graph.size} packages).\n`);
}
