import type { AdapterKind } from '../capabilities.js';
import type { McpAdapter } from '../mcp-server.js';
import type { MutationCaller } from '../mutations.js';

export type FetchLike = typeof fetch;

export interface ProviderRuntimeOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface JsonRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  query?: URLSearchParams;
  headers?: Record<string, string>;
  body?: unknown;
  write?: boolean;
}

export interface ProviderBytes {
  bytes: Uint8Array;
  contentType: string;
}

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly providerCode: string | number | undefined;

  constructor(status: number, providerCode?: string | number) {
    super(`Provider request failed with HTTP ${status}${providerCode ? ` (code ${providerCode})` : ''}.`);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.providerCode = providerCode;
  }
}

export class ProviderOutcomeUnknownError extends Error {
  constructor() {
    super('Provider write outcome is unknown; automatic retry is disabled.');
    this.name = 'ProviderOutcomeUnknownError';
  }
}

export class ProviderResponseTooLargeError extends Error {
  constructor() {
    super('Provider response exceeded the configured size limit.');
    this.name = 'ProviderResponseTooLargeError';
  }
}

export class AdapterAccountMismatchError extends Error {
  constructor(adapter: AdapterKind) {
    super(`Caller is not authorized for this ${adapter} account.`);
    this.name = 'AdapterAccountMismatchError';
  }
}

export function assertCaller(
  caller: MutationCaller,
  adapter: AdapterKind,
  accountId: string,
): void {
  if (caller.adapter !== adapter || caller.accountId !== accountId) {
    throw new AdapterAccountMismatchError(adapter);
  }
}

export function positiveLimit(value: number | undefined, fallback: number, max: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
    throw new RangeError(`limit must be an integer from 1 to ${max}.`);
  }
  return limit;
}

export function queryFromObject(input: Record<string, string | number | boolean | undefined>): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) query.set(key, String(value));
  }
  return query;
}

export function encodePathSegment(value: string): string {
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError('Invalid provider identifier.');
  }
  return encodeURIComponent(value);
}

export function normalizeRuntimeOptions(options: ProviderRuntimeOptions) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxResponseBytes = options.maxResponseBytes ?? 1_000_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new RangeError('timeoutMs must be from 100 to 120000.');
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1_024 || maxResponseBytes > 10_000_000) {
    throw new RangeError('maxResponseBytes must be from 1024 to 10000000.');
  }
  return {
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    timeoutMs,
    maxResponseBytes,
  };
}

export function assertWahaBaseUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError('WAHA base URL must be a valid private HTTP(S) origin.');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const privateHost = host === 'localhost'
    || host === '::1'
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || !host.includes('.')
    || isPrivateIpv4(host)
    || isPrivateIpv6(host);
  if (!['http:', 'https:'].includes(url.protocol)
    || !privateHost
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== '/' && url.pathname !== '')) {
    throw new TypeError('WAHA base URL must be a private HTTP(S) origin without path, credentials, query, or fragment.');
  }
  return url;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function isPrivateIpv6(host: string): boolean {
  return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
}

