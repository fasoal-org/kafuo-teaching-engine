/**
 * Source-image normalization and safe materialization (plan §4.3.5/§4.3.6).
 *
 * ONE normalization boundary for every provider shape: only data URLs pass
 * (all four wired PDF providers emit data URLs), the declared MIME must match
 * the decoded magic bytes, decoded size is bounded, page association is
 * normalized (`pageNumber <= 0` → unknown), and logical ids are TE-minted
 * (`src-<n>`) — provider image ids are untrusted strings that never reach the
 * filesystem. Materialization writes content-addressed files under the Stage
 * media directory; no raw data URL or binary ever enters a Teaching Package
 * snapshot.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { isGeneratedMediaPlaceholder } from '@/lib/media/media-ref';
import { CLASSROOMS_DIR, isValidClassroomId } from '@/lib/server/classroom-storage';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import type { SourceVisualManifestEntry } from '@/lib/types/teaching-package';
import type { PdfImage } from '@openmaic/generation';

const SUPPORTED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const DEFAULT_MAX_SOURCE_IMAGE_BYTES = 10 * 1024 * 1024;
const MIME_TO_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Magic-byte signatures; the declared MIME must match the actual bytes. */
function detectImageMime(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (bytes.subarray(0, 3).toString('ascii') === 'GIF') {
    return 'image/gif';
  }
  return null;
}

