import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMcpServer } from './mcp-server.js';
import { createServiceRuntime } from './runtime.js';

async function main(): Promise<void> {
  const runtime = await createServiceRuntime();
  const server = createMcpServer(runtime.adapter, () => runtime.caller, {
    ...(runtime.mutationCoordinator ? { mutationCoordinator: runtime.mutationCoordinator } : {}),
    ...(runtime.mediaStore ? { mediaStore: runtime.mediaStore } : {}),
  });
  const transport = new StdioServerTransport();
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await server.close(); } catch { /* transport may already be closed */ }
    runtime.close();
  };
  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
  await server.connect(transport);
}

if (isMainEntrypoint(import.meta.url, process.argv[1])) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Startup failed.';
    process.stderr.write(`WhatsApp MCP startup failed: ${message}\n`);
    process.exitCode = 1;
  });
}

function isMainEntrypoint(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}
