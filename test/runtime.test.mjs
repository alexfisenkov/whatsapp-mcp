import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../dist/http-server.js';
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

test('configured runtimes start both adapters and serve authenticated media resources', async () => {
  const profiles = [
    {
      adapter: 'linked-device',
      prefix: 'personal',
      profileId: 'synthetic-personal-profile',
      provider: {
        WHATSAPP_ACCOUNT_ID: 'synthetic-personal-account',
        WAHA_BASE_URL: 'http://127.0.0.1:8859',
        WAHA_API_KEY: 'dummy-waha-api-key',
        WAHA_SESSION_NAME: 'synthetic-session',
      },
    },
    {
      adapter: 'business-graph',
      prefix: 'business',
      profileId: 'synthetic-business-profile',
      provider: {
        WHATSAPP_PHONE_NUMBER_ID: '1234567890',
        WHATSAPP_BUSINESS_ACCOUNT_ID: '9876543210',
        WHATSAPP_GRAPH_ACCESS_TOKEN: 'dummy-graph-access-token',
      },
    },
  ];

  for (const profile of profiles) {
    const stateDirectory = mkdtempSync(join(tmpdir(), `wa-configured-${profile.prefix}-`));
    chmodSync(stateDirectory, 0o700);
    const token = 'dummy-service-token-'.padEnd(48, 'x');
    const revision = 'c'.repeat(40);
    const runtime = await createServiceRuntime({
      NODE_ENV: 'test',
      WHATSAPP_ADAPTER: profile.adapter,
      WHATSAPP_PROFILE_ID: profile.profileId,
      WHATSAPP_STATE_DIR: stateDirectory,
      WHATSAPP_RELEASE_REVISION: revision,
      MCP_SERVICE_TOKEN: token,
      MCP_HOST: '127.0.0.1',
      ...profile.provider,
    }, 'http');
    const server = createHttpServer({ ...runtime.httpConfig(), port: 0 });
    const headers = { authorization: `Bearer ${token}` };
    let client;
    try {
      assert.equal(runtime.configured, true);
      await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const response = await fetch(`${baseUrl}/health`);
      assert.equal(response.status, 200);
      const health = await response.json();
      assert.deepEqual(health, {
        adapter: profile.adapter,
        profileId: profile.profileId,
        releaseRevision: revision,
        configured: true,
        status: 'configured',
      });

      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers },
      });
      client = new Client({ name: `configured-${profile.prefix}-smoke`, version: '0.0.1' });
      await client.connect(transport);
      const listed = await client.listTools();
      assert.ok(listed.tools.some(({ name }) => name.startsWith(`${profile.prefix}_`)));

      const uploaded = await fetch(`${baseUrl}/media`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'text/plain', 'x-file-name': 'startup-fixture.txt' },
        body: `configured ${profile.prefix} resource fixture`,
      });
      const uploadBody = await uploaded.json();
      assert.equal(uploaded.status, 201, JSON.stringify(uploadBody));
      const { mediaId } = uploadBody;
      const resource = await client.readResource({ uri: `whatsapp-media://${mediaId}` });
      assert.equal(Buffer.from(resource.contents[0].blob, 'base64').toString(), `configured ${profile.prefix} resource fixture`);
    } finally {
      if (client) await client.close();
      await new Promise((resolve) => server.close(resolve));
      runtime.close();
      rmSync(stateDirectory, { recursive: true, force: true });
    }
  }
});

test('configured HTTP and stdio entrypoints launch through a current release symlink', async () => {
  const aliasRoot = mkdtempSync(join(tmpdir(), 'wa-release-alias-'));
  chmodSync(aliasRoot, 0o700);
  const currentPath = join(aliasRoot, 'current');
  symlinkSync(process.cwd(), currentPath, 'dir');
  const revision = 'd'.repeat(40);
  const httpState = mkdtempSync(join(tmpdir(), 'wa-symlink-http-state-'));
  const stdioState = mkdtempSync(join(tmpdir(), 'wa-symlink-stdio-state-'));
  chmodSync(httpState, 0o700);
  chmodSync(stdioState, 0o700);
  const httpProbe = createServer();
  await new Promise((resolve, reject) => httpProbe.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const httpPort = httpProbe.address().port;
  await new Promise((resolve) => httpProbe.close(resolve));
  const token = 'dummy-service-token-'.padEnd(48, 'x');

  const httpChild = spawn(process.execPath, [join(currentPath, 'dist/http-server.js')], {
    cwd: currentPath,
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'test',
      WHATSAPP_ADAPTER: 'linked-device',
      WHATSAPP_ACCOUNT_ID: 'symlink-personal-account',
      WAHA_BASE_URL: 'http://127.0.0.1:8859',
      WAHA_API_KEY: 'dummy-waha-api-key',
      WAHA_SESSION_NAME: 'symlink-session',
      WHATSAPP_PROFILE_ID: 'symlink-personal',
      WHATSAPP_STATE_DIR: httpState,
      WHATSAPP_RELEASE_REVISION: revision,
      MCP_SERVICE_TOKEN: token,
      MCP_HOST: '127.0.0.1',
      MCP_PORT: String(httpPort),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let httpStderr = '';
  httpChild.stderr.setEncoding('utf8');
  httpChild.stderr.on('data', (chunk) => { httpStderr += chunk; });
  let httpClient;
  let stdioClient;
  try {
    let health;
    for (let attempt = 0; attempt < 100 && httpChild.exitCode === null; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${httpPort}/health`);
        if (response.ok) { health = await response.json(); break; }
      } catch { /* process may still be starting */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(httpChild.exitCode, null, httpStderr);
    assert.equal(health?.adapter, 'linked-device', httpStderr);
    assert.equal(health?.configured, true);
    httpClient = new Client({ name: 'symlink-http-smoke', version: '0.0.1' });
    const httpTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpPort}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await httpClient.connect(httpTransport);
    assert.ok((await httpClient.listTools()).tools.some(({ name }) => name.startsWith('personal_')));

    const stdioTransport = new StdioClientTransport({
      command: process.execPath,
      args: [join(currentPath, 'dist/server.js')],
      cwd: currentPath,
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'test',
        WHATSAPP_ADAPTER: 'business-graph',
        WHATSAPP_PHONE_NUMBER_ID: '1234567890',
        WHATSAPP_BUSINESS_ACCOUNT_ID: '9876543210',
        WHATSAPP_GRAPH_ACCESS_TOKEN: 'dummy-graph-access-token',
        WHATSAPP_PROFILE_ID: 'symlink-business',
        WHATSAPP_STATE_DIR: stdioState,
        WHATSAPP_RELEASE_REVISION: revision,
      },
      stderr: 'pipe',
    });
    stdioClient = new Client({ name: 'symlink-stdio-smoke', version: '0.0.1' });
    await stdioClient.connect(stdioTransport);
    assert.ok((await stdioClient.listTools()).tools.some(({ name }) => name.startsWith('business_')));
  } finally {
    if (stdioClient) await stdioClient.close();
    if (httpClient) await httpClient.close();
    if (httpChild.exitCode === null) {
      await new Promise((resolve) => {
        httpChild.once('exit', resolve);
        httpChild.kill('SIGTERM');
      });
    }
    rmSync(httpState, { recursive: true, force: true });
    rmSync(stdioState, { recursive: true, force: true });
    rmSync(aliasRoot, { recursive: true, force: true });
  }
});
