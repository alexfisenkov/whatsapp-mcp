import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createMcpServer } from '../dist/mcp-server.js';
import { ManagedMediaStore } from '../dist/media-store.js';

test('download operation links to a private MCP media resource that returns the managed file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-mcp-resource-'));
  chmodSync(root, 0o700);
  const mediaStore = new ManagedMediaStore(root);
  const media = await mediaStore.save({ bytes: Buffer.from('image payload'), mimeType: 'image/png', fileName: 'incoming.png' });
  const caller = { callerId: 'owner', accountId: 'personal-1', adapter: 'linked-device' };
  const adapter = {
    kind: 'linked-device',
    definitions: [{
      id: 'personal.media.download', title: 'Download media', description: 'Download inbound media into the private store.',
      kind: 'read', inputSchema: z.object({ messageId: z.string() }),
    }],
    async authorize(value) { if (value.accountId !== caller.accountId) throw new Error('wrong profile'); },
    async execute() { return { mediaId: media.id, mimeType: media.mimeType, fileName: media.fileName, size: media.size }; },
  };
  const server = createMcpServer(adapter, () => caller, { mediaStore });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'media-resource-reader', version: '0.0.1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const call = await client.callTool({ name: 'personal_media_download', arguments: { messageId: 'm1' } });
    const link = call.content.find((item) => item.type === 'resource_link');
    assert.equal(link.uri, `whatsapp-media://${media.id}`);
    const resource = await client.readResource({ uri: link.uri });
    assert.equal(resource.contents[0].mimeType, 'image/png');
    assert.equal(Buffer.from(resource.contents[0].blob, 'base64').toString(), 'image payload');
  } finally {
    await client.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP media resource reader enforces the current profile authorization', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-mcp-resource-denied-'));
  chmodSync(root, 0o700);
  const mediaStore = new ManagedMediaStore(root);
  const media = await mediaStore.save({ bytes: Buffer.from('private bytes'), mimeType: 'text/plain', fileName: 'private.txt' });
  const adapter = {
    kind: 'linked-device', definitions: [],
    async authorize(caller) { if (caller.accountId !== 'owner-account') throw new Error('wrong profile'); },
    async execute() { return {}; },
  };
  const server = createMcpServer(adapter, () => ({ callerId: 'other', accountId: 'other-account', adapter: 'linked-device' }), { mediaStore });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'media-resource-isolation', version: '0.0.1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await assert.rejects(() => client.readResource({ uri: `whatsapp-media://${media.id}` }), /profile/i);
  } finally {
    await client.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
