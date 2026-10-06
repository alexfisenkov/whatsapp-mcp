import { z } from 'zod';

export const emptyInput = z.object({}).strict();
export const graphId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
export const phoneNumber = z.string().trim().regex(/^\+?[1-9]\d{7,14}$/);
export const pageInput = z.object({
  limit: z.number().int().min(1).max(100).default(25),
  after: z.string().trim().min(1).max(1024).optional(),
}).strict();

const templateParameter = z.union([
  z.object({ type: z.literal('text'), text: z.string().trim().min(1).max(1024) }).strict(),
  z.object({ type: z.literal('currency'), currency: z.object({ fallback_value: z.string().min(1).max(128), code: z.string().regex(/^[A-Z]{3}$/), amount_1000: z.number().int() }).strict() }).strict(),
  z.object({ type: z.literal('date_time'), date_time: z.object({ fallback_value: z.string().min(1).max(128) }).strict() }).strict(),
  z.object({ type: z.enum(['image', 'document', 'video']), id: graphId }).strict(),
]);
export const templateComponent = z.object({
  type: z.enum(['header', 'body', 'button']),
  sub_type: z.enum(['quick_reply', 'url']).optional(),
  index: z.string().regex(/^\d+$/).optional(),
  parameters: z.array(templateParameter).max(20).default([]),
}).strict();

export const sendTextInput = z.object({ to: phoneNumber, text: z.string().trim().min(1).max(4096), previewUrl: z.boolean().default(false) }).strict();
export const sendTemplateInput = z.object({
  to: phoneNumber,
  templateName: z.string().trim().min(1).max(512).regex(/^[a-z0-9_]+$/),
  languageCode: z.string().regex(/^[a-z]{2,3}_[A-Z]{2}$/),
  components: z.array(templateComponent).max(10).default([]),
}).strict();
export const sendMediaInput = z.object({ to: phoneNumber, mediaId: graphId, caption: z.string().max(1024).optional(), filename: z.string().max(240).regex(/^[A-Za-z0-9._ -]+$/).optional() }).strict();
export const sendReactionInput = z.object({ to: phoneNumber, messageId: graphId, emoji: z.string().trim().min(1).max(16) }).strict();
export const sendLocationInput = z.object({
  to: phoneNumber, latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
  name: z.string().trim().min(1).max(100).optional(), address: z.string().trim().min(1).max(300).optional(),
}).strict();
export const sendContactInput = z.object({
  to: phoneNumber,
  formattedName: z.string().trim().min(1).max(256),
  firstName: z.string().trim().min(1).max(128).optional(),
  lastName: z.string().trim().min(1).max(128).optional(),
  phones: z.array(z.object({ phone: phoneNumber, type: z.enum(['CELL', 'MAIN', 'IPHONE', 'HOME', 'WORK']).optional() }).strict()).min(1).max(5),
}).strict();
export const sendButtonsInput = z.object({
  to: phoneNumber,
  body: z.string().trim().min(1).max(1024),
  header: z.string().trim().min(1).max(60).optional(),
  footer: z.string().trim().min(1).max(60).optional(),
  buttons: z.array(z.object({ id: z.string().trim().min(1).max(256), title: z.string().trim().min(1).max(20) }).strict()).min(1).max(3),
}).strict();
export const sendListInput = z.object({
  to: phoneNumber,
  body: z.string().trim().min(1).max(1024),
  button: z.string().trim().min(1).max(20),
  header: z.string().trim().min(1).max(60).optional(),
  footer: z.string().trim().min(1).max(60).optional(),
  sections: z.array(z.object({ title: z.string().trim().min(1).max(24).optional(), rows: z.array(z.object({ id: z.string().trim().min(1).max(200), title: z.string().trim().min(1).max(24), description: z.string().trim().max(72).optional() }).strict()).min(1).max(10) }).strict()).min(1).max(10),
}).strict();
export const markReadInput = z.object({ messageId: graphId }).strict();

