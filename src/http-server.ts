import { createHmac, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpAdapter } from './mcp-server.js';
import { createMcpServer } from './mcp-server.js';
import type { MutationCaller } from './mutations.js';
import type { MutationCoordinator } from './mutations.js';
import { MANAGED_MEDIA_MIME_TYPES, type ManagedMediaStore } from './media-store.js';

export type RuntimeStatus = 'not_configured' | 'configured' | 'upstream_ready' | 'upstream_unavailable';

export interface HealthReport {
  adapter: string;
  profileId: string;
  releaseRevision: string;
  configured: boolean;
  status: RuntimeStatus;
}

export interface MetaWebhookConfig {
  appSignatureKey: string;
  challengeVerifier: string;
  process(payload: unknown): Promise<void>;
  maxBodyBytes?: number;
}

export interface HttpServerConfig {
  adapter: McpAdapter;
  port: number;
  listenHost?: string;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  resolveCaller?: (request: IncomingMessage) => Promise<MutationCaller | null>;
  mutationCoordinator?: MutationCoordinator;
  health(): Promise<HealthReport>;
  metaWebhook?: MetaWebhookConfig;
  mediaStore?: ManagedMediaStore;
  maxMediaUploadBytes?: number;
  maxMcpBodyBytes?: number;
}

class HttpRequestError extends Error {
  constructor(readonly status: 400 | 413, message: string) { super(message); }
}

