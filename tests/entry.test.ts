import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

test('the plugin entry loads in a plain Node process with no SDK resolver or enabled QQ config', () => {
  execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', 'await import(process.argv[1])', new URL('../src/index.ts', import.meta.url).href], { stdio: 'pipe' });
});

test('an unavailable QQ SDK does not prevent loading the core entry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const loader = join(root, 'block-sdk.mjs');
  await writeFile(loader, "export async function resolve(specifier, context, nextResolve) { if (specifier === '@snowluma/sdk') throw new Error('SDK unavailable'); return nextResolve(specifier, context); }");
  execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--loader', pathToFileURL(loader).href, '--input-type=module', '-e', 'await import(process.argv[1])', new URL('../src/index.ts', import.meta.url).href], { stdio: 'pipe' });
});
