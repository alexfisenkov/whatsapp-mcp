import test from 'node:test';
import assert from 'node:assert/strict';
import { MutationCoordinator } from '../dist/mutations.js';

class TestAuditStore {
  records = new Map();

  async insertPrepared(record) {
    this.records.set(record.id, structuredClone(record));
  }

  async get(id) {
    const value = this.records.get(id);
    return value ? structuredClone(value) : undefined;
  }

  async claim(id, caller, now, releaseRevision) {
    const record = this.records.get(id);
    if (!record || record.status !== 'prepared' || record.expiresAt <= now) return { kind: 'rejected' };
    if (record.releaseRevision !== releaseRevision) return { kind: 'rejected' };
    if (record.callerId !== caller.callerId || record.accountId !== caller.accountId || record.adapter !== caller.adapter) {
      return { kind: 'rejected' };
    }
    record.status = 'executing';
    return { kind: 'claimed', record: structuredClone(record) };
  }

  async complete(id, outcome) {
    const record = this.records.get(id);
    record.status = outcome.status;
    record.outcome = outcome;
  }

  async recoverInFlight() { return 0; }
}

const caller = { callerId: 'owner-1', accountId: 'account-1', adapter: 'linked-device' };

test('prepare binds approval to caller, account, adapter, and input digest', async () => {
  const store = new TestAuditStore();
  const coordinator = new MutationCoordinator({ store, releaseRevision: 'release-a', now: () => 1_000, approvalTtlMs: 5_000 });
  const prepared = await coordinator.prepare({ caller, operationId: 'message.send', input: { chatId: 'c1', text: 'hello' } });

  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.callerId, caller.callerId);
  assert.equal(prepared.accountId, caller.accountId);
  assert.equal(prepared.adapter, caller.adapter);
  assert.match(prepared.inputDigest, /^[a-f0-9]{64}$/);
});

test('rejects confirmation by another caller without invoking the writer', async () => {
  const store = new TestAuditStore();
  let calls = 0;
  const coordinator = new MutationCoordinator({ store, releaseRevision: 'release-a', now: () => 1_000, approvalTtlMs: 5_000 });
  const prepared = await coordinator.prepare({ caller, operationId: 'message.send', input: { chatId: 'c1', text: 'hello' } });

  await assert.rejects(() => coordinator.confirm({
    caller: { ...caller, callerId: 'other-user' },
    approvalId: prepared.id,
    inputDigest: prepared.inputDigest,
    operationId: 'message.send',
    input: { chatId: 'c1', text: 'hello' },
    execute: async () => { calls += 1; return { providerReceipt: 'receipt' }; },
  }), /approval/i);
  assert.equal(calls, 0);
});

test('confirms once and never retries a mutation after an unknown outcome', async () => {
  const store = new TestAuditStore();
  let calls = 0;
  const coordinator = new MutationCoordinator({ store, releaseRevision: 'release-a', now: () => 1_000, approvalTtlMs: 5_000 });
  const prepared = await coordinator.prepare({ caller, operationId: 'message.send', input: { chatId: 'c1', text: 'hello' } });
  const execute = async () => { calls += 1; throw new Error('socket closed after write'); };

  const first = await coordinator.confirm({ caller, approvalId: prepared.id, inputDigest: prepared.inputDigest, operationId: 'message.send', input: { chatId: 'c1', text: 'hello' }, execute });
  const second = await coordinator.confirm({ caller, approvalId: prepared.id, inputDigest: prepared.inputDigest, operationId: 'message.send', input: { chatId: 'c1', text: 'hello' }, execute });

  assert.equal(first.status, 'OUTCOME_UNKNOWN');
  assert.equal(second.status, 'OUTCOME_UNKNOWN');
  assert.equal(calls, 1);
});

test('rejects parameter changes after preparation', async () => {
  const store = new TestAuditStore();
  const coordinator = new MutationCoordinator({ store, releaseRevision: 'release-a', now: () => 1_000, approvalTtlMs: 5_000 });
  const prepared = await coordinator.prepare({ caller, operationId: 'message.send', input: { chatId: 'c1', text: 'hello' } });

  await assert.rejects(() => coordinator.confirm({
    caller,
    approvalId: prepared.id,
    inputDigest: '0'.repeat(64),
    operationId: 'message.send',
    input: { chatId: 'c1', text: 'hello' },
    execute: async () => ({ providerReceipt: 'should-not-run' }),
  }), /approval/i);
});

test('rejects a pending approval after the runtime release changes', async () => {
  const store = new TestAuditStore();
  const oldRuntime = new MutationCoordinator({ store, releaseRevision: 'commit-a', now: () => 1_000 });
  const prepared = await oldRuntime.prepare({ caller, operationId: 'message.send', input: { chatId: 'c1', text: 'hello' } });
  const newRuntime = new MutationCoordinator({ store, releaseRevision: 'commit-b', now: () => 1_001 });
  let calls = 0;

  await assert.rejects(() => newRuntime.confirm({
    caller, approvalId: prepared.id, inputDigest: prepared.inputDigest, operationId: 'message.send', input: { chatId: 'c1', text: 'hello' },
    execute: async () => { calls += 1; return {}; },
  }), /approval/i);
  assert.equal(calls, 0);
});
