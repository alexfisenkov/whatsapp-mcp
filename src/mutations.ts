import { createHash, randomUUID } from 'node:crypto';
import type { AdapterKind } from './capabilities.js';

export interface MutationCaller {
  callerId: string;
  accountId: string;
  adapter: AdapterKind;
}

export type MutationStatus = 'prepared' | 'executing' | 'succeeded' | 'OUTCOME_UNKNOWN';

export interface MutationAuditRecord {
  id: string;
  idempotencyKey: string;
  callerId: string;
  accountId: string;
  adapter: AdapterKind;
  releaseRevision: string;
  operationId: string;
  inputDigest: string;
  status: MutationStatus;
  createdAt: number;
  expiresAt: number;
  outcome?: MutationOutcome;
}

export interface MutationOutcome {
  status: 'succeeded' | 'OUTCOME_UNKNOWN';
  result?: unknown;
}

export type MutationClaim =
  | { kind: 'claimed'; record: MutationAuditRecord }
  | { kind: 'rejected' };

/**
 * Production implementations must be durable. `claim` must atomically bind
 * caller/account/adapter, check expiry and transition prepared -> executing so
 * two workers can never execute the same approval concurrently.
 */
export interface MutationAuditStore {
  insertPrepared(record: MutationAuditRecord): Promise<void>;
  get(id: string): Promise<MutationAuditRecord | undefined>;
  claim(id: string, caller: MutationCaller, now: number, releaseRevision: string): Promise<MutationClaim>;
  complete(id: string, outcome: MutationOutcome): Promise<void>;
  recoverInFlight(now: number): Promise<number>;
}

export class InvalidApprovalError extends Error {
  constructor() {
    super('Approval is invalid, expired, or bound to a different operation.');
    this.name = 'InvalidApprovalError';
  }
}

export interface MutationCoordinatorOptions {
  store: MutationAuditStore;
  releaseRevision: string;
  now?: () => number;
  approvalTtlMs?: number;
}

export class MutationCoordinator {
  private readonly store: MutationAuditStore;
  private readonly now: () => number;
  private readonly approvalTtlMs: number;
  private readonly releaseRevision: string;

  constructor(options: MutationCoordinatorOptions) {
    this.store = options.store;
    if (!options.releaseRevision.trim() || options.releaseRevision.length > 128) {
      throw new TypeError('releaseRevision is required and must be at most 128 characters.');
    }
    this.releaseRevision = options.releaseRevision;
    this.now = options.now ?? Date.now;
    this.approvalTtlMs = options.approvalTtlMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.approvalTtlMs) || this.approvalTtlMs <= 0) {
      throw new RangeError('approvalTtlMs must be a positive safe integer.');
    }
  }

  async prepare(input: {
    caller: MutationCaller;
    operationId: string;
    input: unknown;
  }): Promise<MutationAuditRecord> {
    const createdAt = this.now();
    const record: MutationAuditRecord = {
      id: randomUUID(),
      idempotencyKey: randomUUID(),
      callerId: input.caller.callerId,
      accountId: input.caller.accountId,
      adapter: input.caller.adapter,
      releaseRevision: this.releaseRevision,
      operationId: input.operationId,
      inputDigest: digestCanonicalJson(input.input),
      status: 'prepared',
      createdAt,
      expiresAt: createdAt + this.approvalTtlMs,
    };
    await this.store.insertPrepared(record);
    return record;
  }

  async confirm<T>(input: {
    caller: MutationCaller;
    approvalId: string;
    inputDigest: string;
    operationId: string;
    input: unknown;
    execute: () => Promise<T>;
  }): Promise<MutationOutcome> {
    const existing = await this.store.get(input.approvalId);
    if (!existing || !sameCaller(existing, input.caller)
      || existing.inputDigest !== input.inputDigest
      || existing.inputDigest !== digestCanonicalJson(input.input)
      || existing.operationId !== input.operationId
      || existing.releaseRevision !== this.releaseRevision) {
      throw new InvalidApprovalError();
    }
    if (existing.status === 'succeeded' || existing.status === 'OUTCOME_UNKNOWN') {
      return existing.outcome ?? { status: existing.status };
    }
    if (existing.status !== 'prepared') {
      return { status: 'OUTCOME_UNKNOWN' };
    }

    const claim = await this.store.claim(input.approvalId, input.caller, this.now(), this.releaseRevision);
    if (claim.kind !== 'claimed') throw new InvalidApprovalError();

    try {
      const result = await input.execute();
      const outcome: MutationOutcome = { status: 'succeeded', result };
      await this.store.complete(input.approvalId, outcome);
      return outcome;
    } catch {
      // A transport error does not establish whether WhatsApp applied the write.
      // Persist the ambiguity and never retry the provider call automatically.
      const outcome: MutationOutcome = { status: 'OUTCOME_UNKNOWN' };
      await this.store.complete(input.approvalId, outcome);
      return outcome;
    }
  }
}

function sameCaller(record: MutationAuditRecord, caller: MutationCaller): boolean {
  return record.callerId === caller.callerId
    && record.accountId === caller.accountId
    && record.adapter === caller.adapter;
}

function digestCanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('Mutation input must be JSON serializable.');
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(',')}}`;
}
