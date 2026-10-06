import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetaCloudAdapter } from '../dist/providers/graph/index.js';
import { ProviderHttpError, ProviderOutcomeUnknownError } from '../dist/providers/common.js';

const caller = { callerId: 'owner-1', accountId: 'phone-123', adapter: 'business-graph' };
const config = (overrides = {}) => ({
  accountId: 'phone-123',
  phoneNumberId: 'phone-123',
  businessAccountId: 'waba-123',
  accessToken: 'fake',
  ...overrides,
});

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('Meta adapter binds account, fixes graph host/version and hides admin tools by default', () => {
  const adapter = createMetaCloudAdapter(config());
  const ids = adapter.definitions.map(({ id }) => id);
  assert.ok(ids.includes('business.account.get'));
  assert.ok(ids.includes('business.messages.send_text'));
  assert.ok(ids.includes('business.templates.list'));
  assert.ok(ids.includes('business.flows.list'));
  assert.ok(ids.includes('business.analytics.conversations'));
  assert.ok(!ids.includes('business.templates.create'));
  assert.ok(!ids.includes('business.flows.publish'));
  assert.ok(!ids.includes('business.webhooks.subscribe_app'));
  assert.ok(!ids.includes('business.media.upload'));
});

test('Meta text message uses pinned Graph route, bearer credential and typed body', async () => {
  const calls = [];
  const adapter = createMetaCloudAdapter(config({
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return jsonResponse({ messaging_product: 'whatsapp', contacts: [{ wa_id: '15551234567' }], messages: [{ id: 'wamid.1' }] });
    },
  }));
  const result = await adapter.execute('business.messages.send_text', { to: '+15551234567', text: 'Hello' }, caller);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, 'https://graph.facebook.com');
  assert.equal(calls[0].url.pathname, '/v24.0/phone-123/messages');
  assert.equal(calls[0].init.headers.authorization, 'Bearer fake');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    messaging_product: 'whatsapp', to: '15551234567', type: 'text', text: { body: 'Hello', preview_url: false },
  });
  assert.equal(result.messageId, 'wamid.1');
  assert.equal(result.outcome, 'accepted_by_meta; delivery_status_may_arrive_later');
});

test('Meta template list builds a fixed WABA endpoint and retains only paging cursor', async () => {
  const calls = [];
  const adapter = createMetaCloudAdapter(config({
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return jsonResponse({ data: [{ id: 't1', name: 'welcome', status: 'APPROVED', secret: 'drop' }], paging: { next: 'https://example.test/secret', cursors: { after: 'cursor-1' } } });
    },
  }));
  const result = await adapter.execute('business.templates.list', { limit: 10, after: 'cursor-in' }, caller);
  assert.equal(calls[0].url.pathname, '/v24.0/waba-123/message_templates');
  assert.equal(calls[0].url.searchParams.get('after'), 'cursor-in');
  assert.equal(calls[0].url.searchParams.get('fields'), 'id,name,status,category,language,components,rejected_reason');
  assert.deepEqual(result, { items: [{ id: 't1', name: 'welcome', status: 'APPROVED' }], nextCursor: 'cursor-1', hasNextPage: true });
});

test('Meta input validation rejects arbitrary URLs and malformed recipients before HTTP', async () => {
  let calls = 0;
  const adapter = createMetaCloudAdapter(config({ fetchImpl: async () => { calls += 1; return jsonResponse({}); } }));
  await assert.rejects(() => adapter.execute('business.messages.send_text', { to: 'https://127.0.0.1', text: 'Hello' }, caller), /invalid tool arguments/i);
  await assert.rejects(() => adapter.execute('business.messages.send_image', { to: '+15551234567', media_url: 'https://example.com/image.png' }, caller), /invalid tool arguments/i);
  assert.equal(calls, 0);
});

