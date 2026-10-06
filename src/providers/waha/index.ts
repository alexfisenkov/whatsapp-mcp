import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { safeParse } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { AdapterOperation, McpAdapter } from '../../mcp-server.js';
import type { MutationCaller } from '../../mutations.js';
import { MANAGED_MEDIA_MIME_TYPES, type ManagedMediaStore } from '../../media-store.js';
import type { SqliteHistoryStore } from '../../sqlite-history.js';
import { assertCaller, assertWahaBaseUrl, BoundedJsonClient, encodePathSegment, positiveLimit, type ProviderRuntimeOptions } from '../common.js';
import {
  chatListInput, chatsOverviewInput, contactGetInput, emptyInput, groupCreateInput, groupDescriptionInput,
  groupGetInput, groupMembersInput, groupParticipantsInput, groupSubjectInput, groupLeaveInput, markReadInput,
  chatOrganizationInput, deleteMessageInput, deleteMessagePlanInput, editMessageInput, historySyncInput,
  messageGetInput, messageListInput, messageMediaInput, pollVoteInput, reactionInput,
  sendContactVcardInput, sendLocationInput, sendMediaInput, sendPollInput, sendTextInput, statusTextInput, statusImageInput,
  type ChatListInput, type ChatsOverviewInput, type ContactGetInput, type GroupCreateInput,
  type GroupDescriptionInput, type GroupGetInput, type GroupMembersInput, type GroupParticipantsInput, type GroupLeaveInput,
  type GroupSubjectInput, type MarkReadInput, type MessageGetInput, type MessageListInput,
  type ChatOrganizationInput, type DeleteMessageInput, type DeleteMessagePlanInput, type EditMessageInput,
  type HistorySyncInput, type MessageMediaInput, type PollVoteInput, type ReactionInput,
  type SendContactVcardInput, type SendLocationInput, type SendMediaInput, type SendPollInput, type SendTextInput, type StatusTextInput, type StatusImageInput,
} from './schemas.js';

export interface WahaPersonalConfig extends ProviderRuntimeOptions {
  accountId: string;
  baseUrl: string;
  apiKey: string;
  sessionName: string;
  mediaStore?: ManagedMediaStore;
  enableGroupAdministration?: boolean;
  enableStatusPosting?: boolean;
  mediaBaseUrl?: string;
  enableMessageDeletion?: boolean;
}

export interface AuthorizedWahaAdapter extends McpAdapter {
  authorize(caller: MutationCaller): Promise<void>;
  syncHistory(input: HistorySyncInput, caller: MutationCaller, historyStore: SqliteHistoryStore): Promise<unknown>;
}

const definitions: readonly AdapterOperation[] = [
  op('personal.system.health', 'Check WAHA health', 'Read the private WAHA service health state.', 'read', emptyInput),
  op('personal.system.version', 'Get WAHA version', 'Read the configured WAHA version.', 'read', emptyInput),
  op('personal.session.status', 'Get linked-device session status', 'Read the state of this account-linked WAHA session.', 'read', emptyInput),
  op('personal.account.me', 'Get linked WhatsApp account', 'Read the session account identity and display name.', 'read', emptyInput),
  op('personal.chats.list', 'List chats', 'List chats from the bounded NOWEB store with pagination.', 'read', chatListInput),
  op('personal.chats.overview', 'Get chat overview', 'Read chat names and recent-message summaries from the bounded store.', 'read', chatsOverviewInput),
  op('personal.messages.list', 'List messages', 'Read a bounded page from one chat or, on NOWEB, all stored chats.', 'read', messageListInput),
  op('personal.messages.get', 'Get a message', 'Read one message and safe media metadata by chat and message ID.', 'read', messageGetInput),
  op('personal.messages.edit', 'Edit a sent message', 'Edit one of this account’s own messages after verifying sender and target.', 'guarded-mutation', editMessageInput),
  op('personal.contacts.list', 'List contacts', 'List contacts stored by NOWEB with pagination.', 'read', chatListInput),
  op('personal.contacts.get', 'Get a contact', 'Read one saved contact by WhatsApp contact ID.', 'read', contactGetInput),
  op('personal.groups.list', 'List groups', 'List the account groups available through NOWEB.', 'read', chatListInput),
  op('personal.groups.get', 'Get group', 'Read one group and its safe metadata.', 'read', groupGetInput),
  op('personal.groups.participants', 'List group participants', 'Read one page of participants in a group.', 'read', groupParticipantsInput),
  op('personal.channels.list', 'List followed channels', 'Read channels visible to this linked-device account.', 'read', chatListInput),
  op('personal.messages.send_text', 'Send a text message', 'Send one text message to a chat or to a channel where this account is OWNER/ADMIN.', 'guarded-mutation', sendTextInput),
  op('personal.messages.send_image', 'Send an image', 'Send an image already stored in the private managed media store.', 'guarded-mutation', sendMediaInput),
  op('personal.messages.send_file', 'Send a document', 'Send a document already stored in the private managed media store.', 'guarded-mutation', sendMediaInput),
  op('personal.messages.send_voice', 'Send a voice message', 'Send an audio file already stored in the private managed media store.', 'guarded-mutation', sendMediaInput),
  op('personal.messages.send_video', 'Send a video', 'Send a video already stored in the private managed media store.', 'guarded-mutation', sendMediaInput),
  op('personal.messages.send_poll', 'Create a poll', 'Send a WhatsApp poll to a chat.', 'guarded-mutation', sendPollInput),
  op('personal.messages.vote_poll', 'Vote in a poll', 'Cast a vote for a poll message in its chat.', 'guarded-mutation', pollVoteInput),
  op('personal.messages.react', 'React to a message', 'Set or remove a reaction on one message.', 'guarded-mutation', reactionInput),
  op('personal.messages.mark_read', 'Mark chat messages read', 'Mark a bounded number of recent messages as read.', 'guarded-mutation', markReadInput),
  op('personal.messages.send_location', 'Send a location', 'Send a coordinate point to a chat.', 'guarded-mutation', sendLocationInput),
  op('personal.messages.send_contact', 'Send a contact card', 'Send bounded contact fields as a vCard.', 'guarded-mutation', sendContactVcardInput),
  op('personal.chats.archive', 'Archive a chat', 'Archive one chat in this linked-device account.', 'guarded-mutation', chatOrganizationInput),
  op('personal.chats.unarchive', 'Unarchive a chat', 'Unarchive one chat in this linked-device account.', 'guarded-mutation', chatOrganizationInput),
];

