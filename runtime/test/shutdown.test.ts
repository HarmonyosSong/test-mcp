import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { drainHttpServer } from '../src/shutdown.js';

test('drains active HTTP responses before closing runtime resources', async () => {
  let resourcesClosed = false;
  let markStarted!: () => void;
  const requestStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const server = createServer((_request, response) => {
    markStarted();
    setTimeout(() => {
      assert.equal(resourcesClosed, false);
      response.end('finished');
    }, 30);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const responsePromise = fetch(`http://127.0.0.1:${address.port}/`, { headers: { connection: 'close' } });
  await requestStarted;
  const shutdownPromise = drainHttpServer(server, async () => { resourcesClosed = true; }, 1_000);
  const response = await responsePromise;
  assert.equal(await response.text(), 'finished');
  await shutdownPromise;
  assert.equal(resourcesClosed, true);
});

test('closes runtime resources even when the HTTP server close callback fails', async () => {
  const server = createServer();
  let resourcesClosed = false;
  await assert.rejects(
    drainHttpServer(server, async () => { resourcesClosed = true; }),
    /not running/i,
  );
  assert.equal(resourcesClosed, true);
});
