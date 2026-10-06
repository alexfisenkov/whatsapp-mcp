import { z } from 'zod';

export const WAHA_CHAT_ID = z.string().trim().min(3).max(128).regex(/^[A-Za-z0-9._:@-]+$/);
export const WAHA_MESSAGE_ID = z.string().trim().min(3).max(256).regex(/^[A-Za-z0-9._:@-]+$/);
export const WAHA_LIMIT = z.number().int().min(1).max(200).default(50);
export const historySyncInput = z.object({
  chatId: WAHA_CHAT_ID.optional(),
  pageSize: z.number().int().min(1).max(50),
  maxPages: z.number().int().min(1).max(10),
}).strict();
const pageSchema = z.object({ limit: WAHA_LIMIT, offset: z.number().int().min(0).max(10_000).default(0) }).strict();

export const emptyInput = z.object({}).strict();
export const chatListInput = pageSchema.extend({
  sortBy: z.enum(['messageTimestamp', 'id', 'name']).default('messageTimestamp'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
}).strict();
export const chatsOverviewInput = pageSchema.extend({
  ids: z.array(WAHA_CHAT_ID).max(100).optional(),
}).strict();
export const messageListInput = pageSchema.extend({
  chatId: WAHA_CHAT_ID,
  timestampGte: z.number().int().nonnegative().optional(),
  timestampLte: z.number().int().nonnegative().optional(),
  fromMe: z.boolean().optional(),
  ack: z.enum(['ERROR', 'PENDING', 'SERVER', 'DEVICE', 'READ', 'PLAYED']).optional(),
}).strict().refine((input) => input.timestampGte === undefined || input.timestampLte === undefined
  || input.timestampGte <= input.timestampLte, { message: 'timestampGte must not exceed timestampLte.' });
export const messageGetInput = z.object({ chatId: WAHA_CHAT_ID, messageId: WAHA_MESSAGE_ID }).strict();
export const messageMediaInput = z.object({ chatId: WAHA_CHAT_ID, messageId: WAHA_MESSAGE_ID }).strict();
export const contactGetInput = z.object({ contactId: WAHA_CHAT_ID }).strict();
export const groupGetInput = z.object({ groupId: WAHA_CHAT_ID }).strict();
export const groupParticipantsInput = pageSchema.extend({ groupId: WAHA_CHAT_ID }).strict();
export const groupCreateInput = z.object({
  name: z.string().trim().min(1).max(100),
  participants: z.array(WAHA_CHAT_ID).min(1).max(256),
}).strict();
export const groupMembersInput = z.object({ groupId: WAHA_CHAT_ID, participants: z.array(WAHA_CHAT_ID).min(1).max(256) }).strict();
export const groupSubjectInput = z.object({ groupId: WAHA_CHAT_ID, subject: z.string().trim().min(1).max(100) }).strict();
export const groupDescriptionInput = z.object({ groupId: WAHA_CHAT_ID, description: z.string().max(512) }).strict();
export const groupLeaveInput = z.object({ groupId: WAHA_CHAT_ID }).strict();
export const sendTextInput = z.object({
  chatId: WAHA_CHAT_ID,
  text: z.string().trim().min(1).max(4096),
  replyTo: WAHA_MESSAGE_ID.optional(),
}).strict();
export const sendPollInput = z.object({
  chatId: WAHA_CHAT_ID,
  question: z.string().trim().min(1).max(255),
  options: z.array(z.string().trim().min(1).max(100)).min(2).max(12),
  multipleAnswers: z.boolean().default(false),
}).strict().refine((input) => new Set(input.options).size === input.options.length, { message: 'Poll options must be unique.' });
export const pollVoteInput = z.object({
  chatId: WAHA_CHAT_ID,
  pollMessageId: WAHA_MESSAGE_ID,
  pollServerId: z.number().int().nonnegative().optional(),
  votes: z.array(z.string().trim().min(1).max(100)).min(1).max(12),
}).strict();
export const reactionInput = z.object({
  chatId: WAHA_CHAT_ID,
  messageId: WAHA_MESSAGE_ID,
  reaction: z.string().max(16),
}).strict();
export const markReadInput = z.object({
  chatId: WAHA_CHAT_ID,
  messages: z.number().int().min(1).max(100).optional(),
  days: z.number().int().min(1).max(30).optional(),
}).strict();
export const editMessageInput = z.object({
  chatId: WAHA_CHAT_ID,
  messageId: WAHA_MESSAGE_ID,
  text: z.string().trim().min(1).max(4096),
}).strict();
export const deleteMessagePlanInput = z.object({ chatId: WAHA_CHAT_ID, messageId: WAHA_MESSAGE_ID }).strict();
export const deleteMessageInput = z.object({ chatId: WAHA_CHAT_ID, messageId: WAHA_MESSAGE_ID, planId: z.string().uuid() }).strict();
export const chatOrganizationInput = z.object({ chatId: WAHA_CHAT_ID }).strict();
export const sendContactVcardInput = z.object({
  chatId: WAHA_CHAT_ID,
  contacts: z.array(z.object({
    fullName: z.string().trim().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
    organization: z.string().trim().max(256).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)).optional(),
    phoneNumber: z.string().trim().min(7).max(40).regex(/^\+?[0-9][0-9 ()-]{5,38}$/),
    whatsappId: z.string().trim().regex(/^[1-9][0-9]{6,14}$/).optional(),
  }).strict()).min(1).max(5),
}).strict();
export const sendLocationInput = z.object({
  chatId: WAHA_CHAT_ID,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  title: z.string().trim().min(1).max(100),
}).strict();
export const statusTextInput = z.object({
  text: z.string().trim().min(1).max(700),
  contacts: z.array(WAHA_CHAT_ID).max(256).optional(),
  backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  font: z.number().int().min(0).max(5).optional(),
}).strict();
export const statusImageInput = z.object({
  mediaId: z.string().uuid(),
  caption: z.string().max(1024).optional(),
  contacts: z.array(WAHA_CHAT_ID).max(256).optional(),
}).strict();

