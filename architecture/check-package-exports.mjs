import {existsSync} from 'node:fs';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const WORKSPACE_AREAS = ['apps', 'libs', 'e2e', 'tools'];

export async function checkPackageExports(root) {
  const failures = [];
  for (const packageFile of await findPackageFiles(root)) {
    const manifest = JSON.parse(await readFile(packageFile, 'utf8'));
    failures.push(...checkManifestExports(packageFile, manifest));
  }
  if (failures.length > 0)
    throw new Error(`Package export integrity failed:\n${failures.join('\n')}`);
}

export function checkManifestExports(packageFile, manifest) {
  const packageRoot = path.dirname(packageFile);
  const packageName = manifest.name ?? path.relative(process.cwd(), packageFile);
  const failures = [];
  const checkTarget = (label, target) => {
    if (typeof target !== 'string') return;
    const resolved = resolveTarget(packageRoot, target);
    if (!resolved || !existsSync(resolved)) {
      failures.push(`${packageName}: ${label} resolves to missing ${target}`);
    }
  };

  for (const field of ['main', 'types']) checkTarget(field, manifest[field]);
  for (const [entry, target] of Object.entries(manifest.exports ?? {})) {
    if (entry.startsWith('#') || entry === './src' || entry.startsWith('./src/')) {
      failures.push(`${packageName}: ${entry} must not be publicly exported`);
      continue;
    }
    for (const [condition, conditionTarget] of flattenTargets(target)) {
      checkTarget(`exports.${entry}.${condition}`, conditionTarget);
    }
  }
  for (const [entry, target] of Object.entries(manifest.imports ?? {})) {
    if (!entry.startsWith('#'))
      failures.push(`${packageName}: imports key ${entry} must start with #`);
    for (const [condition, conditionTarget] of flattenTargets(target)) {
      checkTarget(`imports.${entry}.${condition}`, conditionTarget);
    }
  }
  return failures;
}

function flattenTargets(value, prefix = '') {
  if (typeof value === 'string') return [[prefix || 'default', value]];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    flattenTargets(child, prefix ? `${prefix}.${key}` : key),
  );
}

function resolveTarget(packageRoot, target) {
  if (target.startsWith('../') || target.startsWith('/') || target.startsWith('#')) return null;
  if (target.includes('*')) {
    const directory = path.dirname(target);
    return existsSync(path.resolve(packageRoot, directory))
      ? path.resolve(packageRoot, directory)
      : null;
  }
  return path.resolve(packageRoot, target);
}

async function findPackageFiles(root) {
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
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  await checkPackageExports(root);
  process.stdout.write('Package export integrity passed.\n');
}
