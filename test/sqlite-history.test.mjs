import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteHistoryStore } from '../dist/sqlite-history.js';

function makeDir() {
  const path = mkdtempSync(join(tmpdir(), 'wa-mcp-history-'));
  chmodSync(path, 0o700);
  return path;
}

const personal = { accountId: 'personal-1', adapter: 'linked-device' };

test('indexes bounded history and reports partial coverage with stable pagination', async () => {
  const dir = makeDir();
  const store = new SqliteHistoryStore(join(dir, 'history.sqlite'));
  try {
    await store.upsertMessages(personal, [
      { chatId: 'chat-1', messageId: 'm1', senderId: 'peer', sentAtMs: 100, body: 'Project alpha update', fromMe: false },
      { chatId: 'chat-1', messageId: 'm2', senderId: 'self', sentAtMs: 200, body: 'Project alpha done', fromMe: true },
      { chatId: 'chat-2', messageId: 'm3', senderId: 'peer', sentAtMs: 300, body: 'Unrelated text', fromMe: false },
    ], {
      source: 'waha-bounded-sync',
      coveredFromMs: 90,
      coveredToMs: 250,
      lastSyncedAtMs: 400,
      complete: false,
    });

    const first = await store.search(personal, { query: 'project alpha', limit: 1 });
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].messageId, 'm2');
    assert.ok(first.nextCursor);
    assert.equal(first.coverage.complete, false);
    assert.equal(first.coverage.coveredFromMs, 90);
    assert.equal(first.coverage.lastSyncedAtMs, 400);
    const second = await store.search(personal, { query: 'project alpha', limit: 1, cursor: first.nextCursor });
    assert.equal(second.items[0].messageId, 'm1');
    assert.equal(second.items[0].trust, 'untrusted_external_content');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('search is account-isolated and message upserts are idempotent', async () => {
  const dir = makeDir();
  const store = new SqliteHistoryStore(join(dir, 'history.sqlite'));
  try {
    const message = { chatId: 'chat-1', messageId: 'm1', senderId: 'peer', sentAtMs: 100, body: 'secret phrase', fromMe: false };
    await store.upsertMessages(personal, [message], { source: 'sync', coveredFromMs: 100, coveredToMs: 100, lastSyncedAtMs: 200, complete: false });
    await store.upsertMessages(personal, [{ ...message, body: 'updated phrase' }], { source: 'sync', coveredFromMs: 90, coveredToMs: 100, lastSyncedAtMs: 300, complete: false });

    const ownerResult = await store.search(personal, { query: 'updated', limit: 10 });
    const otherResult = await store.search({ accountId: 'personal-2', adapter: 'linked-device' }, { query: 'updated', limit: 10 });
    assert.equal(ownerResult.items.length, 1);
    assert.equal(otherResult.items.length, 0);
    assert.equal(ownerResult.coverage.coveredFromMs, 90);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validates search length and result bounds', async () => {
  const dir = makeDir();
  const store = new SqliteHistoryStore(join(dir, 'history.sqlite'));
  try {
    await assert.rejects(() => store.search(personal, { query: '  ', limit: 10 }), /query/i);
    await assert.rejects(() => store.search(personal, { query: 'ok', limit: 500 }), /limit/i);
    await assert.rejects(() => store.search(personal, { query: 'x'.repeat(300), limit: 10 }), /query/i);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('returns bounded chronological context for a known message only within its account', async () => {
  const dir = makeDir();
  const store = new SqliteHistoryStore(join(dir, 'history.sqlite'));
  try {
    await store.upsertMessages(personal, [
      { chatId: 'chat-1', messageId: 'm1', senderId: 'peer', sentAtMs: 100, body: 'before', fromMe: false },
      { chatId: 'chat-1', messageId: 'm2', senderId: 'self', sentAtMs: 200, body: 'target', fromMe: true },
      { chatId: 'chat-1', messageId: 'm3', senderId: 'peer', sentAtMs: 300, body: 'after', fromMe: false },
    ], { source: 'bounded-sync', coveredFromMs: 100, coveredToMs: 300, lastSyncedAtMs: 400, complete: false });
    const context = await store.context(personal, { chatId: 'chat-1', messageId: 'm2', before: 1, after: 1 });
    assert.equal(context.targetFound, true);
    assert.deepEqual(context.items.map(({ messageId }) => messageId), ['m1', 'm2', 'm3']);
    const missing = await store.context({ ...personal, accountId: 'other' }, { chatId: 'chat-1', messageId: 'm2', before: 1, after: 1 });
    assert.equal(missing.targetFound, false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
