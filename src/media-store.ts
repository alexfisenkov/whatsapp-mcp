import {
  chmodSync, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  statSync, unlinkSync, writeSync, constants as fsConstants,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_ALLOWED_BYTES = 25 * 1024 * 1024;
const MEDIA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MANAGED_MEDIA_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/aac',
  'video/mp4', 'video/webm',
  'application/pdf', 'application/zip', 'text/plain',
] as const;
const ALLOWED_MIME_TYPES = new Set<string>(MANAGED_MEDIA_MIME_TYPES);

export interface ManagedMedia {
  id: string;
  mimeType: string;
  fileName: string;
  size: number;
  sha256: string;
}

export interface ManagedMediaContent extends ManagedMedia {
  bytes: Buffer;
}

export class ManagedMediaStore {
  private readonly root: string;

  constructor(rootDirectory: string) {
    this.root = resolve(rootDirectory);
    if (lstatSync(this.root).isSymbolicLink()) throw new Error('Media root must not be a symlink.');
    const rootStat = statSync(this.root);
    if (!rootStat.isDirectory() || (rootStat.mode & 0o077) !== 0) {
      throw new Error('Media root must be a private directory (mode 0700).');
    }
  }

  async save(input: {
    bytes: Buffer;
    mimeType: string;
    fileName: string;
    maxBytes?: number;
  }): Promise<ManagedMedia> {
    const maxBytes = checkedMaxBytes(input.maxBytes ?? DEFAULT_MAX_BYTES);
    const mimeType = normalizeMime(input.mimeType);
    if (!ALLOWED_MIME_TYPES.has(mimeType)) throw new TypeError('Unsupported media MIME type.');
    if (input.bytes.length === 0 || input.bytes.length > maxBytes) throw new RangeError('Media is empty or oversized.');
    const fileName = safeFileName(input.fileName);
    const id = randomUUID();
    const mediaPath = this.filePath(id);
    const metadataPath = this.metadataPath(id);

    const mediaFd = openSync(mediaPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollowFlag(), 0o600);
    try {
      writeSync(mediaFd, input.bytes);
      fsyncSync(mediaFd);
    } catch (error) {
      closeSync(mediaFd);
      unlinkSync(mediaPath);
      throw error;
    }
    closeSync(mediaFd);
    chmodSync(mediaPath, 0o600);
    const media: ManagedMedia = {
      id, mimeType, fileName, size: input.bytes.length,
      sha256: createHash('sha256').update(input.bytes).digest('hex'),
    };
    const metadataFd = openSync(metadataPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollowFlag(), 0o600);
    try {
      writeSync(metadataFd, JSON.stringify(media));
      fsyncSync(metadataFd);
    } catch (error) {
      closeSync(metadataFd);
      unlinkSync(metadataPath);
      unlinkSync(mediaPath);
      throw error;
    }
    closeSync(metadataFd);
    chmodSync(metadataPath, 0o600);
    return media;
  }

  async read(id: string, options: { maxBytes?: number; allowedMimeTypes: readonly string[] }): Promise<ManagedMediaContent> {
    const maxBytes = checkedMaxBytes(options.maxBytes ?? DEFAULT_MAX_BYTES);
    const mediaPath = this.filePath(id);
    const metadataPath = this.metadataPath(id);
    const metadata = readMetadata(metadataPath);
    if (!options.allowedMimeTypes.map(normalizeMime).includes(metadata.mimeType)) {
      throw new TypeError('Media MIME type is not allowed for this operation.');
    }
    const fileFd = openNoFollow(mediaPath);
    try {
      const stat = fstatSync(fileFd);
      if (!stat.isFile()) throw new Error('Managed media must be a regular file.');
      if (stat.size !== metadata.size || stat.size > maxBytes) throw new RangeError('Media is oversized or has changed.');
      const bytes = readFileSync(fileFd);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== metadata.sha256) throw new Error('Managed media integrity check failed.');
      return { ...metadata, bytes };
    } finally {
      closeSync(fileFd);
    }
  }

  private filePath(id: string): string {
    if (!MEDIA_ID.test(id)) throw new TypeError('Invalid managed media ID.');
    return join(this.root, `${id}.bin`);
  }

  private metadataPath(id: string): string {
    if (!MEDIA_ID.test(id)) throw new TypeError('Invalid managed media ID.');
    return join(this.root, `${id}.json`);
  }
}

function readMetadata(path: string): ManagedMedia {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile() || before.size > 4_096) throw new Error('Invalid managed media metadata.');
  const fd = openNoFollow(path);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Invalid managed media metadata.');
    const value = JSON.parse(readFileSync(fd, 'utf8')) as Partial<ManagedMedia>;
    if (typeof value.id !== 'string' || !MEDIA_ID.test(value.id)
      || typeof value.mimeType !== 'string' || typeof value.fileName !== 'string'
      || !Number.isSafeInteger(value.size) || value.size! < 1
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
      throw new Error('Invalid managed media metadata.');
    }
    return {
      id: value.id, mimeType: normalizeMime(value.mimeType),
      fileName: safeFileName(value.fileName), size: value.size!, sha256: value.sha256,
    };
  } finally {
    closeSync(fd);
  }
}

function normalizeMime(value: string): string {
  return value.trim().toLowerCase().split(';', 1)[0] ?? '';
}

function safeFileName(value: string): string {
  const cleaned = value.replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim().slice(0, 128);
  return cleaned || 'attachment';
}

function checkedMaxBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ALLOWED_BYTES) {
    throw new RangeError(`Media limit must be between 1 and ${MAX_ALLOWED_BYTES} bytes.`);
  }
  return value;
}

function noFollowFlag(): number {
  return fsConstants.O_NOFOLLOW ?? 0;
}

function openNoFollow(path: string): number {
  try {
    return openSync(path, fsConstants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ELOOP') {
      throw new Error('Symlink media paths are not allowed.');
    }
    throw error;
  }
}
