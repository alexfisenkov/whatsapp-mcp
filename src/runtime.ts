import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { McpAdapter, AdapterOperation } from './mcp-server.js';
import { createMetaCloudAdapter, type MetaCloudAdapterConfig } from './providers/graph/index.js';
import { createWahaPersonalAdapter, type WahaPersonalConfig } from './providers/waha/index.js';
import { ManagedMediaStore } from './media-store.js';
import { MutationCoordinator, type MutationCaller } from './mutations.js';
import { SqliteAuditStore } from './sqlite-audit.js';
import { SqliteHistoryStore } from './sqlite-history.js';
import { withHistoryTools } from './history-tools.js';
import { MetaWebhookProcessor } from './graph-webhook.js';
import type { HttpServerConfig, HealthReport, MetaWebhookConfig } from './http-server.js';

export interface ServiceRuntime {
  adapter: McpAdapter;
  caller: MutationCaller;
  configured: boolean;
  missingConfiguration: string[];
  profileId: string;
  releaseRevision: string;
  mutationCoordinator?: MutationCoordinator;
  mediaStore?: ManagedMediaStore;
  status(): HealthReport;
  httpConfig(): HttpServerConfig;
  close(): void;
}

export async function createServiceRuntime(
  env: NodeJS.ProcessEnv = process.env,
  mode: 'stdio' | 'http' = 'stdio',
): Promise<ServiceRuntime> {
  const declaredAdapter = env.WHATSAPP_ADAPTER;
  const adapterKind = declaredAdapter === 'business-graph' ? 'business-graph' : 'linked-device';
  const prefix = adapterKind === 'linked-device' ? 'personal' : 'business';
  const missing: string[] = [];
  if (declaredAdapter !== 'linked-device' && declaredAdapter !== 'business-graph') missing.push('WHATSAPP_ADAPTER');
  const stateDirectory = env.WHATSAPP_STATE_DIR ? resolve(env.WHATSAPP_STATE_DIR) : undefined;
  const historyPath = env.WHATSAPP_HISTORY_DB_PATH ?? (stateDirectory ? join(stateDirectory, 'history.sqlite') : undefined);
  const auditPath = env.WHATSAPP_AUDIT_DB_PATH ?? (stateDirectory ? join(stateDirectory, 'audit.sqlite') : undefined);
  const mediaDirectory = env.WHATSAPP_MEDIA_DIR ?? (stateDirectory ? join(stateDirectory, 'media') : undefined);
  const mediaStore = mediaDirectory ? createConfiguredMediaStore(mediaDirectory) : undefined;
  const historyStore = historyPath && isAbsolute(historyPath) ? new SqliteHistoryStore(historyPath) : undefined;
  if (!historyStore) missing.push('WHATSAPP_HISTORY_DB_PATH');

  const providerConfig = adapterKind === 'linked-device'
    ? readProviderConfig('linked-device', env, mediaStore, missing)
    : readProviderConfig('business-graph', env, mediaStore, missing);
  const requiredProviderVariables = adapterKind === 'linked-device'
    ? ['WHATSAPP_ACCOUNT_ID', 'WAHA_BASE_URL', 'WAHA_API_KEY', 'WAHA_SESSION_NAME']
    : ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID', 'WHATSAPP_GRAPH_ACCESS_TOKEN'];
  const providerConfigured = declaredAdapter === adapterKind
    && requiredProviderVariables.every((name) => !missing.includes(name));
  let adapter: McpAdapter;
  if (providerConfigured) {
    adapter = 'apiKey' in providerConfig
      ? createWahaPersonalAdapter(providerConfig)
      : createMetaCloudAdapter(providerConfig);
  } else {
    adapter = createUnconfiguredAdapter(adapterKind, missing);
  }

  if (historyStore) adapter = withHistoryTools(adapter, historyStore);
  const releaseRevision = resolveReleaseRevision(env);
  let auditStore: SqliteAuditStore | undefined;
  let mutationCoordinator: MutationCoordinator | undefined;
  if (providerConfigured && auditPath && isAbsolute(auditPath) && releaseRevision) {
    auditStore = new SqliteAuditStore(auditPath);
    await auditStore.recoverInFlight(Date.now());
    mutationCoordinator = new MutationCoordinator({ store: auditStore, releaseRevision });
  } else {
    if (providerConfigured) missing.push('WHATSAPP_AUDIT_DB_PATH');
    if (!releaseRevision) missing.push('WHATSAPP_RELEASE_REVISION');
    adapter = removeGuardedMutations(adapter);
  }

  const accountId = typeof providerConfig.accountId === 'string' ? providerConfig.accountId : 'unconfigured';
  const profileId = env.WHATSAPP_PROFILE_ID?.trim() || 'unconfigured';
  if (profileId === 'unconfigured') missing.push('WHATSAPP_PROFILE_ID');
  const callerId = env.WHATSAPP_CALLER_ID?.trim() || (adapterKind === 'linked-device' ? 'local-personal-owner' : 'local-business-owner');
  const caller: MutationCaller = { callerId, accountId, adapter: adapterKind };
  const serviceCredential = env.MCP_SERVICE_TOKEN;
  const serviceTokenHeader = normalizeHeaderName(env.MCP_SERVICE_TOKEN_HEADER ?? 'authorization');
  const resolveCaller = serviceCredential && serviceCredential.length >= 32
    ? async (request: import('node:http').IncomingMessage): Promise<MutationCaller | null> => {
      const supplied = request.headers[serviceTokenHeader];
      const raw = Array.isArray(supplied) ? supplied[0] : supplied;
      const candidate = serviceTokenHeader === 'authorization'
        ? (/^Bearer\s+([^\s]+)$/i.exec(raw ?? '')?.[1])
        : raw;
      if (!candidate || !constantTimeTokenEqual(candidate, serviceCredential)) return null;
      return caller;
    }
    : undefined;
  if (mode === 'http' && !resolveCaller) missing.push('MCP_SERVICE_TOKEN');
  const configured = providerConfigured && (mode !== 'http' || Boolean(resolveCaller));
  const status = (): HealthReport => ({
    adapter: adapterKind,
    profileId,
    releaseRevision: releaseRevision || 'unconfigured',
    configured,
    status: configured ? 'configured' : 'not_configured',
  });
  adapter = withRuntimeStatus(adapter, {
    adapter: adapterKind,
    profileId,
    configured: providerConfigured,
    httpAuthenticationReady: Boolean(resolveCaller),
    mutationEnabled: Boolean(mutationCoordinator),
    historyEnabled: Boolean(historyStore),
    mediaEnabled: Boolean(mediaStore),
    missingConfiguration: [...new Set(missing)],
    ...(releaseRevision ? { releaseRevision } : {}),
  });

  const metaWebhook = configured && adapterKind === 'business-graph' && historyStore
    && env.WHATSAPP_META_APP_SECRET && env.WHATSAPP_META_VERIFY_TOKEN && 'accessToken' in providerConfig
    ? makeMetaWebhookConfig(providerConfig, historyStore, env)
    : undefined;

  const httpConfig = (): HttpServerConfig => ({
    adapter,
    port: parsePort(env.MCP_PORT),
    listenHost: env.MCP_HOST ?? '127.0.0.1',
    allowedHosts: splitCsv(env.MCP_ALLOWED_HOSTS ?? 'localhost,127.0.0.1'),
    allowedOrigins: splitCsv(env.MCP_ALLOWED_ORIGINS ?? ''),
    ...(resolveCaller ? { resolveCaller } : {}),
    ...(mutationCoordinator ? { mutationCoordinator } : {}),
    health: async () => status(),
    ...(metaWebhook ? { metaWebhook } : {}),
    ...(mediaStore ? { mediaStore } : {}),
  });

  return {
    adapter,
    caller,
    configured,
    profileId,
    releaseRevision: releaseRevision || 'unconfigured',
    missingConfiguration: [...new Set(missing)],
    ...(mutationCoordinator ? { mutationCoordinator } : {}),
    ...(mediaStore ? { mediaStore } : {}),
    status,
    httpConfig,
    close() {
      historyStore?.close();
      auditStore?.close();
    },
  };
}

