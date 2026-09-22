import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { createRuntime } from '../src/runtime.js';

const SDK_REQUEST_TIMEOUT_MS = 60_000;
// An uncancelled handshake waits at least for the SDK's 60-second request timeout. One sixteenth of that gap
// leaves ample headroom for slow Windows CI while still failing long before the uncancelled path can settle.
const CANCELLED_CLOSE_DEADLINE_MS = SDK_REQUEST_TIMEOUT_MS / 16;

describe('runtime in-flight connection close', () => {
  it.each([
    { skipCache: false, waitForRequest: false },
    { skipCache: false, waitForRequest: true },
    { skipCache: true, waitForRequest: true },
  ])('cancels an unresponsive HTTP connection: %j', async ({ skipCache, waitForRequest }) => {
    const requestReceived = Promise.withResolvers<void>();
    const server = http.createServer(() => {
      requestReceived.resolve();
      // Accept the request but never answer it. Without connection cancellation, the initialize request remains
      // parked on the SDK timeout; there is no child-process teardown that could settle the connection instead.
    });
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
      server.listen(0, '127.0.0.1');
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind to a TCP port');

    const runtime = await createRuntime({
      servers: [
        {
          name: 'unresponsive',
          command: { kind: 'http', url: new URL(`http://127.0.0.1:${address.port}/mcp`) },
          protocolVersion: 'legacy',
        },
      ],
    });
    const connecting = runtime.connect('unresponsive', { disableOAuth: true, allowCachedAuth: false, skipCache });
    const connectionResult = connecting.then(
      () => undefined,
      (error: unknown) => error
    );
    let closing: Promise<void> | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      if (waitForRequest) await requestReceived.promise;
      closing = runtime.close();
      const settledPromptly = await Promise.race([
        Promise.all([closing, connectionResult]).then(
          () => true,
          () => true
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), CANCELLED_CLOSE_DEADLINE_MS);
        }),
      ]);
      expect(settledPromptly).toBe(true);
      await expect(closing).resolves.toBeUndefined();
      await expect(connectionResult).resolves.toBeInstanceOf(Error);
    } finally {
      if (timer) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.allSettled([connecting, closing]);
    }
  });
});
