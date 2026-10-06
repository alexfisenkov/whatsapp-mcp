import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/mcp-server.js';
import { withHistoryTools } from '../dist/history-tools.js';
import { SqliteHistoryStore } from '../dist/sqlite-history.js';

test('registers a real bounded sync hook only when implemented and search returns indexed partial content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-mcp-history-tools-'));
  chmodSync(root, 0o700);
  const history = new SqliteHistoryStore(join(root, 'history.sqlite'));
  const caller = { callerId: 'owner', accountId: 'personal-1', adapter: 'linked-device' };
  let syncInput;
  const baseAdapter = {
    kind: 'linked-device',
    definitions: [],
    async authorize() {},
    async execute() { throw new Error('not implemented'); },
    async syncHistory(input, resolvedCaller, store) {
      syncInput = input;
      assert.equal(resolvedCaller.accountId, caller.accountId);
      await store.upsertMessages({ accountId: caller.accountId, adapter: 'linked-device' }, [
        { chatId: input.chatId, messageId: 'm1', senderId: 'peer', sentAtMs: 100, body: 'history tool marker', fromMe: false },
      ], { source: 'waha-bounded-sync', coveredFromMs: 100, coveredToMs: 100, lastSyncedAtMs: 200, complete: false });
      return { fetchedMessages: 1, complete: false };
    },
  };
  const adapter = withHistoryTools(baseAdapter, history);
  const server = createMcpServer(adapter, () => caller);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'history-tools-test', version: '0.0.1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(({ name }) => name), [
      'personal_history_search', 'personal_history_context', 'personal_history_coverage', 'personal_history_sync',
    ]);
    const sync = await client.callTool({ name: 'personal_history_sync', arguments: { chatId: 'chat-1', pageSize: 10, maxPages: 2 } });
    assert.equal(JSON.parse(sync.content[0].text).result.fetchedMessages, 1);
    assert.deepEqual(syncInput, { chatId: 'chat-1', pageSize: 10, maxPages: 2 });
    const search = await client.callTool({ name: 'personal_history_search', arguments: { query: 'history tool marker', limit: 10 } });
    const result = JSON.parse(search.content[0].text).result;
    assert.equal(result.items.length, 1);
    assert.equal(result.coverage.complete, false);
    assert.equal(result.items[0].trust, 'untrusted_external_content');
  } finally {
    await client.close();
    await server.close();
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('does not advertise personal history sync when adapter has no sync method', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-mcp-history-nosync-'));
  chmodSync(root, 0o700);
  const history = new SqliteHistoryStore(join(root, 'history.sqlite'));
  const adapter = withHistoryTools({
    kind: 'linked-device', definitions: [], async authorize() {}, async execute() { return {}; },
  }, history);
  const server = createMcpServer(adapter, () => ({ callerId: 'owner', accountId: 'personal-1', adapter: 'linked-device' }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'history-capabilities-test', version: '0.0.1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.some(({ name }) => name === 'personal_history_sync'), false);
    assert.equal(listed.tools.some(({ name }) => name === 'personal_history_search'), true);
  } finally {
    await client.close();
    await server.close();
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});
