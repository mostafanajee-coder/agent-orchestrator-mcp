import type {
  JSONRPCMessage,
  JSONRPCNotification,
  JSONRPCRequest,
  MessageExtraInfo,
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/server';

export const REQUEST_RATE_LIMIT_CAPACITY = 30;
export const REQUEST_RATE_LIMIT_REFILL_PER_SECOND = 1;
export const REQUEST_RATE_LIMIT_MAX_RETRY_AFTER_MS = 60_000;

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterMs?: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RequestRateLimiterOptions {
  readonly clock?: () => number;
  readonly capacity?: number;
  readonly refillPerSecond?: number;
}

export class RequestRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly clock: () => number;
  private readonly capacity: number;
  private readonly refillPerSecond: number;

  public constructor(options: RequestRateLimiterOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.capacity = options.capacity ?? REQUEST_RATE_LIMIT_CAPACITY;
    this.refillPerSecond = options.refillPerSecond ?? REQUEST_RATE_LIMIT_REFILL_PER_SECOND;
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1) {
      throw new RangeError('The request-rate capacity is invalid.');
    }
    if (!Number.isFinite(this.refillPerSecond) || this.refillPerSecond <= 0) {
      throw new RangeError('The request-rate refill is invalid.');
    }
  }

  /** Consumes one authenticated request credit for the verified token ID. */
  public consume(tokenId: string): RateLimitDecision {
    if (typeof tokenId !== 'string' || tokenId.trim() === '' || tokenId.length > 256) {
      return { allowed: false, retryAfterMs: REQUEST_RATE_LIMIT_MAX_RETRY_AFTER_MS };
    }
    const now = this.clock();
    if (!Number.isFinite(now)) return { allowed: false, retryAfterMs: REQUEST_RATE_LIMIT_MAX_RETRY_AFTER_MS };
    const existing = this.buckets.get(tokenId);
    const current: Bucket = existing === undefined
      ? { tokens: this.capacity, updatedAt: now }
      : existing;
    const elapsedSeconds = Math.max(0, now - current.updatedAt) / 1_000;
    current.tokens = Math.min(this.capacity, current.tokens + elapsedSeconds * this.refillPerSecond);
    current.updatedAt = now;
    if (current.tokens < 1) {
      this.buckets.set(tokenId, current);
      const retryAfterMs = Math.min(
        REQUEST_RATE_LIMIT_MAX_RETRY_AFTER_MS,
        Math.max(1, Math.ceil((1 - current.tokens) * 1_000 / this.refillPerSecond)),
      );
      return { allowed: false, retryAfterMs };
    }
    current.tokens -= 1;
    this.buckets.set(tokenId, current);
    return { allowed: true };
  }

  /** Test/support hook; limiter state remains process-local and non-persistent. */
  public clear(): void {
    this.buckets.clear();
  }
}

function isRequestOrNotification(message: JSONRPCMessage): message is JSONRPCRequest | JSONRPCNotification {
  return 'method' in message && typeof message.method === 'string';
}

function requestId(message: JSONRPCRequest | JSONRPCNotification): string | number | null | undefined {
  return 'id' in message ? message.id : null;
}

/**
 * Applies the same post-authentication limiter to a shared stdio transport.
 * The wrapper forwards responses without charging a bucket and answers a
 * rejected request before it reaches the MCP server instance.
 */
export class RateLimitedTransport implements Transport {
  public onclose: (() => void) | undefined;
  public onerror: ((error: Error) => void) | undefined;
  public onmessage: (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void) | undefined;
  public readonly hasPerRequestStream: boolean;

  public constructor(
    private readonly inner: Transport,
    private readonly limiter: RequestRateLimiter,
    private readonly tokenId: string,
  ) {
    this.hasPerRequestStream = inner.hasPerRequestStream ?? false;
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo): void => {
      this.handleMessage(message, extra);
    };
  }

  public get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  public set sessionId(value: string | undefined) {
    this.inner.sessionId = value;
  }

  public setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }

  public setSupportedProtocolVersions(versions: string[]): void {
    this.inner.setSupportedProtocolVersions?.(versions);
  }

  public start(): Promise<void> {
    return this.inner.start();
  }

  public send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.inner.send(message, options);
  }

  public close(): Promise<void> {
    return this.inner.close();
  }

  private handleMessage<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo): void {
    if (!isRequestOrNotification(message)) {
      this.onmessage?.(message, extra);
      return;
    }
    const decision = this.limiter.consume(this.tokenId);
    if (decision.allowed) {
      this.onmessage?.(message, extra);
      return;
    }
    const id = requestId(message);
    if (id === null || id === undefined) return;
    void this.inner.send({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32029,
        message: 'Request rate limit exceeded.',
        data: {
          code: 'RATE_LIMITED',
          retry_after_ms: decision.retryAfterMs ?? REQUEST_RATE_LIMIT_MAX_RETRY_AFTER_MS,
        },
      },
    }).catch((error: unknown) => {
      this.onerror?.(error instanceof Error ? error : new Error('Rate-limit response failed.'));
    });
  }
}
