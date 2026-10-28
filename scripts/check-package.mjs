import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const archive = join(root, 'artifacts', `${manifest.name}-${manifest.version}.tgz`);
assert.ok((await stat(archive)).isFile(), 'Pack the compiled plugin into artifacts/ first');
assert.ok(process.env.npm_execpath, 'Run through npm run test:package');
const scratch = join(root, '.host');
await mkdir(scratch, { recursive: true });
const consumer = await mkdtemp(join(scratch, 'package-check-'));
try {
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await copyFile(new URL('./package-smoke.mjs', import.meta.url), join(consumer, 'smoke.mjs'));
  // The parent checkout supplies DSH peers; the tarball gets its own production dependencies.
  execFileSync(process.execPath, [process.env.npm_execpath, 'install', archive, '--omit=dev', '--legacy-peer-deps', '--foreground-scripts', '--no-audit', '--no-fund'], { cwd: consumer, stdio: 'inherit', timeout: 120_000 });
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(consumer, 'smoke.mjs')], { cwd: consumer, stdio: 'inherit', timeout: 15_000 });
} finally {
  assert.equal(dirname(consumer), scratch, 'Only remove the temporary consumer under this checkout');
  await rm(consumer, { recursive: true, force: true });
}
