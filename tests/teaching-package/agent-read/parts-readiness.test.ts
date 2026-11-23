/**
 * Agent read API lesson parts and readiness mapping (Kafuo Agent API A3), plus
 * the LRU that caches the scene projection.
 */
import { describe, expect, it } from 'vitest';

import { unitBadge as panelUnitBadge } from '@/components/edit/LessonPartsPanel';
import { unitBadge } from '@/lib/edit/lesson-part-badge';
import { LruCache, sceneProjectionCacheKey } from '@/lib/server/teaching-package/agent-read/cache';
import { projectAgentParts } from '@/lib/server/teaching-package/agent-read/parts';
import {
  buildAgentReadiness,
  editorLock,
} from '@/lib/server/teaching-package/agent-read/readiness';
import type { UnitCoverage } from '@/lib/server/teaching-package/content-unit-coverage';

function unit(id: string, order: number, partial: Partial<UnitCoverage> = {}): UnitCoverage {
  return {
    id,
    order,
    title: `جزء ${order}`,
    role: 'CONCEPT',
    instructional: true,
    textLength: 100,
    coveredBySlideIds: [],
    citedByOtherSceneIds: [],
    covered: false,
    ...partial,
  };
}

describe('projectAgentParts', () => {
  const units = [
    { ...unit('5010', 1, { covered: true, coveredBySlideIds: ['s3', 's4'] }), text: 'شرح' },
    { ...unit('5011', 2, { citedByOtherSceneIds: ['q1'] }), text: 'سؤال' },
    { ...unit('5012', 3, { role: 'WHY_CONTEXT' }), text: 'الربط مع الحياة' },
    { ...unit('5013', 4, { textLength: 0 }), text: '' },
    { ...unit('5040', 5, { instructional: false, role: 'OBJECTIVES' }), text: null },
    {
      ...unit('5050', 6, { covered: true, coveredBySlideIds: ['s17'] }),
      text: '1. احسب الكتلة\n2. احسب المولات\n3. قارن',
      subtype: 'PRACTICE_SET',
    },
  ];
  const parts = projectAgentParts({
    units,
    essentialUnitIds: ['5010', '5012'],
    bookUnits: [
      { contentUnitId: '5050', kind: 'PRACTICE', element: 'exercise', required: false },
      { contentUnitId: '5010', kind: 'CONCEPT', element: 'concept', required: true },
    ],
  });

  it('badges each part exactly as the editor panel does', () => {
    expect(parts.map((part) => [part.part_id, part.badge, part.can_generate])).toEqual([
      ['5010', 'covered', false],
      ['5011', 'quiz_only', true],
      ['5012', 'no_slide', true],
      ['5013', 'no_slide', false],
      ['5040', 'reference', false],
      ['5050', 'covered', false],
    ]);
    for (const entry of units) expect(unitBadge(entry)).toBe(panelUnitBadge(entry as never));
  });

  it('carries essential, exercise and the slides that teach it', () => {
    expect(parts[0]).toEqual({
      part_id: '5010',
      order: 1,
      title: 'جزء 1',
      content_unit_id: '5010',
      role: 'CONCEPT',
      subtype: null,
      essential: true,
      exercise: false,
      exercise_count: null,
      badge: 'covered',
      taught_by_scene_ids: ['s3', 's4'],
      cited_by_other_scene_ids: [],
      can_generate: false,
      book_pages: null,
    });
    expect(parts[2]).toMatchObject({ essential: true, exercise: false });
    expect(parts[5]).toMatchObject({ exercise: true, exercise_count: 3, subtype: 'PRACTICE_SET' });
  });

  it('answers null when the version records no coverage authority or book map', () => {
    const [first] = projectAgentParts({ units, essentialUnitIds: null, bookUnits: null });
    expect(first).toMatchObject({ essential: null, exercise: null, exercise_count: null });
  });
});

describe('readiness', () => {
  const idle = {
    stageLockedReason: null,
    runningRegenerations: 0,
    runningInsertion: false,
    generationStatus: 'succeeded',
  };

  it('names the first lock that applies', () => {
    expect(editorLock(idle)).toEqual({ locked: false, lock_reason: null });
    expect(
      editorLock({ ...idle, stageLockedReason: 'in_review', runningRegenerations: 1 }),
    ).toEqual({ locked: true, lock_reason: 'stage_locked:in_review' });
    expect(editorLock({ ...idle, runningRegenerations: 1 }).lock_reason).toBe(
      'slide_regeneration_running',
    );
    expect(editorLock({ ...idle, runningInsertion: true }).lock_reason).toBe(
      'slide_insertion_running',
    );
    expect(editorLock({ ...idle, generationStatus: 'running' }).lock_reason).toBe(
      'generation_running',
    );
  });

  it('lists every blocker and counts scenes by type', () => {
    const body = buildAgentReadiness({
      version: { id: 'tpv-1', status: 'draft' },
      lock: idle,
      blockers: [
        { code: 'SLIDES_NEED_REGENERATION', message: 'm1', details: { slides: [] } },
        { code: 'ESSENTIAL_SECTION_UNCOVERED', message: 'm2', details: { unitIds: ['5012'] } },
      ],
      scenes: [{ type: 'slide' }, { type: 'slide' }, { type: 'quiz' }, { type: 'interactive' }],
    });
    expect(body).toEqual({
      version_id: 'tpv-1',
      status: 'draft',
      generation_status: 'succeeded',
      editor: { locked: false, lock_reason: null },
      send_for_approval: {
        allowed: false,
        blocked_by: [
          { code: 'SLIDES_NEED_REGENERATION', message: 'm1', details: { slides: [] } },
          { code: 'ESSENTIAL_SECTION_UNCOVERED', message: 'm2', details: { unitIds: ['5012'] } },
        ],
      },
      counts: { scenes: 4, slides: 2, quizzes: 1 },
    });
  });
});

describe('LruCache', () => {
  it('evicts the least recently used entry', () => {
    const cache = new LruCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.size).toBe(2);
    expect(sceneProjectionCacheKey('v', 's', 3)).not.toBe(sceneProjectionCacheKey('v', 's', 4));
  });
});
