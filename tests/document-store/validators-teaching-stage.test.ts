import { describe, expect, it } from 'vitest';

import { validateAppScene } from '@/lib/document-store/validators';
import { makeSlideScene } from '../agent-runtime/_stage-fixtures';

describe('validateAppScene teachingStage annotation', () => {
  it('accepts a scene without teachingStage (legacy compatible)', () => {
    const result = validateAppScene(makeSlideScene('scene-1', 'stage-1', 1, 'T'));
    expect(result.valid).toBe(true);
  });

  it('accepts a well-formed teachingStage', () => {
    const scene = {
      ...makeSlideScene('scene-1', 'stage-1', 1, 'T'),
      teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
    };
    expect(validateAppScene(scene).valid).toBe(true);
  });

  it('rejects a malformed teachingStage object', () => {
    const scene = {
      ...makeSlideScene('scene-1', 'stage-1', 1, 'T'),
      teachingStage: { key: '', flowIndex: 0 },
    };
    const result = validateAppScene(scene);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: '/teachingStage/key' })]),
      );
    }
  });

  it('rejects a non-integer or negative flowIndex', () => {
    for (const flowIndex of [1.5, -1, '0']) {
      const scene = {
        ...makeSlideScene('scene-1', 'stage-1', 1, 'T'),
        teachingStage: { key: 'k', flowIndex },
      };
      const result = validateAppScene(scene);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: '/teachingStage/flowIndex' })]),
        );
      }
    }
  });

  it('rejects a non-object teachingStage', () => {
    const scene = {
      ...makeSlideScene('scene-1', 'stage-1', 1, 'T'),
      teachingStage: 'lesson_introduction',
    };
    const result = validateAppScene(scene);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: '/teachingStage' })]),
      );
    }
  });
});
