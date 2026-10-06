import { describe, expect, test, vi } from 'vitest';

import { generateSceneContent, resolveImageIds } from '@openmaic/generation';
import type { GeneratedSlideData, PdfImage } from '@openmaic/generation';

import { slideOutline } from './scene-fixtures.js';

function imageElement(src: string): GeneratedSlideData['elements'][number] {
  return {
    id: 'el_1',
    type: 'image',
    src,
    left: 0,
    top: 0,
    width: 400,
    height: 300,
    rotate: 0,
    fixedRatio: false,
  };
}

describe('resolveImageIds — transport decided by the mapping value shape (RFC #1153 part 2 B)', () => {
  test('writes the allocated asset id into src when the mapping value is an asset id', () => {
    const resolved = resolveImageIds([imageElement('img_1')], {
      img_1: 'ast_allocated_image_0001',
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ type: 'image', src: 'ast_allocated_image_0001' });
  });

  test('writes the base64 data URL into src when the mapping value is a data URL', () => {
    const dataUrl = 'data:image/png;base64,AQID';
    const resolved = resolveImageIds([imageElement('img_1')], { img_1: dataUrl });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ type: 'image', src: dataUrl });
  });

  test('removes an image whose id has no mapping entry, in both transports', () => {
    const resolved = resolveImageIds([imageElement('img_9')], { img_1: 'ast_something' });
    expect(resolved).toHaveLength(0);
  });

  test('leaves generated-media placeholders untouched (async backfill path)', () => {
    const resolved = resolveImageIds([imageElement('gen_img_alpha_001')], {
      img_1: 'ast_something',
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ type: 'image', src: 'gen_img_alpha_001' });
  });
});

/**
 * Teaching Package source visuals ride the SAME `imageMapping` channel as
 * course-generation images, but the Teaching Package mints its logical ids as
 * `src-<n>` (see `lib/server/teaching-package/source-images.ts`) while course
 * generation mints `img_<n>`. Before this boundary recognized the `src-` shape,
 * `generateClassroom` supplied a correct mapping and `resolveImageIds` walked
 * straight past every `src-<n>` reference, so the scene persisted a bare
 * `src-11` that the renderer could only treat as an unrenderable placeholder.
 */
describe('resolveImageIds \u2014 Teaching Package source-visual ids (`src-<n>`)', () => {
  const SERVING_PATH = '/api/classroom-media/stage-abc/media/src_11_deadbeef.png';

  test('resolves a source-visual id to its mapped /api/classroom-media path', () => {
    const resolved = resolveImageIds([imageElement('src-1')], {
      'src-1': '/api/classroom-media/stage-abc/media/src_1_0a1b2c3d.png',
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      type: 'image',
      src: '/api/classroom-media/stage-abc/media/src_1_0a1b2c3d.png',
    });
  });

  test('resolves multi-digit source-visual ids (src-11, src-123)', () => {
    const resolved = resolveImageIds([imageElement('src-11'), imageElement('src-123')], {
      'src-11': SERVING_PATH,
      'src-123': '/api/classroom-media/stage-abc/media/src_123_99887766.png',
    });

    expect(resolved.map((el) => (el.type === 'image' ? el.src : undefined))).toEqual([
      SERVING_PATH,
      '/api/classroom-media/stage-abc/media/src_123_99887766.png',
    ]);
  });

  test('course-generation `img_<n>` resolution is unchanged alongside source ids', () => {
    const resolved = resolveImageIds([imageElement('img_1'), imageElement('src-1')], {
      img_1: 'ast_allocated_image_0001',
      'src-1': SERVING_PATH,
    });

    expect(resolved.map((el) => (el.type === 'image' ? el.src : undefined))).toEqual([
      'ast_allocated_image_0001',
      SERVING_PATH,
    ]);
  });

  test('`gen_img_*` placeholders stay untouched even when a source mapping is present', () => {
    const resolved = resolveImageIds([imageElement('gen_img_alpha_001')], {
      'src-1': SERVING_PATH,
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ type: 'image', src: 'gen_img_alpha_001' });
  });

  test('concrete URLs and paths are never rewritten by a source mapping', () => {
    const dataUrl = 'data:image/png;base64,AQID';
    const resolved = resolveImageIds(
      [
        imageElement(dataUrl),
        imageElement('https://cdn.example.com/figure.png'),
        imageElement('http://cdn.example.com/figure.png'),
        imageElement(SERVING_PATH),
      ],
      { 'src-1': SERVING_PATH },
    );

    expect(resolved.map((el) => (el.type === 'image' ? el.src : undefined))).toEqual([
      dataUrl,
      'https://cdn.example.com/figure.png',
      'http://cdn.example.com/figure.png',
      SERVING_PATH,
    ]);
  });

  test('an UNMAPPED source id is dropped \u2014 never persisted as a bare `src-<n>`', () => {
    const resolved = resolveImageIds([imageElement('src-9')], { 'src-1': SERVING_PATH });
    expect(resolved).toHaveLength(0);
  });

  test('an UNSUPPORTED logical source reference is dropped, not persisted as a relative URL', () => {
    // A model-invented shape ("src-abc") has no mapping entry and is not a
    // browser-resolvable address; keeping it would make the renderer request
    // `/<scene>/src-abc`. It takes the same drop path as an unmapped id.
    const resolved = resolveImageIds([imageElement('src-abc')], { 'src-1': SERVING_PATH });
    expect(resolved).toHaveLength(0);
  });
});

describe('generateSceneContent — non-vision text ordering with a mapping present (RFC #1153 part 2, review P3)', () => {
  test('visionEnabled off + imageMapping present lists images in the ORIGINAL sorted order, not slices-concatenated', async () => {
    // Fixture where the full vision-priority interleave ≠ mapped-then-unmapped
    // concat: img_1 and img_3 carry a mapping entry, img_2 and img_4 do not,
    // and they INTERLEAVE in the sort (priority desc, then pageNumber asc).
    // Concatenating [mapped, unmapped] would yield img_1, img_3, img_2, img_4;
    // the pre-partition `sortedAssignedImages` order is the interleave
    // img_1, img_2, img_3, img_4 — which the non-vision text must restore.
    const assignedImages: PdfImage[] = [
      { id: 'img_1', src: '', pageNumber: 1, visionPriority: 2 },
      { id: 'img_2', src: '', pageNumber: 2, visionPriority: 1 },
      { id: 'img_3', src: '', pageNumber: 3, visionPriority: 1 },
      { id: 'img_4', src: '', pageNumber: 4, visionPriority: 0 },
    ];
    const imageMapping = { img_1: 'ast_1', img_3: 'ast_3' };
    let userPrompt = '';
    const aiCall = vi.fn(async (_system: string, user: string) => {
      userPrompt = user;
      return JSON.stringify({ elements: [], remark: '' });
    });

    await generateSceneContent(slideOutline(), aiCall, {
      assignedImages,
      imageMapping,
      visionEnabled: false,
    });

    const availableMedia = userPrompt.split('- **Available Media**:')[1] ?? '';
    const ids = [...availableMedia.matchAll(/\*\*(img_\d+)\*\*/g)].map((match) => match[1]);
    expect(ids).toEqual(['img_1', 'img_2', 'img_3', 'img_4']);
    // No `[see attached]` promise in the non-vision text.
    expect(availableMedia).not.toContain('[see attached]');
  });
});
