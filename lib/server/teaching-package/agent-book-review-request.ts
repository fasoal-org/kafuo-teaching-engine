/**
 * The `POST /api/teaching-packages/[id]/agent-book-reviews` body (Kafuo Agent API
 * D2a): validated and capped before anything is stored. The page images are
 * returned apart (held in memory only); the rest is the stored evidence. Pure.
 */
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  STABLE_TEXT_MAX_CHARS,
  type AgentReviewEvidence,
  type EvidenceBlock,
  type EvidenceImage,
  type EvidencePage,
  type EvidenceUnit,
} from '@/lib/server/teaching-package/agent-book-review-prompt';

export const MAX_PAGES = 30;
export const MAX_BLOCKS = 3000;
export const MAX_UNITS = 500;
/** One page image, base64 characters (≈ 1.5 MB decoded; a 1568 px JPEG is far less). */
export const MAX_IMAGE_BASE64 = 2_000_000;
/** Every image of one request together, base64 characters. */
export const MAX_IMAGES_BASE64 = 24_000_000;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function invalid(message: string): TeachingPackageError {
  return new TeachingPackageError('INVALID_REQUEST', message);
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw invalid(`${field} must be a string`);
  if (value.length > max) throw invalid(`${field} is too long`);
  return value;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  return value === undefined || value === null ? null : text(value, field, max);
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw invalid(`${field} must be an integer`);
  return value;
}

export interface ParsedAgentReviewRequest {
  requestId: string;
  evaluationId: string | null;
  runId: string | null;
  evidence: AgentReviewEvidence;
  images: EvidenceImage[];
}

export function parseAgentReviewRequest(body: Record<string, unknown>): ParsedAgentReviewRequest {
  const requestId = text(body.requestId, 'requestId', 200);
  if (requestId.trim() === '') throw invalid('requestId must not be empty');
  if (!Array.isArray(body.pages) || body.pages.length === 0)
    throw invalid('pages must be a non-empty array');
  if (body.pages.length > MAX_PAGES)
    throw new TeachingPackageError('REQUEST_TOO_LARGE', `at most ${MAX_PAGES} pages`);
  const blocksIn = body.blocks ?? [];
  if (!Array.isArray(blocksIn)) throw invalid('blocks must be an array');
  if (blocksIn.length > MAX_BLOCKS)
    throw new TeachingPackageError('REQUEST_TOO_LARGE', `at most ${MAX_BLOCKS} blocks`);
  const unitsIn = body.units ?? [];
  if (!Array.isArray(unitsIn) || unitsIn.length > MAX_UNITS)
    throw invalid('units must be an array');

  let budget = STABLE_TEXT_MAX_CHARS;
  let truncated = false;
  const take = (value: string): string => {
    if (value.length <= budget) {
      budget -= value.length;
      return value;
    }
    truncated = true;
    const kept = value.slice(0, Math.max(0, budget));
    budget = 0;
    return kept;
  };

  const images: EvidenceImage[] = [];
  let imageChars = 0;
  const pages: EvidencePage[] = body.pages.map((entry, index) => {
    const page = (entry ?? {}) as Record<string, unknown>;
    const pdfPage = integer(page.pdfPage, `pages[${index}].pdfPage`);
    const bookPage =
      page.bookPage === undefined || page.bookPage === null
        ? null
        : integer(page.bookPage, `pages[${index}].bookPage`);
    const image = page.image as Record<string, unknown> | undefined | null;
    if (image) {
      const mediaType = image.mediaType;
      if (mediaType !== 'image/jpeg' && mediaType !== 'image/png') {
        throw invalid(`pages[${index}].image.mediaType must be image/jpeg or image/png`);
      }
      const data = text(image.data, `pages[${index}].image.data`, MAX_IMAGE_BASE64);
      if (!BASE64.test(data)) throw invalid(`pages[${index}].image.data must be base64`);
      imageChars += data.length;
      if (imageChars > MAX_IMAGES_BASE64) {
        throw new TeachingPackageError('REQUEST_TOO_LARGE', 'the page images are too large');
      }
      images.push({ pdfPage, mediaType, data });
    }
    return {
      bookPage,
      pdfPage,
      text: take(text(page.text ?? '', `pages[${index}].text`, 100_000)),
    };
  });

  const blocks: EvidenceBlock[] = blocksIn.map((entry, index) => {
    const block = (entry ?? {}) as Record<string, unknown>;
    const rows = block.rows;
    if (rows !== undefined && rows !== null && !Array.isArray(rows))
      throw invalid(`blocks[${index}].rows`);
    return {
      id: text(String(block.id ?? ''), `blocks[${index}].id`, 100),
      pdfPage: integer(block.pdfPage, `blocks[${index}].pdfPage`),
      kind: text(block.kind ?? 'text', `blocks[${index}].kind`, 40),
      text: take(text(block.text ?? '', `blocks[${index}].text`, 50_000)),
      ...(Array.isArray(rows)
        ? {
            rows: rows
              .slice(0, 100)
              .map((row) =>
                Array.isArray(row) ? row.slice(0, 30).map((cell) => take(String(cell ?? ''))) : [],
              ),
          }
        : {}),
      caption: optionalText(block.caption, `blocks[${index}].caption`, 2000),
      bbox: Array.isArray(block.bbox) ? block.bbox.slice(0, 4).map(Number) : null,
    };
  });
  const blockIds = new Set(blocks.map((block) => block.id));
  if (blockIds.size !== blocks.length) throw invalid('block ids must be unique');

  const units: EvidenceUnit[] = unitsIn.map((entry, index) => {
    const unit = (entry ?? {}) as Record<string, unknown>;
    const ids = unit.blockIds ?? [];
    if (!Array.isArray(ids)) throw invalid(`units[${index}].blockIds must be an array`);
    return {
      contentUnitId: text(String(unit.contentUnitId ?? ''), `units[${index}].contentUnitId`, 100),
      order: integer(unit.order, `units[${index}].order`),
      blockIds: ids.map(String).filter((id) => blockIds.has(id)),
    };
  });

  const constantsIn = body.constants ?? {};
  if (!constantsIn || typeof constantsIn !== 'object' || Array.isArray(constantsIn)) {
    throw invalid('constants must be an object');
  }
  const constants: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(constantsIn as Record<string, unknown>).slice(
    0,
    100,
  )) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(name)) throw invalid(`constant name ${name}`);
    if (typeof value === 'number' && Number.isFinite(value)) constants[name] = value;
    else constants[name] = text(value, `constants.${name}`, 80);
  }

  const d1In = body.d1Findings ?? [];
  if (!Array.isArray(d1In)) throw invalid('d1Findings must be an array');
  const d1Findings = d1In.slice(0, 1000).map((entry, index) => {
    const finding = (entry ?? {}) as Record<string, unknown>;
    return {
      code: text(finding.code, `d1Findings[${index}].code`, 60),
      sceneId: text(finding.sceneId, `d1Findings[${index}].sceneId`, 200),
    };
  });

  return {
    requestId,
    evaluationId: optionalText(body.evaluationId, 'evaluationId', 200),
    runId: optionalText(body.runId, 'runId', 200),
    evidence: { pages, blocks, units, constants, d1Findings, bookTruncated: truncated },
    images,
  };
}
