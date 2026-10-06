import test from 'node:test';
import assert from 'node:assert/strict';
import { createWahaPersonalAdapter } from '../dist/providers/waha/index.js';

const caller = { callerId: 'student-1', accountId: 'personal-1', adapter: 'linked-device' };
const sessionConfig = (overrides = {}) => ({
  accountId: 'personal-1', baseUrl: 'http://127.0.0.1:8859', apiKey: 'private-key', sessionName: 'session-1', ...overrides,
});
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const sampleMessage = (overrides = {}) => ({
  id: 'true_123@c.us_ABCDEFGHIJKLMNOP', chatId: '123@c.us', from: 'me', to: '123@c.us',
  fromMe: true, timestamp: 1_750_000_000, body: 'before', ...overrides,
});

test('WAHA edit does a source check and writes only if the target is owned by this account', async () => {
  const calls = [];
  const adapter = createWahaPersonalAdapter(sessionConfig({ fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (init.method === 'GET') return jsonResponse(sampleMessage());
    return jsonResponse({ id: 'edited-action-1' });
  } }));
  await adapter.execute('personal.messages.edit', { chatId: '123@c.us', messageId: 'true_123@c.us_ABCDEFGHIJKLMNOP', text: 'after' }, caller);
  assert.deepEqual(calls.map(({ init }) => init.method), ['GET', 'PUT']);
  assert.deepEqual(JSON.parse(calls[1].init.body), { text: 'after' });
  assert.equal(calls[0].url.pathname, '/api/session-1/chats/123%40c.us/messages/true_123%40c.us_ABCDEFGHIJKLMNOP');

  calls.length = 0;
  const foreign = createWahaPersonalAdapter(sessionConfig({ fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    return jsonResponse(sampleMessage({ fromMe: false }));
  } }));
  await assert.rejects(() => foreign.execute('personal.messages.edit', { chatId: '123@c.us', messageId: 'true_123@c.us_ABCDEFGHIJKLMNOP', text: 'after' }, caller), /own message/i);
  assert.deepEqual(calls.map(({ init }) => init.method), ['GET']);
});

test('WAHA deletion is hidden by default and plan-bound to an owned message', async () => {
  const defaultAdapter = createWahaPersonalAdapter(sessionConfig());
  assert.ok(!defaultAdapter.definitions.some(({ id }) => id === 'personal.messages.delete'));
  assert.ok(!defaultAdapter.definitions.some(({ id }) => id === 'personal.messages.delete_plan'));

  const calls = [];
  const adapter = createWahaPersonalAdapter(sessionConfig({ enableMessageDeletion: true, fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (init.method === 'GET') return jsonResponse(sampleMessage());
    return jsonResponse({ id: 'deleted-action-1' });
  } }));
  const plan = await adapter.execute('personal.messages.delete_plan', { chatId: '123@c.us', messageId: 'true_123@c.us_ABCDEFGHIJKLMNOP' }, caller);
  assert.match(plan.planId, /^[0-9a-f-]{36}$/i);
  assert.equal(plan.expiresAt > Date.now(), true);
  await adapter.execute('personal.messages.delete', { chatId: '123@c.us', messageId: 'true_123@c.us_ABCDEFGHIJKLMNOP', planId: plan.planId }, caller);
  assert.deepEqual(calls.map(({ init }) => init.method), ['GET', 'GET', 'DELETE']);
  assert.equal(calls[2].url.pathname, '/api/session-1/chats/123%40c.us/messages/true_123%40c.us_ABCDEFGHIJKLMNOP');

  const mismatchCalls = [];
  let mismatchGetCount = 0;
  const mismatch = createWahaPersonalAdapter(sessionConfig({ enableMessageDeletion: true, fetchImpl: async (url, init) => {
    mismatchCalls.push({ url: new URL(url), init });
    mismatchGetCount += 1;
    return jsonResponse(sampleMessage({ body: mismatchGetCount === 1 ? 'before' : 'changed after planning' }));
  } }));
  const stalePlan = await mismatch.execute('personal.messages.delete_plan', { chatId: '123@c.us', messageId: 'true_123@c.us_ABCDEFGHIJKLMNOP' }, caller);
  await assert.rejects(() => mismatch.execute('personal.messages.delete', { chatId: '123@c.us', messageId: 'true_123@c.us_ABCDEFGHIJKLMNOP', planId: stalePlan.planId }, caller), /changed/i);
  assert.deepEqual(mismatchCalls.map(({ init }) => init.method), ['GET', 'GET']);
});