test('Meta provider errors are structured and HTTP 429 is never retried', async () => {
  let calls = 0;
  const adapter = createMetaCloudAdapter(config({ fetchImpl: async () => { calls += 1; return jsonResponse({ error: { code: 4, message: 'private detail' } }, 429); } }));
  await assert.rejects(() => adapter.execute('business.messages.send_text', { to: '+15551234567', text: 'Hello' }, caller), (error) => {
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.status, 429);
    assert.equal(error.providerCode, 4);
    assert.equal(error.message.includes('private detail'), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('Meta timeout after a write is OUTCOME_UNKNOWN and is never retried', async () => {
  let calls = 0;
  const adapter = createMetaCloudAdapter(config({
    timeoutMs: 100,
    fetchImpl: async (_url, init) => {
      calls += 1;
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
    },
  }));
  await assert.rejects(() => adapter.execute('business.messages.send_template', {
    to: '+15551234567', templateName: 'welcome', languageCode: 'en_US', components: [],
  }, caller), ProviderOutcomeUnknownError);
  assert.equal(calls, 1);
});

test('Meta account mismatch blocks requests and config cannot replace the Graph origin', async () => {
  let calls = 0;
  const adapter = createMetaCloudAdapter(config({ fetchImpl: async () => { calls += 1; return jsonResponse({}); } }));
  await assert.rejects(() => adapter.execute('business.account.get', {}, { ...caller, accountId: 'another' }), /not authorized/i);
  assert.equal(calls, 0);
  assert.throws(() => createMetaCloudAdapter(config({ graphApiVersion: 'https://attacker.test' })), /version/i);
  assert.throws(() => createMetaCloudAdapter(config({ accountId: 'another-phone' })), /bound/i);
});

test('Meta media upload reads a managed asset and posts multipart to the fixed media endpoint', async () => {
  const calls = [];
  let reads = 0;
  const mediaStore = {
    async read(id, options) {
      reads += 1;
      assert.equal(id, '550e8400-e29b-41d4-a716-446655440000');
      assert.equal(options.maxBytes, 5 * 1024 * 1024);
      return { id, mimeType: 'image/jpeg', fileName: 'image.jpg', size: 3, bytes: Buffer.from([1, 2, 3]) };
    },
  };
  const adapter = createMetaCloudAdapter(config({ mediaStore, fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    return jsonResponse({ id: 'media-123' });
  } }));
  const result = await adapter.execute('business.media.upload', { managedMediaId: '550e8400-e29b-41d4-a716-446655440000' }, caller);
  assert.equal(reads, 1);
  assert.equal(calls[0].url.pathname, '/v24.0/phone-123/media');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer fake');
  assert.equal(calls[0].init.body.get('messaging_product'), 'whatsapp');
  assert.equal(calls[0].init.body.get('type'), 'image/jpeg');
  assert.equal(calls[0].init.body.get('file').name, 'image.jpg');
  assert.deepEqual(result, { id: 'media-123' });
});

test('Meta inbound media download checks metadata, uses only allowlisted Meta CDN with bearer auth, and stores opaque bytes', async () => {
  const { createHash } = await import('node:crypto');
  const bytes = Buffer.from([1, 2, 3, 4]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const calls = [];
  let saved;
  const mediaStore = { async save(input) { saved = input; return { id: '550e8400-e29b-41d4-a716-446655440000', mimeType: input.mimeType, fileName: input.fileName, size: input.bytes.length, sha256 }; } };
  const adapter = createMetaCloudAdapter(config({ mediaStore, fetchImpl: async (url, init) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, init });
    if (parsed.hostname === 'graph.facebook.com') return jsonResponse({
      id: 'media-123', url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=media-123&ext=999&hash=signature',
      file_size: '4', mime_type: 'image/jpeg', sha256,
    });
    return new Response(bytes, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '4' } });
  } }));
  const result = await adapter.execute('business.media.download', { mediaId: 'media-123' }, caller);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, '/v24.0/media-123');
  assert.equal(calls[0].url.searchParams.get('phone_number_id'), 'phone-123');
  assert.equal(calls[1].url.hostname, 'lookaside.fbsbx.com');
  assert.equal(calls[1].init.headers.authorization, 'Bearer fake');
  assert.equal(calls[1].init.redirect, 'error');
  assert.deepEqual([...saved.bytes], [...bytes]);
  assert.equal(saved.mimeType, 'image/jpeg');
  assert.deepEqual(result, { mediaId: '550e8400-e29b-41d4-a716-446655440000', mimeType: 'image/jpeg', fileName: 'media-media-123.jpg', size: 4, sha256 });
});

