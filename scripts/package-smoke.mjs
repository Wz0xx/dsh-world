import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as plugin from 'dsh-world';
import * as sdk from '@snowluma/sdk';

// check-package copies this probe into the temporary consumer before running it.
const directory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
for (const name of ['dsh-world', '@snowluma/sdk']) {
  assert.ok(require.resolve(`${name}/package.json`).startsWith(join(directory, 'node_modules') + sep), `${name} must come from the freshly installed package`);
}
assert.equal(typeof plugin.apply, 'function');
assert.equal(typeof sdk.SnowLumaWebSocketClient, 'function');
const { createBridge } = await import(new URL('./node_modules/dsh-world/lib/ecosystem/qq-native/snowluma.js', import.meta.url));
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(server, 'listening');
const bridge = createBridge({ wsUrl: `ws://127.0.0.1:${server.address().port}` });
try {
  await bridge.start();
  assert.equal(bridge.getState(), 'online');
} finally {
  await bridge.stop();
  await new Promise(resolve => server.close(resolve));
}
process.stdout.write('Packed plugin entry, SDK install repair and local QQ connection passed.\n');
