import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {expectedExitCode, runtimeExitIsSafe, selectBurstWork} from './run.mjs';

const corpusDirectory = fileURLToPath(new URL('../corpus/v1', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(corpusDirectory, 'manifest.json'), 'utf8'));

test('maps corpus classifications to documented ODiff exit codes', () => {
  const byClassification = new Map(
    manifest.cases.map((testCase) => [
      testCase.expected.classification,
      expectedExitCode(testCase),
    ]),
  );

  assert.equal(byClassification.get('unchanged'), 0);
  assert.equal(byClassification.get('changed'), 22);
  assert.equal(byClassification.get('layout-changed'), 21);
  assert.equal(byClassification.get('decode-error'), 1);
  assert.equal(byClassification.get('valid-or-limit-rejection'), 0);
});

test('models the observed 143-job burst as 126 checks and 17 diffs', () => {
  const work = Array.from({length: 143}, (_, taskIndex) => selectBurstWork(taskIndex, manifest));

  assert.equal(work.filter(({kind}) => kind === 'file-check').length, 126);
  assert.equal(work.filter(({kind}) => kind === 'diff').length, 17);
  assert.ok(
    work
      .filter(({kind}) => kind === 'diff')
      .every(({testCase}) => testCase.expected.engineInvocation),
  );
});

test('rejects task indexes outside the measured burst', () => {
  assert.throws(() => selectBurstWork(-1, manifest));
  assert.throws(() => selectBurstWork(143, manifest));
});

test('separates runtime safety from engine-quality classification', () => {
  const changed = manifest.cases.find(({expected}) => expected.classification === 'changed');
  const corrupt = manifest.cases.find(({expected}) => expected.classification === 'decode-error');

  assert.equal(runtimeExitIsSafe(changed, 0), true);
  assert.equal(runtimeExitIsSafe(changed, 22), true);
  assert.equal(runtimeExitIsSafe(changed, 137), false);
  assert.equal(runtimeExitIsSafe(corrupt, 1), true);
  assert.equal(runtimeExitIsSafe(corrupt, 0), false);
});
