import assert from 'node:assert/strict';
import {readdir, readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../templates/packages');
const shapes = [
  'dto',
  'backend-feature',
  'client',
  'shared-node',
  'provider',
  'compatibility',
  'app',
  'e2e',
];
const libraryShapes = shapes.filter((shape) => !['app', 'e2e'].includes(shape));

const manifest = async (shape) =>
  JSON.parse(await readFile(path.join(root, shape, 'package.json'), 'utf8'));

test('all eight package shapes are inert, minimal, and depcruise-ready', async () => {
  assert.deepEqual(
    (await readdir(root, {withFileTypes: true}))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(),
    [...shapes].sort(),
  );
  for (const shape of shapes) {
    const packageJson = await manifest(shape);
    assert.equal(packageJson.glint.packageType, shape);
    assert.equal(packageJson.scripts.depcruise, 'shipfox-depcruise');
    assert.equal(packageJson.devDependencies['@shipfox/depcruise'], '1.0.1');
    assert.ok((await stat(path.join(root, shape, 'src/index.ts'))).isFile());
    assert.deepEqual(
      (await readdir(path.join(root, shape), {withFileTypes: true}))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
      ['src'],
      `${shape} must not scaffold unused layers`,
    );
  }
});

test('library templates expose only the package root with source and dist conditions', async () => {
  for (const shape of libraryShapes) {
    const packageJson = await manifest(shape);
    assert.deepEqual(Object.keys(packageJson.exports), ['.']);
    assert.equal(packageJson.exports['.'].development.default, './src/index.ts');
    assert.equal(packageJson.exports['.'].default.default, './dist/index.js');
    assert.deepEqual(packageJson.imports, {'#*': './src/*'});
  }
});

test('the universal DTO template does not inject Node or browser globals', async () => {
  const tsconfig = JSON.parse(await readFile(path.join(root, 'dto/tsconfig.build.json'), 'utf8'));
  assert.equal(tsconfig.extends, '@shipfox/ts-config');
  assert.deepEqual(tsconfig.compilerOptions.lib, ['ES2022']);
  assert.equal(tsconfig.compilerOptions.types, undefined);
});
