import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { patchSnowluma } from '../scripts/patch-snowluma.mjs';

test('SDK install patch resolves file and directory exports, preserves explicit extensions and is idempotent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-patch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dist/events'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'dist/index.js'), "export { x } from './value';\nexport { y } from './events';\nexport { z } from './explicit.js';\n");
  await writeFile(join(root, 'dist/value.js'), 'export const x=1;');
  await writeFile(join(root, 'dist/events/index.js'), 'export const y=2;');
  await writeFile(join(root, 'dist/explicit.js'), 'export const z=3;');
  assert.equal(patchSnowluma(root), 1);
  assert.equal(patchSnowluma(root), 0);
  assert.deepEqual({ ...await import(pathToFileURL(join(root, 'dist/index.js')).href) }, { x: 1, y: 2, z: 3 });
  const original = "export { missing } from './missing';\n";
  await writeFile(join(root, 'dist/index.js'), original);
  await writeFile(join(root, 'dist/another.js'), "export { x } from './value';\n");
  assert.throws(() => patchSnowluma(root), /cannot be resolved/);
  assert.equal(await readFile(join(root, 'dist/index.js'), 'utf8'), original);
  assert.equal(await readFile(join(root, 'dist/another.js'), 'utf8'), "export { x } from './value';\n", 'invalid layouts must fail before any file is rewritten');
});
