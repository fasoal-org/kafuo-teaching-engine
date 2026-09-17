/**
 * The Content-Unit grounding gate, checked directly.
 *
 * Blocks are absent from this file on purpose: the model is never shown a
 * `[[BLOCK]]` marker and is never asked to cite one, so there is no block-level
 * grounding left to validate. The manifest still carries blocks — see
 * `normalized-content-resource.test.ts` — they are simply not the model's
 * concern.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  assertOutlineContentUnitGrounding,
  findUngroundedOutlines,
  manifestContentUnitIds,
  OUTLINE_GROUNDING_ERROR_CODE,
} from '@/lib/server/teaching-package/outline-grounding';
import type { NormalizedLessonManifest } from '@/lib/server/teaching-package/normalized-content-resource';
import type { SceneOutline } from '@/lib/types/generation';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/** Ids are strings in the manifest, exactly as Kafuo exports them (`str(...)`). */
const MANIFEST = {
  contentUnits: [
    { id: '2900', orderIndex: 0, role: 'INSTRUCTIONAL', normalizedText: 'a', blocks: [{ id: '51061' }] },
    { id: '2901', orderIndex: 1, role: 'INSTRUCTIONAL', normalizedText: 'b', blocks: [{ id: '51062' }] },
  ],
} as unknown as NormalizedLessonManifest;

const outline = (grounding: Partial<SceneOutline>): SceneOutline =>
  ({
    id: 'scene_1',
    type: 'slide',
    title: 'S',
    description: '',
    keyPoints: [],
    order: 1,
    ...grounding,
  }) as SceneOutline;

const check = (outlines: SceneOutline[]) =>
  assertOutlineContentUnitGrounding(outlines, MANIFEST, 'attempt-1', 1);

describe('content-unit grounding validation', () => {
  it('accepts valid string ids', () => {
    expect(() => check([outline({ sourceContentUnitIds: ['2900'] })])).not.toThrow();
  });

  it('accepts several ids on one outline', () => {
    expect(() => check([outline({ sourceContentUnitIds: ['2900', '2901'] })])).not.toThrow();
  });

  it('accepts numeric ids, which is what "copy it exactly" actually produces', () => {
    // The projection shows the model `[[CONTENT_UNIT id=2900]]` — bare and unquoted. A
    // model copying that faithfully emits a JSON number, and `Set<string>.has(2900)` is
    // false. That mismatch failed every outline of a provably correct package at once.
    expect(() =>
      check([outline({ sourceContentUnitIds: [2900] as unknown as string[] })]),
    ).not.toThrow();
  });

  it('normalizes numeric ids to strings on the outline itself', () => {
    // Accepting a numeric id must not persist one: the declared type is `string[]`,
    // and persistence, the Editor-save merge and successor cloning all carry this
    // value onward untouched. The gate is the one place that can make it true.
    const numeric = outline({ sourceContentUnitIds: [2900, 2901] as unknown as string[] });
    check([numeric]);
    expect(numeric.sourceContentUnitIds).toEqual(['2900', '2901']);
    for (const id of numeric.sourceContentUnitIds!) expect(typeof id).toBe('string');
  });

  it('leaves already-string ids untouched', () => {
    const strings = outline({ sourceContentUnitIds: ['2900'] });
    check([strings]);
    expect(strings.sourceContentUnitIds).toEqual(['2900']);
  });

  it('accepts an outline that carries no block ids at all', () => {
    const grounded = outline({ sourceContentUnitIds: ['2900'] });
    expect('sourceBlockIds' in grounded).toBe(false);
    expect(() => check([grounded])).not.toThrow();
  });

  it('ignores a legacy sourceBlockIds field rather than requiring or checking it', () => {
    // Retained as an optional legacy/internal field for backward compatibility: present
    // or absent, valid or nonsense, it can neither satisfy nor fail the gate.
    expect(() =>
      check([
        outline({
          sourceContentUnitIds: ['2900'],
          sourceBlockIds: ['not-a-real-block'],
        } as Partial<SceneOutline>),
      ]),
    ).not.toThrow();
  });

  it('rejects a missing sourceContentUnitIds field', () => {
    expect(() => check([outline({})])).toThrowError(/missing or unrecognized/);
  });

  it('rejects an empty sourceContentUnitIds array', () => {
    expect(() => check([outline({ sourceContentUnitIds: [] })])).toThrow();
  });

  it('rejects ids that name nothing in the manifest', () => {
    expect(() => check([outline({ sourceContentUnitIds: ['9999'] })])).toThrow();
  });

  it('rejects a mix of one real and one invented id', () => {
    expect(() => check([outline({ sourceContentUnitIds: ['2900', '9999'] })])).toThrow();
  });

  it('rejects a block id offered in place of a content unit id', () => {
    // Block ids are not citable: they are not in the unit id set, so this is ungrounded.
    expect(() => check([outline({ sourceContentUnitIds: ['51061'] })])).toThrow();
  });

  it('fails the run when any single outline is ungrounded', () => {
    expect(() =>
      check([
        outline({ sourceContentUnitIds: ['2900'] }),
        outline({ sourceContentUnitIds: ['2901'] }),
        outline({}),
      ]),
    ).toThrow();
  });

  it('carries the model-output error code, not the package lineage one', () => {
    expect(() => check([outline({})])).toThrowError(
      expect.objectContaining({ code: OUTLINE_GROUNDING_ERROR_CODE }),
    );
    expect(OUTLINE_GROUNDING_ERROR_CODE).toBe('OUTLINE_CONTENT_UNIT_GROUNDING_INVALID');
    expect(OUTLINE_GROUNDING_ERROR_CODE).not.toBe('NORMALIZED_CONTENT_LINEAGE_MISMATCH');
  });

  it('reports which outlines failed and why, without mentioning blocks', () => {
    const faults = findUngroundedOutlines(
      [
        outline({ sourceContentUnitIds: ['2900'] }),
        outline({}),
        outline({ sourceContentUnitIds: [] }),
        outline({ sourceContentUnitIds: ['9999'] }),
      ],
      manifestContentUnitIds(MANIFEST),
    );

    expect(faults.map((f) => f.index)).toEqual([1, 2, 3]);
    expect(faults[0]!.reasons).toEqual(['sourceContentUnitIds missing']);
    expect(faults[1]!.reasons).toEqual(['sourceContentUnitIds empty']);
    expect(faults[2]!.reasons).toEqual(['unknown content units: 9999']);
    expect(JSON.stringify(faults)).not.toContain('lock');
  });

  it('reads the citable id set from the manifest', () => {
    expect([...manifestContentUnitIds(MANIFEST)]).toEqual(['2900', '2901']);
  });
});