test('Meta inbound media rejects a non-Meta URL and redirects without forwarding credentials', async () => {
  let calls = 0;
  const mediaStore = { async save() { throw new Error('must not save'); } };
  const badHost = createMetaCloudAdapter(config({ mediaStore, fetchImpl: async () => {
    calls += 1;
    return jsonResponse({ id: 'media-123', url: 'https://evil.example/attachment', file_size: '4', mime_type: 'image/jpeg', sha256: 'a'.repeat(64) });
  } }));
  await assert.rejects(() => badHost.execute('business.media.download', { mediaId: 'media-123' }, caller), /media URL/i);
  assert.equal(calls, 1);

  const redirects = [];
  const redirecting = createMetaCloudAdapter(config({ mediaStore, fetchImpl: async (url, init) => {
    redirects.push({ url: new URL(url), init });
    if (new URL(url).hostname === 'graph.facebook.com') return jsonResponse({
      id: 'media-123', url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=media-123&ext=999&hash=sig',
      file_size: '4', mime_type: 'image/jpeg', sha256: 'a'.repeat(64),
    });
    return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } });
  } }));
  await assert.rejects(() => redirecting.execute('business.media.download', { mediaId: 'media-123' }, caller));
  assert.equal(redirects.length, 2);
  assert.equal(redirects[1].init.redirect, 'error');
  assert.equal(redirects.some(({ url }) => url.hostname === 'evil.example'), false);
});

test('Meta create/delete/admin capabilities appear only with the explicit admin option', () => {
  const adapter = createMetaCloudAdapter(config({ enableAdminTools: true }));
  const ids = adapter.definitions.map(({ id }) => id);
  assert.ok(ids.includes('business.templates.create'));
  assert.ok(ids.includes('business.templates.delete'));
  assert.ok(ids.includes('business.flows.publish'));
  assert.ok(ids.includes('business.profile.update'));
  assert.ok(ids.includes('business.webhooks.subscribe_app'));
  assert.ok(ids.includes('business.media.delete'));
  assert.ok(!ids.some((id) => id.includes('phone.register') || id.includes('phone.deregister')));
});

test('Meta account and phone reads use documented WABA and phone-number paths', async () => {
  const calls = [];
  const adapter = createMetaCloudAdapter(config({ fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (new URL(url).pathname.endsWith('/phone_numbers')) return jsonResponse({ data: [{ id: 'phone-2', verified_name: 'Other' }] });
    return jsonResponse({ id: 'id-1', name: 'Business', currency: 'USD', timezone_id: 'UTC', display_phone_number: '+1555', verified_name: 'Example' });
  } }));
  await adapter.execute('business.account.get', {}, caller);
  await adapter.execute('business.phone.get', {}, caller);
  await adapter.execute('business.phone_numbers.list', { limit: 10 }, caller);
  assert.deepEqual(calls.map(({ url }) => url.pathname), [
    '/v24.0/waba-123', '/v24.0/phone-123', '/v24.0/waba-123/phone_numbers',
  ]);
  assert.equal(calls[0].url.searchParams.get('fields'), 'id,name,currency,timezone_id,message_template_namespace');
  assert.equal(calls[2].url.searchParams.get('limit'), '10');
});

test('Meta profile and webhook reads project only intended fields', async () => {
  const calls = [];
  const adapter = createMetaCloudAdapter(config({ fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (new URL(url).pathname.endsWith('subscribed_apps')) return jsonResponse({ data: [{ id: 'app-1', name: 'App', access_token: 'x' }] });
    return jsonResponse({ data: [{ about: 'About', address: 'Address', email: 'x@example.com', token: 'x' }] });
  } }));
  const profile = await adapter.execute('business.profile.get', {}, caller);
  const subscriptions = await adapter.execute('business.webhooks.list_subscribed_apps', {}, caller);
  assert.equal(calls[0].url.pathname, '/v24.0/phone-123/whatsapp_business_profile');
  assert.equal(calls[1].url.pathname, '/v24.0/waba-123/subscribed_apps');
  assert.deepEqual(profile, { about: 'About', address: 'Address', email: 'x@example.com' });
  assert.deepEqual(subscriptions, { apps: [{ id: 'app-1', name: 'App' }] });
});

