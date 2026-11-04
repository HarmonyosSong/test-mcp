import type { ServerType } from '@hono/node-server';

export async function drainHttpServer(
  server: ServerType,
  closeResources: () => Promise<void>,
  timeoutMs = 30_000,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const closed = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => {
      if ('closeAllConnections' in server) server.closeAllConnections();
    }, timeoutMs);
    server.close((error) => error ? reject(error) : resolve());
  });
  let serverCloseError: unknown;
  let serverCloseFailed = false;
  try {
    await closed;
  } catch (error) {
    serverCloseFailed = true;
    serverCloseError = error;
  } finally {
    if (timer) clearTimeout(timer);
  }

  let resourceCloseError: unknown;
  let resourceCloseFailed = false;
  try {
    await closeResources();
  } catch (error) {
    resourceCloseFailed = true;
    resourceCloseError = error;
  }
  if (serverCloseFailed && resourceCloseFailed) {
    throw new AggregateError([serverCloseError, resourceCloseError], 'HTTP server and runtime resource shutdown failed');
  }
  if (serverCloseFailed) throw serverCloseError;
  if (resourceCloseFailed) throw resourceCloseError;
}
