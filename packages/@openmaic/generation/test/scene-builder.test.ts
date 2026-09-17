import { describe, expect, it } from 'vitest';
import { validateScene } from '@openmaic/dsl';
import {
  applyOutlineFallbacks,
  buildCompleteScene,
  changeOutlineType,
  type GeneratedSceneContent,
  type SceneOutline,
  type SceneTeachingSkills,
} from '@openmaic/generation';
import { nanoid } from 'nanoid';
import { pblOutline, quizOutline, slideOutline, widgetOutline } from './scene-fixtures.js';

const content = {
  elements: [
    {
      id: 'text-1',
      type: 'text' as const,
      left: 0,
      top: 0,
      width: 400,
      height: 80,
      content: 'Dependency injection',
      rotate: 0,
      lineHeight: 1,
      fill: '#000000',
      vertical: false,
      defaultFontName: 'Arial',
      defaultColor: '#000000',
    },
  ],
};

describe('buildCompleteScene', () => {
  it('uses a random scene id by default', () => {
    const first = buildCompleteScene(slideOutline(), content, [], 'stage-1');
    const second = buildCompleteScene(slideOutline(), content, [], 'stage-1');
    expect(first?.id).toBeTruthy();
    expect(second?.id).toBeTruthy();
    expect(first?.id).not.toBe(second?.id);
  });

  it('honors an injected id across retries/upserts', () => {
    const first = buildCompleteScene(slideOutline(), content, [], 'stage-1', {
      sceneId: 'stable-scene-id',
    });
    const retry = buildCompleteScene(slideOutline(), content, [], 'stage-1', {
      sceneId: 'stable-scene-id',
    });
    expect(first?.id).toBe('stable-scene-id');
    expect(retry?.id).toBe(first?.id);
    expect(first?.outlineId).toBe('slide-1');
    expect(validateScene(first)).toEqual({ valid: true });
  });
});

describe('buildCompleteScene — Teaching Skills carrier (Module 2 W9)', () => {
  /**
   * The §K shape on purpose: `primary feynman v1` + `supporting feynman v2` is
   * the same canonical Skill twice under different exact versions. W12's
   * duplicate detection must be able to catch it (keying on the id) while
   * resolution keys on the pair — this wave's carrier must merely PRESERVE the
   * distinction, never validate it.
   */
  const skills: SceneTeachingSkills = {
    primary: { skillId: 'feynman-learning', version: 'v1' },
    supporting: [
      { skillId: 'learning-to-learn', version: 'v1' },
      { skillId: 'feynman-learning', version: 'v2' },
    ],
    classification: 'instructional',
  };

  function outlineOf(
    type: SceneOutline['type'],
    teachingSkills?: SceneTeachingSkills,
  ): SceneOutline {
    const base =
      type === 'slide'
        ? slideOutline()
        : type === 'quiz'
          ? quizOutline()
          : type === 'interactive'
            ? widgetOutline()
            : pblOutline();
    return { ...base, ...(teachingSkills !== undefined && { teachingSkills }) };
  }

  function contentOf(type: SceneOutline['type']): GeneratedSceneContent {
    switch (type) {
      case 'slide':
        return { elements: [], background: { type: 'color', color: '#fff' } } as never;
      case 'quiz':
        return { questions: [] } as never;
      case 'interactive':
        return { html: '<p/>', widgetType: 'diagram', widgetConfig: {} } as never;
      case 'pbl':
        return { projectV2: { id: nanoid() } } as never;
    }
  }

  it.each(['slide', 'quiz', 'interactive', 'pbl'] as const)(
    'copies the carrier verbatim onto a %s scene and it survives document-JSON persistence',
    (type) => {
      const scene = buildCompleteScene(outlineOf(type, skills), contentOf(type), [], 'stage-9');
      // Copied exactly — the same-reference seam `teachingStage` uses.
      expect(scene?.teachingSkills).toEqual(skills);
      // The document store persists scene JSON; a reload returns the carrier
      // intact, primary/supporting refs and classification unchanged (VAL-TS-013).
      const reloaded = JSON.parse(JSON.stringify(scene)) as NonNullable<typeof scene>;
      expect(reloaded.teachingSkills).toEqual(skills);
    },
  );

  it.each(['slide', 'quiz', 'interactive', 'pbl'] as const)(
    'omits the carrier entirely when the outline has none — legacy stays legacy (%s)',
    (type) => {
      const scene = buildCompleteScene(outlineOf(type), contentOf(type), [], 'stage-9');
      expect(scene?.teachingSkills).toBeUndefined();
      expect('teachingSkills' in (scene ?? {})).toBe(false);
    },
  );

  it('preserves a non-instructional classification with no Skill assignment', () => {
    // BR-TS-025: a genuinely structural Scene carries its classification without
    // a fabricated primary. The carrier holds that shape unvalidated until W12.
    const structural: SceneTeachingSkills = { classification: 'non-instructional' };
    const scene = buildCompleteScene(
      outlineOf('slide', structural),
      contentOf('slide'),
      [],
      'stage-9',
    );
    expect(scene?.teachingSkills).toEqual(structural);
  });

  it('changeOutlineType preserves the carrier across type changes', () => {
    for (const targetType of ['slide', 'quiz', 'interactive', 'pbl'] as const) {
      const changed = changeOutlineType(outlineOf('slide', skills), targetType);
      expect(changed.teachingSkills).toEqual(skills);
    }
  });

  it('applyOutlineFallbacks preserves the carrier through the interactive→slide fallback', () => {
    const interactive = outlineOf('interactive', skills) as SceneOutline;
    delete (interactive as Partial<SceneOutline>).interactiveConfig;
    delete (interactive as Partial<SceneOutline>).widgetType;
    delete (interactive as Partial<SceneOutline>).widgetOutline;
    const fallback = applyOutlineFallbacks(interactive, true);
    expect(fallback.type).toBe('slide');
    expect(fallback.teachingSkills).toEqual(skills);
  });
});
