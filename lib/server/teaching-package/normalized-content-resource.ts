import { createHash } from 'node:crypto';

import JSZip from 'jszip';

import { fetchBytesSecurely, type SecureBytesOptions } from '@/lib/server/agent-runtime/fetch-url';
import { ContentResourceAcquisitionError } from '@/lib/server/teaching-package/content-resource';
import {
  toVisionPdfImages,
  type NormalizedSource,
  type NormalizedSourceImage,
} from '@/lib/server/teaching-package/source-images';
import type {
  KafuoLearningItemContext,
  KafuoNormalizedContentResource,
} from '@/lib/types/teaching-package';

export const NORMALIZED_CONTENT_SCHEMA = 'kafuo.normalized-content.v1' as const;

interface ManifestBlock {
  id: string;
  orderIndex: number;
  blockType: string;
  role?: string;
  text?: string;
  page?: number;
  disposition?: 'included' | 'excluded';
  associatedVisualIds?: string[];
}

interface ManifestUnit {
  id: string;
  orderIndex: number;
  role: string;
  subtype?: string;
  title?: string;
  normalizedText?: string;
  blocks: ManifestBlock[];
}

interface ManifestVisual {
  id: string;
  mediaPath: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  width: number;
  height: number;
  pageNumber?: number;
  sourceBlockId?: string;
  candidateId?: string;
  providerVisualId?: string;
  caption?: string;
  figureLabel?: string;
  description?: string;
  role?: string;
  visionPriority?: number;
  contentUnitIds?: string[];
  blockIds?: string[];
}

export interface NormalizedLessonManifest {
  schemaVersion: typeof NORMALIZED_CONTENT_SCHEMA;
  packageId: string;
  learningItem: { type: 'lesson' | 'section'; id: string };
  contentSource: { id: string; checksumSha256?: string };
  contentRevisionId: string;
  parseRunId: string;
  structureProfile: { id: string; versionId: string };
  language: string;
  pageCount: number;
  contentUnits: ManifestUnit[];
  visuals: ManifestVisual[];
}

export interface AcquiredNormalizedSource extends NormalizedSource {
  manifest: NormalizedLessonManifest;
  blockCount: number;
}

export interface NormalizedAcquisitionPolicy {
  maxBytes: number;
  maxExpandedBytes: number;
  maxFiles: number;
  maxMediaBytes: number;
  bodyTimeoutMs: number;
  maxAttempts: number;
  secureFetch?: SecureBytesOptions['fetchImpl'];
  dispatcher?: SecureBytesOptions['dispatcher'];
}

const envLimit = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

function fail(code: string, message: string): never {
  throw new ContentResourceAcquisitionError(code, false, message);
}

function isRetryableDownload(error: unknown): boolean {
  const record = error as { name?: string; message?: string };
  if (record?.name !== 'FetchUrlError') return true;
  const message = record.message ?? '';
  return !message.includes('blocked') && !message.includes('Unsupported content type');
}

async function downloadWithRetry(
  resource: KafuoNormalizedContentResource,
  policy: Partial<NormalizedAcquisitionPolicy>,
  maxBytes: number,
): Promise<Awaited<ReturnType<typeof fetchBytesSecurely>>> {
  const maxAttempts =
    policy.maxAttempts ?? envLimit('TEACHING_PACKAGE_ACQUISITION_MAX_ATTEMPTS', 3);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetchBytesSecurely(resource.url, {
        allowedContentTypes: new Set(['application/zip', 'application/octet-stream']),
        maxBytes,
        bodyTimeoutMs:
          policy.bodyTimeoutMs ?? envLimit('TEACHING_PACKAGE_NORMALIZED_TIMEOUT_MS', 120_000),
        ...(policy.secureFetch ? { fetchImpl: policy.secureFetch } : {}),
        ...(policy.dispatcher ? { dispatcher: policy.dispatcher } : {}),
      });
    } catch (error) {
      const retryable = isRetryableDownload(error);
      if (!retryable || attempt >= maxAttempts) {
        throw new ContentResourceAcquisitionError(
          'NORMALIZED_CONTENT_DOWNLOAD_FAILED',
          retryable,
          'the normalized content package could not be downloaded',
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(1000 * 2 ** (attempt - 1), 10_000)),
      );
    }
  }
  throw new ContentResourceAcquisitionError(
    'NORMALIZED_CONTENT_DOWNLOAD_FAILED',
    true,
    'the normalized content package could not be downloaded',
  );
}