function resolveReleaseRevision(env: NodeJS.ProcessEnv): string {
  const markerPath = resolve(process.cwd(), '.whatsapp-release-sha');
  const marker = existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() : '';
  if (marker && !/^[a-f0-9]{40}$/i.test(marker)) throw new Error('Invalid .whatsapp-release-sha marker.');
  const configured = env.WHATSAPP_RELEASE_REVISION?.trim() ?? '';
  if (configured && !/^[a-f0-9]{40}$/i.test(configured)) throw new Error('WHATSAPP_RELEASE_REVISION must be a 40-character Git SHA.');
  if (marker && configured && marker.toLowerCase() !== configured.toLowerCase()) {
    throw new Error('Configured release SHA does not match the loaded release marker.');
  }
  const verified = marker || configured;
  if (verified) return verified.toLowerCase();
  return '';
}

function readProviderConfig(
  adapter: 'linked-device',
  env: NodeJS.ProcessEnv,
  mediaStore: ManagedMediaStore | undefined,
  missing: string[],
): WahaPersonalConfig;
function readProviderConfig(
  adapter: 'business-graph',
  env: NodeJS.ProcessEnv,
  mediaStore: ManagedMediaStore | undefined,
  missing: string[],
): MetaCloudAdapterConfig;
function readProviderConfig(
  adapter: 'linked-device' | 'business-graph',
  env: NodeJS.ProcessEnv,
  mediaStore: ManagedMediaStore | undefined,
  missing: string[],
): WahaPersonalConfig | MetaCloudAdapterConfig {
  if (adapter === 'linked-device') {
    const accountId = env.WHATSAPP_ACCOUNT_ID?.trim() ?? '';
    const baseUrl = env.WAHA_BASE_URL?.trim() ?? '';
    const apiKey = env.WAHA_API_KEY ?? '';
    const sessionName = env.WAHA_SESSION_NAME?.trim() ?? '';
    for (const [key, value] of Object.entries({
      WHATSAPP_ACCOUNT_ID: accountId,
      WAHA_BASE_URL: baseUrl,
      WAHA_API_KEY: apiKey,
      WAHA_SESSION_NAME: sessionName,
    })) if (!value) missing.push(key);
    return {
      accountId, baseUrl, apiKey, sessionName,
      ...(mediaStore ? { mediaStore } : {}),
      enableGroupAdministration: env.WAHA_ENABLE_GROUP_ADMIN === 'true',
      enableStatusPosting: env.WAHA_ENABLE_STATUS_POSTING === 'true',
    };
  }

  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim() ?? '';
  const businessAccountId = env.WHATSAPP_BUSINESS_ACCOUNT_ID?.trim() ?? '';
  const graphAccessCredential = env.WHATSAPP_GRAPH_ACCESS_TOKEN ?? '';
  for (const [key, value] of Object.entries({
    WHATSAPP_PHONE_NUMBER_ID: phoneNumberId,
    WHATSAPP_BUSINESS_ACCOUNT_ID: businessAccountId,
    WHATSAPP_GRAPH_ACCESS_TOKEN: graphAccessCredential,
  })) if (!value) missing.push(key);
  return {
    accountId: phoneNumberId,
    phoneNumberId,
    businessAccountId,
    accessToken: graphAccessCredential,
    graphApiVersion: env.WHATSAPP_GRAPH_API_VERSION ?? 'v24.0',
    enableAdminTools: env.WHATSAPP_GRAPH_ADMIN_TOOLS === 'true',
    ...(mediaStore ? { mediaStore } : {}),
  };
}