export function createHttpServer(config: HttpServerConfig): Server {
  const listenHost = config.listenHost ?? '127.0.0.1';
  if (!isLoopbackAddress(listenHost)) throw new Error('MCP HTTP server must bind to a loopback IP address.');
  if (config.allowedHosts.length === 0) throw new Error('At least one allowed Host is required.');
  if (config.metaWebhook && config.adapter.kind !== 'business-graph') {
    throw new Error('Meta webhook may only be attached to the Business Graph instance.');
  }
  const allowedHosts = new Set(config.allowedHosts.map((host) => host.toLowerCase()));
  const allowedOrigins = new Set(config.allowedOrigins.map((origin) => new URL(origin).origin));
  const server = createServer((request, response) => {
    void routeRequest(config, allowedHosts, allowedOrigins, request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        const status = error instanceof HttpRequestError ? error.status : 500;
        sendJson(response, status, { error: status === 413 ? 'request_too_large' : status === 400 ? 'invalid_request' : 'internal_error' });
      }
      else response.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export function isLoopbackAddress(host: string): boolean {
  if (host === 'localhost') return true;
  if (isIP(host) === 4) return host.startsWith('127.');
  return host === '::1';
}

async function routeRequest(
  config: HttpServerConfig,
  allowedHosts: Set<string>,
  allowedOrigins: Set<string>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!hostAllowed(request, allowedHosts)) return sendJson(response, 421, { error: 'host_not_allowed' });
  if (!originAllowed(request, allowedOrigins)) return sendJson(response, 403, { error: 'origin_not_allowed' });

  const pathname = request.url ? new URL(request.url, `http://${request.headers.host}`).pathname : '/';
  if (pathname === '/health' && request.method === 'GET') {
    const report = await config.health();
    const identityReady = report.profileId !== 'unconfigured' && /^[a-f0-9]{40}$/i.test(report.releaseRevision);
    return sendJson(response, identityReady ? 200 : 503, report);
  }
  if (pathname === '/webhooks/meta') {
    if (!config.metaWebhook) return sendJson(response, 404, { error: 'not_found' });
    return handleMetaWebhook(request, response, config.metaWebhook);
  }
  if (pathname === '/media') return handleMediaUpload(request, response, config);
  const mediaMatch = /^\/media\/([0-9a-f-]{36})$/i.exec(pathname);
  const requestedMediaId = mediaMatch?.[1];
  if (requestedMediaId) return handleMediaDownload(request, response, config, requestedMediaId);
  if (pathname !== '/mcp') return sendJson(response, 404, { error: 'not_found' });
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return sendJson(response, 405, { error: 'method_not_allowed' });
  }

  const caller = await config.resolveCaller?.(request);
  if (!caller || caller.adapter !== config.adapter.kind) return sendJson(response, 401, { error: 'unauthorized' });
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') return sendJson(response, 415, { error: 'application_json_required' });
  const body = await readJsonBody(request, config.maxMcpBodyBytes ?? 1_000_000);
    const mcp = createMcpServer(config.adapter, () => caller, {
      ...(config.mutationCoordinator ? { mutationCoordinator: config.mutationCoordinator } : {}),
      ...(config.mediaStore ? { mediaStore: config.mediaStore } : {}),
    });
  const transport = new StreamableHTTPServerTransport();
  try {
    // The SDK's optional callback declarations conflict with exactOptionalPropertyTypes.
    await mcp.connect(transport as unknown as Transport);
    await transport.handleRequest(request, response, body);
  } finally {
    await mcp.close();
  }
}

async function handleMediaDownload(
  request: IncomingMessage,
  response: ServerResponse,
  config: HttpServerConfig,
  mediaId: string,
): Promise<void> {
  if (!config.mediaStore) return sendJson(response, 404, { error: 'not_found' });
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return sendJson(response, 405, { error: 'method_not_allowed' });
  }
  const caller = await config.resolveCaller?.(request);
  if (!caller || caller.adapter !== config.adapter.kind) return sendJson(response, 401, { error: 'unauthorized' });
  try {
    await config.adapter.authorize(caller);
  } catch {
    return sendJson(response, 403, { error: 'account_not_authorized' });
  }
  try {
    const media = await config.mediaStore.read(mediaId, {
      maxBytes: 25 * 1024 * 1024,
      allowedMimeTypes: MANAGED_MEDIA_MIME_TYPES,
    });
    response.writeHead(200, {
      'content-type': media.mimeType,
      'content-length': String(media.size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(media.fileName)}`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'x-content-sha256': media.sha256,
    });
    response.end(media.bytes);
  } catch {
    return sendJson(response, 404, { error: 'media_not_found' });
  }
}

async function handleMediaUpload(
  request: IncomingMessage,
  response: ServerResponse,
  config: HttpServerConfig,
): Promise<void> {
  if (!config.mediaStore) return sendJson(response, 404, { error: 'not_found' });
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return sendJson(response, 405, { error: 'method_not_allowed' });
  }
  const caller = await config.resolveCaller?.(request);
  if (!caller || caller.adapter !== config.adapter.kind) return sendJson(response, 401, { error: 'unauthorized' });
  try {
    await config.adapter.authorize(caller);
  } catch {
    return sendJson(response, 403, { error: 'account_not_authorized' });
  }
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (!contentType) return sendJson(response, 415, { error: 'content_type_required' });
  const fileName = request.headers['x-file-name'];
  if (typeof fileName !== 'string' || fileName.length > 256) return sendJson(response, 400, { error: 'file_name_required' });
  const bytes = await readRawBody(request, config.maxMediaUploadBytes ?? 5 * 1024 * 1024);
  const media = await config.mediaStore.save({
    bytes,
    mimeType: contentType,
    fileName,
    maxBytes: config.maxMediaUploadBytes ?? 5 * 1024 * 1024,
  });
  return sendJson(response, 201, {
    mediaId: media.id,
    mimeType: media.mimeType,
    fileName: media.fileName,
    size: media.size,
    sha256: media.sha256,
  });
}

async function handleMetaWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  config: MetaWebhookConfig,
): Promise<void> {
  if (request.method === 'GET') {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const mode = url.searchParams.get('hub.mode');
    const challengeVerifier = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode !== 'subscribe' || !constantTimeEqual(challengeVerifier, config.challengeVerifier) || challenge === null) {
      return sendJson(response, 403, { error: 'webhook_verification_failed' });
    }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end(challenge);
    return;
  }
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'GET, POST');
    return sendJson(response, 405, { error: 'method_not_allowed' });
  }
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') return sendJson(response, 415, { error: 'application_json_required' });
  const rawBody = await readRawBody(request, config.maxBodyBytes ?? 1_000_000);
  const signature = request.headers['x-hub-signature-256'];
  if (typeof signature !== 'string' || !verifyMetaSignature(rawBody, signature, config.appSignatureKey)) {
    return sendJson(response, 401, { error: 'invalid_webhook_signature' });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return sendJson(response, 400, { error: 'invalid_json' });
  }
  await config.process(payload);
  return sendJson(response, 200, { accepted: true });
}

export function verifyMetaSignature(rawBody: Buffer, signature: string, appSignatureKey: string): boolean {
  const match = /^sha256=([a-f0-9]{64})$/i.exec(signature);
  const digest = match?.[1];
  if (!digest) return false;
  const expected = createHmac('sha256', appSignatureKey).update(rawBody).digest();
  const supplied = Buffer.from(digest, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function hostAllowed(request: IncomingMessage, allowedHosts: Set<string>): boolean {
  const host = request.headers.host;
  if (!host) return false;
  try {
    const parsed = new URL(`http://${host}`);
    return !parsed.username && !parsed.password && allowedHosts.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function originAllowed(request: IncomingMessage, allowedOrigins: Set<string>): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return allowedOrigins.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const rawBody = await readRawBody(request, maxBytes);
  try {
    return JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    throw new HttpRequestError(400, 'Invalid JSON request body.');
  }
}

async function readRawBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = request.headers['content-length'];
  if (declared && Number(declared) > maxBytes) throw new HttpRequestError(413, 'Request body too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new HttpRequestError(413, 'Request body too large.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

function constantTimeEqual(left: string | null, right: string): boolean {
  if (left === null) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(data);
}

async function runHttpMain(): Promise<void> {
  const { createServiceRuntime } = await import('./runtime.js');
  const runtime = await createServiceRuntime(process.env, 'http');
  const config = runtime.httpConfig();
  const server = createHttpServer(config);
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.listenHost ?? '127.0.0.1', () => resolveListen());
  });
  process.stderr.write(`WhatsApp MCP HTTP ready on ${config.listenHost ?? '127.0.0.1'}:${config.port}; configured=${runtime.configured}\n`);
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    runtime.close();
  };
  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
}

if (isMainEntrypoint(import.meta.url, process.argv[1])) {
  void runHttpMain().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Startup failed.';
    process.stderr.write(`WhatsApp MCP startup failed: ${message}\n`);
    process.exitCode = 1;
  });
}

function isMainEntrypoint(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}
