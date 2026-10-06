import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParsedPdfContent } from '@/lib/types/pdf';
import {
  applySourceVisualPrecedence,
  normalizeSourceImages,
  toVisionPdfImages,
} from '@/lib/server/teaching-package/source-images';
import { makeSlideScene } from '../agent-runtime/_stage-fixtures';

/** Minimal real PNG header bytes (1×1) so magic/dimension checks exercise reality. */
function pngBytes(width = 3, height = 2): Buffer {
  const header = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
    (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff,
    (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff,
    8, 6, 0, 0, 0,
  ]);
  return header;
}

function jpegBytes(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
}

function gifBytes(): Buffer {
  return Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x05, 0x00, 0x04, 0x00, 0, 0]);
}

function webpBytes(): Buffer {
  return Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, // RIFF....WEBP
    0x56, 0x50, 0x38, 0x20, // "VP8 " lossy
    0, 0, 0, 0, 0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0xf0, 0x01, 0xa7, 0x02, 0xb4, 0x03,
  ]);
}

function dataUrl(bytes: Buffer, mime: string): string {
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function parsed(images: Array<{ id: string; src: string; pageNumber: number; description?: string }>): ParsedPdfContent {
  return {
    text: 'pdf text',
    images: images.map((image) => image.src),
    metadata: {
      pageCount: 2,
      pdfImages: images,
    },
  } as ParsedPdfContent;
}

describe('normalizeSourceImages', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('normalizes the four provider shapes and mints src-<n> ids', () => {
    const result = normalizeSourceImages(
      parsed([
        { id: 'img_1', src: dataUrl(pngBytes(), 'image/png'), pageNumber: 1 },
        { id: '../../etc/passwd', src: dataUrl(jpegBytes(), 'image/jpeg'), pageNumber: 2 },
        { id: 'mineru-3', src: dataUrl(gifBytes(), 'image/gif'), pageNumber: 0 },
        { id: 'cloud-4', src: dataUrl(webpBytes(), 'image/webp'), pageNumber: 3, description: 'a figure' },
      ]),
    );
    expect(result.dropped).toBe(0);
    expect(result.images.map((image) => image.id)).toEqual([
      'src-1',
      'src-2',
      'src-3',
      'src-4',
    ]);
    // pageNumber <= 0 becomes unknown (null), never a fake page.
    expect(result.images[2]!.pageNumber).toBeNull();
    expect(result.images[3]!.description).toBe('a figure');
    // Dimensions derived from the PNG header.
    expect(result.images[0]).toMatchObject({ width: 3, height: 2 });
    // Traversal-shaped provider ids never become filenames — retained as provenance only.
    expect(result.images[1]!.providerImageId).toBe('../../etc/passwd');
  });

  it('drops unsupported data-URL shapes and non-data URLs, counting them', () => {
    const result = normalizeSourceImages(
      parsed([
        { id: 'ok', src: dataUrl(pngBytes(), 'image/png'), pageNumber: 1 },
        { id: 'svg', src: 'data:image/svg+xml;base64,PHN2Zw==', pageNumber: 1 },
        { id: 'http', src: 'https://evil.example.test/x.png', pageNumber: 1 },
        { id: 'garbage', src: 'not-a-url', pageNumber: 1 },
      ]),
    );
    expect(result.images).toHaveLength(1);
    expect(result.dropped).toBe(3);
  });

  it('drops a declared MIME that does not match the actual magic bytes', () => {
    const pngAsJpeg = dataUrl(pngBytes(), 'image/jpeg');
    const result = normalizeSourceImages(parsed([{ id: 'x', src: pngAsJpeg, pageNumber: 1 }]));
    expect(result.images).toHaveLength(0);
    expect(result.dropped).toBe(1);
  });

  it('enforces the decoded size limit', () => {
    vi.stubEnv('TEACHING_PACKAGE_SOURCE_IMAGE_MAX_BYTES', '16');
    const result = normalizeSourceImages(
      parsed([{ id: 'x', src: dataUrl(pngBytes(2000, 2000), 'image/png'), pageNumber: 1 }]),
    );
    expect(result.images).toHaveLength(0);
    expect(result.dropped).toBe(1);
  });

  it('produces the vision channel with stable ids and data URLs', () => {
    const { images } = normalizeSourceImages(
      parsed([{ id: 'img_1', src: dataUrl(pngBytes(), 'image/png'), pageNumber: 4 }]),
    );
    const vision = toVisionPdfImages(images);
    expect(vision[0]).toMatchObject({ id: 'src-1', pageNumber: 4 });
    expect(vision[0]!.src.startsWith('data:image/png;base64,')).toBe(true);
  });
});

