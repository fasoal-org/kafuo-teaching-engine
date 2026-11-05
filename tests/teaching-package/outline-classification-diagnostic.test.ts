/**
 * 5 Nov 2026: a governed outline answer once carried a Skill id
 * ("feynman-learning") as its instructional classification. Nothing checked it
 * until Submit and AI slide insertion, which then refused the whole package.
 * The app-authority diagnosis now reports it as admin-correctable, and the
 * value is never guessed (BR-TS-054).
 */
import { describe, expect, it } from 'vitest';

import { appOutlineDiagnostics } from '@/lib/server/teaching-package/outline-correction';
import type { SceneOutline } from '@/lib/types/generation';

function outline(id: string, classification: unknown): SceneOutline {
  return {
    id,
    type: 'slide',
    title: id,
    description: '',
    keyPoints: [],
    order: 1,
    teachingSkills: { classification } as SceneOutline['teachingSkills'],
  } as SceneOutline;
}

const context = (governed: boolean) => ({
  flow: [],
  contentUnitIds: null,
  sourceImages: [],
  governed,
});

describe('appOutlineDiagnostics — instructional classification', () => {
  it('reports a classification outside the closed vocabulary, per outline', () => {
    const diagnostics = appOutlineDiagnostics(
      [
        outline('ok-1', 'instructional'),
        outline('bad', 'feynman-learning'),
        outline('ok-2', 'non-instructional'),
      ],
      context(true),
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'SCENE_CLASSIFICATION_INVALID',
        disposition: 'admin_correctable',
        outlineIndex: 1,
        outlineId: 'bad',
        field: 'teachingSkills',
        allowedValues: ['instructional', 'non-instructional'],
      }),
    ]);
    expect(diagnostics[0]!.message).toContain('feynman-learning');
  });

  it('leaves an absent classification to the submit gate, as before', () => {
    const missing = { ...outline('none', undefined), teachingSkills: undefined } as SceneOutline;
    expect(appOutlineDiagnostics([missing], context(true))).toEqual([]);
  });

  it('checks nothing on an ungoverned run', () => {
    expect(appOutlineDiagnostics([outline('bad', 'feynman-learning')], context(false))).toEqual([]);
  });
});
