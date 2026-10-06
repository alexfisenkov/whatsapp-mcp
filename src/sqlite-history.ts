import { DatabaseSync } from 'node:sqlite';
import { openPrivateDatabase } from './sqlite.js';
import type { AdapterKind } from './capabilities.js';

export interface HistoryIdentity {
  accountId: string;
  adapter: AdapterKind;
}

export interface HistorySyncRequest {
  chatId?: string;
  pageSize: number;
  maxPages: number;
}

export interface IndexedMessage {
  chatId: string;
  messageId: string;
  senderId: string;
  sentAtMs: number;
  body: string;
  fromMe: boolean;
  providerMediaId?: string;
  mediaMimeType?: string;
  mediaFileName?: string;
}

export interface HistoryCoverageInput {
  source: string;
  coveredFromMs: number;
  coveredToMs: number;
  lastSyncedAtMs: number;
  complete: boolean;
}

export interface HistoryCoverage {
  status: 'available' | 'empty';
  complete: boolean;
  coveredFromMs?: number;
  coveredToMs?: number;
  lastSyncedAtMs?: number;
  sources: string[];
  note: string;
}

export interface SearchPage {
  items: Array<IndexedMessage & { trust: 'untrusted_external_content' }>;
  nextCursor?: string;
  coverage: HistoryCoverage;
}

export interface ContextPage {
  items: Array<IndexedMessage & { trust: 'untrusted_external_content' }>;
  targetFound: boolean;
  coverage: HistoryCoverage;
}

export interface BusinessDeliveryStatus {
  messageId: string;
  recipientId: string;
  status: 'sent' | 'failed' | 'delivered' | 'read';
  timestampMs: number;
  errorCode?: number;
}