const statusDefinitions: readonly AdapterOperation[] = [
  op('personal.status.send_text', 'Publish a text status', 'Publish a text status to the configured WhatsApp audience or a bounded contact set.', 'guarded-mutation', statusTextInput),
  op('personal.status.send_image', 'Publish an image status', 'Publish a managed image as a WhatsApp status.', 'guarded-mutation', statusImageInput),
];

const mediaDownloadDefinition: AdapterOperation = op('personal.media.download', 'Download received media', 'Copy media from a linked-device message into this profile’s private managed media store and return an opaque media ID.', 'read', messageMediaInput);

const groupAdminDefinitions: readonly AdapterOperation[] = [
  op('personal.groups.create', 'Create a group', 'Create one WhatsApp group with explicit participants.', 'guarded-mutation', groupCreateInput),
  op('personal.groups.add_participants', 'Add group participants', 'Add explicit participants to one group.', 'guarded-mutation', groupMembersInput),
  op('personal.groups.remove_participants', 'Remove group participants', 'Remove explicit participants from one group.', 'guarded-mutation', groupMembersInput),
  op('personal.groups.update_subject', 'Change group subject', 'Update one group subject.', 'guarded-mutation', groupSubjectInput),
  op('personal.groups.update_description', 'Change group description', 'Update one group description.', 'guarded-mutation', groupDescriptionInput),
  op('personal.groups.leave', 'Leave a group', 'Leave one group from this linked-device account.', 'guarded-mutation', groupLeaveInput),
];

const deletePlanDefinition: AdapterOperation = op('personal.messages.delete_plan', 'Plan deletion of your message', 'Read one message, require that it is from this account, and issue a short-lived digest-bound deletion plan.', 'read', deleteMessagePlanInput);
const deleteMessageDefinition: AdapterOperation = op('personal.messages.delete', 'Delete your message', 'Delete only a previously planned own message after owner approval and an unchanged-target check.', 'guarded-mutation', deleteMessageInput);

