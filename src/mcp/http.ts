import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import {
  createMcpHandler,
  requireBearerAuth,
  type AuthInfo as SdkAuthInfo,
} from '@modelcontextprotocol/server';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';

import { createSdkTokenVerifier, type AccessTokenResolver } from './auth.js';
import { createMcpServerFactory } from './server.js';
import type { Phase4AuthorityToolOptions } from './tools/codexDecide.js';
import type { Phase5JobToolOptions } from './tools/jobLifecycle.js';
import type { Phase6WorkerToolOptions } from './tools/phase6.js';

export const MCP_HTTP_HOST = '127.0.0.1';
export const MCP_HTTP_PATH = '/mcp';
export const MCP_HTTP_DEFAULT_PORT = 4317;
export const MCP_HTTP_MAX_BODY_BYTES = 1024 * 1024;
export const MCP_HTTP_REQUEST_TIMEOUT_MS = 15_000;

export interface HttpLogger {
  readonly error: (message: string) => void;
}

export interface HttpServerOptions {
  readonly resolver: AccessTokenResolver;
  readonly version: string;
  readonly port?: number;
  readonly logger?: HttpLogger;
  readonly authority?: Phase4AuthorityToolOptions;
  readonly jobs?: Phase5JobToolOptions;
  readonly workers?: Phase6WorkerToolOptions;
  /** Fail-closed startup gate; it runs before this server binds. */
  readonly verifyStartup: () => void;
}

class RequestBodyTooLargeError extends Error {
  public override readonly name = 'RequestBodyTooLargeError';
}

const DEFAULT_LOGGER: HttpLogger = { error: () => undefined };

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function webHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else {
      result.set(name, value);
    }
  }
  return result;
}

function requestUrl(request: IncomingMessage): string {
  const host = headerValue(request.headers, 'host') ?? 'localhost';
  return new URL(request.url ?? '/', `http://${host}`).toString();
}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const method = (request.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return undefined;

  const declaredLength = Number(headerValue(request.headers, 'content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MCP_HTTP_MAX_BODY_BYTES) {
    request.resume();
    throw new RequestBodyTooLargeError('request body exceeds the configured limit');
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > MCP_HTTP_MAX_BODY_BYTES) {
      throw new RequestBodyTooLargeError('request body exceeds the configured limit');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    ...headers,
  });
  response.end(body);
}

async function writeWebResponse(response: ServerResponse, webResponse: Response): Promise<void> {
  const headers: Record<string, string> = {};
  webResponse.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const body = Buffer.from(await webResponse.arrayBuffer());
  if (headers['content-length'] === undefined) headers['content-length'] = String(body.byteLength);
  response.writeHead(webResponse.status, headers);
  response.end(body);
}

function pathFromUrl(url: string | undefined): string {
  const raw = url ?? '/';
  const question = raw.indexOf('?');
  return question === -1 ? raw : raw.slice(0, question);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  nodeHandler: ReturnType<typeof toNodeHandler>,
  authGate: ReturnType<typeof requireBearerAuth>,
  validateHost: ReturnType<typeof localhostHostValidation>,
  validateOrigin: ReturnType<typeof localhostOriginValidation>,
): Promise<void> {
  if (!validateHost(request, response)) return;
  if (!validateOrigin(request, response)) return;

  if (pathFromUrl(request.url) !== MCP_HTTP_PATH) {
    sendJson(response, 404, { error: 'not_found' });
    return;
  }

  // Authenticate before reading an unauthenticated body. This both enforces
  // the gate on every request and avoids spending body budget on rejected input.
  const authRequest = new Request(requestUrl(request), {
    method: 'GET',
    headers: webHeaders(request.headers),
  });
  const auth = await authGate(authRequest);
  if (auth instanceof Response) {
    await writeWebResponse(response, auth);
    return;
  }

  const body = await readBoundedBody(request);
  let parsedBody: unknown;
  if (body !== undefined && body.byteLength > 0) {
    try {
      parsedBody = JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      sendJson(response, 400, {
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Invalid JSON request' },
        id: null,
      });
      return;
    }
  }

  const authenticatedRequest = request as unknown as Parameters<typeof nodeHandler>[0] & {
    auth?: SdkAuthInfo;
  };
  authenticatedRequest.auth = auth;
  if (parsedBody === undefined) {
    await nodeHandler(authenticatedRequest, response);
  } else {
    await nodeHandler(authenticatedRequest, response, parsedBody);
  }
}

/** Creates an unbound Node HTTP server for deterministic integration tests. */
export function createHttpServer(options: HttpServerOptions): Server {
  const logger = options.logger ?? DEFAULT_LOGGER;
  const mcpHandler = createMcpHandler(
    createMcpServerFactory({
      transport: 'http',
      version: options.version,
      ...(options.authority === undefined ? {} : { authority: options.authority }),
      ...(options.jobs === undefined ? {} : { jobs: options.jobs }),
      ...(options.workers === undefined ? {} : { workers: options.workers }),
    }),
    {
      legacy: 'stateless',
      responseMode: 'auto',
      onerror: () => logger.error('MCP HTTP protocol error'),
    },
  );
  const nodeHandler = toNodeHandler(mcpHandler, {
    onerror: () => logger.error('MCP HTTP request conversion failed'),
  });
  const authGate = requireBearerAuth({
    verifier: createSdkTokenVerifier(options.resolver),
    requiredScopes: ['mcp'],
  });
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const server = createServer((request, response) => {
    void handleRequest(
      request,
      response,
      nodeHandler,
      authGate,
      validateHost,
      validateOrigin,
    ).catch((error: unknown) => {
      if (error instanceof RequestBodyTooLargeError) {
        if (!response.headersSent) {
          sendJson(response, 413, { error: 'request_body_too_large' });
        } else {
          response.destroy();
        }
        return;
      }

      logger.error('MCP HTTP request failed');
      if (!response.headersSent) {
        sendJson(response, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      } else {
        response.destroy();
      }
    });
  });

  server.requestTimeout = MCP_HTTP_REQUEST_TIMEOUT_MS;
  server.headersTimeout = MCP_HTTP_REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = 5_000;
  server.on('close', () => {
    void mcpHandler.close().catch(() => logger.error('MCP HTTP handler close failed'));
  });
  return server;
}

function portOrDefault(port: number | undefined): number {
  const selected = port ?? MCP_HTTP_DEFAULT_PORT;
  if (!Number.isInteger(selected) || selected < 0 || selected > 65_535) {
    throw new RangeError('HTTP port must be an integer between 0 and 65535');
  }
  return selected;
}

/** Starts on the explicit loopback address; port 0 is useful only for tests. */
export function startHttpServer(options: HttpServerOptions): Server {
  options.verifyStartup();
  const server = createHttpServer(options);
  server.listen({ host: MCP_HTTP_HOST, port: portOrDefault(options.port) });
  return server;
}

/** Starts and awaits the loopback bind, useful for integration acceptance tests. */
export async function listenHttpServer(options: HttpServerOptions): Promise<Server> {
  options.verifyStartup();
  const server = createHttpServer(options);
  const port = portOrDefault(options.port);
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
    server.listen({ host: MCP_HTTP_HOST, port });
  });
  return server;
}

export async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