test('Meta analytics dates are bounded and translated into the documented Graph field expression', async () => {
  const calls = [];
  const adapter = createMetaCloudAdapter(config({ fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    return jsonResponse({ conversation_analytics: { data: [{ conversations: 2 }] } });
  } }));
  await adapter.execute('business.analytics.conversations', { startDate: '2026-01-01', endDate: '2026-01-03' }, caller);
  assert.equal(calls[0].url.pathname, '/v24.0/waba-123');
  assert.equal(calls[0].url.searchParams.get('fields'), 'conversation_analytics.start(2026-01-01).end(2026-01-03).granularity(DAY)');
  await assert.rejects(() => adapter.execute('business.analytics.templates', { startDate: '2026-02-30', endDate: '2026-03-01' }, caller));
  assert.equal(calls.length, 1);
});

test('Meta Flow operations use fixed WABA and Flow endpoints without exposing endpoint URLs', async () => {
  const calls = [];
  const adapter = createMetaCloudAdapter(config({ fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    return jsonResponse({ data: [{ id: 'flow-1', name: 'Flow', status: 'DRAFT', endpoint_uri: 'https://private.example/hook' }] });
  } }));
  const result = await adapter.execute('business.flows.list', { limit: 10 }, caller);
  assert.equal(calls[0].url.pathname, '/v24.0/waba-123/flows');
  assert.equal(JSON.stringify(result).includes('endpoint_uri'), false);
});

test('Meta template deletion, Flow publishing and webhook subscription writes stay hidden unless admin tools are enabled', async () => {
  const adapter = createMetaCloudAdapter(config());
  const hidden = new Set(adapter.definitions.map(({ id }) => id));
  assert.equal(hidden.has('business.templates.delete'), false);
  assert.equal(hidden.has('business.flows.publish'), false);
  assert.equal(hidden.has('business.webhooks.subscribe_app'), false);

  const calls = [];
  const enabled = createMetaCloudAdapter(config({ enableAdminTools: true, fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    return jsonResponse({ success: true });
  } }));
  await enabled.execute('business.templates.delete', { name: 'welcome' }, caller);
  await enabled.execute('business.flows.publish', { flowId: 'flow-1' }, caller);
  await enabled.execute('business.webhooks.subscribe_app', {}, caller);
  assert.deepEqual(calls.map(({ url }) => url.pathname), [
    '/v24.0/waba-123/message_templates', '/v24.0/flow-1/publish', '/v24.0/waba-123/subscribed_apps',
  ]);
  assert.equal(calls[0].url.searchParams.get('name'), 'welcome');
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[2].init.method, 'POST');
});

test('Meta interactive and read-receipt message types use the messages endpoint with typed payloads', async () => {
  const calls = [];
  const adapter = createMetaCloudAdapter(config({ fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (JSON.parse(init.body).status === 'read') return jsonResponse({ success: true });
    return jsonResponse({ contacts: [{ wa_id: '15551234567' }], messages: [{ id: 'wamid.1' }] });
  } }));
  await adapter.execute('business.messages.send_interactive_buttons', { to: '+15551234567', body: 'Choose', buttons: [{ id: 'yes', title: 'Yes' }] }, caller);
  await adapter.execute('business.messages.send_location', { to: '+15551234567', latitude: 1, longitude: 2 }, caller);
  await adapter.execute('business.messages.mark_read', { messageId: 'wamid.2' }, caller);
  assert.ok(calls.every(({ url }) => url.pathname === '/v24.0/phone-123/messages'));
  const buttons = JSON.parse(calls[0].init.body);
  assert.equal(buttons.type, 'interactive');
  assert.equal(buttons.interactive.action.buttons[0].reply.id, 'yes');
  assert.deepEqual(JSON.parse(calls[2].init.body), { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.2' });
});

test('Meta identity binding and unknown capability reject without provider calls', async () => {
  let calls = 0;
  const adapter = createMetaCloudAdapter(config({ fetchImpl: async () => { calls += 1; return jsonResponse({}); } }));
  await assert.rejects(() => adapter.execute('business.messages.not_real', {}, caller), /UNSUPPORTED/);
  await assert.rejects(() => adapter.execute('business.account.get', {}, { ...caller, accountId: 'different' }), /not authorized/i);
  assert.equal(calls, 0);
});
