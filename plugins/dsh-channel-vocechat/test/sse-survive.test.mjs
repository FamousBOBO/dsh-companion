import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSseClient } from '../sse.mjs';
import { createStore } from '../store.mjs';

/**
 * A fake VoceChat that kills the socket mid-stream, exactly like stopping the container does.
 * `content-type: text/event-stream` + a real `data:` frame, then `socket.destroy()`.
 */
function dyingStreamServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"ready"}\n\n');
    setTimeout(() => { res.socket.destroy(); }, 120);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const auth = { token: async () => 'T', refreshNow: async () => 'T2', describe: () => ({}) };

test('a socket dying mid-stream does not produce an unhandledRejection', async () => {
  // This is the production regression: `reader.cancel()` rejects with the same `terminated`
  // error, a synchronous `try/catch` cannot catch a rejection, and `dsh-app-boot` treats any
  // unhandled rejection as a fatal load failure (`proc.exit(1)`). Measured: stopping the VoceChat
  // container killed the whole DSH host.
  const seen = [];
  const onUnhandled = reason => seen.push(reason);
  const before = process.listenerCount('unhandledRejection');

  const { server, port } = await dyingStreamServer();
  const store = createStore({ dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'vc-die-')) });
  const client = createSseClient({
    baseUrl: `http://127.0.0.1:${port}`,
    auth,
    store,
    onEvent: () => {},
    reconnectBaseMs: 20,
    reconnectMaxMs: 20,
  });

  const previousHandler = process.rawListeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', onUnhandled);

  client.start();
  await new Promise(r => setTimeout(r, 800));
  await client.stop({ stopTimeoutMs: 200 });

  process.removeAllListeners('unhandledRejection');
  for (const handler of previousHandler) process.on('unhandledRejection', handler);
  server.close();

  assert.deepEqual(seen, [], `no unhandled rejection: got ${seen.map(String).join(' | ')}`);
  assert.equal(process.listenerCount('unhandledRejection') >= before, true);
  // The client must have recorded the break and kept going, not died.
  assert.equal(client.info().counters.errors >= 1, true, 'the break must be counted');
});

test('after the socket dies the loop keeps reconnecting from the cursor', async () => {
  let connections = 0;
  const server = http.createServer((req, res) => {
    connections += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"ready"}\n\n');
    setTimeout(() => { res.socket.destroy(); }, 80);
  });
  const port = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

  const store = createStore({ dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'vc-die2-')) });
  const client = createSseClient({
    baseUrl: `http://127.0.0.1:${port}`, auth, store, onEvent: () => {},
    reconnectBaseMs: 30, reconnectMaxMs: 30,
  });
  client.start();
  await new Promise(r => setTimeout(r, 600));
  await client.stop({ stopTimeoutMs: 300 });
  server.close();

  assert.equal(connections >= 2, true, `it must reconnect after each death (got ${connections})`);
});