export function createWahaPersonalAdapter(config: WahaPersonalConfig): AuthorizedWahaAdapter {
  if (!config.accountId.trim() || !config.apiKey.trim() || !/^[A-Za-z0-9._-]{1,64}$/.test(config.sessionName)) {
    throw new TypeError('WAHA account, API key, and session name are required.');
  }
  const baseUrl = assertWahaBaseUrl(config.baseUrl);
  const mediaOrigin = assertWahaBaseUrl(config.mediaBaseUrl ?? config.baseUrl);
  const client = new BoundedJsonClient(baseUrl, { 'X-Api-Key': config.apiKey }, config);
  const enabledDefinitions = [
    ...definitions.filter((definition) => {
      const needsMedia = definition.id === 'personal.messages.send_image'
        || definition.id === 'personal.messages.send_file'
        || definition.id === 'personal.messages.send_voice'
        || definition.id === 'personal.messages.send_video';
      return !needsMedia || Boolean(config.mediaStore);
    }),
    ...(config.enableGroupAdministration === true ? groupAdminDefinitions : []),
    ...(config.enableStatusPosting === true
      ? statusDefinitions.filter((definition) => definition.id !== 'personal.status.send_image' || Boolean(config.mediaStore))
      : []),
    ...(config.mediaStore ? [mediaDownloadDefinition] : []),
    ...(config.enableMessageDeletion === true ? [deletePlanDefinition, deleteMessageDefinition] : []),
  ];
  const schemaById = new Map(enabledDefinitions.map((definition) => [definition.id, definition.inputSchema]));
  const deletionPlans = new Map<string, MessageDeletePlan>();

  return {
    kind: 'linked-device',
    definitions: enabledDefinitions,
    async authorize(caller) {
      assertCaller(caller, 'linked-device', config.accountId);
    },
    async syncHistory(rawInput, caller, historyStore) {
      assertCaller(caller, 'linked-device', config.accountId);
      const input = historySyncInput.parse(rawInput);
      const messages: Array<{ chatId: string; messageId: string; senderId: string; sentAtMs: number; body: string; fromMe: boolean }> = [];
      const skipped = { malformed: 0, overlongBody: 0 };
      let pagesRead = 0;
      let oldest = Number.POSITIVE_INFINITY;
      let newest = 0;
      const chatTarget = input.chatId ?? 'all';
      for (let page = 0; page < input.maxPages; page += 1) {
        const query = new URLSearchParams({ limit: String(input.pageSize), offset: String(page * input.pageSize), downloadMedia: 'false' });
        const response = await client.json<unknown>({
          method: 'GET', path: `/api/${encodePathSegment(config.sessionName)}/chats/${encodePathSegment(chatTarget)}/messages`, query,
        });
        const records = projectList(response, (record) => asObject(record));
        pagesRead += 1;
        for (const record of records) {
          const messageId = record.id;
          const fromMe = record.fromMe;
          const timestamp = typeof record.timestamp === 'number' ? record.timestamp : Number(record.timestamp);
          const chatId = typeof record.chatId === 'string' ? record.chatId : (fromMe === true ? record.to : record.from);
          const senderId = fromMe === true ? 'me' : (record.participant ?? record.from ?? record.to);
          const body = typeof record.body === 'string' ? record.body : '';
          if (typeof messageId !== 'string' || typeof chatId !== 'string' || typeof senderId !== 'string'
            || typeof fromMe !== 'boolean' || !Number.isFinite(timestamp) || timestamp < 0) {
            skipped.malformed += 1;
            continue;
          }
          if (body.length > 100_000) {
            skipped.overlongBody += 1;
            continue;
          }
          const sentAtMs = timestamp < 1_000_000_000_000 ? Math.trunc(timestamp * 1000) : Math.trunc(timestamp);
          messages.push({ chatId, messageId, senderId, sentAtMs, body, fromMe });
          oldest = Math.min(oldest, sentAtMs);
          newest = Math.max(newest, sentAtMs);
        }
        if (records.length < input.pageSize) break;
      }
      const now = Date.now();
      const coveredFromMs = Number.isFinite(oldest) ? oldest : now;
      const coveredToMs = Math.max(coveredFromMs, newest || now);
      await historyStore.upsertMessages(
        { accountId: caller.accountId, adapter: 'linked-device' },
        messages,
        { source: 'waha-noweb-bounded-sync', coveredFromMs, coveredToMs, lastSyncedAtMs: now, complete: false },
      );
      return {
        pagesRead,
        indexedMessages: messages.length,
        skipped,
        complete: false,
        note: 'Bounded newest-page sync only. WAHA store/history may omit older messages; webhook events should supplement this index.',
      };
    },
    async execute(operationId, rawInput, caller) {
      assertCaller(caller, 'linked-device', config.accountId);
      const schema = schemaById.get(operationId);
      if (!schema) throw new Error('UNSUPPORTED');
      const parsed = await safeParse(schema, rawInput);
      if (!parsed.success) throw new TypeError('Invalid tool arguments.');
      const input = parsed.data;
      return executeOperation(client, config.sessionName, mediaOrigin, config.mediaStore, deletionPlans, operationId, input as never, caller);
    },
  };
}

interface MessageDeletePlan {
  callerId: string;
  accountId: string;
  chatId: string;
  messageId: string;
  messageDigest: string;
  expiresAt: number;
  used: boolean;
}