function createUnconfiguredAdapter(kind: 'linked-device' | 'business-graph', missing: string[]): McpAdapter {
  const prefix = kind === 'linked-device' ? 'personal' : 'business';
  const definition: AdapterOperation = {
    id: `${prefix}.system.configuration`,
    title: 'Read runtime configuration status',
    description: 'Report whether this isolated WhatsApp adapter has its required configuration; this does not claim an upstream connection.',
    kind: 'read',
    inputSchema: z.object({}),
  };
  return {
    kind,
    definitions: [definition],
    async authorize() {},
    async execute(operationId) {
      if (operationId !== definition.id) throw new Error('UNSUPPORTED');
      return { configured: false, status: 'not_configured', missingConfiguration: [...new Set(missing)] };
    },
  };
}

function withRuntimeStatus(adapter: McpAdapter, state: Record<string, unknown>): McpAdapter {
  const prefix = adapter.kind === 'linked-device' ? 'personal' : 'business';
  const id = `${prefix}.system.configuration`;
  if (adapter.definitions.some((definition) => definition.id === id)) return adapter;
  const definition: AdapterOperation = {
    id,
    title: 'Read runtime configuration status',
    description: 'Report configuration flags and known runtime limits; it does not perform a WhatsApp connection check.',
    kind: 'read',
    inputSchema: z.object({}),
  };
  return {
    ...adapter,
    definitions: [...adapter.definitions, definition],
    async execute(operationId, input, caller) {
      if (operationId === id) return { ...state };
      return adapter.execute(operationId, input, caller);
    },
  };
}

