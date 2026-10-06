import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetaWebhookProcessor } from '../dist/graph-webhook.js';
import { SqliteHistoryStore } from '../dist/sqlite-history.js';

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'wa-meta-webhook-'));
  chmodSync(root, 0o700);
  const store = new SqliteHistoryStore(join(root, 'history.sqlite'));
  const processor = new MetaWebhookProcessor({
    accountId: 'phone-1', businessAccountId: 'waba-1', phoneNumberId: 'phone-1',
    store, now: () => 1_800_000_000_000,
  });
  return { root, store, processor };
}

function payload({ phoneId = 'phone-1', statuses = [] } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'waba-1',
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: phoneId, display_phone_number: 'do-not-index' },
          messages: [{
            id: 'wamid.in-1', from: 'customer-1', timestamp: '1700000000',
            type: 'text', text: { body: 'inbound request about a custom order' },
          }],
          statuses,
        },
      }],
    }],
  };
}

test('indexes only phone-bound verified message events and deduplicates Meta retries', async () => {
  const { root, store, processor } = makeFixture();
  try {
    const first = await processor.process(payload({ statuses: [{
      id: 'wamid.out-1', recipient_id: 'customer-1', status: 'delivered', timestamp: '1700000010',
    }] }));
    const retry = await processor.process(payload({ statuses: [{
      id: 'wamid.out-1', recipient_id: 'customer-1', status: 'delivered', timestamp: '1700000010',
    }] }));
    assert.equal(first.acceptedMessages, 1);
    assert.equal(first.acceptedStatuses, 1);
    assert.equal(retry.duplicateMessages, 1);
    assert.equal(retry.duplicateStatuses, 1);
    const found = await store.search({ accountId: 'phone-1', adapter: 'business-graph' }, { query: 'custom order', limit: 10 });
    assert.equal(found.items.length, 1);
    assert.equal(found.coverage.complete, false);
    assert.equal(found.items[0].chatId, 'customer-1');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects WABA and phone number mismatches before indexing', async () => {
  const { root, store, processor } = makeFixture();
  try {
    await assert.rejects(() => processor.process(payload({ phoneId: 'another-phone' })), /mismatch/i);
    const found = await store.search({ accountId: 'phone-1', adapter: 'business-graph' }, { query: 'custom order', limit: 10 });
    assert.equal(found.items.length, 0);
    await assert.rejects(() => processor.process({ ...payload(), entry: [{ id: 'another-waba', changes: [] }] }), /mismatch/i);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('delivery status advances monotonically and does not regress on delayed callbacks', async () => {
  const { root, store, processor } = makeFixture();
  try {
    await processor.process(payload({ statuses: [
      { id: 'wamid.out-1', recipient_id: 'customer-1', status: 'read', timestamp: '1700000020' },
      { id: 'wamid.out-1', recipient_id: 'customer-1', status: 'delivered', timestamp: '1700000030' },
      { id: 'wamid.out-1', recipient_id: 'customer-1', status: 'failed', timestamp: '1700000040', errors: [{ code: 131000 }] },
    ] }));
    const status = await store.getBusinessDeliveryStatus(
      { accountId: 'phone-1', adapter: 'business-graph' }, 'wamid.out-1', 'customer-1',
    );
    assert.equal(status.status, 'read');
    assert.equal(status.timestampMs, 1_700_000_020_000);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeps provider media IDs from verified Business callbacks but never indexes provider URLs', async () => {
  const { root, store, processor } = makeFixture();
  const event = payload();
  event.entry[0].changes[0].value.messages[0] = {
    id: 'wamid.image-1', from: 'customer-1', timestamp: '1700000000', type: 'image',
    image: {
      id: 'meta-media-123', mime_type: 'image/jpeg', filename: 'proof.jpg',
      caption: 'delivery confirmation', url: 'https://not-trusted.example/file',
    },
  };
  try {
    await processor.process(event);
    const found = await store.search({ accountId: 'phone-1', adapter: 'business-graph' }, { query: 'delivery confirmation', limit: 5 });
    assert.equal(found.items[0].providerMediaId, 'meta-media-123');
    assert.equal(found.items[0].mediaMimeType, 'image/jpeg');
    assert.equal('url' in found.items[0], false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
