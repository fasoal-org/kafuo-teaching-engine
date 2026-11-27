/**
 * Page images (contract `docs/frds/page-images-export-contract-2026-11-27.md`): the whole
 * book pages of a lesson, from the normalized export's optional `pages` field, for the
 * g5.v12 package reviewer only. They never enter generation.
 *
 * Storage (contract §4.2): one JPEG per page in the Stage's media folder
 * (`media/page_<NNNN>_<sha8>.jpg`, read back through the checksum-verified crop reader),
 * and a Stage-independent index beside that folder (`source-pages.json`), which the
 * media route never serves. Both go with the Stage folder (`removeStageMediaDir`).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createLogger } from '@/lib/logger';
import { CLASSROOMS_DIR, isValidClassroomId } from '@/lib/server/classroom-storage';

const log = createLogger('SourcePages');

/** Contract §2.2: the long side of a page image, never more. */
export const SOURCE_PAGE_MAX_LONG_EDGE_PX = 1568;
/** Contract §2.3: pages per export. */
export const SOURCE_PAGE_MAX_COUNT = 40;
/** Contract §2.3: bytes per page (1.5 MiB). */
export const SOURCE_PAGE_MAX_BYTES = 1_572_864;
/** Contract §2.3: page bytes in all (40 MiB). */
export const SOURCE_PAGES_MAX_TOTAL_BYTES = 40 * 1024 * 1024;

const INDEX_FILE = 'source-pages.json';
const INDEX_SCHEMA = 'te.source-pages.v1';
const SHA256_HEX = /^[0-9a-f]{64}$/;
const PAGE_FILE = /^page_\d{4,}_[0-9a-f]{8}\.jpg$/;

/** One verified page image of an export (memory only until it is stored). */
export interface NormalizedSourcePage {
  /** 1-based PDF page index (the blocks' `page`). */
  pageNumber: number;
  data: Buffer;
  /** Lowercase hex SHA-256 of `data`. */
  sha256: string;
  width: number;
  height: number;
  /** Contract §3: the units with a block on this page (included blocks first). */
  unitIds: string[];
}

/** One stored page, as the index lists it (no Stage id: the index travels with nothing). */
export interface StoredSourcePage {
  pageNumber: number;
  fileName: string;
  sha256: string;
  width: number;
  height: number;
  sizeBytes: number;
  unitIds: string[];
}

export function sourcePageFileName(page: Pick<NormalizedSourcePage, 'pageNumber' | 'sha256'>) {
  return `page_${String(page.pageNumber).padStart(4, '0')}_${page.sha256.slice(0, 8)}.jpg`;
}

/** The serving path the crop reader (`readSourceVisualDataUrl`) accepts for a stored page. */
export function sourcePageServingPath(stageId: string, fileName: string): string {
  return `/api/classroom-media/${stageId}/media/${fileName}`;
}

/**
 * Store an export's pages for one Stage (g5.v12 generations only; the runner calls it
 * for each reserved Stage). Idempotent: the same pages write the same files and index.
 * Returns how many pages were stored.
 */
export async function materializeSourcePages(
  pages: readonly NormalizedSourcePage[],
  stageId: string,
  classroomsDir: string = CLASSROOMS_DIR,
): Promise<number> {
  if (!isValidClassroomId(stageId)) {
    throw new Error('book pages can be stored only under a valid stage media directory');
  }
  if (pages.length === 0) return 0;
  const stageDir = path.resolve(classroomsDir, stageId);
  const mediaDir = path.join(stageDir, 'media');
  await fs.mkdir(mediaDir, { recursive: true });
  const index: StoredSourcePage[] = [];
  for (const page of pages) {
    const fileName = sourcePageFileName(page);
    const target = path.resolve(mediaDir, fileName);
    if (!target.startsWith(mediaDir + path.sep)) {
      throw new Error('refusing to write a book page outside the stage media directory');
    }
    await fs.writeFile(target, page.data);
    index.push({
      pageNumber: page.pageNumber,
      fileName,
      sha256: page.sha256,
      width: page.width,
      height: page.height,
      sizeBytes: page.data.length,
      unitIds: [...page.unitIds],
    });
  }
  // The index last, and whole: a reader sees every page or none.
  const temp = path.join(stageDir, `${INDEX_FILE}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temp, JSON.stringify({ schema: INDEX_SCHEMA, pages: index }));
  await fs.rename(temp, path.join(stageDir, INDEX_FILE));
  return index.length;
}

function storedPage(value: unknown): StoredSourcePage | null {
  const page = value as Partial<StoredSourcePage> | null;
  if (
    !page ||
    !Number.isSafeInteger(page.pageNumber) ||
    page.pageNumber! <= 0 ||
    typeof page.fileName !== 'string' ||
    !PAGE_FILE.test(page.fileName) ||
    typeof page.sha256 !== 'string' ||
    !SHA256_HEX.test(page.sha256) ||
    !Number.isSafeInteger(page.width) ||
    !Number.isSafeInteger(page.height) ||
    page.width! <= 0 ||
    page.height! <= 0 ||
    !Number.isSafeInteger(page.sizeBytes) ||
    !Array.isArray(page.unitIds) ||
    page.unitIds.some((id) => typeof id !== 'string')
  ) {
    return null;
  }
  return page as StoredSourcePage;
}

/**
 * What a Stage holds of its book pages (review MEDIUM-B: "none" and "unreadable" differ).
 * - `none`: no index (an older export, another Teaching Model, an edit successor's Stage,
 *   an unsafe Stage id): the reviewer uses the crops, and a page a finding names names
 *   nothing.
 * - `unreadable`: an index exists but cannot be read or is not one this TE wrote: the
 *   crops are used, and a page a finding names stays unread (it may exist).
 * - `stored`: the pages, in page order.
 */
export type StageSourcePages =
  | { status: 'none' }
  | { status: 'unreadable' }
  | { status: 'stored'; pages: StoredSourcePage[] };

/** The pages stored for one Stage (`StageSourcePages`). Never throws. */
export async function readStageSourcePages(
  stageId: string,
  classroomsDir: string = CLASSROOMS_DIR,
): Promise<StageSourcePages> {
  if (!isValidClassroomId(stageId)) return { status: 'none' };
  let raw: string;
  try {
    raw = await fs.readFile(path.resolve(classroomsDir, stageId, INDEX_FILE), 'utf8');
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') return { status: 'none' };
    log.warn(`stage ${stageId}: its book-page index could not be read; the crops are used`);
    return { status: 'unreadable' };
  }
  try {
    const parsed = JSON.parse(raw) as { schema?: unknown; pages?: unknown };
    if (parsed.schema !== INDEX_SCHEMA || !Array.isArray(parsed.pages)) throw new Error('shape');
    const pages = parsed.pages.map(storedPage);
    if (pages.some((page) => page === null)) throw new Error('entry');
    return {
      status: 'stored',
      pages: (pages as StoredSourcePage[]).sort((a, b) => a.pageNumber - b.pageNumber),
    };
  } catch {
    log.warn(`stage ${stageId}: its book-page index is not readable; the crops are used`);
    return { status: 'unreadable' };
  }
}
