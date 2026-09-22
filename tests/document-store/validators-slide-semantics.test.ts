import { describe, expect, it } from 'vitest';

import { validateAppScene } from '@/lib/document-store/validators';
import { migrateScene, migrateSlideContent } from '@/lib/edit/slide-schema';
import { applySlideEdit } from '@/lib/server/agent-runtime/course-edit/apply';
import type { Scene, SlideContent } from '@/lib/types/stage';
import { makeSlideScene } from '../agent-runtime/_stage-fixtures';

function slideSceneWith(extra: Record<string, unknown>): Scene {
  const scene = makeSlideScene('scene-1', 'stage-1', 1, 'T');
  return { ...scene, content: { ...scene.content, ...extra } } as Scene;
}

describe('validateAppScene slide contentRole / contentKind', () => {
  it('accepts a legacy slide scene without contentRole, contentKind or Slide.type', () => {
    const scene = makeSlideScene('scene-1', 'stage-1', 1, 'T');
    expect(scene.content).not.toHaveProperty('contentRole');
    expect(scene.content).not.toHaveProperty('contentKind');
    expect(validateAppScene(scene).valid).toBe(true);
  });

  it.each([
    ['orientation', undefined],
    ['explanation', 'concept'],
    ['explanation', 'definition'],
    ['activity', 'investigation'],
    ['practice', 'guided'],
  ])('accepts %s + %s', (contentRole, contentKind) => {
    const extra = contentKind === undefined ? { contentRole } : { contentRole, contentKind };
    expect(validateAppScene(slideSceneWith(extra)).valid).toBe(true);
  });

  it.each([
    ['example', 'concept'],
    ['summary', 'guided'],
    ['procedure', 'observation'],
  ])('rejects %s + %s at the write boundary', (contentRole, contentKind) => {
    const result = validateAppScene(slideSceneWith({ contentRole, contentKind }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.map((error) => error.path)).toEqual(['/content/contentKind']);
    }
  });

  it('rejects an unknown role and a kind without a role', () => {
    const unknownRole = validateAppScene(slideSceneWith({ contentRole: 'learning_objectives' }));
    expect(unknownRole.valid).toBe(false);
    const orphanKind = validateAppScene(slideSceneWith({ contentKind: 'concept' }));
    expect(orphanKind.valid).toBe(false);
  });
});

describe('slide semantics across existing content boundaries', () => {
  const content = slideSceneWith({ contentRole: 'practice', contentKind: 'guided' })
    .content as SlideContent;

  it('survives slide-content migration', () => {
    expect(migrateSlideContent(content)).toMatchObject({
      contentRole: 'practice',
      contentKind: 'guided',
    });
  });

  it('migrating a legacy scene does not fabricate semantics', () => {
    const migrated = migrateScene(makeSlideScene('scene-1', 'stage-1', 1, 'T'));
    expect(migrated.content).not.toHaveProperty('contentRole');
    expect(migrated.content).not.toHaveProperty('contentKind');
  });

  it('survives a canvas edit patch, which validates only the canvas', () => {
    const result = applySlideEdit(content, {
      op: 'patch',
      action: 'set',
      path: '/canvas/type',
      value: 'content',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.canvas.type).toBe('content');
      expect(result.value).toMatchObject({ contentRole: 'practice', contentKind: 'guided' });
    }
  });

  it('is out of reach of canvas-scoped edit patches', () => {
    const result = applySlideEdit(content, {
      op: 'patch',
      action: 'set',
      path: '/contentRole',
      value: 'summary',
    });
    expect(result.ok).toBe(false);
  });
});
