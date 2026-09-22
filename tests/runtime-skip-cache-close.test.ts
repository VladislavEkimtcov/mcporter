import { Client } from '@modelcontextprotocol/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import type { ClientContext } from '../src/runtime/transport-types.js';

const createClientContext = vi.hoisted(() => vi.fn());
vi.mock('../src/runtime/transport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runtime/transport.js')>()),
  createClientContext,
}));
const { RuntimeConnectionCache } = await import('../src/runtime/connection-cache.js');

afterEach(() => {
  createClientContext.mockReset();
  vi.restoreAllMocks();
});

it.each(['close', 'supersede'])(
  'retires a late uncached context after %s without returning it to callers',
  async (action) => {
    const definition: ServerDefinition = {
      name: 'late',
      command: { kind: 'stdio', command: 'unused', args: [], cwd: process.cwd() },
    };
    const pending = Promise.withResolvers<ClientContext>();
    createClientContext.mockReturnValue(pending.promise);
    const cache = new RuntimeConnectionCache(new Map([[definition.name, definition]]), {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      clientInfo: { name: 'test', version: '1' },
      oauthTimeoutMs: 1000,
      elicitationHandler: async () => ({ action: 'decline' }),
    });
    const client = new Client({ name: 'test', version: '1' });
    const clientClose = vi.spyOn(client, 'close').mockResolvedValue(undefined);
    const transport = { start: vi.fn(async () => {}), send: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const context: ClientContext = { definition, client, transport };
    const connecting = cache.connect(definition.name, { skipCache: true });
    const outcome = connecting.catch((error: unknown) => error);
    await vi.waitFor(() => expect(createClientContext).toHaveBeenCalledOnce());
    if (action === 'supersede') cache.supersedeDefinition(definition.name, () => {});
    const closing = cache.close(definition.name);
    let closed = false;
    void closing.then(
      () => {
        closed = true;
      },
      () => {
        closed = true;
      }
    );
    try {
      expect(createClientContext.mock.calls[0]?.[3]?.signal.aborted).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      pending.resolve(context);
      await closing;
      await expect(outcome).resolves.toMatchObject({ message: expect.stringContaining('superseded') });
      expect(transport.close).toHaveBeenCalledOnce();
      expect(clientClose).toHaveBeenCalledOnce();
      await expect(cache.getConnectionInfo(definition.name)).resolves.toBeUndefined();
    } finally {
      pending.resolve(context);
      await Promise.allSettled([closing, connecting]);
    }
  }
);
