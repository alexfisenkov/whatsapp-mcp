import { mkdtempSync, chmodSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createWahaPersonalAdapter } from '../dist/providers/waha/index.js';
import { createMetaCloudAdapter } from '../dist/providers/graph/index.js';
import { SqliteHistoryStore } from '../dist/sqlite-history.js';
import { withHistoryTools } from '../dist/history-tools.js';

const temporaryRoot = mkdtempSync(join(tmpdir(), 'whatsapp-mcp-capability-manifest-'));
chmodSync(temporaryRoot, 0o700);

try {
  const history = new SqliteHistoryStore(join(temporaryRoot, 'history.sqlite'));
  const mediaStore = { async read() { throw new Error('Manifest generation never reads media.'); } };
  const personalConfig = {
    accountId: 'manifest-personal',
    baseUrl: 'http://127.0.0.1:8859',
    apiKey: 'manifest-placeholder-not-a-credential',
    sessionName: 'manifest_only',
    mediaStore,
  };
  const businessConfig = {
    accountId: 'manifest-phone',
    phoneNumberId: 'manifest-phone',
    businessAccountId: 'manifest-waba',
    accessToken: 'manifest-placeholder-not-a-credential',
    graphApiVersion: 'v24.0',
    mediaStore,
  };
  const personalDefault = withHistoryTools(createWahaPersonalAdapter(personalConfig), history);
  const personalExpanded = withHistoryTools(createWahaPersonalAdapter({
    ...personalConfig, enableGroupAdministration: true, enableStatusPosting: true,
  }), history);
  const businessDefault = withHistoryTools(createMetaCloudAdapter(businessConfig), history);
  const businessExpanded = withHistoryTools(createMetaCloudAdapter({ ...businessConfig, enableAdminTools: true }), history);

  const profile = (defaultAdapter, expandedAdapter) => {
    const defaults = new Map(defaultAdapter.definitions.map((item) => [item.id, item]));
    const expanded = new Map(expandedAdapter.definitions.map((item) => [item.id, item]));
    return {
      default: [...defaults.values()].map(project),
      conditional: [...expanded.values()].filter((item) => !defaults.has(item.id)).map(project),
    };
  };
  const output = {
    generator: 'scripts/generate-capabilities.mjs',
    note: 'Generated from adapter operation definitions. Conditional tools appear only when their documented runtime flag is enabled. No WhatsApp/Meta API request is made.',
    profiles: {
      personal: profile(personalDefault, personalExpanded),
      business: profile(businessDefault, businessExpanded),
    },
  };
  const destination = resolve('docs/Матрица-возможностей.json');
  writeFileSync(destination, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`Wrote ${destination}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function project(operation) {
  return {
    id: operation.id,
    title: operation.title,
    kind: operation.kind,
    description: operation.description,
  };
}
