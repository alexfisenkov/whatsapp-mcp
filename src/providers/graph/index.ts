import { safeParse } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { AdapterOperation, McpAdapter } from '../../mcp-server.js';
import type { MutationCaller } from '../../mutations.js';
import { assertCaller, BoundedJsonClient } from '../common.js';
import { accountDefinitions, executeAccountOperation } from './account.js';
import { analyticsDefinitions, executeAnalyticsOperation } from './analytics.js';
import { flowAdminDefinitions, flowDefinitions, executeFlowOperation } from './flows.js';
import { mediaAdminDefinitions, mediaDefinitions, mediaDownloadDefinitions, mediaUploadDefinitions, executeMediaOperation } from './media.js';
import { executeMessageOperation, messageDefinitions } from './messages.js';
import { executeProfileOperation, profileAdminDefinitions, profileDefinitions } from './profile.js';
import { executeTemplateOperation, templateAdminDefinitions, templateDefinitions } from './templates.js';
import { executeWebhookOperation, webhookAdminDefinitions, webhookDefinitions } from './webhooks.js';
import { validateGraphConfig, type MetaGraphConfig } from './shared.js';

export interface MetaCloudAdapterConfig extends MetaGraphConfig {}

export interface AuthorizedMetaCloudAdapter extends McpAdapter {
  authorize(caller: MutationCaller): Promise<void>;
}

export function createMetaCloudAdapter(config: MetaCloudAdapterConfig): AuthorizedMetaCloudAdapter {
  const version = validateGraphConfig(config);
  if (config.accountId !== config.phoneNumberId) {
    throw new TypeError('Business accountId must be bound to the configured phoneNumberId.');
  }
  const effectiveConfig = { ...config, graphApiVersion: version };
  const client = new BoundedJsonClient(
    new URL('https://graph.facebook.com/'),
    { authorization: `Bearer ${config.accessToken}` },
    config,
  );
  const context = { config: effectiveConfig, client, ...(config.mediaStore ? { mediaStore: config.mediaStore } : {}) };
  const definitions: AdapterOperation[] = [
    ...accountDefinitions,
    ...messageDefinitions,
    ...templateDefinitions,
    ...mediaDefinitions,
    ...flowDefinitions,
    ...profileDefinitions,
    ...analyticsDefinitions,
    ...webhookDefinitions,
    ...(config.mediaStore ? [...mediaUploadDefinitions, ...mediaDownloadDefinitions] : []),
    ...(config.enableAdminTools ? [
      ...templateAdminDefinitions,
      ...mediaAdminDefinitions,
      ...flowAdminDefinitions,
      ...profileAdminDefinitions,
      ...webhookAdminDefinitions,
    ] : []),
  ];
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));

  return {
    kind: 'business-graph',
    definitions,
    async authorize(caller) {
      assertCaller(caller, 'business-graph', config.accountId);
    },
    async execute(operationId, rawInput, caller) {
      assertCaller(caller, 'business-graph', config.accountId);
      const definition = byId.get(operationId);
      if (!definition) throw new Error('UNSUPPORTED');
      const parsed = await safeParse(definition.inputSchema, rawInput);
      if (!parsed.success) throw new TypeError('Invalid tool arguments.');
      if (operationId.startsWith('business.messages.')) return executeMessageOperation(context, operationId, parsed.data);
      if (operationId.startsWith('business.templates.')) return executeTemplateOperation(context, operationId, parsed.data);
      if (operationId.startsWith('business.media.')) return executeMediaOperation(context, operationId, parsed.data);
      if (operationId.startsWith('business.flows.')) return executeFlowOperation(context, operationId, parsed.data);
      if (operationId.startsWith('business.profile.')) return executeProfileOperation(context, operationId, parsed.data);
      if (operationId.startsWith('business.account.') || operationId.startsWith('business.phone')) return executeAccountOperation(context, operationId, parsed.data);
      if (operationId.startsWith('business.analytics.')) return executeAnalyticsOperation(context, operationId, parsed.data);
      if (operationId.startsWith('business.webhooks.')) return executeWebhookOperation(context, operationId);
      throw new Error('UNSUPPORTED');
    },
  };
}
