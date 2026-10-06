import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, lstatSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAuditStore } from '../dist/sqlite-audit.js';

function makeDir() {
  const path = mkdtempSync(join(tmpdir(), 'wa-mcp-audit-'));
  chmodSync(path, 0o700);
  return path;
}

const record = {
  id: 'approval-1', idempotencyKey: 'idem-1', callerId: 'caller-1', accountId: 'account-1',
  adapter: 'linked-device', releaseRevision: 'release-a', operationId: 'personal.message.send', inputDigest: 'a'.repeat(64),
  status: 'prepared', createdAt: 100, expiresAt: 1_000,
};

test('persists audit records across database reopen without storing message payload', async () => {
  const dir = makeDir();
  const path = join(dir, 'state.sqlite');
  try {
    const first = new SqliteAuditStore(path);
    await first.insertPrepared(record);
    first.close();

    const second = new SqliteAuditStore(path);
    const saved = await second.get(record.id);
    assert.equal(saved.id, record.id);
    assert.equal(saved.inputDigest, record.inputDigest);
    assert.equal('payload' in saved, false);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('allows one atomic claim only for the bound caller and account', async () => {
  const dir = makeDir();
  const store = new SqliteAuditStore(join(dir, 'state.sqlite'));
  try {
    await store.insertPrepared(record);
    const owner = { callerId: record.callerId, accountId: record.accountId, adapter: record.adapter };
    const other = { ...owner, accountId: 'other-account' };
    assert.deepEqual(await store.claim(record.id, other, 101, record.releaseRevision), { kind: 'rejected' });

    const results = await Promise.all([
      store.claim(record.id, owner, 101, record.releaseRevision),
      store.claim(record.id, owner, 101, record.releaseRevision),
    ]);
    assert.equal(results.filter(({ kind }) => kind === 'claimed').length, 1);
    assert.equal((await store.get(record.id)).status, 'executing');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('marks claimed operations OUTCOME_UNKNOWN after restart without retry', async () => {
  const dir = makeDir();
  const path = join(dir, 'state.sqlite');
  const owner = { callerId: record.callerId, accountId: record.accountId, adapter: record.adapter };
  try {
    const first = new SqliteAuditStore(path);
    await first.insertPrepared(record);
    await first.claim(record.id, owner, 101, record.releaseRevision);
    first.close();

    const afterRestart = new SqliteAuditStore(path);
    assert.equal(await afterRestart.recoverInFlight(102), 1);
    assert.equal((await afterRestart.get(record.id)).status, 'OUTCOME_UNKNOWN');
    assert.equal(await afterRestart.recoverInFlight(103), 0);
    afterRestart.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses symlink database paths and non-private state directories', () => {
  const dir = makeDir();
  const target = join(dir, 'target.sqlite');
  const alias = join(dir, 'alias.sqlite');
  const publicDir = join(dir, 'public');
  mkdirSync(publicDir);
  chmodSync(publicDir, 0o755);
  try {
    symlinkSync(target, alias);
    assert.throws(() => new SqliteAuditStore(alias), /symlink/i);
    assert.throws(() => new SqliteAuditStore(join(publicDir, 'state.sqlite')), /private/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
