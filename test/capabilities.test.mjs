import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { CapabilityRegistry, UnsupportedCapabilityError } from '../dist/capabilities.js';

const operation = (adapter, id) => ({
  adapter,
  id,
  title: `Test ${id}`,
  description: 'Bounded test operation.',
  kind: 'read',
  inputSchema: z.object({ limit: z.number().int().min(1).max(10) }),
});

test('lists only operations implemented by the selected adapter', () => {
  const registry = new CapabilityRegistry([
    operation('linked-device', 'chat.list'),
    operation('business-graph', 'template.list'),
  ]);

  assert.deepEqual(registry.list('linked-device').map(({ id }) => id), ['chat.list']);
  assert.deepEqual(registry.list('business-graph').map(({ id }) => id), ['template.list']);
});

test('rejects duplicate operation IDs in one adapter', () => {
  assert.throws(() => new CapabilityRegistry([
    operation('linked-device', 'chat.list'),
    operation('linked-device', 'chat.list'),
  ]), /duplicate/i);
});

test('missing provider capability returns UNSUPPORTED instead of a placeholder', () => {
  const registry = new CapabilityRegistry([operation('linked-device', 'chat.list')]);

  assert.throws(
    () => registry.require('business-graph', 'group.create'),
    (error) => error instanceof UnsupportedCapabilityError && error.code === 'UNSUPPORTED',
  );
});

test('validates operation arguments against its declared schema', () => {
  const registry = new CapabilityRegistry([operation('linked-device', 'chat.list')]);
  const capability = registry.require('linked-device', 'chat.list');

  assert.deepEqual(capability.inputSchema.parse({ limit: 5 }), { limit: 5 });
  assert.throws(() => capability.inputSchema.parse({ limit: 500 }));
});