async function executeOperation(
  client: BoundedJsonClient,
  session: string,
  mediaOrigin: URL,
  mediaStore: ManagedMediaStore | undefined,
  deletionPlans: Map<string, MessageDeletePlan>,
  operationId: string,
  input: never,
  caller: MutationCaller,
): Promise<unknown> {
  switch (operationId) {
    case 'personal.system.health': {
      const result = await client.json<Record<string, unknown>>({ method: 'GET', path: '/health' });
      return projectObject(result, ['status']);
    }
    case 'personal.system.version': {
      const result = await client.json<Record<string, unknown>>({ method: 'GET', path: '/api/version' });
      return projectObject(result, ['version', 'environment', 'commit']);
    }
    case 'personal.session.status': {
      const result = await client.json<Record<string, unknown>>({ method: 'GET', path: `/api/sessions/${encodePathSegment(session)}` });
      return projectSession(result);
    }
    case 'personal.account.me': {
      const result = await client.json<Record<string, unknown>>({ method: 'GET', path: `/api/sessions/${encodePathSegment(session)}/me` });
      return projectObject(result, ['id', 'pushName', 'name', 'platform']);
    }
    case 'personal.chats.list': {
      const page = input as ChatListInput;
      const limit = positiveLimit(page.limit, 50, 200);
      const query = new URLSearchParams({ limit: String(limit), offset: String(page.offset), sortBy: page.sortBy, sortOrder: page.sortOrder });
      return { chats: projectList(await client.json<unknown>({ method: 'GET', path: `/api/${encodePathSegment(session)}/chats`, query }), projectChat) };
    }
    case 'personal.chats.overview': {
      const page = input as ChatsOverviewInput;
      const body = { pagination: { limit: positiveLimit(page.limit, 50, 200), offset: page.offset }, ...(page.ids ? { filter: { ids: page.ids } } : {}) };
      return { chats: projectList(await client.json<unknown>({ method: 'POST', path: `/api/${encodePathSegment(session)}/chats/overview`, body }), projectChatOverview) };
    }
    case 'personal.messages.list': {
      const page = input as MessageListInput;
      const query = new URLSearchParams({ limit: String(positiveLimit(page.limit, 50, 200)), offset: String(page.offset), downloadMedia: 'false' });
      if (page.timestampGte !== undefined) query.set('filter.timestamp.gte', String(page.timestampGte));
      if (page.timestampLte !== undefined) query.set('filter.timestamp.lte', String(page.timestampLte));
      if (page.fromMe !== undefined) query.set('filter.fromMe', String(page.fromMe));
      if (page.ack !== undefined) query.set('filter.ack', page.ack);
      const chatId = encodePathSegment(page.chatId);
      const result = await client.json<unknown>({ method: 'GET', path: `/api/${encodePathSegment(session)}/chats/${chatId}/messages`, query });
      return { messages: projectList(result, projectMessage), coverage: { complete: false, source: 'waha-noweb-store', note: 'Only currently stored and synchronized messages are available.' } };
    }
    case 'personal.messages.get': {
      const params = input as MessageGetInput;
      const result = await client.json<unknown>({ method: 'GET', path: `/api/${encodePathSegment(session)}/chats/${encodePathSegment(params.chatId)}/messages/${encodePathSegment(params.messageId)}`, query: new URLSearchParams({ downloadMedia: 'false' }) });
      return projectMessage(result);
    }
    case 'personal.messages.edit': {
      const params = input as EditMessageInput;
      const current = await getMessage(client, session, params.chatId, params.messageId);
      requireOwnMessage(current, params.chatId, params.messageId);
      return projectSendResult(await client.json({
        method: 'PUT',
        path: `/api/${encodePathSegment(session)}/chats/${encodePathSegment(params.chatId)}/messages/${encodePathSegment(params.messageId)}`,
        body: { text: params.text },
        write: true,
      }));
    }
    case 'personal.media.download': {
      const params = input as MessageMediaInput;
      if (!mediaStore) throw new Error('UNSUPPORTED');
      const response = await client.json<unknown>({
        method: 'GET',
        path: `/api/${encodePathSegment(session)}/chats/${encodePathSegment(params.chatId)}/messages/${encodePathSegment(params.messageId)}`,
        query: new URLSearchParams({ downloadMedia: 'true' }),
      });
      const message = asObject(response);
      if (message.id !== params.messageId || message.hasMedia !== true || !message.media || typeof message.media !== 'object') {
        throw new Error('Media is unavailable for this message.');
      }
      const media = message.media as Record<string, unknown>;
      if (typeof media.url !== 'string' || typeof media.mimetype !== 'string') throw new Error('Media has not been downloaded by WAHA.');
      const providerUrl = parseWahaMediaUrl(media.url, mediaOrigin);
      const downloaded = await client.privateWahaMedia(`/api/files/${encodePathSegment(providerUrl.fileName)}`, 5 * 1024 * 1024);
      const mimeType = media.mimetype.split(';', 1)[0]?.trim().toLowerCase() ?? '';
      if (!MANAGED_MEDIA_MIME_TYPES.includes(mimeType as typeof MANAGED_MEDIA_MIME_TYPES[number])) throw new TypeError('Unsupported media MIME type.');
      if (downloaded.contentType && downloaded.contentType !== 'application/octet-stream' && downloaded.contentType !== mimeType) {
        throw new Error('WAHA media response MIME type did not match the message metadata.');
      }
      const stored = await mediaStore.save({ bytes: Buffer.from(downloaded.bytes), mimeType, fileName: typeof media.filename === 'string' ? media.filename : providerUrl.fileName, maxBytes: 5 * 1024 * 1024 });
      return { mediaId: stored.id, mimeType: stored.mimeType, fileName: stored.fileName, size: stored.size, sha256: stored.sha256 };
    }
    case 'personal.contacts.list': {
      const page = input as ChatListInput;
      const query = new URLSearchParams({ session, limit: String(positiveLimit(page.limit, 50, 200)), offset: String(page.offset), sortBy: 'id', sortOrder: page.sortOrder });
      return { contacts: projectList(await client.json<unknown>({ method: 'GET', path: '/api/contacts/all', query }), projectContact) };
    }
    case 'personal.contacts.get': {
      const params = input as ContactGetInput;
      const query = new URLSearchParams({ session, contactId: params.contactId });
      return projectContact(await client.json<unknown>({ method: 'GET', path: '/api/contacts', query }));
    }
    case 'personal.groups.list': {
      const page = input as ChatListInput;
      const query = new URLSearchParams({ limit: String(positiveLimit(page.limit, 50, 200)), offset: String(page.offset) });
      return { groups: projectList(await client.json<unknown>({ method: 'GET', path: `/api/${encodePathSegment(session)}/groups`, query }), projectGroup) };
    }
    case 'personal.groups.get': {
      const params = input as GroupGetInput;
      return projectGroup(await client.json<unknown>({ method: 'GET', path: `/api/${encodePathSegment(session)}/groups/${encodePathSegment(params.groupId)}` }));
    }
    case 'personal.groups.participants': {
      const params = input as GroupParticipantsInput;
      const query = new URLSearchParams({ limit: String(positiveLimit(params.limit, 50, 200)), offset: String(params.offset) });
      return { participants: projectList(await client.json<unknown>({ method: 'GET', path: `/api/${encodePathSegment(session)}/groups/${encodePathSegment(params.groupId)}/participants`, query }), projectParticipant) };
    }
    case 'personal.groups.create': {
      const params = input as GroupCreateInput;
      const body = { name: params.name, participants: params.participants.map((id) => ({ id })) };
      return projectGroup(await client.json({ method: 'POST', path: `/api/${encodePathSegment(session)}/groups`, body, write: true }));
    }
    case 'personal.groups.add_participants':
    case 'personal.groups.remove_participants': {
      const params = input as GroupMembersInput;
      const action = operationId.endsWith('add_participants') ? 'add' : 'remove';
      const body = { participants: params.participants.map((id) => ({ id })) };
      return projectObject(await client.json({ method: 'POST', path: `/api/${encodePathSegment(session)}/groups/${encodePathSegment(params.groupId)}/participants/${action}`, body, write: true }), ['update', 'participants']);
    }
    case 'personal.groups.update_subject': {
      const params = input as GroupSubjectInput;
      return projectObject(await client.json({ method: 'PUT', path: `/api/${encodePathSegment(session)}/groups/${encodePathSegment(params.groupId)}/subject`, body: { subject: params.subject }, write: true }), ['subject']);
    }
    case 'personal.groups.update_description': {
      const params = input as GroupDescriptionInput;
      return projectObject(await client.json({ method: 'PUT', path: `/api/${encodePathSegment(session)}/groups/${encodePathSegment(params.groupId)}/description`, body: { description: params.description }, write: true }), ['description']);
    }
    case 'personal.groups.leave': {
      const params = input as GroupLeaveInput;
      return projectObject(await client.json({ method: 'POST', path: `/api/${encodePathSegment(session)}/groups/${encodePathSegment(params.groupId)}/leave`, body: {}, write: true }), ['id', 'success']);
    }
    case 'personal.channels.list': {
      const page = input as ChatListInput;
      const query = new URLSearchParams({ limit: String(positiveLimit(page.limit, 50, 200)), offset: String(page.offset) });
      return { channels: projectList(await client.json<unknown>({ method: 'GET', path: `/api/${encodePathSegment(session)}/channels`, query }), projectChannel) };
    }
    case 'personal.messages.send_text': {
      const params = input as SendTextInput;
      if (params.chatId.endsWith('@newsletter')) await requireOwnedChannel(client, session, params.chatId);
      const body = { session, chatId: params.chatId, text: params.text, ...(params.replyTo ? { reply_to: params.replyTo } : {}) };
      return projectSendResult(await client.json({ method: 'POST', path: '/api/sendText', body, write: true }));
    }
    case 'personal.messages.send_image':
    case 'personal.messages.send_file':
    case 'personal.messages.send_voice':
    case 'personal.messages.send_video': {
      const params = input as SendMediaInput;
      const allowedMimes: Record<string, string[]> = {
        'personal.messages.send_image': ['image/jpeg', 'image/png'],
        'personal.messages.send_file': ['application/pdf', 'text/plain', 'application/zip'],
        'personal.messages.send_voice': ['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav'],
        'personal.messages.send_video': ['video/mp4'],
      };
      if (!mediaStore) throw new Error('UNSUPPORTED');
      const stored = await mediaStore.read(params.mediaId, { maxBytes: 5 * 1024 * 1024, allowedMimeTypes: allowedMimes[operationId] ?? [] });
      if (params.chatId.endsWith('@newsletter')) await requireOwnedChannel(client, session, params.chatId);
      const routes: Record<string, string> = {
        'personal.messages.send_image': '/api/sendImage',
        'personal.messages.send_file': '/api/sendFile',
        'personal.messages.send_voice': '/api/sendVoice',
        'personal.messages.send_video': '/api/sendVideo',
      };
      const body = {
        session,
        chatId: params.chatId,
        ...(params.caption ? { caption: params.caption } : {}),
        file: { mimetype: stored.mimeType, filename: stored.fileName, data: stored.bytes.toString('base64') },
      };
      return projectSendResult(await client.json({ method: 'POST', path: routes[operationId]!, body, write: true }));
    }
    case 'personal.messages.send_poll': {
      const params = input as SendPollInput;
      if (params.chatId.endsWith('@newsletter')) throw new TypeError('Channel poll creation is not in the supported NOWEB operation set.');
      const body = { session, chatId: params.chatId, poll: { name: params.question, options: params.options, multipleAnswers: params.multipleAnswers } };
      return projectSendResult(await client.json({ method: 'POST', path: '/api/sendPoll', body, write: true }));
    }
    case 'personal.messages.vote_poll': {
      const params = input as PollVoteInput;
      return projectSendResult(await client.json({ method: 'POST', path: '/api/sendPollVote', body: { session, chatId: params.chatId, pollMessageId: params.pollMessageId, ...(params.pollServerId !== undefined ? { pollServerId: params.pollServerId } : {}), votes: params.votes }, write: true }));
    }
    case 'personal.messages.react': {
      const params = input as ReactionInput;
      return projectSendResult(await client.json({ method: 'PUT', path: '/api/reaction', body: { session, chatId: params.chatId, messageId: params.messageId, reaction: params.reaction }, write: true }));
    }
    case 'personal.messages.mark_read': {
      const params = input as MarkReadInput;
      const body = { ...(params.messages !== undefined ? { messages: params.messages } : {}), ...(params.days !== undefined ? { days: params.days } : {}) };
      return projectSendResult(await client.json({ method: 'POST', path: `/api/${encodePathSegment(session)}/chats/${encodePathSegment(params.chatId)}/messages/read`, body, write: true }));
    }
    case 'personal.messages.send_location': {
      const params = input as SendLocationInput;
      return projectSendResult(await client.json({ method: 'POST', path: '/api/sendLocation', body: { session, chatId: params.chatId, latitude: params.latitude, longitude: params.longitude, title: params.title }, write: true }));
    }
    case 'personal.messages.send_contact': {
      const params = input as SendContactVcardInput;
      return projectSendResult(await client.json({ method: 'POST', path: '/api/sendContactVcard', body: { session, chatId: params.chatId, contacts: params.contacts }, write: true }));
    }
    case 'personal.chats.archive':
    case 'personal.chats.unarchive': {
      const params = input as ChatOrganizationInput;
      const action = operationId.endsWith('.archive') && !operationId.endsWith('.unarchive') ? 'archive' : 'unarchive';
      return projectSendResult(await client.json({ method: 'POST', path: `/api/${encodePathSegment(session)}/chats/${encodePathSegment(params.chatId)}/${action}`, body: {}, write: true }));
    }
    case 'personal.messages.delete_plan': {
      const params = input as DeleteMessagePlanInput;
      for (const [id, plan] of deletionPlans) if (plan.expiresAt <= Date.now() || plan.used) deletionPlans.delete(id);
      const message = await getMessage(client, session, params.chatId, params.messageId);
      requireOwnMessage(message, params.chatId, params.messageId);
      if (typeof message.body !== 'string') throw new Error('Message body is unavailable for deletion planning.');
      const id = randomUUID();
      const expiresAt = Date.now() + 5 * 60_000;
      deletionPlans.set(id, {
        callerId: caller.callerId,
        accountId: caller.accountId,
        chatId: params.chatId,
        messageId: params.messageId,
        messageDigest: messageDigest(message),
        expiresAt,
        used: false,
      });
      return { planId: id, chatId: params.chatId, messageId: params.messageId, expiresAt, note: 'Delete is available only for this account’s unchanged own message and requires separate owner approval.' };
    }
    case 'personal.messages.delete': {
      const params = input as DeleteMessageInput;
      const plan = deletionPlans.get(params.planId);
      if (!plan || plan.used || plan.expiresAt <= Date.now() || plan.callerId !== caller.callerId || plan.accountId !== caller.accountId
        || plan.chatId !== params.chatId || plan.messageId !== params.messageId) throw new Error('Deletion plan is invalid, expired, or bound to another target.');
      plan.used = true;
      const current = await getMessage(client, session, params.chatId, params.messageId);
      requireOwnMessage(current, params.chatId, params.messageId);
      if (messageDigest(current) !== plan.messageDigest) throw new Error('Message changed after deletion planning. Create a new plan.');
      try {
        const result = await client.json({
          method: 'DELETE',
          path: `/api/${encodePathSegment(session)}/chats/${encodePathSegment(params.chatId)}/messages/${encodePathSegment(params.messageId)}`,
          write: true,
        });
        return projectSendResult(result);
      } finally {
        deletionPlans.delete(params.planId);
      }
    }
    case 'personal.status.send_text': {
      const params = input as StatusTextInput;
      const body = {
        text: params.text,
        ...(params.contacts ? { contacts: params.contacts } : {}),
        ...(params.backgroundColor ? { backgroundColor: params.backgroundColor } : {}),
        ...(params.font !== undefined ? { font: params.font } : {}),
      };
      return projectStatusResult(await client.json({ method: 'POST', path: `/api/${encodePathSegment(session)}/status/text`, body, write: true }));
    }
    case 'personal.status.send_image': {
      const params = input as StatusImageInput;
      if (!mediaStore) throw new Error('UNSUPPORTED');
      const stored = await mediaStore.read(params.mediaId, { maxBytes: 5 * 1024 * 1024, allowedMimeTypes: ['image/jpeg', 'image/png'] });
      const body = {
        file: { mimetype: stored.mimeType, filename: stored.fileName, data: stored.bytes.toString('base64') },
        ...(params.caption ? { caption: params.caption } : {}),
        ...(params.contacts ? { contacts: params.contacts } : {}),
      };
      return projectStatusResult(await client.json({ method: 'POST', path: `/api/${encodePathSegment(session)}/status/image`, body, write: true }));
    }
    default:
      throw new Error('UNSUPPORTED');
  }
}