export class BoundedJsonClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(
    private readonly baseUrl: URL,
    private readonly headers: Record<string, string>,
    options: ProviderRuntimeOptions = {},
  ) {
    const normalized = normalizeRuntimeOptions(options);
    this.fetchImpl = normalized.fetchImpl;
    this.timeoutMs = normalized.timeoutMs;
    this.maxResponseBytes = normalized.maxResponseBytes;
  }

  async json<T = unknown>(request: JsonRequest): Promise<T> {
    if (!request.path.startsWith('/') || request.path.startsWith('//') || request.path.includes('..')) {
      throw new TypeError('Provider path must be a fixed absolute path.');
    }
    const url = new URL(request.path, this.baseUrl);
    if (request.query) url.search = request.query.toString();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: request.method,
        headers: {
          accept: 'application/json',
          ...this.headers,
          ...request.headers,
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch {
      clearTimeout(timeout);
      if (request.write) throw new ProviderOutcomeUnknownError();
      throw new Error('Provider request could not be completed.');
    }

    try {
      let raw: Uint8Array;
      try {
        raw = await readBoundedBody(response, this.maxResponseBytes);
      } catch (error) {
        if (request.write && response.ok) throw new ProviderOutcomeUnknownError();
        throw error;
      }
      const text = new TextDecoder().decode(raw);
      let parsed: unknown = {};
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          if (request.write && response.ok) throw new ProviderOutcomeUnknownError();
          throw new Error('Provider returned an invalid JSON response.');
        }
      }
      if (!response.ok) throw new ProviderHttpError(response.status, extractProviderCode(parsed));
      return parsed as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async multipart<T = unknown>(path: string, fields: Record<string, string>, file: Blob, fileName: string): Promise<T> {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('..')) {
      throw new TypeError('Provider path must be a fixed absolute path.');
    }
    const url = new URL(path, this.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    form.set('file', file, fileName);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { accept: 'application/json', ...this.headers },
        body: form,
        signal: controller.signal,
        redirect: 'error',
      });
    } catch {
      clearTimeout(timeout);
      throw new ProviderOutcomeUnknownError();
    }
    try {
      let raw: Uint8Array;
      try {
        raw = await readBoundedBody(response, this.maxResponseBytes);
      } catch (error) {
        if (response.ok) throw new ProviderOutcomeUnknownError();
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        if (response.ok) throw new ProviderOutcomeUnknownError();
        throw new Error('Provider returned an invalid JSON response.');
      }
      if (!response.ok) throw new ProviderHttpError(response.status, extractProviderCode(parsed));
      return parsed as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async privateWahaMedia(path: string, maxBytes: number): Promise<ProviderBytes> {
    if (!path.startsWith('/api/files/') || path.startsWith('//') || path.includes('..')) {
      throw new TypeError('WAHA media path must be one fixed files endpoint path.');
    }
    const url = new URL(path, this.baseUrl);
    return this.readBytes(url, maxBytes, { accept: '*/*', ...this.headers });
  }

  async metaMediaUrl(urlText: string, maxBytes: number): Promise<ProviderBytes> {
    let url: URL;
    try {
      url = new URL(urlText);
    } catch {
      throw new TypeError('Meta returned an invalid media URL.');
    }
    const allowedKeys = new Set(['mid', 'ext', 'hash', 'source']);
    if (url.protocol !== 'https:' || url.hostname !== 'lookaside.fbsbx.com' || (url.port && url.port !== '443')
      || url.username || url.password || url.hash
      || !url.pathname.startsWith('/whatsapp_business/attachments/')) {
      throw new TypeError('Meta returned a media URL outside the trusted Meta media origin.');
    }
    for (const key of url.searchParams.keys()) {
      if (!allowedKeys.has(key)) throw new TypeError('Meta media URL contains an unexpected query parameter.');
    }
    if (!url.searchParams.get('mid') || !url.searchParams.get('ext') || !url.searchParams.get('hash')) {
      throw new TypeError('Meta media URL is missing required signed parameters.');
    }
    return this.readBytes(url, maxBytes, { accept: '*/*', ...this.headers });
  }

  private async readBytes(url: URL, maxBytes: number, headers: Record<string, string>): Promise<ProviderBytes> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 25 * 1024 * 1024) {
      throw new RangeError('Binary response limit must be from 1 byte to 25 MiB.');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET', headers, signal: controller.signal, redirect: 'error',
      });
    } catch {
      clearTimeout(timeout);
      throw new Error('Provider media download could not be completed.');
    }
    try {
      const bytes = await readBoundedBody(response, maxBytes);
      if (!response.ok) throw new ProviderHttpError(response.status, extractProviderCodeFromBytes(bytes));
      return { bytes, contentType: (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '' };
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new ProviderResponseTooLargeError();
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ProviderResponseTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function extractProviderCode(value: unknown): string | number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' || typeof code === 'number' ? code : undefined;
}

function extractProviderCodeFromBytes(bytes: Uint8Array): string | number | undefined {
  try {
    return extractProviderCode(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return undefined;
  }
}

export function assertAdapter(adapter: McpAdapter, kind: AdapterKind): void {
  if (adapter.kind !== kind) throw new Error(`Provider factory returned the wrong adapter kind: ${adapter.kind}.`);
}
