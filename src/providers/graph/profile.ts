import { z } from 'zod';
import type { AdapterOperation } from '../../mcp-server.js';
import { emptyInput } from './schemas.js';
import { graphPath, projectGraphObject, type GraphContext } from './shared.js';

export const profileDefinitions: readonly AdapterOperation[] = [
  op('business.profile.get', 'Get business profile', 'Read the profile visible for this WhatsApp Business phone number.', 'read', emptyInput),
];

export const updateProfileInput = z.object({
  about: z.string().trim().max(139).optional(),
  address: z.string().trim().max(256).optional(),
  description: z.string().trim().max(512).optional(),
  email: z.string().email().max(128).optional(),
  websites: z.array(z.string().url().startsWith('https://')).max(2).optional(),
  vertical: z.string().trim().min(1).max(128).optional(),
}).strict().refine((input) => Object.keys(input).length > 0, { message: 'At least one profile field is required.' });
type UpdateProfileInput = z.infer<typeof updateProfileInput>;

export const profileAdminDefinitions: readonly AdapterOperation[] = [
  op('business.profile.update', 'Update business profile', 'Update explicitly supplied WhatsApp Business profile fields.', 'guarded-mutation', updateProfileInput),
];

export async function executeProfileOperation(context: GraphContext, operationId: string, input: unknown): Promise<unknown> {
  if (operationId === 'business.profile.get') {
    const result = await context.client.json({
      method: 'GET', path: graphPath(context, `/${context.config.phoneNumberId}/whatsapp_business_profile`),
      query: new URLSearchParams({ fields: 'about,address,description,email,profile_picture_url,websites,vertical' }),
    });
    return projectProfile(result);
  }
  if (operationId === 'business.profile.update') {
    const value = updateProfileInput.parse(input) as UpdateProfileInput;
    const result = await context.client.json({
      method: 'POST', path: graphPath(context, `/${context.config.phoneNumberId}/whatsapp_business_profile`), write: true,
      body: { messaging_product: 'whatsapp', ...value },
    });
    return projectGraphObject(result, ['success']);
  }
  throw new Error('UNSUPPORTED');
}

function projectProfile(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as Record<string, unknown>).data)) {
    const data = (value as { data: unknown[] }).data;
    if (!data[0]) throw new Error('Provider response schema mismatch.');
    return projectGraphObject(data[0], ['about', 'address', 'description', 'email', 'profile_picture_url', 'websites', 'vertical']);
  }
  return projectGraphObject(value, ['about', 'address', 'description', 'email', 'profile_picture_url', 'websites', 'vertical']);
}

function op(id: string, title: string, description: string, kind: AdapterOperation['kind'], inputSchema: AdapterOperation['inputSchema']): AdapterOperation {
  return { id, title, description, kind, inputSchema };
}
