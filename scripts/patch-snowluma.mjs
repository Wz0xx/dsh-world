import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** SDK 1.x supports Node 22 but publishes extensionless ESM imports; keep the fix in every install. */
export function patchSnowluma(packageDir) {
  const changes = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) { visit(file); continue; }
      if (extname(file) !== '.js') continue;
      const source = readFileSync(file, 'utf8');
      const patched = source.replace(/(\b(?:from|import)\s*['"])(\.[^'"]+)(['"])/g, (match, prefix, specifier, quote) => {
        if (extname(specifier)) return match;
        const suffix = ['.js', '/index.js'].find(value => existsSync(resolve(dirname(file), specifier + value)));
        if (!suffix) throw new Error(`SnowLuma SDK import cannot be resolved: ${file}: ${specifier}`);
        return prefix + specifier + suffix + quote;
      });
      if (patched !== source) changes.push([file, patched]);
    }
  }
  const dist = join(packageDir, 'dist');
  if (!existsSync(dist)) return 0;
  visit(dist);
  for (const [file, patched] of changes) writeFileSync(file, patched, 'utf8');
  return changes.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const require = createRequire(import.meta.url);
  // @snowluma/sdk 是可选依赖：没装、装了一半、或者被 --omit=optional 跳过，都不该让整场
  // npm install 失败 —— 它只在 QQ 那条通道被拨开时才用得上。postinstall 里抛错会把插件
  // 本身一起拖死，那正是 2026-10-28「0.6.0 之后变成强制依赖、插件死机」的根。
  let manifest;
  try {
    manifest = require.resolve('@snowluma/sdk/package.json');
  } catch {
    process.stdout.write('@snowluma/sdk 不在，跳过 ESM 修补（可选依赖，QQ 通道拨开前用不到）。');
    process.exit(0);
  }
  const count = patchSnowluma(dirname(manifest));
  process.stdout.write('SnowLuma SDK ESM imports ready (' + count + ' files updated).');
}
