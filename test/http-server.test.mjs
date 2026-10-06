import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { createHttpServer } from '../dist/http-server.js';
import { ManagedMediaStore } from '../dist/media-store.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function withServer(config, fn) {
  const server = createHttpServer({
    adapter: {
      kind: 'business-graph',
      definitions: [{
        id: 'business.templates.list', title: 'List templates', description: 'List business templates.',
        kind: 'read', inputSchema: z.object({ limit: z.number().int().min(1).max(5) }),
      }],
      async authorize() {},
      async execute() { return { templates: [] }; },
    },
    port: 0,
    allowedHosts: ['127.0.0.1'],
    allowedOrigins: ['https://app.example.test'],
    health: async () => ({
      adapter: 'business-graph', profileId: 'business-test', releaseRevision: 'a'.repeat(40),
      configured: false, status: 'not_configured',
    }),
    ...config,
  });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const address = server.address();
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('fails closed without authenticated caller and does not invoke the adapter', async () => {
  let calls = 0;
  await withServer({
    resolveCaller: async () => null,
    adapter: {
      kind: 'business-graph', definitions: [], async authorize() {},
      async execute() { calls += 1; return {}; },
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 401);
    assert.equal(calls, 0);
  });
});

test('rejects unapproved Host and Origin headers', async () => {
  await withServer({ resolveCaller: async () => null }, async (baseUrl) => {
    const url = new URL(baseUrl);
    const hostileHostStatus = await new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: url.hostname, port: url.port, path: '/health', headers: { host: 'evil.example.test' } }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(hostileHostStatus, 421);
    const hostileOrigin = await fetch(`${baseUrl}/health`, { headers: { origin: 'https://evil.example.test' } });
    assert.equal(hostileOrigin.status, 403);
  });
});

test('does not expose browser CORS; Origin is a DNS-rebinding check for server clients', async () => {
  await withServer({ resolveCaller: async () => null }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });
});

test('health reports missing credentials without claiming upstream readiness', async () => {
  await withServer({ resolveCaller: async () => null }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.configured, false);
    assert.equal(result.status, 'not_configured');
    assert.equal('token' in result, false);
  });
});

test('verifies Meta challenge and HMAC over the exact raw POST body', async () => {
  const appSignatureKey = 'k';
  const challengeVerifier = 'v';
  const processed = [];
  await withServer({
    resolveCaller: async () => null,
    metaWebhook: { appSignatureKey, challengeVerifier, async process(payload) { processed.push(payload); } },
  }, async (baseUrl) => {
    const challenge = await fetch(`${baseUrl}/webhooks/meta?hub.mode=subscribe&hub.verify_token=${challengeVerifier}&hub.challenge=abc123`);
    assert.equal(challenge.status, 200);
    assert.equal(await challenge.text(), 'abc123');

    const body = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');
    const signature = `sha256=${createHmac('sha256', appSignatureKey).update(body).digest('hex')}`;
    const accepted = await fetch(`${baseUrl}/webhooks/meta`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body,
    });
    assert.equal(accepted.status, 200);
    assert.equal(processed.length, 1);

    const rejected = await fetch(`${baseUrl}/webhooks/meta`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=bad' }, body,
    });
    assert.equal(rejected.status, 401);
    assert.equal(processed.length, 1);
  });
});

test('authenticated binary upload returns a managed ID and never accepts arbitrary paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-mcp-http-media-'));
  chmodSync(root, 0o700);
  const mediaStore = new ManagedMediaStore(root);
  await withServer({
    resolveCaller: async (request) => request.headers.authorization === 'Bearer test'
      ? { callerId: 'owner', accountId: 'business-1', adapter: 'business-graph' }
      : null,
    mediaStore,
  }, async (baseUrl) => {
    const denied = await fetch(`${baseUrl}/media`, {
      method: 'POST', headers: { 'content-type': 'text/plain', 'x-file-name': 'note.txt' }, body: 'denied',
    });
    assert.equal(denied.status, 401);
    const accepted = await fetch(`${baseUrl}/media`, {
      method: 'POST', headers: {
        authorization: 'Bearer test', 'content-type': 'text/plain', 'x-file-name': 'note.txt',
      }, body: 'approved bytes',
    });
    assert.equal(accepted.status, 201);
    const media = await accepted.json();
    assert.match(media.mediaId, /^[0-9a-f-]{36}$/i);
    assert.equal('path' in media, false);
    const read = await mediaStore.read(media.mediaId, { maxBytes: 100, allowedMimeTypes: ['text/plain'] });
    assert.equal(read.bytes.toString(), 'approved bytes');
    const downloadDenied = await fetch(`${baseUrl}/media/${media.mediaId}`);
    assert.equal(downloadDenied.status, 401);
    const download = await fetch(`${baseUrl}/media/${media.mediaId}`, {
      headers: { authorization: 'Bearer test' },
    });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-disposition'), "attachment; filename*=UTF-8''note.txt");
    assert.equal(download.headers.get('x-content-sha256'), media.sha256);
    assert.equal(await download.text(), 'approved bytes');
  });
  mediaStore.close?.();
  rmSync(root, { recursive: true, force: true });
});

test('HTTP Streamable MCP returns media resource links that the same profile can read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-mcp-http-resource-'));
  chmodSync(root, 0o700);
  const mediaStore = new ManagedMediaStore(root);
  const media = await mediaStore.save({ bytes: Buffer.from('graph inbound media'), mimeType: 'image/png', fileName: 'inbound.png' });
  const adapter = {
    kind: 'business-graph',
    definitions: [{
      id: 'business.media.download', title: 'Download inbound media', description: 'Download a verified inbound media object.',
      kind: 'read', inputSchema: z.object({ providerMediaId: z.string() }),
    }],
    async authorize(caller) { if (caller.accountId !== 'business-1') throw new Error('not this profile'); },
    async execute() { return { mediaId: media.id, mimeType: media.mimeType, size: media.size }; },
  };
  await withServer({
    adapter,
    mediaStore,
    resolveCaller: async (request) => request.headers.authorization === 'Bearer profile-1'
      ? { callerId: 'business-owner', accountId: 'business-1', adapter: 'business-graph' }
      : null,
  }, async (baseUrl) => {
    const client = new Client({ name: 'http-media-resource-test', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer profile-1' } },
    });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: 'business_media_download', arguments: { providerMediaId: 'g-media-id' } });
      const link = result.content.find((item) => item.type === 'resource_link');
      assert.equal(link.uri, `whatsapp-media://${media.id}`);
      const read = await client.readResource({ uri: link.uri });
      assert.equal(Buffer.from(read.contents[0].blob, 'base64').toString(), 'graph inbound media');
    } finally {
      await client.close();
    }
  });
  rmSync(root, { recursive: true, force: true });
});
