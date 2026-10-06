import { describe, it, expect } from 'vitest';
import { createSceneAPI } from '@/lib/api/stage-api-scene';
import type { StageStore } from '@/lib/api/stage-api-types';
import type { Scene, Stage, StageMode } from '@/lib/types/stage';
import type { SceneTeachingSkills } from '@/lib/types/teaching-package';

function mockStore() {
  const state = {
    stage: { id: 'stage-1', name: 'S', createdAt: 1, updatedAt: 1 } as Stage,
    scenes: [] as Scene[],
    currentSceneId: null as string | null,
    mode: 'edit' as StageMode,
  };
  const store: StageStore = {
    getState: () => state,
    setState: (partial) => Object.assign(state, partial),
    subscribe: () => () => {},
  };
  return { api: createSceneAPI(store), scenes: () => state.scenes };
}

describe('stage api scene.create — type/content authority', () => {
  it('keeps params.type authoritative and pins content.type to it', () => {
    const { api, scenes } = mockStore();
    const r = api.create({ type: 'slide', title: 'T' });
    expect(r.success).toBe(true);
    const scene = scenes()[0];
    expect(scene.type).toBe('slide');
    expect(scene.content.type).toBe('slide');
  });

  it('rejects a content.type that disagrees with the scene type (no silent override)', () => {
    const { api, scenes } = mockStore();
    const r = api.create({
      type: 'slide',
      title: 'T',
      content: { type: 'interactive', html: 'x' },
    });
    expect(r.success).toBe(false);
    expect(scenes()).toHaveLength(0);
  });
});

describe('stage api scene.create — Teaching Skills carrier reaches the store', () => {
  // Module 2 P0: the store spread carried teachingStage but dropped
  // teachingSkills, so the carrier never reached a persisted Scene. The `in`
  // assertions below distinguish an ABSENT key from a present-but-undefined
  // one — the latter would fabricate lineage state on legacy data (AC-TS-034).
  const carrier: SceneTeachingSkills = {
    primary: { skillId: 'feynman-learning', version: 'v1' },
    classification: 'instructional',
  };

  it('persists the carrier on the created scene when supplied', () => {
    const { api, scenes } = mockStore();
    const r = api.create({ type: 'slide', title: 'T', teachingSkills: carrier });
    expect(r.success).toBe(true);
    expect(scenes()[0]!.teachingSkills).toEqual(carrier);
    expect('teachingSkills' in scenes()[0]!).toBe(true);
  });

  it('leaves the key absent when not supplied', () => {
    const { api, scenes } = mockStore();
    const r = api.create({ type: 'slide', title: 'T' });
    expect(r.success).toBe(true);
    expect('teachingSkills' in scenes()[0]!).toBe(false);
  });
});

describe('stage api scene.create — Content Unit binding reaches the store', () => {
  // CLS-C27: the generation path passed sourceContentUnitIds, but create()
  // dropped it, so every generated scene was stored without its binding and
  // Stage Help refused every question (HELP_GROUNDING_UNAVAILABLE).
  it('persists the ids on the created scene when supplied', () => {
    const { api, scenes } = mockStore();
    const ids = ['cu-2', 'cu-1'];
    const r = api.create({ type: 'quiz', title: 'T', sourceContentUnitIds: ids });
    expect(r.success).toBe(true);
    expect(scenes()[0]!.sourceContentUnitIds).toEqual(['cu-2', 'cu-1']);
    // A copy: the caller's array is not shared with the stored scene.
    expect(scenes()[0]!.sourceContentUnitIds).not.toBe(ids);
  });

  it('leaves the key absent when not supplied (never fabricated)', () => {
    const { api, scenes } = mockStore();
    const r = api.create({ type: 'slide', title: 'T' });
    expect(r.success).toBe(true);
    expect('sourceContentUnitIds' in scenes()[0]!).toBe(false);
  });
});