function string(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    fail(code, 'normalized content manifest is invalid');
  return value;
}

function safePath(name: string): boolean {
  if (name === 'media/') return true;
  return (
    name === 'manifest.json' ||
    (name.startsWith('media/') &&
      !name.endsWith('/') &&
      !name.includes('\\') &&
      !name.split('/').some((part) => part === '' || part === '.' || part === '..'))
  );
}

function archiveEntryNames(bytes: Buffer): string[] {
  const names: string[] = [];
  for (let offset = 0; offset + 46 <= bytes.length; ) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    names.push(bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

function imageFacts(bytes: Buffer): { mimeType: string; width: number; height: number } | null {
  if (bytes.length >= 24 && bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
    return { mimeType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 10 && bytes.subarray(0, 3).toString('ascii') === 'GIF') {
    return { mimeType: 'image/gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1]!;
      const length = bytes.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return {
          mimeType: 'image/jpeg',
          height: bytes.readUInt16BE(offset + 5),
          width: bytes.readUInt16BE(offset + 7),
        };
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  if (
    bytes.length >= 30 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    const format = bytes.subarray(12, 16).toString('ascii');
    if (format === 'VP8X')
      return {
        mimeType: 'image/webp',
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3),
      };
  }
  return null;
}

function ordered<T extends { id: string; orderIndex: number }>(values: T[], code: string): T[] {
  const ids = new Set<string>();
  const orders = new Set<number>();
  for (const value of values) {
    string(value.id, code);
    if (
      ids.has(value.id) ||
      !Number.isSafeInteger(value.orderIndex) ||
      value.orderIndex < 0 ||
      orders.has(value.orderIndex)
    )
      fail(code, 'normalized content ordering or identity is invalid');
    ids.add(value.id);
    orders.add(value.orderIndex);
  }
  return [...values].sort((a, b) => a.orderIndex - b.orderIndex);
}

/**
 * Content Unit roles that are allowed to carry no teaching text at all.
 *
 * Kafuo's own readiness facts (`book_grounded_readiness_facts.py`) treat
 * `{REFERENCE, UNCLASSIFIED}` as non-instructional; its metadata use case
 * (`generate_lesson_metadata.py`) carves out only `{REFERENCE}`. The wider set
 * is adopted here deliberately: this projection must not fail acquisition of a
 * package Kafuo itself considers approvable.
 */
const NON_INSTRUCTIONAL_UNIT_ROLES = new Set(['REFERENCE', 'UNCLASSIFIED']);

/** Does any of this unit's blocks associate a visual? (internal evidence only). */
function unitCarriesVisuals(unit: ManifestUnit): boolean {
  return (unit.blocks ?? []).some((block) => (block.associatedVisualIds ?? []).length > 0);
}

/**
 * Project the approved package onto the text the LLM actually receives.
 *
 * The approved Content Unit is the pedagogical authority: exactly one entry per
 * unit, carrying the unit's own approved `normalizedText`. Document Blocks are
 * lower-level extraction/provenance records — they stay in the manifest for
 * archive integrity, visual resolution, and internal provenance, but they are
 * never rendered here, so the model can neither read a block nor cite one.
 *
 * Fail-closed: a unit that is expected to teach but carries no usable
 * `normalizedText` fails acquisition. The Blocks are NOT concatenated as a
 * silent substitute — an un-normalized unit is a Kafuo-side defect, and hiding
 * it behind reassembled block text would ground the lesson in unapproved text.
 */
export function adaptNormalizedText(manifest: NormalizedLessonManifest): string {
  const lines: string[] = [];
  let rendered = 0;
  for (const unit of ordered(manifest.contentUnits, 'NORMALIZED_CONTENT_ARCHIVE_INVALID')) {
    const text = unit.normalizedText?.trim();
    if (!text) {
      // A figure-only or reference unit legitimately teaches nothing in prose:
      // it is skipped, not failed. Its visuals still reach the model through
      // the vision channel, associated by this unit's id.
      if (unitCarriesVisuals(unit) || NON_INSTRUCTIONAL_UNIT_ROLES.has(unit.role?.toUpperCase()))
        continue;
      fail(
        'NORMALIZED_CONTENT_EMPTY',
        `approved content unit ${unit.id} carries no usable normalized text`,
      );
    }
    lines.push(
      `[[CONTENT_UNIT id=${unit.id} order=${unit.orderIndex} role=${unit.role}${unit.subtype ? ` subtype=${unit.subtype}` : ''}]]`,
    );
    if (unit.title) lines.push(`TITLE: ${unit.title}`);
    lines.push(text);
    lines.push('[[/CONTENT_UNIT]]');
    rendered += 1;
  }
  if (rendered === 0)
    fail('NORMALIZED_CONTENT_EMPTY', 'normalized content contains no usable authoritative text');
  return lines.join('\n');
}

function validateLineage(
  resource: KafuoNormalizedContentResource,
  item: Pick<KafuoLearningItemContext, 'type' | 'id'>,
  manifest: NormalizedLessonManifest,
): void {
  if (
    manifest.schemaVersion !== NORMALIZED_CONTENT_SCHEMA ||
    manifest.packageId !== resource.id ||
    manifest.learningItem?.type !== item.type ||
    manifest.learningItem?.id !== item.id ||
    manifest.contentSource?.id !== resource.contentSourceId ||
    manifest.contentRevisionId !== resource.contentRevisionId ||
    manifest.parseRunId !== resource.parseRunId ||
    manifest.structureProfile?.id !== resource.structureProfile.id ||
    manifest.structureProfile?.versionId !== resource.structureProfile.versionId
  )
    fail(
      'NORMALIZED_CONTENT_LINEAGE_MISMATCH',
      'normalized content lineage does not match the request',
    );
}

export async function acquireNormalizedContentResource(
  resource: KafuoNormalizedContentResource,
  learningItem: Pick<KafuoLearningItemContext, 'type' | 'id'>,
  policy: Partial<NormalizedAcquisitionPolicy> = {},
): Promise<AcquiredNormalizedSource> {
  const maxBytes =
    policy.maxBytes ?? envLimit('TEACHING_PACKAGE_NORMALIZED_MAX_BYTES', 100 * 1024 * 1024);
  const downloaded = await downloadWithRetry(resource, policy, maxBytes);
  const bytes = downloaded.bytes;
  const measuredSha256 = createHash('sha256').update(bytes).digest('hex');
  if (
    downloaded.truncated ||
    bytes.length !== resource.fileSizeBytes ||
    measuredSha256 !== resource.checksumSha256.toLowerCase()
  ) {
    fail(
      'NORMALIZED_CONTENT_INTEGRITY_MISMATCH',
      'normalized content package integrity does not match the request',
    );
  }
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50)
    fail('NORMALIZED_CONTENT_ARCHIVE_INVALID', 'normalized content is not a supported ZIP archive');

  const rawNames = archiveEntryNames(bytes);
  const maxFiles = policy.maxFiles ?? envLimit('TEACHING_PACKAGE_NORMALIZED_MAX_FILES', 1000);
  if (
    rawNames.length === 0 ||
    rawNames.length > maxFiles ||
    new Set(rawNames).size !== rawNames.length ||
    rawNames.some((name) => !safePath(name))
  ) {
    fail('NORMALIZED_CONTENT_ARCHIVE_INVALID', 'normalized content archive entries are unsafe');
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { createFolders: false, checkCRC32: true });
  } catch {
    fail('NORMALIZED_CONTENT_ARCHIVE_INVALID', 'normalized content archive cannot be read');
  }
  const manifestEntry = zip.file('manifest.json');
  if (!manifestEntry || zip.file(/^manifest\.json$/).length !== 1)
    fail('NORMALIZED_CONTENT_ARCHIVE_INVALID', 'normalized content manifest is missing');
  let manifest: NormalizedLessonManifest;
  try {
    manifest = JSON.parse(await manifestEntry.async('text')) as NormalizedLessonManifest;
  } catch {
    fail('NORMALIZED_CONTENT_ARCHIVE_INVALID', 'normalized content manifest is invalid JSON');
  }
  if (manifest.schemaVersion !== NORMALIZED_CONTENT_SCHEMA)
    fail('NORMALIZED_CONTENT_SCHEMA_UNSUPPORTED', 'normalized content schema is unsupported');
  validateLineage(resource, learningItem, manifest);
  if (!Array.isArray(manifest.contentUnits) || !Array.isArray(manifest.visuals))
    fail('NORMALIZED_CONTENT_ARCHIVE_INVALID', 'normalized content manifest shape is invalid');
  const declaredPaths = new Set([
    'manifest.json',
    ...manifest.visuals.map((visual) => visual.mediaPath),
  ]);
  for (const [name, entry] of Object.entries(zip.files)) {
    const permissions =
      typeof entry.unixPermissions === 'string'
        ? Number.parseInt(entry.unixPermissions, 8)
        : entry.unixPermissions;
    if (
      (permissions !== null &&
        permissions !== undefined &&
        (permissions & 0o170000) === 0o120000) ||
      (!entry.dir && !declaredPaths.has(name))
    ) {
      fail(
        'NORMALIZED_CONTENT_ARCHIVE_INVALID',
        'normalized content archive contains an undeclared or unsafe entry',
      );
    }
  }

  const units = ordered(manifest.contentUnits, 'NORMALIZED_CONTENT_ARCHIVE_INVALID');
  const blockIds = new Set<string>();
  const associationByVisual = new Map<
    string,
    { unitIds: Set<string>; blockIds: Set<string>; role?: string }
  >();
  for (const unit of units) {
    for (const block of ordered(unit.blocks ?? [], 'NORMALIZED_CONTENT_ARCHIVE_INVALID')) {
      if (blockIds.has(block.id))
        fail(
          'NORMALIZED_CONTENT_ARCHIVE_INVALID',
          'normalized content block identity is duplicated',
        );
      blockIds.add(block.id);
      for (const visualId of block.associatedVisualIds ?? []) {
        const association = associationByVisual.get(visualId) ?? {
          unitIds: new Set(),
          blockIds: new Set(),
          role: unit.role,
        };
        association.unitIds.add(unit.id);
        association.blockIds.add(block.id);
        associationByVisual.set(visualId, association);
      }
    }
  }
  const visualIds = new Set<string>();
  const normalizedImages: NormalizedSourceImage[] = [];
  let expandedBytes = (await manifestEntry.async('uint8array')).byteLength;
  const maxExpanded =
    policy.maxExpandedBytes ??
    envLimit('TEACHING_PACKAGE_NORMALIZED_MAX_EXPANDED_BYTES', 300 * 1024 * 1024);
  const maxMedia =
    policy.maxMediaBytes ??
    envLimit('TEACHING_PACKAGE_NORMALIZED_MAX_MEDIA_BYTES', 10 * 1024 * 1024);
  let visualIndex = 0;
  for (const visual of manifest.visuals) {
    visualIndex += 1;
    if (visualIds.has(visual.id))
      fail('NORMALIZED_CONTENT_ARCHIVE_INVALID', 'normalized visual identity is duplicated');
    visualIds.add(string(visual.id, 'NORMALIZED_CONTENT_ARCHIVE_INVALID'));
    const association = associationByVisual.get(visual.id);
    if (!association || (visual.sourceBlockId && !association.blockIds.has(visual.sourceBlockId)))
      fail('NORMALIZED_CONTENT_ASSOCIATION_INVALID', 'normalized visual association is dangling');
    if (
      visual.contentUnitIds &&
      (visual.contentUnitIds.length !== association.unitIds.size ||
        visual.contentUnitIds.some((id) => !association.unitIds.has(id)))
    )
      fail(
        'NORMALIZED_CONTENT_ASSOCIATION_INVALID',
        'normalized visual reverse association is asymmetric',
      );
    if (
      visual.blockIds &&
      (visual.blockIds.length !== association.blockIds.size ||
        visual.blockIds.some((id) => !association.blockIds.has(id)))
    )
      fail(
        'NORMALIZED_CONTENT_ASSOCIATION_INVALID',
        'normalized visual reverse association is asymmetric',
      );
    if (!safePath(visual.mediaPath) || visual.mediaPath === 'manifest.json')
      fail('NORMALIZED_CONTENT_ARCHIVE_INVALID', 'normalized media path is unsafe');
    const entry = zip.file(visual.mediaPath);
    if (!entry) fail('NORMALIZED_CONTENT_MEDIA_INVALID', 'normalized media is missing');
    const data = Buffer.from(await entry.async('uint8array'));
    expandedBytes += data.length;
    if (data.length <= 0 || data.length > maxMedia || expandedBytes > maxExpanded)
      fail('NORMALIZED_CONTENT_ARCHIVE_INVALID', 'normalized archive exceeds expanded size limits');
    const facts = imageFacts(data);
    const digest = createHash('sha256').update(data).digest('hex');
    if (
      !facts ||
      facts.mimeType !== visual.mimeType ||
      data.length !== visual.sizeBytes ||
      digest !== visual.checksumSha256.toLowerCase() ||
      facts.width !== visual.width ||
      facts.height !== visual.height
    )
      fail('NORMALIZED_CONTENT_MEDIA_INVALID', 'normalized media integrity is invalid');
    normalizedImages.push({
      id: `src-${visualIndex}`,
      data,
      mimeType: facts.mimeType,
      sha256: digest,
      pageNumber: visual.pageNumber && visual.pageNumber > 0 ? Math.floor(visual.pageNumber) : null,
      width: facts.width,
      height: facts.height,
      ...(visual.description || visual.caption
        ? { description: visual.description ?? visual.caption }
        : {}),
      providerImageId: visual.providerVisualId ?? visual.id,
      normalizedPackageId: manifest.packageId,
      contentSourceId: manifest.contentSource.id,
      contentRevisionId: manifest.contentRevisionId,
      parseRunId: manifest.parseRunId,
      structureProfile: manifest.structureProfile,
      sourceContentUnitIds: [...association.unitIds],
      sourceBlockIds: [...association.blockIds],
      ...(association.role ? { sourceRole: association.role } : {}),
      ...(visual.caption ? { caption: visual.caption } : {}),
      ...(visual.figureLabel ? { figureLabel: visual.figureLabel } : {}),
      ...(Number.isFinite(visual.visionPriority) ? { visionPriority: visual.visionPriority } : {}),
    });
  }
  for (const associatedId of associationByVisual.keys())
    if (!visualIds.has(associatedId))
      fail(
        'NORMALIZED_CONTENT_ASSOCIATION_INVALID',
        'normalized block references a missing visual',
      );

  const visionImages = toVisionPdfImages(normalizedImages);
  return {
    manifest,
    blockCount: blockIds.size,
    text: adaptNormalizedText(manifest),
    images: visionImages.map((image) => image.src),
    normalizedImages,
    visionImages,
    visionMapping: Object.fromEntries(visionImages.map((image) => [image.id, image.src])),
    measuredBytes: bytes.length,
    measuredSha256,
  };
}

export function recordNormalizedContentSummary(
  snapshot: Record<string, unknown>,
  source: AcquiredNormalizedSource,
): Record<string, unknown> {
  return {
    ...snapshot,
    normalizedContentResource: {
      ...((snapshot.normalizedContentResource as Record<string, unknown> | undefined) ?? {}),
      measuredBytes: source.measuredBytes,
      measuredSha256: source.measuredSha256,
      contentUnitCount: source.manifest.contentUnits.length,
      blockCount: source.blockCount,
      visualCount: source.normalizedImages.length,
    },
    pdfContentSummary: {
      present: true,
      textLength: source.text.length,
      imageCount: source.visionImages.length,
    },
    sourceVisualSummary: {
      available: source.normalizedImages.length,
      selected: 0,
      materialized: 0,
    },
  };
}
