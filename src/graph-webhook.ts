import type { HistoryIdentity, IndexedMessage, SqliteHistoryStore } from './sqlite-history.js';

export interface MetaWebhookProcessorConfig {
  accountId: string;
  businessAccountId: string;
  phoneNumberId: string;
  store: SqliteHistoryStore;
  now?: () => number;
}

export interface MetaWebhookProcessResult {
  acceptedMessages: number;
  duplicateMessages: number;
  acceptedStatuses: number;
  duplicateStatuses: number;
}

export class MetaWebhookProcessor {
  private readonly identity: HistoryIdentity;
  private readonly config: MetaWebhookProcessorConfig;
  private readonly now: () => number;

  constructor(config: MetaWebhookProcessorConfig) {
    if (!config.accountId || config.accountId !== config.phoneNumberId) {
      throw new TypeError('Webhook account must match the configured phone number ID.');
    }
    if (!config.businessAccountId) throw new TypeError('Business account ID is required.');
    this.identity = { accountId: config.accountId, adapter: 'business-graph' };
    this.config = config;
    this.now = config.now ?? Date.now;
  }

  async process(payload: unknown): Promise<MetaWebhookProcessResult> {
    const root = asRecord(payload, 'Invalid Meta webhook payload.');
    if (root.object !== 'whatsapp_business_account') throw new TypeError('Unexpected Meta webhook object.');
    const entries = asArray(root.entry, 'Meta webhook entry must be an array.');
    if (entries.length > 100) throw new RangeError('Meta webhook entry limit exceeded.');
    const result: MetaWebhookProcessResult = {
      acceptedMessages: 0, duplicateMessages: 0, acceptedStatuses: 0, duplicateStatuses: 0,
    };

    for (const rawEntry of entries) {
      const entry = asRecord(rawEntry, 'Invalid Meta webhook entry.');
      if (entry.id !== this.config.businessAccountId) throw new Error('Meta webhook Business account mismatch.');
      const changes = asArray(entry.changes, 'Meta webhook changes must be an array.');
      if (changes.length > 100) throw new RangeError('Meta webhook change limit exceeded.');
      for (const rawChange of changes) {
        const change = asRecord(rawChange, 'Invalid Meta webhook change.');
        if (change.field !== 'messages') continue;
        const value = asRecord(change.value, 'Invalid WhatsApp message webhook value.');
        const metadata = asRecord(value.metadata, 'WhatsApp webhook metadata is required.');
        if (metadata.phone_number_id !== this.config.phoneNumberId) {
          throw new Error('Meta webhook phone-number account mismatch.');
        }
        const messages = value.messages === undefined ? [] : asArray(value.messages, 'messages must be an array.');
        const statuses = value.statuses === undefined ? [] : asArray(value.statuses, 'statuses must be an array.');
        if (messages.length > 100 || statuses.length > 100) throw new RangeError('Meta webhook event limit exceeded.');
        for (const rawMessage of messages) {
          const message = parseMessage(rawMessage);
          const inserted = await this.config.store.ingestBusinessMessage(
            this.identity,
            `meta:message:${this.config.phoneNumberId}:${message.messageId}`,
            message,
            this.now(),
          );
          if (inserted) result.acceptedMessages += 1;
          else result.duplicateMessages += 1;
        }
        for (const rawStatus of statuses) {
          const status = parseStatus(rawStatus);
          const key = `meta:status:${this.config.phoneNumberId}:${status.messageId}:${status.recipientId}:${status.status}:${status.timestampMs}`;
          const inserted = await this.config.store.ingestBusinessStatus(this.identity, key, status, this.now());
          if (inserted) result.acceptedStatuses += 1;
          else result.duplicateStatuses += 1;
        }
      }
    }
    return result;
  }
}

function parseMessage(value: unknown): IndexedMessage {
  const message = asRecord(value, 'Invalid WhatsApp message event.');
  const messageId = requiredString(message.id, 'Message ID is required.');
  const senderId = requiredString(message.from, 'Message sender is required.');
  const sentAtMs = parseTimestamp(message.timestamp);
  const type = typeof message.type === 'string' ? message.type : 'unknown';
  const body = messageBody(type, message);
  const media = isRecord(message[type]) ? message[type] as Record<string, unknown> : undefined;
  const providerMediaId = media ? optionalString(media.id, 256) : undefined;
  const mediaMimeType = media ? optionalString(media.mime_type, 128) : undefined;
  const mediaFileName = media ? optionalString(media.filename, 128) : undefined;
  return {
    chatId: senderId, messageId, senderId, sentAtMs, body, fromMe: false,
    ...(providerMediaId ? { providerMediaId } : {}),
    ...(mediaMimeType ? { mediaMimeType } : {}),
    ...(mediaFileName ? { mediaFileName } : {}),
  };
}

function parseStatus(value: unknown) {
  const status = asRecord(value, 'Invalid WhatsApp status event.');
  const rawStatus = requiredString(status.status, 'Delivery status is required.');
  if (!['sent', 'failed', 'delivered', 'read'].includes(rawStatus)) throw new TypeError('Unsupported Meta delivery status.');
  let errorCode: number | undefined;
  if (Array.isArray(status.errors) && status.errors.length > 0) {
    const error = asRecord(status.errors[0], 'Invalid Meta delivery error.');
    if (Number.isSafeInteger(error.code)) errorCode = error.code as number;
  }
  return {
    messageId: requiredString(status.id, 'Status message ID is required.'),
    recipientId: requiredString(status.recipient_id, 'Status recipient is required.'),
    status: rawStatus as 'sent' | 'failed' | 'delivered' | 'read',
    timestampMs: parseTimestamp(status.timestamp),
    ...(errorCode !== undefined ? { errorCode } : {}),
  };
}

function messageBody(type: string, message: Record<string, unknown>): string {
  if (type === 'text') {
    const text = asRecord(message.text, 'Invalid text message.');
    return optionalString(text.body, 100_000) ?? '';
  }
  if (['image', 'video', 'document', 'audio', 'sticker'].includes(type)) {
    const media = message[type];
    const caption = isRecord(media) ? optionalString(media.caption, 16_000) : undefined;
    return caption ? `[${type}] ${caption}` : `[${type} message]`;
  }
  if (type === 'interactive') {
    const interactive = isRecord(message.interactive) ? message.interactive : {};
    const reply = isRecord(interactive.button_reply) ? optionalString(interactive.button_reply.title, 4_000)
      : isRecord(interactive.list_reply) ? optionalString(interactive.list_reply.title, 4_000)
        : undefined;
    return reply ?? '[interactive reply]';
  }
  return `[${type.slice(0, 40)} message]`;
}

function parseTimestamp(value: unknown): number {
  const seconds = typeof value === 'string' && /^\d{1,12}$/.test(value) ? Number(value)
    : typeof value === 'number' && Number.isSafeInteger(value) ? value
      : Number.NaN;
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) {
    throw new TypeError('Invalid Meta event timestamp.');
  }
  return seconds * 1000;
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(message);
  return value;
}

function asArray(value: unknown, message: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(message);
  return value;
}

function requiredString(value: unknown, message: string): string {
  const result = optionalString(value, 512);
  if (!result) throw new TypeError(message);
  return result;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
