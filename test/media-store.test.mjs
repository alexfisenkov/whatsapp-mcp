import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedMediaStore } from '../dist/media-store.js';

function makeDir() {
  const path = mkdtempSync(join(tmpdir(), 'wa-mcp-media-'));
  chmodSync(path, 0o700);
  return path;
}

test('stores and retrieves media by opaque ID without exposing a filesystem path', async () => {
  const root = makeDir();
  try {
    const store = new ManagedMediaStore(root);
    const created = await store.save({ bytes: Buffer.from('file content'), mimeType: 'text/plain', fileName: 'invoice.txt' });
    assert.match(created.id, /^[0-9a-f-]{36}$/i);
    assert.equal('path' in created, false);
    const read = await store.read(created.id, { maxBytes: 100, allowedMimeTypes: ['text/plain'] });
    assert.equal(read.bytes.toString(), 'file content');
    assert.equal(read.fileName, 'invoice.txt');
    assert.equal(read.size, 12);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects oversized data, disallowed mime types, and traversal IDs', async () => {
  const root = makeDir();
  try {
    const store = new ManagedMediaStore(root);
    await assert.rejects(() => store.save({ bytes: Buffer.alloc(20), mimeType: 'application/x-executable', fileName: 'x.exe', maxBytes: 10 }), /mime|size/i);
    const item = await store.save({ bytes: Buffer.from('safe'), mimeType: 'text/plain', fileName: 'safe.txt' });
    await assert.rejects(() => store.read(item.id, { maxBytes: 1, allowedMimeTypes: ['text/plain'] }), /size/i);
    await assert.rejects(() => store.read('../escape', { maxBytes: 10, allowedMimeTypes: ['text/plain'] }), /id/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses symlink roots and symlink media files', async () => {
  const root = makeDir();
  const outside = makeDir();
  const alias = join(root, 'alias');
  try {
    symlinkSync(outside, alias);
    assert.throws(() => new ManagedMediaStore(alias), /symlink/i);
    const store = new ManagedMediaStore(root);
    const item = await store.save({ bytes: Buffer.from('original'), mimeType: 'text/plain', fileName: 'item.txt' });
    const target = join(root, `${item.id}.bin`);
    rmSync(target);
    writeFileSync(join(outside, 'outside.bin'), 'private outside');
    symlinkSync(join(outside, 'outside.bin'), target);
    await assert.rejects(() => store.read(item.id, { maxBytes: 100, allowedMimeTypes: ['text/plain'] }), /symlink/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('detects changed media bytes by SHA-256 before returning content', async () => {
  const root = makeDir();
  try {
    const store = new ManagedMediaStore(root);
    const item = await store.save({ bytes: Buffer.from('original'), mimeType: 'text/plain', fileName: 'item.txt' });
    writeFileSync(join(root, `${item.id}.bin`), 'tampered');
    await assert.rejects(() => store.read(item.id, { maxBytes: 100, allowedMimeTypes: ['text/plain'] }), /integrity/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