export const listTemplatesInput = pageInput.extend({
  status: z.enum(['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED']).optional(),
  category: z.enum(['AUTHENTICATION', 'MARKETING', 'UTILITY']).optional(),
  name: z.string().trim().min(1).max(512).optional(),
}).strict();
export const getTemplateInput = z.object({ templateId: graphId }).strict();
const createTemplateButton = z.discriminatedUnion('type', [
  z.object({ type: z.literal('QUICK_REPLY'), text: z.string().trim().min(1).max(25) }).strict(),
  z.object({ type: z.literal('URL'), text: z.string().trim().min(1).max(25), url: z.string().url().startsWith('https://') }).strict(),
  z.object({ type: z.literal('PHONE_NUMBER'), text: z.string().trim().min(1).max(25), phone_number: z.string().trim().min(1).max(32) }).strict(),
]);
const createTemplateComponent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('HEADER'), format: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION']), text: z.string().trim().min(1).max(60).optional() }).strict(),
  z.object({ type: z.literal('BODY'), text: z.string().trim().min(1).max(1024) }).strict(),
  z.object({ type: z.literal('FOOTER'), text: z.string().trim().min(1).max(60) }).strict(),
  z.object({ type: z.literal('BUTTONS'), buttons: z.array(createTemplateButton).min(1).max(10) }).strict(),
]);
export const createTemplateInput = z.object({
  name: z.string().trim().min(1).max(512).regex(/^[a-z0-9_]+$/),
  category: z.enum(['AUTHENTICATION', 'MARKETING', 'UTILITY']),
  language: z.string().regex(/^[a-z]{2,3}_[A-Z]{2}$/),
  components: z.array(createTemplateComponent).min(1).max(10),
}).strict();
export const deleteTemplateInput = z.object({ name: z.string().trim().min(1).max(512).regex(/^[a-z0-9_]+$/), templateId: graphId.optional() }).strict();

export const mediaUploadInput = z.object({
  managedMediaId: z.string().uuid(),
}).strict();
export const mediaGetInput = z.object({ mediaId: graphId }).strict();

export const listFlowsInput = pageInput.extend({ status: z.enum(['DRAFT', 'PUBLISHED', 'DEPRECATED', 'BLOCKED', 'THROTTLED']).optional() }).strict();
export const getFlowInput = z.object({ flowId: graphId }).strict();
export const createFlowInput = z.object({ name: z.string().trim().min(1).max(200), categories: z.array(z.string().trim().min(1).max(64)).min(1).max(10) }).strict();
export const updateFlowInput = z.object({ flowId: graphId, name: z.string().trim().min(1).max(200).optional(), categories: z.array(z.string().trim().min(1).max(64)).min(1).max(10).optional() }).strict().refine((input) => input.name !== undefined || input.categories !== undefined, { message: 'At least one field is required.' });
export const flowIdInput = z.object({ flowId: graphId }).strict();
export const sendFlowInput = z.object({
  to: phoneNumber, flowId: graphId, flowToken: z.string().trim().min(1).max(1024), cta: z.string().trim().min(1).max(30),
  body: z.string().trim().min(1).max(1024), header: z.string().trim().min(1).max(60).optional(), footer: z.string().trim().min(1).max(60).optional(),
  mode: z.enum(['draft', 'published']).default('published'),
  screen: z.string().trim().min(1).max(128),
}).strict();

export type SendTextInput = z.infer<typeof sendTextInput>;
export type SendTemplateInput = z.infer<typeof sendTemplateInput>;
export type SendMediaInput = z.infer<typeof sendMediaInput>;
export type SendReactionInput = z.infer<typeof sendReactionInput>;
export type SendLocationInput = z.infer<typeof sendLocationInput>;
export type SendContactInput = z.infer<typeof sendContactInput>;
export type SendButtonsInput = z.infer<typeof sendButtonsInput>;
export type SendListInput = z.infer<typeof sendListInput>;
export type MarkReadInput = z.infer<typeof markReadInput>;
export type ListTemplatesInput = z.infer<typeof listTemplatesInput>;
export type GetTemplateInput = z.infer<typeof getTemplateInput>;
export type CreateTemplateInput = z.infer<typeof createTemplateInput>;
export type DeleteTemplateInput = z.infer<typeof deleteTemplateInput>;
export type MediaUploadInput = z.infer<typeof mediaUploadInput>;
export type MediaGetInput = z.infer<typeof mediaGetInput>;
export type ListFlowsInput = z.infer<typeof listFlowsInput>;
export type GetFlowInput = z.infer<typeof getFlowInput>;
export type CreateFlowInput = z.infer<typeof createFlowInput>;
export type UpdateFlowInput = z.infer<typeof updateFlowInput>;
export type FlowIdInput = z.infer<typeof flowIdInput>;
export type SendFlowInput = z.infer<typeof sendFlowInput>;
