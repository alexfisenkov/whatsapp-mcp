import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/mcp-server.js';
import { MutationCoordinator } from '../dist/mutations.js';

test('MCP protocol lists only adapter-backed tools and binds calls to the resolved account', async () => {
  const calls = [];
  const adapter = {
    kind: 'linked-device',
    definitions: [{
      id: 'personal.chats.list',
      title: 'List chats',
      description: 'List chats within the authenticated personal account.',
      kind: 'read',
      inputSchema: z.object({ limit: z.number().int().min(1).max(10) }),
    }],
    async authorize(caller) {
      if (caller.accountId !== 'personal-1') throw new Error('unauthorized account');
    },
    async execute(operationId, input, caller) {
      calls.push({ operationId, input, caller });
      return { chats: [{ id: 'c1', name: 'External WhatsApp content' }] };
    },
  };
  const server = createMcpServer(adapter, () => ({
    callerId: 'student-1', accountId: 'personal-1', adapter: 'linked-device',
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'contract-test', version: '0.0.1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(({ name }) => name), ['personal_chats_list']);
  const result = await client.callTool({ name: 'personal_chats_list', arguments: { limit: 5 } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].operationId, 'personal.chats.list');
  assert.equal(calls[0].caller.accountId, 'personal-1');
  assert.match(result.content[0].text, /untrusted/i);
  await client.close();
  await server.close();
});

test('MCP tool validates arguments before calling an adapter', async () => {
  let calls = 0;
  const adapter = {
    kind: 'business-graph',
    definitions: [{
      id: 'business.templates.list',
      title: 'List templates',
      description: 'List templates for the configured business account.',
      kind: 'read',
      inputSchema: z.object({ limit: z.number().int().min(1).max(10) }),
    }],
    async authorize(caller) {
      if (caller.accountId !== 'business-1') throw new Error('unauthorized account');
    },
    async execute() { calls += 1; return { templates: [] }; },
  };
  const server = createMcpServer(adapter, () => ({
    callerId: 'owner', accountId: 'business-1', adapter: 'business-graph',
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'contract-test', version: '0.0.1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const result = await client.callTool({
    name: 'business_templates_list', arguments: { limit: 99 },
  });
  assert.equal(result.isError, true);
  assert.equal(calls, 0);
  await client.close();
  await server.close();
});

test('guarded mutations require prepare, matching confirmation, and execute once', async () => {
  const caller = { callerId: 'owner', accountId: 'personal-1', adapter: 'linked-device' };
  const records = new Map();
  const store = {
    async insertPrepared(record) { records.set(record.id, structuredClone(record)); },
    async get(id) { return structuredClone(records.get(id)); },
    async claim(id, who, now, revision) {
      const record = records.get(id);
      if (!record || record.status !== 'prepared' || record.expiresAt <= now
        || record.callerId !== who.callerId || record.accountId !== who.accountId
        || record.adapter !== who.adapter || record.releaseRevision !== revision) return { kind: 'rejected' };
      record.status = 'executing';
      return { kind: 'claimed', record: structuredClone(record) };
    },
    async complete(id, outcome) {
      const record = records.get(id);
      record.status = outcome.status;
      record.outcome = outcome;
    },
    async recoverInFlight() { return 0; },
  };
  const coordinator = new MutationCoordinator({ store, releaseRevision: 'commit-1' });
  let writes = 0;
  const adapter = {
    kind: 'linked-device',
    definitions: [{
      id: 'personal.messages.send_text',
      title: 'Send text',
      description: 'Send one exact text to one chat.',
      kind: 'guarded-mutation',
      inputSchema: z.object({ chatId: z.string(), text: z.string() }),
    }],
    async authorize() {},
    async execute() { writes += 1; return { status: 'accepted', messageId: 'm1' }; },
  };
  const server = createMcpServer(adapter, () => caller, { mutationCoordinator: coordinator });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'mutation-test', version: '0.0.1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(({ name }) => name), [
    'personal_messages_send_text_prepare', 'personal_mutation_confirm',
  ]);
  const preparedCall = await client.callTool({
    name: 'personal_messages_send_text_prepare', arguments: { chatId: 'c1', text: 'hello' },
  });
  const prepared = JSON.parse(preparedCall.content[0].text);
  assert.equal(prepared.executed, false);
  assert.equal(writes, 0);
  const confirmation = {
    approvalId: prepared.approvalId,
    inputDigest: prepared.inputDigest,
    operationId: 'personal.messages.send_text',
    input: { chatId: 'c1', text: 'hello' },
  };
  const confirmed = await client.callTool({ name: 'personal_mutation_confirm', arguments: confirmation });
  const replay = await client.callTool({ name: 'personal_mutation_confirm', arguments: confirmation });
  assert.equal(JSON.parse(confirmed.content[0].text).status, 'succeeded');
  assert.equal(JSON.parse(replay.content[0].text).status, 'succeeded');
  assert.equal(writes, 1);
  await client.close();
  await server.close();
});
