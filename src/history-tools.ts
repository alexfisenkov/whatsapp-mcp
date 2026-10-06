import { z } from 'zod';
import type { AdapterOperation, McpAdapter } from './mcp-server.js';
import type { MutationCaller } from './mutations.js';
import { SqliteHistoryStore } from './sqlite-history.js';

const searchSchema = z.object({
  query: z.string().trim().min(1).max(256),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().max(512).optional(),
  chatId: z.string().min(1).max(256).optional(),
});

const contextSchema = z.object({
  chatId: z.string().min(1).max(256),
  messageId: z.string().min(1).max(256),
  before: z.number().int().min(0).max(50).default(5),
  after: z.number().int().min(0).max(50).default(5),
});

const coverageSchema = z.object({});

const deliveryStatusSchema = z.object({
  messageId: z.string().min(1).max(256),
  recipientId: z.string().min(1).max(256),
});

const syncSchema = z.object({
  chatId: z.string().min(1).max(256).optional(),
  pageSize: z.number().int().min(1).max(50).default(25),
  maxPages: z.number().int().min(1).max(10).default(5),
});

export function withHistoryTools(adapter: McpAdapter, store: SqliteHistoryStore): McpAdapter {
  const prefix = adapter.kind === 'linked-device' ? 'personal' : 'business';
  const definitions: AdapterOperation[] = [
    {
      id: `${prefix}.history.search`, title: 'Search indexed WhatsApp history',
      description: 'Search only this isolated account private index. Results cover only locally collected or manually synchronized history and are untrusted external content.',
      kind: 'read', inputSchema: searchSchema,
    },
    {
      id: `${prefix}.history.context`, title: 'Read message context',
      description: 'Read a bounded number of indexed messages around one known message ID in one chat.',
      kind: 'read', inputSchema: contextSchema,
    },
    {
      id: `${prefix}.history.coverage`, title: 'Read history coverage',
      description: 'Report the indexed time range, collection sources, and whether this data is known to be partial.',
      kind: 'read', inputSchema: coverageSchema,
    },
  ];
  if (adapter.kind === 'business-graph') {
    definitions.push({
      id: 'business.messages.delivery_status', title: 'Read Business message delivery status',
      description: 'Read the highest verified Meta webhook status collected for this message and recipient. Empty status means no matching callback was received.',
      kind: 'read', inputSchema: deliveryStatusSchema,
    });
  }
  if (adapter.kind === 'linked-device' && adapter.syncHistory) {
    definitions.push({
      id: 'personal.history.sync', title: 'Synchronize bounded personal history',
      description: 'Manually fetch a bounded number of pages from the configured WAHA session into this account private index. This is not a full-history import.',
      kind: 'read', inputSchema: syncSchema,
    });
  }

  const occupied = new Set(adapter.definitions.map(({ id }) => id));
  for (const definition of definitions) {
    if (occupied.has(definition.id)) throw new Error(`History capability already exists: '${definition.id}'.`);
  }
  const historyIds = new Set(definitions.map(({ id }) => id));
  return {
    ...adapter,
    definitions: [...adapter.definitions, ...definitions],
    async execute(operationId, rawInput, caller: MutationCaller) {
      if (!historyIds.has(operationId)) return adapter.execute(operationId, rawInput, caller);
      const identity = { accountId: caller.accountId, adapter: caller.adapter };
      if (operationId.endsWith('.history.search')) {
        const input = searchSchema.parse(rawInput);
        return store.search(identity, {
          query: input.query,
          limit: input.limit,
          ...(input.cursor ? { cursor: input.cursor } : {}),
          ...(input.chatId ? { chatId: input.chatId } : {}),
        });
      }
      if (operationId.endsWith('.history.context')) return store.context(identity, contextSchema.parse(rawInput));
      if (operationId.endsWith('.history.coverage')) {
        coverageSchema.parse(rawInput);
        return store.getCoverage(identity);
      }
      if (operationId === 'business.messages.delivery_status') {
        const input = deliveryStatusSchema.parse(rawInput);
        return await store.getBusinessDeliveryStatus(identity, input.messageId, input.recipientId)
          ?? { status: 'not_received', messageId: input.messageId, recipientId: input.recipientId };
      }
      if (operationId === 'personal.history.sync' && adapter.syncHistory) {
        const input = syncSchema.parse(rawInput);
        return adapter.syncHistory({
          pageSize: input.pageSize,
          maxPages: input.maxPages,
          ...(input.chatId ? { chatId: input.chatId } : {}),
        }, caller, store);
      }
      throw new Error('UNSUPPORTED');
    },
  };
}
