import { createServer, type Server } from 'node:net';

import { SecurityError } from '../errors.js';

/** The loopback endpoint that serializes the canonical AOM runtime. */
export const CANONICAL_RUNTIME_HOST = '127.0.0.1';
export const CANONICAL_RUNTIME_PORT = 4317;

export interface RuntimeOwnership {
  /** Releases the held runtime ownership endpoint. */
  readonly close: () => Promise<void>;
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

/**
 * Acquires the canonical runtime ownership endpoint and holds it until close.
 *
 * This is deliberately a real listening socket, not a probe or a persistent
 * lock file. An AOM HTTP server owns the same endpoint while it is serving;
 * the stdio CLI also acquires this passive endpoint so all production modes
 * share one single-instance boundary. A caller must keep the returned handle
 * for the entire mutation or runtime lifetime.
 */
export async function acquireCanonicalRuntimeOwnership(options: {
  readonly host?: string;
  readonly port?: number;
} = {}): Promise<RuntimeOwnership> {
  const host = options.host ?? CANONICAL_RUNTIME_HOST;
  const port = options.port ?? CANONICAL_RUNTIME_PORT;
  const server = createServer((socket) => {
    // The ownership socket is not an application protocol endpoint. Any
    // unexpected connection is closed without reading or reflecting data.
    socket.destroy();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host, port });
    });
  } catch (cause) {
    await closeServer(server).catch(() => undefined);
    const code = cause as NodeJS.ErrnoException;
    if (code.code === 'EADDRINUSE') {
      throw new SecurityError(
        'AOM runtime ownership is already held, so the state mutation was refused.',
        'Stop the running AOM service and retry. No state was changed.',
      );
    }
    throw new SecurityError(
      'AOM runtime ownership could not be acquired, so the state mutation was refused.',
      'Verify that the canonical local runtime endpoint is available and retry. No state was changed.',
    );
  }

  return { close: () => closeServer(server) };
}
