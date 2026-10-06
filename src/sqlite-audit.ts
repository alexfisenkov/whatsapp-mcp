import { DatabaseSync } from 'node:sqlite';
import { openPrivateDatabase } from './sqlite.js';
import type {
  MutationAuditRecord,
  MutationAuditStore,
  MutationCaller,
  MutationClaim,
  MutationOutcome,
} from './mutations.js';

/** One private database per adapter instance; never share personal and Business data. */
export class SqliteAuditStore implements MutationAuditStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    this.db = openPrivateDatabase(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS mutation_records (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        caller_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        adapter TEXT NOT NULL,
        release_revision TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        input_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mutation_audit_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        approval_id TEXT NOT NULL REFERENCES mutation_records(id),
        event_type TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        outcome_status TEXT
      );
      CREATE INDEX IF NOT EXISTS mutation_audit_events_approval_idx
        ON mutation_audit_events(approval_id, event_id);
    `);
  }

  async insertPrepared(record: MutationAuditRecord): Promise<void> {
    if (record.status !== 'prepared') throw new Error('Only prepared records can be inserted.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO mutation_records
          (id, idempotency_key, caller_id, account_id, adapter, release_revision, operation_id,
           input_digest, status, created_at, expires_at, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id, record.idempotencyKey, record.callerId, record.accountId, record.adapter,
        record.releaseRevision, record.operationId, record.inputDigest, record.status, record.createdAt,
        record.expiresAt, JSON.stringify(record),
      );
      this.db.prepare(`
        INSERT INTO mutation_audit_events (approval_id, event_type, occurred_at)
        VALUES (?, 'prepared', ?)
      `).run(record.id, record.createdAt);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async get(id: string): Promise<MutationAuditRecord | undefined> {
    const row = this.db.prepare('SELECT record_json FROM mutation_records WHERE id = ?').get(id) as
      | { record_json: string }
      | undefined;
    return row ? JSON.parse(row.record_json) as MutationAuditRecord : undefined;
  }

  async claim(id: string, caller: MutationCaller, now: number, releaseRevision: string): Promise<MutationClaim> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`
        SELECT record_json FROM mutation_records
        WHERE id = ? AND caller_id = ? AND account_id = ? AND adapter = ?
          AND release_revision = ? AND status = 'prepared' AND expires_at > ?
      `).get(id, caller.callerId, caller.accountId, caller.adapter, releaseRevision, now) as
        | { record_json: string }
        | undefined;
      if (!row) {
        this.db.exec('ROLLBACK');
        return { kind: 'rejected' };
      }
      const record = JSON.parse(row.record_json) as MutationAuditRecord;
      record.status = 'executing';
      this.db.prepare(`
        UPDATE mutation_records SET status = 'executing', record_json = ?
        WHERE id = ? AND status = 'prepared'
      `).run(JSON.stringify(record), id);
      this.db.prepare(`
        INSERT INTO mutation_audit_events (approval_id, event_type, occurred_at)
        VALUES (?, 'execution_claimed', ?)
      `).run(id, now);
      this.db.exec('COMMIT');
      return { kind: 'claimed', record };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async complete(id: string, outcome: MutationOutcome): Promise<void> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`
        SELECT record_json FROM mutation_records WHERE id = ? AND status = 'executing'
      `).get(id) as { record_json: string } | undefined;
      if (!row) throw new Error('Mutation is not in executing state.');
      const record = JSON.parse(row.record_json) as MutationAuditRecord;
      record.status = outcome.status;
      record.outcome = outcome;
      this.db.prepare(`
        UPDATE mutation_records SET status = ?, record_json = ?
        WHERE id = ? AND status = 'executing'
      `).run(outcome.status, JSON.stringify(record), id);
      this.db.prepare(`
        INSERT INTO mutation_audit_events (approval_id, event_type, occurred_at, outcome_status)
        VALUES (?, 'completed', ?, ?)
      `).run(id, Date.now(), outcome.status);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async recoverInFlight(now: number): Promise<number> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare(`
        SELECT id, record_json FROM mutation_records WHERE status = 'executing'
      `).all() as Array<{ id: string; record_json: string }>;
      const update = this.db.prepare(`
        UPDATE mutation_records SET status = 'OUTCOME_UNKNOWN', record_json = ?
        WHERE id = ? AND status = 'executing'
      `);
      const audit = this.db.prepare(`
        INSERT INTO mutation_audit_events (approval_id, event_type, occurred_at, outcome_status)
        VALUES (?, 'recovered_after_restart', ?, 'OUTCOME_UNKNOWN')
      `);
      for (const row of rows) {
        const record = JSON.parse(row.record_json) as MutationAuditRecord;
        record.status = 'OUTCOME_UNKNOWN';
        record.outcome = { status: 'OUTCOME_UNKNOWN' };
        update.run(JSON.stringify(record), row.id);
        audit.run(row.id, now);
      }
      this.db.exec('COMMIT');
      return rows.length;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
