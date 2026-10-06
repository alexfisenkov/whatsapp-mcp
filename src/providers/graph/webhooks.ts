import type { AdapterOperation } from '../../mcp-server.js';
import { emptyInput } from './schemas.js';
import { graphPath, projectGraphObject, type GraphContext } from './shared.js';

export const webhookDefinitions: readonly AdapterOperation[] = [
  op('business.webhooks.list_subscribed_apps', 'List subscribed webhook apps', 'Read app subscriptions on this WhatsApp Business Account.', 'read', emptyInput),
];

export const webhookAdminDefinitions: readonly AdapterOperation[] = [
  op('business.webhooks.subscribe_app', 'Subscribe this app to WABA webhooks', 'Subscribe the configured app to WABA webhook events.', 'guarded-mutation', emptyInput),
  op('business.webhooks.unsubscribe_app', 'Unsubscribe this app from WABA webhooks', 'Remove the configured app subscription from this WABA.', 'guarded-mutation', emptyInput),
];

export async function executeWebhookOperation(context: GraphContext, operationId: string): Promise<unknown> {
  const path = graphPath(context, `/${context.config.businessAccountId}/subscribed_apps`);
  if (operationId === 'business.webhooks.list_subscribed_apps') {
    const response = await context.client.json<unknown>({ method: 'GET', path });
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('Provider response schema mismatch.');
    const source = response as Record<string, unknown>;
    if (!Array.isArray(source.data)) throw new Error('Provider response schema mismatch.');
    return { apps: source.data.map((item) => projectGraphObject(item, ['id', 'name', 'link'])) };
  }
  if (operationId === 'business.webhooks.subscribe_app') {
    return projectGraphObject(await context.client.json({ method: 'POST', path, body: {}, write: true }), ['success']);
  }
  if (operationId === 'business.webhooks.unsubscribe_app') {
    return projectGraphObject(await context.client.json({ method: 'DELETE', path, write: true }), ['success']);
  }
  throw new Error('UNSUPPORTED');
}

function op(id: string, title: string, description: string, kind: AdapterOperation['kind'], inputSchema: AdapterOperation['inputSchema']): AdapterOperation {
  return { id, title, description, kind, inputSchema };
}
