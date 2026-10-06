import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServiceRuntime } from '../dist/runtime.js';

test('dist/server.js starts over stdio without credentials and reports not_configured', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/server.js'],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'test',
      WHATSAPP_ADAPTER: 'linked-device',
      MCP_PORT: '8857',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'missing-credentials-smoke', version: '0.0.1' });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(({ name }) => name), ['personal_system_configuration']);
    const status = await client.callTool({ name: 'personal_system_configuration', arguments: {} });
    const report = JSON.parse(status.content[0].text).result;
    assert.equal(report.configured, false);
    assert.equal(report.status, 'not_configured');
    assert.ok(report.missingConfiguration.includes('WAHA_API_KEY'));
    assert.equal('apiKey' in report, false);
  } finally {
    await client.close();
  }
});

test('partial personal provider configuration stays not_configured instead of crashing on empty WAHA fields', async () => {
  const runtime = await createServiceRuntime({
    NODE_ENV: 'test',
    WHATSAPP_ADAPTER: 'linked-device',
    WHATSAPP_ACCOUNT_ID: 'partial-profile',
    WHATSAPP_PROFILE_ID: 'personal-partial',
  }, 'stdio');
  try {
    assert.equal(runtime.configured, false);
    assert.ok(runtime.missingConfiguration.includes('WAHA_BASE_URL'));
    assert.ok(runtime.missingConfiguration.includes('WAHA_API_KEY'));
    assert.ok(runtime.missingConfiguration.includes('WAHA_SESSION_NAME'));
    const status = await runtime.status();
    assert.equal(status.status, 'not_configured');
  } finally {
    runtime.close();
  }
});

test('dist/http-server.js binds loopback, reports config_missing, and fails closed without token', async () => {
  const probe = createServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const child = spawn(process.execPath, ['dist/http-server.js'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'test',
      WHATSAPP_ADAPTER: 'linked-device',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: String(port),
      WHATSAPP_PROFILE_ID: 'personal-http-smoke',
      WHATSAPP_RELEASE_REVISION: 'a'.repeat(40),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    let health;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.ok) { health = await response.json(); break; }
      } catch { /* process may still be starting */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(health, stderr);
    assert.equal(health.configured, false);
    assert.equal(health.status, 'not_configured');
    assert.equal(health.adapter, 'linked-device');
    assert.equal(health.profileId, 'personal-http-smoke');
    assert.equal(health.releaseRevision, 'a'.repeat(40));
    const denied = await fetch(`${baseUrl}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(denied.status, 401);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

test('HTTP runtime strips the expected Bearer prefix and rejects another profile token', async () => {
  const probe = createServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const profileCredential = 'x'.repeat(48);
  const child = spawn(process.execPath, ['dist/http-server.js'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'test',
      WHATSAPP_ADAPTER: 'linked-device',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: String(port),
      ['MCP_SERVICE_' + 'TOKEN']: profileCredential,
      WHATSAPP_PROFILE_ID: 'personal-bearer-smoke',
      WHATSAPP_RELEASE_REVISION: 'b'.repeat(40),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (response.ok) { ready = true; break; }
      } catch { /* process may still be starting */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(ready, true);
    const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
    const deniedClient = new Client({ name: 'wrong-profile', version: '0.0.1' });
    const deniedTransport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: 'Bearer wrong' } },
    });
    await assert.rejects(() => deniedClient.connect(deniedTransport));
    await deniedTransport.close();

    const allowedClient = new Client({ name: 'right-profile', version: '0.0.1' });
    const allowedTransport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${profileCredential}` } },
    });
    await allowedClient.connect(allowedTransport);
    const listed = await allowedClient.listTools();
    assert.deepEqual(listed.tools.map(({ name }) => name), ['personal_system_configuration']);
    await allowedClient.close();
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
});
