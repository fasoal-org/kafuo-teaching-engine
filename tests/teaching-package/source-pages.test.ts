/**
 * Page images (contract page-images-export-contract-2026-11-27.md): the whole book pages
 * of a g5.v12 lesson are stored in the Stage media folder and read back, checksum-verified,
 * for the reviewer, where they replace the crops on them. A temp folder only.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  namedBookImages,
  namedPages,
  pickReviewFigures,
  withReviewPages,
  type ReviewFigure,
  type ReviewFigureSet,
} from '@/lib/server/teaching-package/package-review-input';
import { bookFigureLabel } from '@/lib/server/teaching-package/package-review-prompt';
import {
  materializeSourcePages,
  readStageSourcePages,
  sourcePageServingPath,
  type NormalizedSourcePage,
} from '@/lib/server/teaching-package/source-pages';
import { readSourceVisualDataUrl } from '@/lib/server/teaching-package/source-visual-bytes';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'source-pages-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const bytesOf = (salt: number) =>
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 6, 32, 4, 84, salt, 0xff, 0xd9]);
const page = (pageNumber: number, unitIds: string[], salt = pageNumber): NormalizedSourcePage => {
  const data = bytesOf(salt);
  return {
    pageNumber,
    data,
    sha256: createHash('sha256').update(data).digest('hex'),
    width: 1108,
    height: 1568,
    unitIds,
  };
};
const crop = (n: number, unit: string, pageNumber: number | null): ReviewFigure => ({
  name: `src_${n}`,
  unitIds: [unit],
  pageNumber,
  mediaType: 'image/png',
  data: `CROP${n}`,
  tokens: 255,
});

describe('storing and reading the pages of one Stage', () => {
  it('writes one file per page and a Stage-independent index; reads them back in page order', async () => {
    const stored = await materializeSourcePages(
      [page(13, ['6760']), page(12, ['6758'])],
      'stage-1',
      dir,
    );
    expect(stored).toBe(2);
    const files = await fs.readdir(path.join(dir, 'stage-1', 'media'));
    expect(files.sort()).toEqual([
      expect.stringMatching(/^page_0012_[0-9a-f]{8}\.jpg$/),
      expect.stringMatching(/^page_0013_[0-9a-f]{8}\.jpg$/),
    ]);
    // The index sits beside the media folder (never served) and names no Stage.
    const raw = await fs.readFile(path.join(dir, 'stage-1', 'source-pages.json'), 'utf8');
    expect(raw).not.toContain('stage-1');
    const read = await readStageSourcePages('stage-1', dir);
    expect(read.status).toBe('stored');
    const pages = read.status === 'stored' ? read.pages : [];
    expect(pages.map((entry) => [entry.pageNumber, entry.unitIds, entry.width])).toEqual([
      [12, ['6758'], 1108],
      [13, ['6760'], 1108],
    ]);
    // Storing the same pages again is the same files and index.
    await materializeSourcePages([page(12, ['6758']), page(13, ['6760'])], 'stage-1', dir);
    expect((await fs.readdir(path.join(dir, 'stage-1', 'media'))).length).toBe(2);
  });

  it('no index or an unsafe Stage id is "none"; a foreign or broken index is "unreadable"', async () => {
    expect(await readStageSourcePages('stage-2', dir)).toEqual({ status: 'none' });
    expect(await readStageSourcePages('../stage-1', dir)).toEqual({ status: 'none' });
    // Review MEDIUM-B: an index that exists but is not one this TE wrote, or is not JSON.
    await fs.mkdir(path.join(dir, 'stage-3'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'stage-3', 'source-pages.json'),
      JSON.stringify({
        schema: 'te.source-pages.v1',
        pages: [{ pageNumber: 1, fileName: '../x' }],
      }),
    );
    expect(await readStageSourcePages('stage-3', dir)).toEqual({ status: 'unreadable' });
    await fs.writeFile(path.join(dir, 'stage-3', 'source-pages.json'), '{not json');
    expect(await readStageSourcePages('stage-3', dir)).toEqual({ status: 'unreadable' });
    await expect(materializeSourcePages([page(1, [])], '../escape', dir)).rejects.toThrow();
    expect(await materializeSourcePages([], 'stage-4', dir)).toBe(0);
  });
});

describe('the reviewer: pages replace the crops on them', () => {
  async function stagePages() {
    await materializeSourcePages(
      [page(12, ['6758']), page(13, ['6760']), page(14, [])],
      'stage-1',
      dir,
    );
    const read = await readStageSourcePages('stage-1', dir);
    const stored = read.status === 'stored' ? read.pages : [];
    // Page 13's file no longer matches its checksum.
    await fs.writeFile(
      path.join(dir, 'stage-1', 'media', stored[1]!.fileName),
      Buffer.from('tampered'),
    );
    return stored.map((entry) => ({
      ...entry,
      servingPath: sourcePageServingPath('stage-1', entry.fileName),
    }));
  }

  it('a readable page takes the crops on it; an unreadable one is unread and its crops stay', async () => {
    const crops: ReviewFigureSet = {
      figures: [crop(1, '6758', 12), crop(2, '6760', 13), crop(4, '9999', null)],
      // A crop the reader could not read, on a page that is shown whole.
      unreadable: [{ name: 'src_3', unitIds: ['6799'], pageNumber: 12 }],
      unsendable: [],
    };
    const set = await withReviewPages(crops, await stagePages(), (servingPath, expected) =>
      readSourceVisualDataUrl(servingPath, expected, dir),
    );
    expect(
      set.figures.map((figure) => [figure.name, figure.kind, figure.unitIds, figure.covers]),
    ).toEqual([
      ['page_12', 'page', ['6758', '6799'], ['src_1', 'src_3']],
      ['page_14', 'page', [], []],
      ['src_2', undefined, ['6760'], undefined],
      ['src_4', undefined, ['9999'], undefined],
    ]);
    expect(set.figures[0]).toMatchObject({
      mediaType: 'image/jpeg',
      pageNumber: 12,
      tokens: 2_317,
    });
    expect(set.unreadable).toEqual([
      { name: 'page_13', unitIds: ['6760'], pageNumber: 13, kind: 'page' },
    ]);
    // No page: the crops' set as it is.
    expect(await withReviewPages(crops, null)).toBe(crops);
    expect(await withReviewPages(crops, [])).toBe(crops);
  });

  it('the first review wants every page; a re-check its units’ pages and the pages its findings name', () => {
    const pageFigure = (n: number, units: string[], covers: string[]): ReviewFigure => ({
      name: `page_${n}`,
      unitIds: units,
      pageNumber: n,
      mediaType: 'image/jpeg',
      data: `PAGE${n}`,
      tokens: 2_317,
      kind: 'page',
      covers,
    });
    const set: ReviewFigureSet = {
      figures: [
        pageFigure(12, ['6758'], ['src_1']),
        pageFigure(13, ['6760'], ['src_2']),
        pageFigure(14, [], []),
        crop(5, '6799', null),
      ],
      unreadable: [],
    };
    const names = (picked: ReturnType<typeof pickReviewFigures>) =>
      picked.figures.map((figure) => figure.name);
    // The first review: every page of the lesson, and the crops of the judged units.
    expect(
      names(
        pickReviewFigures(set, new Set(['6758', '6799']), 40_000, [], 60_000, { allPages: true }),
      ),
    ).toEqual(['page_12', 'page_13', 'page_14', 'src_5']);
    // A re-check of a slide citing 6760: its page only.
    expect(names(pickReviewFigures(set, new Set(['6760']), 40_000))).toEqual(['page_13']);
    // A finding read from «[الشكل src_1]» or «[الصفحة ١٤]» wants the page holding it.
    expect(
      names(pickReviewFigures(set, new Set(['6760']), 40_000, namedBookImages('[الشكل src_1] 25'))),
    ).toEqual(['page_12', 'page_13']);
    expect(
      names(
        pickReviewFigures(set, new Set(['x']), 40_000, namedBookImages('«[الصفحة ١٤]» الجدول')),
      ),
    ).toEqual(['page_14']);
    // A held page holds the crops it covers too: a finding read from src_2 waits for it.
    const held = pickReviewFigures(set, new Set(['6760']), 0, ['src_2']);
    expect(held.evidence.held).toEqual(['page_13', 'src_2']);
    expect(held.evidence.unreadable).toEqual([]);
    const sent = pickReviewFigures(set, new Set(['6760']), 40_000);
    expect(sent.evidence.sent).toEqual(['page_13', 'src_2']);
  });

  it('reads a page the way a quote may write it, and labels a page with the crops on it', () => {
    // Review H-1: only the rubric's bracketed «[الصفحة N]»; a page number the book prints
    // («تمرين صفحة 45», «page 4») is book text, never a name.
    expect(namedPages('«[الصفحة 12]» و [ الصفحة ١٣ ] و تمرين صفحة 45 و page 4 و page_05')).toEqual([
      'page_12',
      'page_13',
    ]);
    expect(namedPages('[الشكل src_2] 25')).toEqual([]);
    expect(
      bookFigureLabel({
        name: 'page_12',
        unitIds: ['6758', '6799'],
        pageNumber: 12,
        kind: 'page',
        covers: ['src_1', 'src_3'],
      }),
    ).toBe('<<BOOK PAGE 12 | unit_id=6758,6799 | figures=src_1,src_3>>');
    expect(
      bookFigureLabel({ name: 'page_14', unitIds: [], pageNumber: 14, kind: 'page', covers: [] }),
    ).toBe('<<BOOK PAGE 14 | unit_id= | figures=->>');
  });
});
