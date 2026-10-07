import test from 'node:test';
import assert from 'node:assert/strict';
import { createWahaPersonalAdapter } from '../dist/providers/waha/index.js';
import { ProviderHttpError, ProviderOutcomeUnknownError } from '../dist/providers/common.js';

const caller = { callerId: 'student-1', accountId: 'personal-1', adapter: 'linked-device' };
const config = (overrides = {}) => ({
  accountId: 'personal-1',
  baseUrl: 'http://127.0.0.1:8859',
  apiKey: 'fake',
  sessionName: 'student_account_1',
  ...overrides,
});

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('WAHA registers only real bounded capabilities and hides gated group administration', () => {
  const adapter = createWahaPersonalAdapter(config());
  const ids = adapter.definitions.map(({ id }) => id);
  assert.ok(ids.includes('personal.messages.list'));
  assert.ok(ids.includes('personal.messages.send_text'));
  assert.ok(ids.includes('personal.groups.list'));
  assert.ok(!ids.includes('personal.messages.search'));
  assert.ok(!ids.includes('personal.groups.create'));
  assert.ok(!ids.includes('personal.messages.send_image'));
});

test('WAHA binds caller before the first HTTP request', async () => {
  let calls = 0;
  const adapter = createWahaPersonalAdapter(config({ fetchImpl: async () => { calls += 1; return jsonResponse({ status: 'OK' }); } }));
  await assert.rejects(
    () => adapter.execute('personal.system.health', {}, { ...caller, accountId: 'another-account' }),
    /not authorized/i,
  );
  assert.equal(calls, 0);
});

test('WAHA rejects caller-supplied session overrides before any provider request', async () => {
  let calls = 0;
  const adapter = createWahaPersonalAdapter(config({
    fetchImpl: async () => { calls += 1; return jsonResponse({}); },
  }));
  const forgedSession = 'other-profile-session';
  const cases = [
    ['personal.messages.list', { chatId: '111@c.us', limit: 10, offset: 0, session: forgedSession }],
    ['personal.contacts.list', { limit: 10, offset: 0, session: forgedSession }],
    ['personal.contacts.get', { contactId: '111@c.us', session: forgedSession }],
    ['personal.messages.send_text', { chatId: '111@c.us', text: 'hello', session: forgedSession }],
  ];

  for (const [operationId, input] of cases) {
    await assert.rejects(
      () => adapter.execute(operationId, input, caller),
      /invalid tool arguments/i,
      `${operationId} must reject a forged session field`,
    );
  }
  assert.equal(calls, 0);
});

test('WAHA chat page uses a fixed session route and strips engine internals and media URLs', async () => {
  const calls = [];
  const adapter = createWahaPersonalAdapter(config({
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return jsonResponse([{ id: 'm1', timestamp: 1_700_000_000, from: '111@c.us', fromMe: false, body: 'untrusted text', hasMedia: true, ack: 3, _data: { private: true }, media: { url: 'http://internal/file', mimetype: 'image/jpeg', filename: 'photo.jpg' } }]);
    },
  }));
  const result = await adapter.execute('personal.messages.list', { chatId: '111@c.us', limit: 10, offset: 0 }, caller);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/api/student_account_1/chats/111%40c.us/messages');
  assert.equal(calls[0].url.searchParams.get('downloadMedia'), 'false');
  assert.equal(calls[0].init.headers['X-Api-Key'], 'fake');
  assert.deepEqual(result.messages[0].media, { mimetype: 'image/jpeg', filename: 'photo.jpg' });
  assert.equal('_data' in result.messages[0], false);
  assert.equal(JSON.stringify(result).includes('internal/file'), false);
  assert.equal(result.coverage.complete, false);
});

test('WAHA send uses global route with session in body and never retries rejected writes', async () => {
  const calls = [];
  const adapter = createWahaPersonalAdapter(config({
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return jsonResponse({ id: 'message-1', timestamp: 123 }, 503);
    },
  }));
  await assert.rejects(() => adapter.execute('personal.messages.send_text', { chatId: '123@c.us', text: 'hello' }, caller), ProviderHttpError);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/api/sendText');
  assert.deepEqual(JSON.parse(calls[0].init.body), { session: 'student_account_1', chatId: '123@c.us', text: 'hello' });
});

test('WAHA rejects malformed input before fetch and marks network write failure unknown without retry', async () => {
  let calls = 0;
  const bad = createWahaPersonalAdapter(config({ fetchImpl: async () => { calls += 1; return jsonResponse({}); } }));
  await assert.rejects(() => bad.execute('personal.messages.send_text', { chatId: 'https://evil.test', text: 'hello' }, caller), /invalid tool arguments/i);
  assert.equal(calls, 0);

  const broken = createWahaPersonalAdapter(config({ fetchImpl: async () => { calls += 1; throw new Error('network'); } }));
  await assert.rejects(() => broken.execute('personal.messages.send_text', { chatId: '123@c.us', text: 'hello' }, caller), ProviderOutcomeUnknownError);
  assert.equal(calls, 1);
});