describe('materializeSourceImages', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'srcvis-'));
    vi.stubEnv('OPENMAIC_CLASSROOMS_DIR', tmp);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it('writes content-addressed safe filenames, dedupes identical bytes, and builds the manifest', async () => {
    const { images } = normalizeSourceImages(
      parsed([
        { id: 'a', src: dataUrl(pngBytes(), 'image/png'), pageNumber: 1 },
        { id: 'b', src: dataUrl(pngBytes(), 'image/png'), pageNumber: 2 },
      ]),
    );
    // CLASSROOMS_DIR binds at module load; re-import under the stubbed env.
    vi.resetModules();
    const { materializeSourceImages } = await import('@/lib/server/teaching-package/source-images');
    // Same bytes → same content hash, two logical ids.
    const { servingMapping, visionMapping, manifest } = await materializeSourceImages(
      images,
      'Stage_ok1',
      'cs-9',
    );
    expect(Object.keys(servingMapping)).toEqual(['src-1', 'src-2']);
    expect(servingMapping['src-1']).toMatch(/^\/api\/classroom-media\/Stage_ok1\/media\/src_1_[0-9a-f]{8}\.png$/);
    expect(servingMapping['src-2']).toMatch(/^\/api\/classroom-media\/Stage_ok1\/media\/src_2_[0-9a-f]{8}\.png$/);
    // Identical bytes → identical content hash fragment in both names.
    const hashOf = (value: string) => value.match(/_([0-9a-f]{8})\.png$/)![1];
    expect(hashOf(servingMapping['src-2']!)).toBe(hashOf(servingMapping['src-1']!));
    expect(manifest).toHaveLength(2);
    expect(manifest[0]).toMatchObject({
      id: 'src-1',
      contentResourceId: 'cs-9',
      pageNumber: 1,
      mimeType: 'image/png',
    });
    expect(manifest[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(visionMapping['src-1']!.startsWith('data:image/png;base64,')).toBe(true);
    const files = await fs.readdir(path.join(tmp, 'Stage_ok1', 'media'));
    expect(files).toHaveLength(2); // one content-addressed file per logical id
    for (const file of files) expect(file).toMatch(/^src_[12]_[0-9a-f]{8}\.png$/);
  });

  it('refuses an invalid stage id (path traversal never reaches the filesystem)', async () => {
    const { images } = normalizeSourceImages(
      parsed([{ id: 'a', src: dataUrl(pngBytes(), 'image/png'), pageNumber: 1 }]),
    );
    vi.resetModules();
    const { materializeSourceImages } = await import('@/lib/server/teaching-package/source-images');
    await expect(materializeSourceImages(images, '../escape', 'cs-9')).rejects.toThrow(
      /valid stage media directory/,
    );
    await expect(materializeSourceImages(images, 'ok/id', 'cs-9')).rejects.toThrow(
      /valid stage media directory/,
    );
  });
});

describe('applySourceVisualPrecedence (per visual need)', () => {
  function slide(outlineId: string, srcs: string[]) {
    const scene = makeSlideScene(`scene-${outlineId}`, 'stage-x', 1, 'S');
    (scene.content as { canvas: { elements: unknown[] } }).canvas.elements = srcs.map(
      (src, index) => ({ id: `el-${index}`, type: 'image', src }),
    );
    return { ...scene, outlineId };
  }

  it('one selected source visual + one unrelated AI placeholder → both survive', () => {
    // By precedence time the selected reference is already RESOLVED to its
    // serving path (resolveImageIds ran during slide generation).
    const scenes = [
      slide('o1', ['/api/classroom-media/stage-x/media/src_1_aaaa.png', 'gen_img_extra1']),
    ];
    const outlines = [
      {
        id: 'o1',
        suggestedImageIds: ['src-1'],
        mediaGenerations: [{ type: 'image', elementId: 'gen_img_extra1' }],
      },
    ];
    applySourceVisualPrecedence(scenes, outlines, {
      'src-1': '/api/classroom-media/stage-x/media/src_1_aaaa.png',
    });
    const elements = (scenes[0] as { content: { canvas: { elements: Array<{ src: string }> } } })
      .content.canvas.elements;
    // The selected source visual is placed as its own element; the unrelated
    // placeholder keeps its request and stays a placeholder.
    expect(elements.map((el) => el.src)).toEqual([
      '/api/classroom-media/stage-x/media/src_1_aaaa.png',
      'gen_img_extra1',
    ]);
    expect(outlines[0]!.mediaGenerations).toHaveLength(1);
  });

  it('a placeholder competing with an unplaced selected source visual loses: the source wins and the request is dropped', () => {
    const scenes = [slide('o1', ['gen_img_1'])];
    const outlines = [
      {
        id: 'o1',
        suggestedImageIds: ['src-1'],
        mediaGenerations: [
          { type: 'image', elementId: 'gen_img_1' },
          { type: 'video', elementId: 'gen_vid_1' },
        ],
      },
    ];
    applySourceVisualPrecedence(scenes, outlines, {
      'src-1': '/api/classroom-media/stage-x/media/src_1_bbbb.png',
    });
    const elements = (scenes[0] as { content: { canvas: { elements: Array<{ src: string }> } } })
      .content.canvas.elements;
    expect(elements[0]!.src).toBe('/api/classroom-media/stage-x/media/src_1_bbbb.png');
    // The image generation request is dropped; the video request is untouched.
    expect(outlines[0]!.mediaGenerations).toEqual([{ type: 'video', elementId: 'gen_vid_1' }]);
  });

  it('an already-referenced selected visual is not duplicated onto placeholders', () => {
    const scenes = [slide('o1', ['/api/classroom-media/stage-x/media/src_1_cccc.png', 'gen_img_1'])];
    const outlines = [
      {
        id: 'o1',
        suggestedImageIds: ['src-1'],
        mediaGenerations: [{ type: 'image', elementId: 'gen_img_1' }],
      },
    ];
    applySourceVisualPrecedence(scenes, outlines, {
      'src-1': '/api/classroom-media/stage-x/media/src_1_cccc.png',
    });
    const elements = (scenes[0] as { content: { canvas: { elements: Array<{ src: string }> } } })
      .content.canvas.elements;
    expect(elements[1]!.src).toBe('gen_img_1'); // unrelated need keeps its request
    expect(outlines[0]!.mediaGenerations).toHaveLength(1);
  });
});