function op(id: string, title: string, description: string, kind: AdapterOperation['kind'], inputSchema: z.ZodType): AdapterOperation {
  return { id, title, description, kind, inputSchema };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Provider response schema mismatch.');
  return value as Record<string, unknown>;
}

function projectObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  const source = asObject(value);
  return Object.fromEntries(allowed.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function projectList<T>(value: unknown, project: (item: unknown) => T): T[] {
  if (Array.isArray(value)) return value.map(project);
  const obj = asObject(value);
  const data = obj.data;
  if (Array.isArray(data)) return data.map(project);
  throw new Error('Provider response schema mismatch.');
}

function projectChat(value: unknown): Record<string, unknown> {
  const source = asObject(value);
  const result = projectObject(source, ['id', 'name', 'timestamp', 'unreadCount', 'isGroup', 'isReadOnly', 'archived']);
  if (source.lastMessage) result.lastMessage = projectMessage(source.lastMessage);
  return result;
}

function projectChatOverview(value: unknown): Record<string, unknown> {
  const source = asObject(value);
  const projected = projectObject(source, ['id', 'name', 'picture']);
  if (source.lastMessage) projected.lastMessage = projectMessage(source.lastMessage);
  return projected;
}

function projectMessage(value: unknown): Record<string, unknown> {
  const source = asObject(value);
  const result = projectObject(source, ['id', 'timestamp', 'from', 'fromMe', 'to', 'participant', 'body', 'hasMedia', 'ack', 'ackName', 'replyTo', 'editedMessageId', 'revokedMessageId', 'source']);
  if (source.media && typeof source.media === 'object') result.media = projectObject(source.media, ['mimetype', 'filename']);
  return result;
}

function projectContact(value: unknown): Record<string, unknown> {
  return projectObject(value, ['id', 'number', 'name', 'pushname', 'shortName', 'isMe', 'isGroup', 'isWAContact', 'isMyContact', 'isBlocked']);
}

function projectGroup(value: unknown): Record<string, unknown> {
  const source = asObject(value);
  const result = projectObject(source, ['id', 'gid', 'name', 'subject', 'description', 'size', 'announce', 'restrict', 'creation', 'owner']);
  if (Array.isArray(source.participants)) result.participants = source.participants.map(projectParticipant);
  return result;
}

function projectParticipant(value: unknown): Record<string, unknown> {
  return projectObject(value, ['id', 'phoneNumber', 'isAdmin', 'isSuperAdmin', 'admin']);
}

function projectChannel(value: unknown): Record<string, unknown> {
  return projectObject(value, ['id', 'name', 'description', 'role', 'createdAt', 'picture']);
}

function projectSession(value: unknown): Record<string, unknown> {
  const source = asObject(value);
  const result = projectObject(source, ['name', 'status', 'engine', 'me', 'timestamps']);
  if (source.engine && typeof source.engine === 'object') result.engine = projectObject(source.engine, ['engine']);
  if (source.me && typeof source.me === 'object') result.me = projectObject(source.me, ['id', 'pushName']);
  return result;
}

function projectSendResult(value: unknown): Record<string, unknown> {
  const source = asObject(value);
  const result = projectObject(source, ['id', 'messageId', 'timestamp', 'ack', 'ackName', 'status', 'success']);
  return { ...result, outcome: 'accepted_by_waha; delivery_status_may_arrive_later' };
}

async function getMessage(client: BoundedJsonClient, session: string, chatId: string, messageId: string): Promise<Record<string, unknown>> {
  const message = await client.json<unknown>({
    method: 'GET',
    path: `/api/${encodePathSegment(session)}/chats/${encodePathSegment(chatId)}/messages/${encodePathSegment(messageId)}`,
    query: new URLSearchParams({ downloadMedia: 'false' }),
  });
  return asObject(message);
}

function requireOwnMessage(message: Record<string, unknown>, expectedChatId: string, expectedId: string): void {
  const actualChatId = message.chatId ?? (message.fromMe === true ? message.to : message.from);
  if (typeof message.id !== 'string' || !messageIdMatches(message.id, expectedId) || message.fromMe !== true
    || (typeof actualChatId === 'string' && actualChatId !== expectedChatId)) {
    throw new TypeError('The target must be the exact own message in this account.');
  }
}

function messageIdMatches(actual: string, expected: string): boolean {
  return actual === expected || actual.split('_').at(-1) === expected;
}

function messageDigest(message: Record<string, unknown>): string {
  const body = typeof message.body === 'string' ? message.body : '';
  const timestamp = typeof message.timestamp === 'number' ? message.timestamp : null;
  return createHash('sha256').update(JSON.stringify({ id: message.id, body, timestamp, fromMe: message.fromMe })).digest('hex');
}

async function requireOwnedChannel(client: BoundedJsonClient, session: string, channelId: string): Promise<void> {
  if (!channelId.endsWith('@newsletter')) throw new TypeError('Channel ID must end in @newsletter.');
  const response = await client.json<unknown>({
    method: 'GET', path: `/api/${encodePathSegment(session)}/channels/${encodePathSegment(channelId)}`,
  });
  const channel = asObject(response);
  if (channel.id !== channelId || (channel.role !== 'OWNER' && channel.role !== 'ADMIN')) {
    throw new TypeError('Channel posting requires OWNER or ADMIN role.');
  }
}

function projectStatusResult(value: unknown): Record<string, unknown> {
  const source = asObject(value);
  const key = source.key && typeof source.key === 'object' ? source.key as Record<string, unknown> : {};
  if (typeof key.id !== 'string') throw new Error('Provider response schema mismatch.');
  return { statusMessageId: key.id, outcome: 'accepted_by_waha; views_may_arrive_later' };
}

function parseWahaMediaUrl(value: string, expectedOrigin: URL): { fileName: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('WAHA returned an invalid media URL.');
  }
  if (url.origin !== expectedOrigin.origin || url.username || url.password || url.search || url.hash
    || !url.pathname.startsWith('/api/files/')) {
    throw new TypeError('WAHA media URL is outside the configured private files endpoint.');
  }
  const encodedFileName = url.pathname.slice('/api/files/'.length);
  if (!encodedFileName || encodedFileName.includes('/')) throw new TypeError('WAHA media filename is invalid.');
  let fileName: string;
  try { fileName = decodeURIComponent(encodedFileName); } catch { throw new TypeError('WAHA media filename is invalid.'); }
  if (!/^[A-Za-z0-9@._-]{1,240}$/.test(fileName) || fileName === '.' || fileName === '..' || fileName.includes('..')) {
    throw new TypeError('WAHA media filename is invalid.');
  }
  return { fileName };
}
