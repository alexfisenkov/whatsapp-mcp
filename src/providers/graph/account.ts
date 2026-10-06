import type { AdapterOperation } from '../../mcp-server.js';
import { pageInput, emptyInput } from './schemas.js';
import { graphPath, projectGraphObject, projectGraphPage, type GraphContext } from './shared.js';

export const accountDefinitions: readonly AdapterOperation[] = [
  op('business.account.get', 'Get WhatsApp Business Account', 'Read the configured WABA name and supported account metadata.', 'read', emptyInput),
  op('business.phone.get', 'Get business phone number', 'Read metadata for the configured WhatsApp Business phone number.', 'read', emptyInput),
  op('business.phone_numbers.list', 'List business phone numbers', 'List a bounded page of phone numbers linked to this WABA.', 'read', pageInput),
];

export async function executeAccountOperation(context: GraphContext, operationId: string, input: unknown): Promise<unknown> {
  if (operationId === 'business.account.get') {
    const result = await context.client.json({
      method: 'GET', path: graphPath(context, `/${context.config.businessAccountId}`),
      query: new URLSearchParams({ fields: 'id,name,currency,timezone_id,message_template_namespace' }),
    });
    return projectGraphObject(result, ['id', 'name', 'currency', 'timezone_id', 'message_template_namespace']);
  }
  if (operationId === 'business.phone.get') {
    const result = await context.client.json({
      method: 'GET', path: graphPath(context, `/${context.config.phoneNumberId}`),
      query: new URLSearchParams({ fields: 'id,display_phone_number,verified_name,quality_rating,platform_type,code_verification_status' }),
    });
    return projectGraphObject(result, ['id', 'display_phone_number', 'verified_name', 'quality_rating', 'platform_type', 'code_verification_status']);
  }
  if (operationId === 'business.phone_numbers.list') {
    const value = pageInput.parse(input);
    const query = new URLSearchParams({
      fields: 'id,display_phone_number,verified_name,quality_rating,platform_type,code_verification_status',
      limit: String(value.limit),
    });
    if (value.after) query.set('after', value.after);
    const response = await context.client.json({ method: 'GET', path: graphPath(context, `/${context.config.businessAccountId}/phone_numbers`), query });
    return projectGraphPage(response, (item) => projectGraphObject(item, ['id', 'display_phone_number', 'verified_name', 'quality_rating', 'platform_type', 'code_verification_status']));
  }
  throw new Error('UNSUPPORTED');
}

function op(id: string, title: string, description: string, kind: AdapterOperation['kind'], inputSchema: AdapterOperation['inputSchema']): AdapterOperation {
  return { id, title, description, kind, inputSchema };
}
