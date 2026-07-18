import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {checkManifestExports} from './check-package-exports.mjs';

async function withPackage(manifest, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glint-exports-'));
  try {
    await mkdir(path.join(root, 'src'), {recursive: true});
    await mkdir(path.join(root, 'dist'), {recursive: true});
    await writeFile(path.join(root, 'src', 'index.ts'), 'export {};\n');
    await writeFile(path.join(root, 'dist', 'index.js'), 'export {};\n');
    await writeFile(path.join(root, 'dist', 'index.d.ts'), 'export {};\n');
    await writeFile(path.join(root, 'package.json'), `${JSON.stringify(manifest)}\n`);
    await run(path.join(root, 'package.json'));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

const validManifest = {
  name: '@glint/example',
  main: 'dist/index.js',
  types: 'dist/index.d.ts',
  imports: {'#*': './src/*'},
  exports: {
    '.': {
      development: {types: './src/index.ts', default: './src/index.ts'},
      default: {types: './dist/index.d.ts', default: './dist/index.js'},
    },
  },
};

test('well-formed source and dist entry points pass', async () => {
  await withPackage(validManifest, (packageFile) => {
    assert.deepEqual(checkManifestExports(packageFile, validManifest), []);
  });
});

test('missing default and types dist targets fail', async () => {
  const manifest = structuredClone(validManifest);
  manifest.exports['.'].default.types = './dist/missing.d.ts';
  manifest.exports['.'].default.default = './dist/missing.js';
  await withPackage(manifest, (packageFile) => {
    assert.match(checkManifestExports(packageFile, manifest).join('\n'), /missing\.d\.ts/);
    assert.match(checkManifestExports(packageFile, manifest).join('\n'), /missing\.js/);
  });
});

test('public deep and private export keys fail', async () => {
  const manifest = structuredClone(validManifest);
  manifest.exports['#core'] = './src/index.ts';
  manifest.exports['./src/*'] = './src/*';
  await withPackage(manifest, (packageFile) => {
    assert.match(
      checkManifestExports(packageFile, manifest).join('\n'),
      /#core must not be publicly exported/,
    );
    assert.match(
      checkManifestExports(packageFile, manifest).join('\n'),
      /\.\/src\/\* must not be publicly exported/,
    );
  });
});

test('unresolved self-import targets fail', async () => {
  const manifest = structuredClone(validManifest);
  manifest.imports['#*'] = './src/missing/*';
  await withPackage(manifest, (packageFile) => {
    assert.match(
      checkManifestExports(packageFile, manifest).join('\n'),
      /imports\.#\*\.default resolves to missing/,
    );
  });
});