test('WAHA managed media send reads only an allowed private asset and constructs one global API request', async () => {
  const calls = [];
  let mediaReads = 0;
  const mediaStore = {
    async read(id, options) {
      mediaReads += 1;
      assert.equal(id, '550e8400-e29b-41d4-a716-446655440000');
      assert.deepEqual(options.allowedMimeTypes, ['image/jpeg', 'image/png']);
      return { id, mimeType: 'image/jpeg', fileName: 'image.jpg', size: 3, bytes: Buffer.from([1, 2, 3]) };
    },
  };
  const adapter = createWahaPersonalAdapter(config({
    mediaStore,
    fetchImpl: async (url, init) => { calls.push({ url: new URL(url), init }); return jsonResponse({ id: 'm-out' }); },
  }));
  const result = await adapter.execute('personal.messages.send_image', { chatId: '123@c.us', mediaId: '550e8400-e29b-41d4-a716-446655440000', caption: 'hi' }, caller);
  assert.equal(mediaReads, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/api/sendImage');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.session, 'student_account_1');
  assert.equal(body.file.data, 'AQID');
  assert.equal(body.file.url, undefined);
  assert.equal(result.outcome, 'accepted_by_waha; delivery_status_may_arrive_later');
});

test('WAHA group administration is opt-in and calls the exact participant route', async () => {
  const calls = [];
  const adapter = createWahaPersonalAdapter(config({
    enableGroupAdministration: true,
    fetchImpl: async (url, init) => { calls.push({ url: new URL(url), init }); return jsonResponse({ update: 'success' }); },
  }));
  await adapter.execute('personal.groups.add_participants', { groupId: '111@g.us', participants: ['222@c.us'] }, caller);
  assert.equal(calls[0].url.pathname, '/api/student_account_1/groups/111%40g.us/participants/add');
  assert.deepEqual(JSON.parse(calls[0].init.body), { participants: [{ id: '222@c.us' }] });
});

test('WAHA contact, poll, reaction, read and channel operations use their documented routes', async () => {
  const calls = [];
  const adapter = createWahaPersonalAdapter(config({
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      if (new URL(url).pathname === '/api/contacts/all') return jsonResponse([{ id: '123@c.us', name: 'A' }]);
      if (new URL(url).pathname.endsWith('/channels')) return jsonResponse([{ id: '123@newsletter', name: 'News' }]);
      if (new URL(url).pathname === '/api/sendPoll') return jsonResponse({ id: 'poll-1' });
      if (new URL(url).pathname === '/api/reaction') return jsonResponse({ id: 'reaction-1' });
      if (new URL(url).pathname.endsWith('/messages/read')) return jsonResponse({ ids: ['m1'] });
      return jsonResponse({});
    },
  }));
  await adapter.execute('personal.contacts.list', { limit: 10, offset: 0 }, caller);
  await adapter.execute('personal.channels.list', { limit: 10, offset: 0 }, caller);
  await adapter.execute('personal.messages.send_poll', { chatId: '123@c.us', question: 'Q?', options: ['A', 'B'] }, caller);
  await adapter.execute('personal.messages.react', { chatId: '123@c.us', messageId: 'true_123@c.us_AAAAAAAA', reaction: '👍' }, caller);
  await adapter.execute('personal.messages.mark_read', { chatId: '123@c.us', messages: 10, days: 1 }, caller);
  assert.deepEqual(calls.map(({ url }) => url.pathname), [
    '/api/contacts/all', '/api/student_account_1/channels', '/api/sendPoll', '/api/reaction',
    '/api/student_account_1/chats/123%40c.us/messages/read',
  ]);
  assert.deepEqual(JSON.parse(calls[2].init.body).poll, { name: 'Q?', options: ['A', 'B'], multipleAnswers: false });
  assert.equal(calls[3].init.method, 'PUT');
});

test('WAHA status posting is absent by default and explicitly gated', async () => {
  const hidden = createWahaPersonalAdapter(config());
  assert.ok(!hidden.definitions.some(({ id }) => id.startsWith('personal.status.')));
  const calls = [];
  const enabled = createWahaPersonalAdapter(config({
    enableStatusPosting: true,
    fetchImpl: async (url, init) => { calls.push({ url: new URL(url), init }); return jsonResponse({ key: { id: 'status-1' } }); },
  }));
  const result = await enabled.execute('personal.status.send_text', { text: 'Hello', backgroundColor: '#abcdef', contacts: ['123@c.us'] }, caller);
  assert.equal(calls[0].url.pathname, '/api/student_account_1/status/text');
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'Hello', backgroundColor: '#abcdef', contacts: ['123@c.us'] });
  assert.equal(result.statusMessageId, 'status-1');
});

test('WAHA rejects public upstream origins and bounds the history sync contract', async () => {
  assert.throws(() => createWahaPersonalAdapter(config({ baseUrl: 'https://example.com' })), /private/i);
  let calls = 0;
  const adapter = createWahaPersonalAdapter(config({ fetchImpl: async () => { calls += 1; return jsonResponse([]); } }));
  const historyStore = { async upsertMessages(_identity, messages, coverage) { this.saved = { messages, coverage }; } };
  const result = await adapter.syncHistory({ pageSize: 2, maxPages: 1 }, caller, historyStore);
  assert.equal(calls, 1);
  assert.equal(result.complete, false);
  assert.equal(historyStore.saved.coverage.complete, false);
  assert.equal(historyStore.saved.coverage.source, 'waha-noweb-bounded-sync');
  await assert.rejects(() => adapter.syncHistory({ pageSize: 51, maxPages: 1 }, caller, historyStore));
});