export const sendMediaInput = z.object({
  chatId: WAHA_CHAT_ID,
  mediaId: z.string().uuid(),
  caption: z.string().max(1024).optional(),
}).strict();

export type ChatListInput = z.infer<typeof chatListInput>;
export type ChatsOverviewInput = z.infer<typeof chatsOverviewInput>;
export type MessageListInput = z.infer<typeof messageListInput>;
export type MessageGetInput = z.infer<typeof messageGetInput>;
export type MessageMediaInput = z.infer<typeof messageMediaInput>;
export type EditMessageInput = z.infer<typeof editMessageInput>;
export type DeleteMessagePlanInput = z.infer<typeof deleteMessagePlanInput>;
export type DeleteMessageInput = z.infer<typeof deleteMessageInput>;
export type ChatOrganizationInput = z.infer<typeof chatOrganizationInput>;
export type SendContactVcardInput = z.infer<typeof sendContactVcardInput>;
export type SendLocationInput = z.infer<typeof sendLocationInput>;
export type ContactGetInput = z.infer<typeof contactGetInput>;
export type GroupGetInput = z.infer<typeof groupGetInput>;
export type GroupParticipantsInput = z.infer<typeof groupParticipantsInput>;
export type GroupCreateInput = z.infer<typeof groupCreateInput>;
export type GroupMembersInput = z.infer<typeof groupMembersInput>;
export type GroupSubjectInput = z.infer<typeof groupSubjectInput>;
export type GroupDescriptionInput = z.infer<typeof groupDescriptionInput>;
export type GroupLeaveInput = z.infer<typeof groupLeaveInput>;
export type SendTextInput = z.infer<typeof sendTextInput>;
export type SendPollInput = z.infer<typeof sendPollInput>;
export type PollVoteInput = z.infer<typeof pollVoteInput>;
export type ReactionInput = z.infer<typeof reactionInput>;
export type MarkReadInput = z.infer<typeof markReadInput>;
export type SendMediaInput = z.infer<typeof sendMediaInput>;
export type StatusTextInput = z.infer<typeof statusTextInput>;
export type StatusImageInput = z.infer<typeof statusImageInput>;
export type HistorySyncInput = z.infer<typeof historySyncInput>;