test('WAHA location and vCard use documented global endpoints and fields', async () => {
  const calls = [];
  const adapter = createWahaPersonalAdapter(sessionConfig({ fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    return jsonResponse({ id: 'out-1' });
  } }));
  await adapter.execute('personal.messages.send_location', { chatId: '123@c.us', latitude: 1.25, longitude: -2.5, title: 'Studio' }, caller);
  await adapter.execute('personal.messages.send_contact', {
    chatId: '123@c.us', contacts: [{ fullName: 'Ada Lovelace', phoneNumber: '+441234567890', organization: 'Example', whatsappId: '441234567890' }],
  }, caller);
  assert.deepEqual(calls.map(({ url }) => url.pathname), ['/api/sendLocation', '/api/sendContactVcard']);
  assert.deepEqual(JSON.parse(calls[0].init.body), { session: 'session-1', chatId: '123@c.us', latitude: 1.25, longitude: -2.5, title: 'Studio' });
  assert.equal(JSON.parse(calls[1].init.body).contacts[0].fullName, 'Ada Lovelace');
});

test('WAHA archive and unarchive are available for NOWEB with a fixed chat target', async () => {
  const calls = [];
  const adapter = createWahaPersonalAdapter(sessionConfig({ fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    return jsonResponse({ success: true });
  } }));
  await adapter.execute('personal.chats.archive', { chatId: '123@c.us' }, caller);
  await adapter.execute('personal.chats.unarchive', { chatId: '123@c.us' }, caller);
  assert.deepEqual(calls.map(({ url }) => url.pathname), [
    '/api/session-1/chats/123%40c.us/archive', '/api/session-1/chats/123%40c.us/unarchive',
  ]);
  assert.ok(calls.every(({ init }) => init.method === 'POST'));
});

test('WAHA downloads media only from the configured private API origin and saves opaque managed media', async () => {
  const calls = [];
  const saved = [];
  const mediaStore = { async save(input) { saved.push(input); return { id: '550e8400-e29b-41d4-a716-446655440000', mimeType: input.mimeType, fileName: input.fileName, size: input.bytes.length, sha256: 'a'.repeat(64) }; } };
  const adapter = createWahaPersonalAdapter(sessionConfig({ mediaStore, fetchImpl: async (url, init) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, init });
    if (parsed.pathname.includes('/messages/')) return jsonResponse({ ...sampleMessage(), hasMedia: true, media: { url: 'http://127.0.0.1:8859/api/files/true_123@c.us_ABCDEFGHIJKLMNOP.jpg', mimetype: 'image/jpeg', filename: 'photo.jpg' } });
    return new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  } }));
  const result = await adapter.execute('personal.media.download', { chatId: '123@c.us', messageId: 'true_123@c.us_ABCDEFGHIJKLMNOP' }, caller);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.searchParams.get('downloadMedia'), 'true');
  assert.equal(calls[1].url.origin, 'http://127.0.0.1:8859');
  assert.equal(calls[1].url.pathname, '/api/files/true_123%40c.us_ABCDEFGHIJKLMNOP.jpg');
  assert.equal(calls[1].init.headers['X-Api-Key'], 'private-key');
  assert.equal(saved[0].mimeType, 'image/jpeg');
  assert.deepEqual([...saved[0].bytes], [1, 2, 3]);
  assert.equal(result.mediaId, '550e8400-e29b-41d4-a716-446655440000');
});

test('WAHA media downloader rejects a foreign response origin without fetching it', async () => {
  const calls = [];
  const mediaStore = { async save() { throw new Error('must not save'); } };
  const adapter = createWahaPersonalAdapter(sessionConfig({ mediaStore, fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    return jsonResponse({ ...sampleMessage(), hasMedia: true, media: { url: 'https://evil.example/api/files/anything.jpg', mimetype: 'image/jpeg', filename: 'x.jpg' } });
  } }));
  await assert.rejects(() => adapter.execute('personal.media.download', { chatId: '123@c.us', messageId: 'true_123@c.us_ABCDEFGHIJKLMNOP' }, caller), /media URL/i);
  assert.equal(calls.length, 1);
});
