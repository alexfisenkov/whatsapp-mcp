import type { AdapterOperation } from '../../mcp-server.js';
import { graphIdSegment, graphPath, projectGraphObject, projectGraphPage, type GraphContext } from './shared.js';
import { createTemplateInput, deleteTemplateInput, getTemplateInput, listTemplatesInput, type CreateTemplateInput, type DeleteTemplateInput, type GetTemplateInput, type ListTemplatesInput } from './schemas.js';

export const templateDefinitions: readonly AdapterOperation[] = [
  op('business.templates.list', 'List message templates', 'List templates on the configured WhatsApp Business Account.', 'read', listTemplatesInput),
  op('business.templates.get', 'Get message template', 'Read one template by Meta template ID.', 'read', getTemplateInput),
];

export const templateAdminDefinitions: readonly AdapterOperation[] = [
  op('business.templates.create', 'Create a message template', 'Submit a typed message template for Meta review.', 'guarded-mutation', createTemplateInput),
  op('business.templates.delete', 'Delete a message template', 'Delete a template by its exact name and optional ID.', 'guarded-mutation', deleteTemplateInput),
];

export async function executeTemplateOperation(context: GraphContext, operationId: string, input: unknown): Promise<unknown> {
  const wabaId = context.config.businessAccountId;
  switch (operationId) {
    case 'business.templates.list': {
      const value = listTemplatesInput.parse(input) as ListTemplatesInput;
      const query = new URLSearchParams({
        fields: 'id,name,status,category,language,components,rejected_reason',
        limit: String(value.limit),
      });
      if (value.after) query.set('after', value.after);
      if (value.status) query.set('status', value.status);
      if (value.category) query.set('category', value.category);
      if (value.name) query.set('name', value.name);
      const response = await context.client.json({ method: 'GET', path: graphPath(context, `/${wabaId}/message_templates`), query });
      return projectGraphPage(response, projectTemplate);
    }
    case 'business.templates.get': {
      const value = getTemplateInput.parse(input) as GetTemplateInput;
      const query = new URLSearchParams({ fields: 'id,name,status,category,language,components,rejected_reason' });
      return projectTemplate(await context.client.json({ method: 'GET', path: graphPath(context, `/${graphIdSegment(value.templateId)}`), query }));
    }
    case 'business.templates.create': {
      const value = createTemplateInput.parse(input) as CreateTemplateInput;
      const response = await context.client.json({
        method: 'POST', path: graphPath(context, `/${wabaId}/message_templates`), write: true,
        body: { name: value.name, category: value.category, language: value.language, components: value.components },
      });
      return projectGraphObject(response, ['id', 'status', 'category']);
    }
    case 'business.templates.delete': {
      const value = deleteTemplateInput.parse(input) as DeleteTemplateInput;
      const query = new URLSearchParams({ name: value.name });
      if (value.templateId) query.set('h', value.templateId);
      const response = await context.client.json({ method: 'DELETE', path: graphPath(context, `/${wabaId}/message_templates`), query, write: true });
      return projectGraphObject(response, ['success']);
    }
    default:
      throw new Error('UNSUPPORTED');
  }
}

function projectTemplate(value: unknown): Record<string, unknown> {
  return projectGraphObject(value, ['id', 'name', 'status', 'category', 'language', 'components', 'rejected_reason']);
}

function op(id: string, title: string, description: string, kind: AdapterOperation['kind'], inputSchema: AdapterOperation['inputSchema']): AdapterOperation {
  return { id, title, description, kind, inputSchema };
}
