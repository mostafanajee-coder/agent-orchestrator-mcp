import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import {
  RateLimitedTransport,
  RequestRateLimiter,
} from '../../src/mcp/admission.js';

class FakeTransport implements Transport {
  public readonly hasPerRequestStream = false;
  public onclose: (() => void) | undefined;
  public onerror: ((error: Error) => void) | undefined;
  public onmessage: (<T extends JSONRPCMessage>(message: T) => void) | undefined;
  public readonly sent: JSONRPCMessage[] = [];

  public start(): Promise<void> {
    return Promise.resolve();
  }

  public send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  public close(): Promise<void> {
    this.onclose?.();
    return Promise.resolve();
  }

  public emit(message: JSONRPCMessage): void {
    this.onmessage?.(message);
  }
}

describe('Phase 9 request admission', () => {
  it('enforces a per-token bucket and independent token budgets', () => {
    let now = 0;
    const limiter = new RequestRateLimiter({ clock: () => now });
    for (let index = 0; index < 30; index += 1) {
      expect(limiter.consume('token-a').allowed).toBe(true);
    }
    expect(limiter.consume('token-a')).toMatchObject({ allowed: false, retryAfterMs: 1_000 });
    expect(limiter.consume('token-b').allowed).toBe(true);
    now += 1_000;
    expect(limiter.consume('token-a').allowed).toBe(true);
  });

  it('charges requests but forwards responses and answers rejected requests itself', async () => {
    const limiter = new RequestRateLimiter({ capacity: 1, clock: () => 0 });
    const inner = new FakeTransport();
    const transport = new RateLimitedTransport(inner, limiter, 'token-a');
    const forwarded: JSONRPCMessage[] = [];
    transport.onmessage = (message): void => { forwarded.push(message); };

    inner.emit({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    inner.emit({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ping', arguments: {} } });
    inner.emit({ jsonrpc: '2.0', id: 3, result: {} });
    await Promise.resolve();

    expect(forwarded).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, result: {} },
    ]);
    expect(inner.sent).toEqual([{
      jsonrpc: '2.0',
      id: 2,
      error: {
        code: -32029,
        message: 'Request rate limit exceeded.',
        data: { code: 'RATE_LIMITED', retry_after_ms: 1_000 },
      },
    }]);
  });
});
