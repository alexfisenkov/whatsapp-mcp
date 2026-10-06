import type { AdapterOperation } from '../../mcp-server.js';
import { createHash } from 'node:crypto';
import { mediaGetInput, mediaUploadInput, type MediaGetInput, type MediaUploadInput } from './schemas.js';
import { graphIdSegment, graphPath, projectGraphObject, type GraphContext } from './shared.js';

export const mediaDefinitions: readonly AdapterOperation[] = [
  op('business.media.get', 'Get media metadata', 'Read safe metadata for a Meta media ID without exposing its temporary download URL.', 'read', mediaGetInput),
];

export const mediaDownloadDefinitions: readonly AdapterOperation[] = [
  op('business.media.download', 'Download received media', 'Download a Meta media ID through the allowlisted Meta CDN into the private managed media store.', 'read', mediaGetInput),
];

export const mediaUploadDefinitions: readonly AdapterOperation[] = [
  op('business.media.upload', 'Upload managed media to Meta', 'Upload a file already stored in the private managed media store and return its Meta media ID.', 'guarded-mutation', mediaUploadInput),
];

export const mediaAdminDefinitions: readonly AdapterOperation[] = [
  op('business.media.delete', 'Delete uploaded media', 'Delete one Meta media object by ID.', 'guarded-mutation', mediaGetInput),
];

export async function executeMediaOperation(context: GraphContext, operationId: string, input: unknown): Promise<unknown> {
  if (operationId === 'business.media.get' || operationId === 'business.media.delete') {
    const value = mediaGetInput.parse(input) as MediaGetInput;
    const result = await context.client.json({
      method: operationId.endsWith('.delete') ? 'DELETE' : 'GET',
      path: graphPath(context, `/${graphIdSegment(value.mediaId)}`),
      ...(operationId.endsWith('.delete') ? { write: true } : {}),
    });
    return projectGraphObject(result, ['id', 'file_size', 'mime_type', 'sha256', 'success']);
  }
  if (operationId === 'business.media.download') {
    const value = mediaGetInput.parse(input) as MediaGetInput;
    if (!context.mediaStore) throw new Error('UNSUPPORTED');
    const metadata = await context.client.json<Record<string, unknown>>({
      method: 'GET',
      path: graphPath(context, `/${graphIdSegment(value.mediaId)}`),
      query: new URLSearchParams({ phone_number_id: context.config.phoneNumberId }),
    });
    if (metadata.id !== value.mediaId || typeof metadata.url !== 'string' || typeof metadata.mime_type !== 'string') {
      throw new Error('Provider media metadata is incomplete.');
    }
    const mimeType = metadata.mime_type.trim().toLowerCase();
    const allowed = ['image/jpeg', 'image/png', 'application/pdf', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'video/mp4'];
    if (!allowed.includes(mimeType)) throw new TypeError('Meta media MIME type is not supported by the managed media store.');
    const size = typeof metadata.file_size === 'number' ? metadata.file_size : Number(metadata.file_size);
    if (!Number.isSafeInteger(size) || size < 1 || size > 5 * 1024 * 1024) throw new RangeError('Meta media is empty or exceeds 5 MiB.');

    const mediaUrl = new URL(metadata.url);
    if (mediaUrl.searchParams.get('mid') !== value.mediaId) throw new TypeError('Meta media URL does not match the requested media ID.');
    const download = await context.client.metaMediaUrl(metadata.url, 5 * 1024 * 1024);
    if (download.bytes.length !== size) throw new Error('Meta media size did not match its metadata.');
    if (download.contentType !== mimeType) throw new Error('Meta media MIME type did not match its metadata.');
    if (typeof metadata.sha256 !== 'string' || !matchesSha256(download.bytes, metadata.sha256)) {
      throw new Error('Meta media checksum did not match its metadata.');
    }
    const fileName = `media-${value.mediaId}.${extensionFor(mimeType)}`;
    const stored = await context.mediaStore.save({ bytes: Buffer.from(download.bytes), mimeType, fileName, maxBytes: 5 * 1024 * 1024 });
    return { mediaId: stored.id, mimeType: stored.mimeType, fileName: stored.fileName, size: stored.size, sha256: stored.sha256 };
  }
  if (operationId === 'business.media.upload') {
    const value = mediaUploadInput.parse(input) as MediaUploadInput;
    if (!context.mediaStore) throw new Error('UNSUPPORTED');
    const stored = await context.mediaStore.read(value.managedMediaId, {
      maxBytes: 5 * 1024 * 1024,
      allowedMimeTypes: ['image/jpeg', 'image/png', 'application/pdf', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'video/mp4'],
    });
    const result = await context.client.multipart<Record<string, unknown>>(
      graphPath(context, `/${context.config.phoneNumberId}/media`),
      { messaging_product: 'whatsapp', type: stored.mimeType },
      new Blob([Uint8Array.from(stored.bytes).buffer as ArrayBuffer], { type: stored.mimeType }),
      stored.fileName,
    );
    const projected = projectGraphObject(result, ['id']);
    if (typeof projected.id !== 'string' || projected.id.length > 128) throw new Error('Provider response schema mismatch.');
    return projected;
  }
  throw new Error('UNSUPPORTED');
}

function matchesSha256(bytes: Uint8Array, expected: string): boolean {
  const digest = createHash('sha256').update(bytes).digest();
  if (/^[0-9a-f]{64}$/i.test(expected)) return digest.toString('hex').toLowerCase() === expected.toLowerCase();
  try {
    const decoded = Buffer.from(expected, 'base64');
    return decoded.length === digest.length && decoded.equals(digest);
  } catch {
    return false;
  }
}

function extensionFor(mimeType: string): string {
  const extensions: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf',
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'video/mp4': 'mp4',
  };
  const extension = extensions[mimeType];
  if (!extension) throw new TypeError('Meta media MIME type is not supported.');
  return extension;
}

function op(id: string, title: string, description: string, kind: AdapterOperation['kind'], inputSchema: AdapterOperation['inputSchema']): AdapterOperation {
  return { id, title, description, kind, inputSchema };
}
