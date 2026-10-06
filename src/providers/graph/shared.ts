import type { ManagedMediaStore } from '../../media-store.js';
import { BoundedJsonClient, encodePathSegment, type ProviderRuntimeOptions } from '../common.js';

export interface MetaGraphConfig extends ProviderRuntimeOptions {
  accountId: string;
  phoneNumberId: string;
  businessAccountId: string;
  accessToken: string;
  graphApiVersion?: string;
  enableAdminTools?: boolean;
  mediaStore?: ManagedMediaStore;
}

export interface GraphContext {
  config: MetaGraphConfig;
  client: BoundedJsonClient;
  mediaStore?: ManagedMediaStore;
}

export function validateGraphConfig(config: MetaGraphConfig): string {
  for (const [name, value] of Object.entries({
    accountId: config.accountId,
    phoneNumberId: config.phoneNumberId,
    businessAccountId: config.businessAccountId,
  })) {
    if (!value || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError(`${name} is invalid.`);
  }
  if (!config.accessToken || config.accessToken.length > 16_384 || /[\r\n]/.test(config.accessToken)) {
    throw new TypeError('Meta access token is invalid.');
  }
  const version = config.graphApiVersion ?? 'v24.0';
  if (!/^v\d+\.\d+$/.test(version)) throw new TypeError('Graph API version must use the vN.N format.');
  return version;
}

export function graphPath(context: GraphContext, path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) throw new TypeError('Invalid fixed Graph path.');
  return `/${context.config.graphApiVersion ?? 'v24.0'}${path}`;
}

export function graphIdSegment(id: string): string {
  return encodePathSegment(id);
}

export function projectGraphObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Provider response schema mismatch.');
  const source = value as Record<string, unknown>;
  const result = Object.fromEntries(allowed.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
  if (Object.keys(result).length === 0) throw new Error('Provider response schema mismatch.');
  return result;
}

export function projectGraphPage(value: unknown, project: (item: unknown) => Record<string, unknown>) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Provider response schema mismatch.');
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.data)) throw new Error('Provider response schema mismatch.');
  const paging = source.paging && typeof source.paging === 'object' ? source.paging as Record<string, unknown> : {};
  const cursors = paging.cursors && typeof paging.cursors === 'object' ? paging.cursors as Record<string, unknown> : {};
  return {
    items: source.data.map(project),
    nextCursor: typeof cursors.after === 'string' ? cursors.after : undefined,
    hasNextPage: typeof paging.next === 'string',
  };
}

export function projectSentMessage(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Provider response schema mismatch.');
  const source = value as Record<string, unknown>;
  const messages = source.messages;
  if (!Array.isArray(messages) || !messages[0] || typeof messages[0] !== 'object') throw new Error('Provider response schema mismatch.');
  const id = (messages[0] as Record<string, unknown>).id;
  if (typeof id !== 'string' || id.length > 256) throw new Error('Provider response schema mismatch.');
  const contacts = Array.isArray(source.contacts) ? source.contacts : [];
  const contact = contacts[0] && typeof contacts[0] === 'object' ? contacts[0] as Record<string, unknown> : {};
  return {
    messageId: id,
    recipient: typeof contact.wa_id === 'string' ? contact.wa_id : undefined,
    outcome: 'accepted_by_meta; delivery_status_may_arrive_later',
  };
}