/** Decode dimensions straight from the image header (no re-encode). */
function detectImageDimensions(bytes: Buffer, mime: string): { width?: number; height?: number } {
  try {
    if (mime === 'image/png' && bytes.length >= 24) {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (mime === 'image/gif' && bytes.length >= 10) {
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    if (mime === 'image/jpeg') {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = bytes[offset + 1]!;
        const length = bytes.readUInt16BE(offset + 2);
        if (
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc
        ) {
          return {
            height: bytes.readUInt16BE(offset + 5),
            width: bytes.readUInt16BE(offset + 7),
          };
        }
        offset += 2 + length;
      }
      return {};
    }
    if (mime === 'image/webp') {
      const format = bytes.subarray(12, 16).toString('ascii');
      if (format === 'VP8 ' && bytes.length >= 30) {
        return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
      }
      if (format === 'VP8L' && bytes.length >= 25) {
        const bits = bytes.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (format === 'VP8X' && bytes.length >= 30) {
        const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
        const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
        return { width, height };
      }
    }
  } catch {
    // Header parsing is best-effort; dimensions stay absent on any surprise.
  }
  return {};
}

/** The two source-visual failure modes the runner maps to attempt codes. */
export class SourceVisualModelUnavailableError extends Error {
  readonly code = 'SOURCE_VISUAL_MODEL_UNAVAILABLE' as const;

  constructor(stages: string[]) {
    super(
      `source visuals require a vision-capable model for ${stages.join(' and ')}; ` +
        `configure MODEL_ROUTES entries whose model reports capabilities.vision`,
    );
    this.name = 'SourceVisualModelUnavailableError';
  }
}

export class SourceVisualProcessingError extends Error {
  readonly code = 'SOURCE_VISUAL_PROCESSING_FAILED' as const;
  readonly retryable: boolean;

  constructor(retryable: boolean, safeMessage: string) {
    super(safeMessage);
    this.name = 'SourceVisualProcessingError';
    this.retryable = retryable;
  }
}

export interface NormalizedSourceImage {
  /** TE-minted stable logical id: `src-<n>` in encounter order. */
  id: string;
  /** Decoded bytes (memory only; never persisted). */
  data: Buffer;
  mimeType: string;
  sha256: string;
  pageNumber: number | null;
  width?: number;
  height?: number;
  description?: string;
  /** The provider's own image id, retained as provenance only. */
  providerImageId?: string;
}

export interface NormalizeSourceImagesResult {
  images: NormalizedSourceImage[];
  /** Count of provider entries dropped as unsupported/invalid (never fatal). */
  dropped: number;
}

function sourceImageMaxBytes(): number {
  const raw = Number(process.env.TEACHING_PACKAGE_SOURCE_IMAGE_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_SOURCE_IMAGE_BYTES;
}

/**
 * Normalize the parsed PDF's visual entries: accept only
 * `data:image/(png|jpeg|webp|gif);base64,…`, verify the declared MIME against
 * the decoded magic bytes, bound the decoded size, normalize page association,
 * derive missing dimensions from the header, and mint stable logical ids.
 * Unsupported entries are dropped and counted — never a pipeline failure.
 */
export function normalizeSourceImages(parsed: ParsedPdfContent): NormalizeSourceImagesResult {
  const entries = parsed.metadata?.pdfImages ?? [];
  const images: NormalizedSourceImage[] = [];
  let dropped = 0;
  let counter = 0;

  for (const entry of entries) {
    counter += 1;
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(
      entry.src ?? '',
    );
    if (!match) {
      dropped += 1;
      continue;
    }
    const declaredMime = match[1]!;
    let data: Buffer;
    try {
      data = Buffer.from(match[2]!, 'base64');
    } catch {
      dropped += 1;
      continue;
    }
    if (data.byteLength === 0 || data.byteLength > sourceImageMaxBytes()) {
      dropped += 1;
      continue;
    }
    const actualMime = detectImageMime(data);
    if (actualMime !== declaredMime) {
      dropped += 1;
      continue;
    }
    const dims = detectImageDimensions(data, actualMime!);
    const pageNumber =
      typeof entry.pageNumber === 'number' && Number.isFinite(entry.pageNumber) && entry.pageNumber > 0
        ? Math.floor(entry.pageNumber)
        : null;
    images.push({
      id: `src-${counter}`,
      data,
      mimeType: actualMime!,
      sha256: createHash('sha256').update(data).digest('hex'),
      pageNumber,
      ...(dims.width !== undefined && dims.width > 0 ? { width: dims.width } : {}),
      ...(dims.height !== undefined && dims.height > 0 ? { height: dims.height } : {}),
      ...(typeof entry.description === 'string' && entry.description
        ? { description: entry.description }
        : {}),
      ...(typeof entry.id === 'string' && entry.id ? { providerImageId: entry.id } : {}),
    });
  }

  return { images, dropped };
}

/** The vision-channel view of a normalized image (model eyes only). */
export function toVisionPdfImages(images: NormalizedSourceImage[]): PdfImage[] {
  return images.map((image) => ({
    id: image.id,
    src: `data:${image.mimeType};base64,${image.data.toString('base64')}`,
    pageNumber: image.pageNumber ?? 0,
    ...(image.description !== undefined ? { description: image.description } : {}),
    ...(image.width !== undefined ? { width: image.width } : {}),
    ...(image.height !== undefined ? { height: image.height } : {}),
  }));
}

export interface MaterializeSourceImagesResult {
  /** logical id → origin-relative serving path (element srcs). */
  servingMapping: Record<string, string>;
  /** logical id → data URL (model vision channel; memory only). */
  visionMapping: Record<string, string>;
  /** Lightweight provenance manifest (persisted on the outline record). */
  manifest: SourceVisualManifestEntry[];
}

/** Safe, content-addressed filename: `src_<n>_<sha8>.<ext>` — never a provider id. */
function safeMediaFileName(image: NormalizedSourceImage): string {
  const ext = MIME_TO_EXTENSION[image.mimeType] ?? 'png';
  return `src_${image.id.slice('src-'.length)}_${image.sha256.slice(0, 8)}.${ext}`;
}

/**
 * Materialize the SELECTED source images under the Stage media directory.
 * The stage id must be a valid classroom id (the path stays inside
 * `CLASSROOMS_DIR`), identical bytes are deduped by content hash, and the
 * return carries serving paths plus the provenance manifest — never a data
 * URL, never a signed retrieval URL.
 */
export async function materializeSourceImages(
  images: NormalizedSourceImage[],
  stageId: string,
  contentResourceId: string,
): Promise<MaterializeSourceImagesResult> {
  if (!isValidClassroomId(stageId)) {
    throw new Error('source visuals can be materialized only under a valid stage media directory');
  }
  const mediaDir = path.join(CLASSROOMS_DIR, stageId, 'media');
  await fs.mkdir(mediaDir, { recursive: true });

  const servingMapping: Record<string, string> = {};
  const visionMapping: Record<string, string> = {};
  const manifest: SourceVisualManifestEntry[] = [];
  const writtenFiles = new Set<string>();

  for (const image of images) {
    const fileName = safeMediaFileName(image);
    const target = path.join(mediaDir, fileName);
    // Path containment: the filename is TE-minted, but resolve and verify anyway.
    if (!path.resolve(target).startsWith(path.resolve(mediaDir) + path.sep)) {
      throw new Error('refusing to write a source visual outside the stage media directory');
    }
    // Content-addressed name: re-materializing the same logical id with the
    // same bytes is an idempotent no-op (identical bytes dedupe on disk).
    if (!writtenFiles.has(fileName)) {
      await fs.writeFile(target, image.data);
      writtenFiles.add(fileName);
    }
    const servingPath = `/api/classroom-media/${stageId}/media/${fileName}`;
    servingMapping[image.id] = servingPath;
    visionMapping[
      image.id
    ] = `data:${image.mimeType};base64,${image.data.toString('base64')}`;
    manifest.push({
      id: image.id,
      contentResourceId,
      ...(image.providerImageId !== undefined
        ? { providerImageId: image.providerImageId }
        : {}),
      pageNumber: image.pageNumber,
      ...(image.width !== undefined ? { width: image.width } : {}),
      ...(image.height !== undefined ? { height: image.height } : {}),
      ...(image.description !== undefined ? { description: image.description } : {}),
      mimeType: image.mimeType,
      sha256: image.sha256,
      servingPath,
    });
  }

  return { servingMapping, visionMapping, manifest };
}

/** An image element on a slide canvas. */
interface SlideImageElement {
  id?: string;
  type?: string;
  src?: unknown;
}

/**
 * Per-visual-need source-visual precedence (plan §4.3.6), applied to the
 * built scenes BEFORE AI media generation:
 *
 * - A visual need is one slide image element. For each slide scene, collect
 *   the outline's selected source visuals not yet referenced by an element of
 *   THAT scene (`unusedSelected`, in `suggestedImageIds` order).
 * - Each generated-image placeholder element in that scene consumes the next
 *   unused selected source visual: its `src` is rewritten to the serving path
 *   and the matching `MediaGenerationRequest` (whose `elementId` IS the
 *   placeholder src value) is dropped from the outline.
 * - Placeholders with no unplaced selected source visual left are UNRELATED
 *   needs: their generation requests survive, so AI image generation is never
 *   disabled globally or per outline. Video requests are untouched.
 */
export function applySourceVisualPrecedence<
  TScene extends { type: string; outlineId?: string; content?: unknown },
  TOutline extends {
    id: string;
    suggestedImageIds?: string[];
    mediaGenerations?: Array<{ type: string; elementId: string }>;
  },
>(scenes: TScene[], outlines: TOutline[], servingMapping: Record<string, string>): void {
  const outlineById = new Map(outlines.map((outline) => [outline.id, outline]));
  const droppedRequestElementIds = new Set<string>();

  for (const scene of scenes) {
    if (scene.type !== 'slide') continue;
    const outline = scene.outlineId ? outlineById.get(scene.outlineId) : undefined;
    if (!outline) continue;
    const selected = (outline.suggestedImageIds ?? []).filter((id) => servingMapping[id]);
    if (selected.length === 0) continue;

    const elements = (scene.content as { canvas?: { elements?: SlideImageElement[] } } | undefined)
      ?.canvas?.elements;
    if (!elements) continue;

    const referenced = new Set<string>();
    for (const element of elements) {
      if (element.type === 'image' && typeof element.src === 'string') {
        referenced.add(element.src);
      }
    }
    const unusedSelected = selected.filter((id) => !referenced.has(servingMapping[id]!));
    if (unusedSelected.length === 0) continue;

    for (const element of elements) {
      if (unusedSelected.length === 0) break;
      if (element.type !== 'image' || typeof element.src !== 'string') continue;
      if (!isGeneratedMediaPlaceholder(element.src)) continue;
      const nextId = unusedSelected.shift()!;
      droppedRequestElementIds.add(element.src);
      element.src = servingMapping[nextId]!;
    }
  }

  if (droppedRequestElementIds.size > 0) {
    for (const outline of outlines) {
      if (!outline.mediaGenerations || outline.mediaGenerations.length === 0) continue;
      outline.mediaGenerations = outline.mediaGenerations.filter(
        (request) =>
          !(request.type === 'image' && droppedRequestElementIds.has(request.elementId)),
      );
    }
  }
}

/** The `NormalizedSource` Layer A hands to every classroom run (plan §4.3.2). */
export interface NormalizedSource {
  text: string;
  /** Raw parsed images (data URLs) — the legacy `pdfContent.images` channel. */
  images: string[];
  /** Normalized source visuals (stable ids, provenance, bytes in memory). */
  normalizedImages: NormalizedSourceImage[];
  /** Vision channel for the two model calls that actually see images. */
  visionImages: PdfImage[];
  /** logical id → data URL. */
  visionMapping: Record<string, string>;
  measuredBytes: number;
  measuredSha256: string;
}
