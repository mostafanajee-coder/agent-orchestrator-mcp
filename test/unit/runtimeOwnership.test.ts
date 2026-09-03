import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { SecurityError } from '../../src/errors.js';
import { acquireCanonicalRuntimeOwnership } from '../../src/runtime/ownership.js';

let probe: Server | undefined;
let port: number;

afterEach(async () => {
  if (probe !== undefined) {
    await new Promise<void>((resolve) => probe?.close(() => resolve()));
    probe = undefined;
  }
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server did not bind');
  port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return port;
}

describe('canonical runtime ownership', () => {
  it('holds a real loopback ownership socket and releases it explicitly', async () => {
    const selectedPort = await freePort();
    const ownership = await acquireCanonicalRuntimeOwnership({ port: selectedPort });

    await expect(acquireCanonicalRuntimeOwnership({ port: selectedPort })).rejects.toThrow(SecurityError);
    await ownership.close();

    const replacement = await acquireCanonicalRuntimeOwnership({ port: selectedPort });
    await replacement.close();
  });

  it('does not expose an application protocol on the ownership socket', async () => {
    const selectedPort = await freePort();
    const ownership = await acquireCanonicalRuntimeOwnership({ port: selectedPort });
    probe = createServer();
    await expect(new Promise<void>((resolve, reject) => {
      probe?.once('error', reject);
      probe?.listen({ host: '127.0.0.1', port: selectedPort }, () => resolve());
    })).rejects.toThrow();
    await ownership.close();
  });
});