function removeGuardedMutations(adapter: McpAdapter): McpAdapter {
  const readOnlyIds = new Set(adapter.definitions.filter(({ kind }) => kind === 'read').map(({ id }) => id));
  return {
    ...adapter,
    definitions: adapter.definitions.filter(({ kind }) => kind === 'read'),
    async execute(operationId, input, caller) {
      if (!readOnlyIds.has(operationId)) throw new Error('UNSUPPORTED');
      return adapter.execute(operationId, input, caller);
    },
  };
}

function createConfiguredMediaStore(directory: string): ManagedMediaStore {
  const path = resolve(directory);
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error('WHATSAPP_MEDIA_DIR must be private (mode 0700).');
  return new ManagedMediaStore(path);
}

function makeMetaWebhookConfig(provider: MetaCloudAdapterConfig, store: SqliteHistoryStore, env: NodeJS.ProcessEnv): MetaWebhookConfig {
  const processor = new MetaWebhookProcessor({
    accountId: provider.accountId,
    phoneNumberId: provider.phoneNumberId,
    businessAccountId: provider.businessAccountId,
    store,
  });
  return {
    appSignatureKey: env.WHATSAPP_META_APP_SECRET!,
    challengeVerifier: env.WHATSAPP_META_VERIFY_TOKEN!,
    async process(payload) { await processor.process(payload); },
  };
}

function constantTimeTokenEqual(left: string, right: string): boolean {
  const a = createHmac('sha256', 'whatsapp-mcp-service-token').update(left).digest();
  const b = createHmac('sha256', 'whatsapp-mcp-service-token').update(right).digest();
  return timingSafeEqual(a, b);
}

function normalizeHeaderName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized !== 'authorization' && !/^x-[a-z0-9-]{1,60}$/.test(normalized)) {
    throw new TypeError('MCP_SERVICE_TOKEN_HEADER must be Authorization or an X- header name.');
  }
  return normalized;
}

function splitCsv(value: string): string[] {
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

function parsePort(value: string | undefined): number {
  const port = value ? Number(value) : 8857;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new RangeError('MCP_PORT must be 1-65535.');
  return port;
}