export class SqliteHistoryStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    this.db = openPrivateDatabase(databasePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS indexed_messages (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        adapter TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sent_at_ms INTEGER NOT NULL,
        body TEXT NOT NULL,
        from_me INTEGER NOT NULL,
        provider_media_id TEXT,
        media_mime_type TEXT,
        media_file_name TEXT,
        UNIQUE(account_id, adapter, chat_id, message_id)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS indexed_messages_fts USING fts5(
        account_id UNINDEXED,
        adapter UNINDEXED,
        chat_id,
        message_id UNINDEXED,
        sent_at_ms UNINDEXED,
        body,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TABLE IF NOT EXISTS history_coverage (
        account_id TEXT NOT NULL,
        adapter TEXT NOT NULL,
        source TEXT NOT NULL,
        covered_from_ms INTEGER NOT NULL,
        covered_to_ms INTEGER NOT NULL,
        last_synced_at_ms INTEGER NOT NULL,
        complete INTEGER NOT NULL,
        PRIMARY KEY(account_id, adapter, source)
      );
      CREATE TABLE IF NOT EXISTS provider_event_receipts (
        account_id TEXT NOT NULL,
        adapter TEXT NOT NULL,
        event_key TEXT NOT NULL,
        received_at_ms INTEGER NOT NULL,
        PRIMARY KEY(account_id, adapter, event_key)
      );
      CREATE TABLE IF NOT EXISTS business_delivery_status (
        account_id TEXT NOT NULL,
        adapter TEXT NOT NULL,
        message_id TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        status TEXT NOT NULL,
        status_rank INTEGER NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        error_code INTEGER,
        PRIMARY KEY(account_id, adapter, message_id, recipient_id)
      );
    `);
  }

  async upsertMessages(
    identity: HistoryIdentity,
    messages: readonly IndexedMessage[],
    coverage: HistoryCoverageInput,
  ): Promise<void> {
    validateCoverage(coverage);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const find = this.db.prepare(`
        SELECT row_id FROM indexed_messages
        WHERE account_id = ? AND adapter = ? AND chat_id = ? AND message_id = ?
      `);
      const upsert = this.db.prepare(`
        INSERT INTO indexed_messages
          (account_id, adapter, chat_id, message_id, sender_id, sent_at_ms, body, from_me,
           provider_media_id, media_mime_type, media_file_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, adapter, chat_id, message_id) DO UPDATE SET
          sender_id = excluded.sender_id,
          sent_at_ms = excluded.sent_at_ms,
          body = excluded.body,
          from_me = excluded.from_me,
          provider_media_id = excluded.provider_media_id,
          media_mime_type = excluded.media_mime_type,
          media_file_name = excluded.media_file_name
      `);
      const deleteFts = this.db.prepare('DELETE FROM indexed_messages_fts WHERE rowid = ?');
      const insertFts = this.db.prepare(`
        INSERT INTO indexed_messages_fts
          (rowid, account_id, adapter, chat_id, message_id, sent_at_ms, body)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const message of messages) {
        validateMessage(message);
        const prior = find.get(identity.accountId, identity.adapter, message.chatId, message.messageId) as
          | { row_id: number }
          | undefined;
        upsert.run(
          identity.accountId, identity.adapter, message.chatId, message.messageId,
          message.senderId, message.sentAtMs, message.body, message.fromMe ? 1 : 0,
          message.providerMediaId ?? null, message.mediaMimeType ?? null, message.mediaFileName ?? null,
        );
        const row = find.get(identity.accountId, identity.adapter, message.chatId, message.messageId) as { row_id: number };
        if (prior) deleteFts.run(prior.row_id);
        insertFts.run(row.row_id, identity.accountId, identity.adapter, message.chatId, message.messageId, message.sentAtMs, message.body);
      }

      this.db.prepare(`
        INSERT INTO history_coverage
          (account_id, adapter, source, covered_from_ms, covered_to_ms, last_synced_at_ms, complete)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, adapter, source) DO UPDATE SET
          covered_from_ms = MIN(covered_from_ms, excluded.covered_from_ms),
          covered_to_ms = MAX(covered_to_ms, excluded.covered_to_ms),
          last_synced_at_ms = MAX(last_synced_at_ms, excluded.last_synced_at_ms),
          complete = MIN(complete, excluded.complete)
      `).run(
        identity.accountId, identity.adapter, coverage.source, coverage.coveredFromMs,
        coverage.coveredToMs, coverage.lastSyncedAtMs, coverage.complete ? 1 : 0,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async search(
    identity: HistoryIdentity,
    input: { query: string; limit: number; cursor?: string; chatId?: string },
  ): Promise<SearchPage> {
    const query = input.query.trim();
    if (query.length < 1 || query.length > 256) throw new RangeError('Search query must be 1-256 characters.');
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new RangeError('Search limit must be between 1 and 100.');
    }
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
    const filters: string[] = ['indexed_messages_fts MATCH ?', 'm.account_id = ?', 'm.adapter = ?'];
    const values: Array<string | number> = [toFtsPhrase(query), identity.accountId, identity.adapter];
    if (input.chatId) {
      filters.push('m.chat_id = ?');
      values.push(input.chatId);
    }
    if (cursor) {
      filters.push('(m.sent_at_ms < ? OR (m.sent_at_ms = ? AND m.message_id < ?))');
      values.push(cursor.sentAtMs, cursor.sentAtMs, cursor.messageId);
    }
    values.push(input.limit + 1);
    const rows = this.db.prepare(`
      SELECT m.chat_id, m.message_id, m.sender_id, m.sent_at_ms, m.body, m.from_me,
        m.provider_media_id, m.media_mime_type, m.media_file_name
      FROM indexed_messages_fts
      JOIN indexed_messages AS m ON m.row_id = indexed_messages_fts.rowid
      WHERE ${filters.join(' AND ')}
      ORDER BY m.sent_at_ms DESC, m.message_id DESC
      LIMIT ?
    `).all(...values) as Array<{
      chat_id: string; message_id: string; sender_id: string; sent_at_ms: number; body: string; from_me: number;
      provider_media_id: string | null; media_mime_type: string | null; media_file_name: string | null;
    }>;
    const hasMore = rows.length > input.limit;
    const pageRows = rows.slice(0, input.limit);
    const last = pageRows.at(-1);
    const coverage = this.coverageFor(identity);
    return {
      items: pageRows.map(toUntrustedMessage),
      ...(hasMore && last ? { nextCursor: encodeCursor({ sentAtMs: last.sent_at_ms, messageId: last.message_id }) } : {}),
      coverage,
    };
  }

  async getCoverage(identity: HistoryIdentity): Promise<HistoryCoverage> {
    return this.coverageFor(identity);
  }

  async context(
    identity: HistoryIdentity,
    input: { chatId: string; messageId: string; before: number; after: number },
  ): Promise<ContextPage> {
    if (!input.chatId || !input.messageId) throw new TypeError('chatId and messageId are required.');
    if (![input.before, input.after].every((count) => Number.isInteger(count) && count >= 0 && count <= 50)) {
      throw new RangeError('Context bounds must be from 0 to 50 messages.');
    }
    const target = this.db.prepare(`
      SELECT sent_at_ms, message_id FROM indexed_messages
      WHERE account_id = ? AND adapter = ? AND chat_id = ? AND message_id = ?
    `).get(identity.accountId, identity.adapter, input.chatId, input.messageId) as
      | { sent_at_ms: number; message_id: string }
      | undefined;
    if (!target) return { items: [], targetFound: false, coverage: this.coverageFor(identity) };
    const before = input.before > 0 ? this.db.prepare(`
      SELECT chat_id, message_id, sender_id, sent_at_ms, body, from_me,
        provider_media_id, media_mime_type, media_file_name FROM indexed_messages
      WHERE account_id = ? AND adapter = ? AND chat_id = ?
        AND (sent_at_ms < ? OR (sent_at_ms = ? AND message_id < ?))
      ORDER BY sent_at_ms DESC, message_id DESC LIMIT ?
    `).all(identity.accountId, identity.adapter, input.chatId, target.sent_at_ms, target.sent_at_ms, target.message_id, input.before) as unknown as IndexedRow[] : [];
    const after = this.db.prepare(`
      SELECT chat_id, message_id, sender_id, sent_at_ms, body, from_me,
        provider_media_id, media_mime_type, media_file_name FROM indexed_messages
      WHERE account_id = ? AND adapter = ? AND chat_id = ?
        AND (sent_at_ms > ? OR (sent_at_ms = ? AND message_id >= ?))
      ORDER BY sent_at_ms ASC, message_id ASC LIMIT ?
    `).all(identity.accountId, identity.adapter, input.chatId, target.sent_at_ms, target.sent_at_ms, target.message_id, input.after + 1) as unknown as IndexedRow[];
    return {
      items: [...before.reverse(), ...after].map(toUntrustedMessage),
      targetFound: true,
      coverage: this.coverageFor(identity),
    };
  }

  async ingestBusinessMessage(
    identity: HistoryIdentity,
    eventKey: string,
    message: IndexedMessage,
    receivedAtMs: number,
  ): Promise<boolean> {
    assertBusinessIdentity(identity);
    validateEvent(eventKey, receivedAtMs);
    validateMessage(message);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.claimEvent(identity, eventKey, receivedAtMs)) {
        this.db.exec('COMMIT');
        return false;
      }
      this.upsertOneMessage(identity, message);
      this.updateCoverage(identity, {
        source: 'meta-webhook', coveredFromMs: message.sentAtMs,
        coveredToMs: message.sentAtMs, lastSyncedAtMs: receivedAtMs, complete: false,
      });
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async ingestBusinessStatus(identity: HistoryIdentity, eventKey: string, status: BusinessDeliveryStatus, receivedAtMs: number): Promise<boolean> {
    assertBusinessIdentity(identity);
    validateEvent(eventKey, receivedAtMs);
    if (!status.messageId || !status.recipientId || !Number.isSafeInteger(status.timestampMs) || status.timestampMs < 0) {
      throw new TypeError('Invalid Business delivery status.');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.claimEvent(identity, eventKey, receivedAtMs)) {
        this.db.exec('COMMIT');
        return false;
      }
      const statusRank = ({ sent: 1, failed: 2, delivered: 3, read: 4 } as const)[status.status];
      this.db.prepare(`
        INSERT INTO business_delivery_status
          (account_id, adapter, message_id, recipient_id, status, status_rank, timestamp_ms, error_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, adapter, message_id, recipient_id) DO UPDATE SET
          status = excluded.status,
          status_rank = excluded.status_rank,
          timestamp_ms = excluded.timestamp_ms,
          error_code = excluded.error_code
        WHERE excluded.status_rank > business_delivery_status.status_rank
          OR (excluded.status_rank = business_delivery_status.status_rank
              AND excluded.timestamp_ms >= business_delivery_status.timestamp_ms)
      `).run(
        identity.accountId, identity.adapter, status.messageId, status.recipientId,
        status.status, statusRank, status.timestampMs, status.errorCode ?? null,
      );
      this.updateCoverage(identity, {
        source: 'meta-webhook-status', coveredFromMs: status.timestampMs,
        coveredToMs: status.timestampMs, lastSyncedAtMs: receivedAtMs, complete: false,
      });
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async getBusinessDeliveryStatus(identity: HistoryIdentity, messageId: string, recipientId: string): Promise<BusinessDeliveryStatus | undefined> {
    assertBusinessIdentity(identity);
    const row = this.db.prepare(`
      SELECT message_id, recipient_id, status, timestamp_ms, error_code
      FROM business_delivery_status
      WHERE account_id = ? AND adapter = ? AND message_id = ? AND recipient_id = ?
    `).get(identity.accountId, identity.adapter, messageId, recipientId) as {
      message_id: string; recipient_id: string; status: BusinessDeliveryStatus['status']; timestamp_ms: number; error_code: number | null;
    } | undefined;
    if (!row) return undefined;
    return {
      messageId: row.message_id,
      recipientId: row.recipient_id,
      status: row.status,
      timestampMs: row.timestamp_ms,
      ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
    };
  }

  private coverageFor(identity: HistoryIdentity): HistoryCoverage {
    const rows = this.db.prepare(`
      SELECT MIN(covered_from_ms) AS covered_from_ms,
        MAX(covered_to_ms) AS covered_to_ms,
        MAX(last_synced_at_ms) AS last_synced_at_ms,
        MIN(complete) AS complete,
        GROUP_CONCAT(source) AS sources
      FROM history_coverage WHERE account_id = ? AND adapter = ?
    `).get(identity.accountId, identity.adapter) as {
      covered_from_ms: number | null; covered_to_ms: number | null; last_synced_at_ms: number | null;
      complete: number | null; sources: string | null;
    };
    if (rows.covered_from_ms === null) {
      return {
        status: 'empty', complete: false, sources: [],
        note: 'No indexed history is available for this account.',
      };
    }
    return {
      status: 'available',
      complete: rows.complete === 1,
      coveredFromMs: rows.covered_from_ms,
      ...(rows.covered_to_ms !== null ? { coveredToMs: rows.covered_to_ms } : {}),
      ...(rows.last_synced_at_ms !== null ? { lastSyncedAtMs: rows.last_synced_at_ms } : {}),
      sources: rows.sources ? rows.sources.split(',') : [],
      note: rows.complete === 1
        ? 'Provider marked this imported range complete; this is not proof of full account history.'
        : 'Partial indexed coverage only; missing messages and unsynced ranges may exist.',
    };
  }

  private claimEvent(identity: HistoryIdentity, eventKey: string, receivedAtMs: number): boolean {
    const result = this.db.prepare(`
      INSERT INTO provider_event_receipts (account_id, adapter, event_key, received_at_ms)
      VALUES (?, ?, ?, ?) ON CONFLICT(account_id, adapter, event_key) DO NOTHING
    `).run(identity.accountId, identity.adapter, eventKey, receivedAtMs);
    return result.changes === 1;
  }

  private upsertOneMessage(identity: HistoryIdentity, message: IndexedMessage): void {
    const prior = this.db.prepare(`
      SELECT row_id FROM indexed_messages
      WHERE account_id = ? AND adapter = ? AND chat_id = ? AND message_id = ?
    `).get(identity.accountId, identity.adapter, message.chatId, message.messageId) as { row_id: number } | undefined;
    this.db.prepare(`
      INSERT INTO indexed_messages
          (account_id, adapter, chat_id, message_id, sender_id, sent_at_ms, body, from_me,
           provider_media_id, media_mime_type, media_file_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, adapter, chat_id, message_id) DO UPDATE SET
        sender_id = excluded.sender_id, sent_at_ms = excluded.sent_at_ms,
        body = excluded.body, from_me = excluded.from_me,
        provider_media_id = excluded.provider_media_id,
        media_mime_type = excluded.media_mime_type,
        media_file_name = excluded.media_file_name
    `).run(identity.accountId, identity.adapter, message.chatId, message.messageId,
      message.senderId, message.sentAtMs, message.body, message.fromMe ? 1 : 0,
      message.providerMediaId ?? null, message.mediaMimeType ?? null, message.mediaFileName ?? null);
    const row = this.db.prepare(`
      SELECT row_id FROM indexed_messages
      WHERE account_id = ? AND adapter = ? AND chat_id = ? AND message_id = ?
    `).get(identity.accountId, identity.adapter, message.chatId, message.messageId) as { row_id: number };
    if (prior) this.db.prepare('DELETE FROM indexed_messages_fts WHERE rowid = ?').run(prior.row_id);
    this.db.prepare(`
      INSERT INTO indexed_messages_fts
        (rowid, account_id, adapter, chat_id, message_id, sent_at_ms, body)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(row.row_id, identity.accountId, identity.adapter, message.chatId, message.messageId, message.sentAtMs, message.body);
  }

  private updateCoverage(identity: HistoryIdentity, coverage: HistoryCoverageInput): void {
    this.db.prepare(`
      INSERT INTO history_coverage
        (account_id, adapter, source, covered_from_ms, covered_to_ms, last_synced_at_ms, complete)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, adapter, source) DO UPDATE SET
        covered_from_ms = MIN(covered_from_ms, excluded.covered_from_ms),
        covered_to_ms = MAX(covered_to_ms, excluded.covered_to_ms),
        last_synced_at_ms = MAX(last_synced_at_ms, excluded.last_synced_at_ms),
        complete = MIN(complete, excluded.complete)
    `).run(identity.accountId, identity.adapter, coverage.source, coverage.coveredFromMs,
      coverage.coveredToMs, coverage.lastSyncedAtMs, coverage.complete ? 1 : 0);
  }

  close(): void {
    this.db.close();
  }
}

interface IndexedRow {
  chat_id: string;
  message_id: string;
  sender_id: string;
  sent_at_ms: number;
  body: string;
  from_me: number;
  provider_media_id?: string | null;
  media_mime_type?: string | null;
  media_file_name?: string | null;
}

function toUntrustedMessage(row: IndexedRow): IndexedMessage & { trust: 'untrusted_external_content' } {
  return {
    chatId: row.chat_id,
    messageId: row.message_id,
    senderId: row.sender_id,
    sentAtMs: row.sent_at_ms,
    body: row.body,
    fromMe: row.from_me === 1,
    ...(row.provider_media_id ? { providerMediaId: row.provider_media_id } : {}),
    ...(row.media_mime_type ? { mediaMimeType: row.media_mime_type } : {}),
    ...(row.media_file_name ? { mediaFileName: row.media_file_name } : {}),
    trust: 'untrusted_external_content',
  };
}

function validateMessage(message: IndexedMessage): void {
  if (!message.chatId || !message.messageId || !message.senderId) throw new TypeError('Message identifiers are required.');
  if (!Number.isSafeInteger(message.sentAtMs) || message.sentAtMs < 0) throw new TypeError('Invalid message timestamp.');
  if (message.body.length > 100_000) throw new RangeError('Message body exceeds index limit.');
  if (message.providerMediaId && message.providerMediaId.length > 256) throw new RangeError('Provider media ID exceeds index limit.');
  if (message.mediaMimeType && message.mediaMimeType.length > 128) throw new RangeError('Media MIME type exceeds index limit.');
  if (message.mediaFileName && message.mediaFileName.length > 128) throw new RangeError('Media file name exceeds index limit.');
}

function validateCoverage(coverage: HistoryCoverageInput): void {
  if (!coverage.source || coverage.source.length > 100) throw new TypeError('Invalid coverage source.');
  if (![coverage.coveredFromMs, coverage.coveredToMs, coverage.lastSyncedAtMs].every(Number.isSafeInteger)) {
    throw new TypeError('Coverage timestamps must be integers.');
  }
  if (coverage.coveredFromMs > coverage.coveredToMs) throw new RangeError('Coverage interval is reversed.');
}

function assertBusinessIdentity(identity: HistoryIdentity): void {
  if (identity.adapter !== 'business-graph' || !identity.accountId) {
    throw new TypeError('Business history requires a bound Graph account.');
  }
}

function validateEvent(eventKey: string, timestampMs: number): void {
  if (!eventKey || eventKey.length > 512 || /[\u0000-\u001f\u007f]/.test(eventKey)) {
    throw new TypeError('Invalid provider event key.');
  }
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) throw new TypeError('Invalid provider event timestamp.');
}

function toFtsPhrase(query: string): string {
  const phrase = query.replaceAll('"', '""');
  return `"${phrase}"`;
}

function encodeCursor(value: { sentAtMs: number; messageId: string }): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(value: string): { sentAtMs: number; messageId: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (!Number.isSafeInteger(parsed.sentAtMs) || typeof parsed.messageId !== 'string') throw new Error();
    return { sentAtMs: parsed.sentAtMs as number, messageId: parsed.messageId };
  } catch {
    throw new TypeError('Invalid history cursor.');
  }
}
