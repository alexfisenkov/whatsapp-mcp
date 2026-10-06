import { z } from 'zod';
import type { AdapterOperation } from '../../mcp-server.js';
import { graphPath, projectGraphObject, type GraphContext } from './shared.js';

const analyticsInput = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  granularity: z.enum(['DAY', 'MONTH']).default('DAY'),
}).strict().superRefine((input, context) => {
  const start = Date.parse(`${input.startDate}T00:00:00Z`);
  const end = Date.parse(`${input.endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== input.startDate) context.addIssue({ code: 'custom', path: ['startDate'], message: 'Invalid calendar date.' });
  if (!Number.isFinite(end) || new Date(end).toISOString().slice(0, 10) !== input.endDate) context.addIssue({ code: 'custom', path: ['endDate'], message: 'Invalid calendar date.' });
  if (end < start || end - start > 366 * 24 * 60 * 60 * 1000) context.addIssue({ code: 'custom', path: ['endDate'], message: 'Date range must be ordered and at most 366 days.' });
});
type AnalyticsInput = z.infer<typeof analyticsInput>;

export const analyticsDefinitions: readonly AdapterOperation[] = [
  op('business.analytics.conversations', 'Get conversation analytics', 'Read bounded conversation analytics for this WABA.', analyticsInput),
  op('business.analytics.templates', 'Get template analytics', 'Read bounded template analytics for this WABA.', analyticsInput),
];

export async function executeAnalyticsOperation(context: GraphContext, operationId: string, input: unknown): Promise<unknown> {
  const value = analyticsInput.parse(input) as AnalyticsInput;
  const metric = operationId === 'business.analytics.conversations' ? 'conversation_analytics' : 'template_analytics';
  const field = `${metric}.start(${value.startDate}).end(${value.endDate}).granularity(${value.granularity})`;
  const response = await context.client.json({
    method: 'GET', path: graphPath(context, `/${context.config.businessAccountId}`),
    query: new URLSearchParams({ fields: field }),
  });
  return projectGraphObject(response, [metric]);
}

function op(id: string, title: string, description: string, inputSchema: AdapterOperation['inputSchema']): AdapterOperation {
  return { id, title, description, kind: 'read', inputSchema };
}
