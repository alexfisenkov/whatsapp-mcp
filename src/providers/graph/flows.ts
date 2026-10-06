import type { AdapterOperation } from '../../mcp-server.js';
import { createFlowInput, flowIdInput, getFlowInput, listFlowsInput, updateFlowInput, type CreateFlowInput, type FlowIdInput, type GetFlowInput, type ListFlowsInput, type UpdateFlowInput } from './schemas.js';
import { graphIdSegment, graphPath, projectGraphObject, projectGraphPage, type GraphContext } from './shared.js';

export const flowDefinitions: readonly AdapterOperation[] = [
  op('business.flows.list', 'List WhatsApp Flows', 'List a bounded page of Flow metadata for this WABA.', 'read', listFlowsInput),
  op('business.flows.get', 'Get WhatsApp Flow', 'Read metadata and validation state for one Flow.', 'read', getFlowInput),
];

export const flowAdminDefinitions: readonly AdapterOperation[] = [
  op('business.flows.create', 'Create WhatsApp Flow', 'Create a draft Flow with a name and categories.', 'guarded-mutation', createFlowInput),
  op('business.flows.update', 'Update WhatsApp Flow metadata', 'Update a draft Flow name or categories.', 'guarded-mutation', updateFlowInput),
  op('business.flows.publish', 'Publish WhatsApp Flow', 'Publish one validated Flow.', 'guarded-mutation', flowIdInput),
  op('business.flows.deprecate', 'Deprecate WhatsApp Flow', 'Deprecate one published Flow.', 'guarded-mutation', flowIdInput),
  op('business.flows.delete', 'Delete WhatsApp Flow', 'Delete one Flow by its Meta ID.', 'guarded-mutation', flowIdInput),
];

export async function executeFlowOperation(context: GraphContext, operationId: string, input: unknown): Promise<unknown> {
  const wabaId = context.config.businessAccountId;
  if (operationId === 'business.flows.list') {
    const value = listFlowsInput.parse(input) as ListFlowsInput;
    const query = new URLSearchParams({ fields: 'id,name,status,categories,validation_errors,json_version,data_api_version', limit: String(value.limit) });
    if (value.after) query.set('after', value.after);
    if (value.status) query.set('status', value.status);
    const response = await context.client.json({ method: 'GET', path: graphPath(context, `/${wabaId}/flows`), query });
    return projectGraphPage(response, projectFlow);
  }
  if (operationId === 'business.flows.get') {
    const value = getFlowInput.parse(input) as GetFlowInput;
    const query = new URLSearchParams({ fields: 'id,name,status,categories,validation_errors,json_version,data_api_version' });
    return projectFlow(await context.client.json({ method: 'GET', path: graphPath(context, `/${graphIdSegment(value.flowId)}`), query }));
  }
  if (operationId === 'business.flows.create') {
    const value = createFlowInput.parse(input) as CreateFlowInput;
    return projectFlow(await context.client.json({
      method: 'POST', path: graphPath(context, `/${wabaId}/flows`), write: true,
      body: { name: value.name, categories: value.categories },
    }));
  }
  if (operationId === 'business.flows.update') {
    const value = updateFlowInput.parse(input) as UpdateFlowInput;
    const { flowId, ...body } = value;
    return projectFlow(await context.client.json({
      method: 'POST', path: graphPath(context, `/${graphIdSegment(flowId)}`), write: true,
      body,
    }));
  }
  if (operationId === 'business.flows.publish' || operationId === 'business.flows.deprecate' || operationId === 'business.flows.delete') {
    const value = flowIdInput.parse(input) as FlowIdInput;
    const flowId = graphIdSegment(value.flowId);
    if (operationId === 'business.flows.delete') {
      return projectGraphObject(await context.client.json({ method: 'DELETE', path: graphPath(context, `/${flowId}`), write: true }), ['success']);
    }
    const operation = operationId.endsWith('.publish') ? 'publish' : 'deprecate';
    return projectGraphObject(await context.client.json({ method: 'POST', path: graphPath(context, `/${flowId}/${operation}`), body: {}, write: true }), ['success']);
  }
  throw new Error('UNSUPPORTED');
}

function projectFlow(value: unknown): Record<string, unknown> {
  return projectGraphObject(value, ['id', 'name', 'status', 'categories', 'validation_errors', 'json_version', 'data_api_version']);
}

function op(id: string, title: string, description: string, kind: AdapterOperation['kind'], inputSchema: AdapterOperation['inputSchema']): AdapterOperation {
  return { id, title, description, kind, inputSchema };
}
