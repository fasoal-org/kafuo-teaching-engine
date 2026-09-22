import { describe, expect, it } from 'vitest';
import { validateScene } from '@openmaic/dsl';
import {
  applyOutlineFallbacks,
  assertGeneratedSlideScene,
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

  it('applyOutlineFallbacks never turns a config-less interactive outline into a slide', () => {
    const interactive = outlineOf('interactive', skills) as SceneOutline;
    delete (interactive as Partial<SceneOutline>).interactiveConfig;
    delete (interactive as Partial<SceneOutline>).widgetType;
    delete (interactive as Partial<SceneOutline>).widgetOutline;
    expect(() => applyOutlineFallbacks(interactive, true)).toThrow(/OUTLINE_SCENE_CONFIG_INVALID/);
    expect(interactive.type).toBe('interactive');
  });
});

describe('buildCompleteScene — slide semantics (outline → final Slide)', () => {
  const classified = (semantics: Partial<SceneOutline>): SceneOutline => ({
    ...slideOutline(),
    ...semantics,
  });
  const slideContentOf = (scene: ReturnType<typeof buildCompleteScene>) => {
    if (!scene || scene.content.type !== 'slide') throw new Error('expected a slide scene');
    return scene.content;
  };

  it('builds the lesson opening as slide / cover / orientation', () => {
    const scene = buildCompleteScene(
      classified({ slideType: 'cover', contentRole: 'orientation' }),
      content,
      [],
      'stage-1',
    );
    expect(scene?.type).toBe('slide');
    const slide = slideContentOf(scene);
    expect(slide.canvas.type).toBe('cover');
    expect(slide.contentRole).toBe('orientation');
    expect(slide).not.toHaveProperty('contentKind');
    expect(validateScene(scene)).toEqual({ valid: true });
  });

  it.each([
    ['content', 'explanation', 'concept'],
    ['content', 'explanation', 'definition'],
    ['content', 'activity', 'source_analysis'],
    ['content', 'practice', 'guided'],
  ] as const)('preserves %s / %s / %s unchanged', (slideType, contentRole, contentKind) => {
    const scene = buildCompleteScene(
      classified({ slideType, contentRole, contentKind }),
      content,
      [],
      'stage-1',
    );
    const slide = slideContentOf(scene);
    expect(slide.canvas.type).toBe(slideType);
    expect(slide).toMatchObject({ contentRole, contentKind });
    expect(validateScene(scene)).toEqual({ valid: true });
  });

  it('keeps a role without kinds free of any contentKind', () => {
    const slide = slideContentOf(
      buildCompleteScene(
        classified({ slideType: 'content', contentRole: 'worked_example' }),
        content,
        [],
        'stage-1',
      ),
    );
    expect(slide.contentRole).toBe('worked_example');
    expect(slide).not.toHaveProperty('contentKind');
  });

  it('places the metadata only where the shared contract puts it', () => {
    const scene = buildCompleteScene(
      classified({ slideType: 'content', contentRole: 'practice', contentKind: 'guided' }),
      content,
      [],
      'stage-1',
    );
    // Slide.type on the canvas; role/kind on SlideContent — no parallel copy
    // on the Scene or inside the canvas.
    expect(scene).not.toHaveProperty('slideType');
    expect(scene).not.toHaveProperty('contentRole');
    expect(scene).not.toHaveProperty('contentKind');
    const slide = slideContentOf(scene);
    expect(slide).not.toHaveProperty('slideType');
    expect(slide.canvas).not.toHaveProperty('contentRole');
    expect(slide.canvas).not.toHaveProperty('contentKind');
  });

  it('never infers a classification: an unclassified outline builds the legacy shape', () => {
    // Title, description and key points all scream "summary"; the generated
    // element says "Dependency injection". None of it is read.
    const scene = buildCompleteScene(
      {
        ...slideOutline(),
        title: 'Summary',
        description: 'Summary of the lesson and closing',
        keyPoints: ['Summary', 'Conclusion'],
      },
      content,
      [],
      'stage-1',
    );
    const slide = slideContentOf(scene);
    expect(slide.canvas).not.toHaveProperty('type');
    expect(slide).not.toHaveProperty('contentRole');
    expect(slide).not.toHaveProperty('contentKind');
    expect(Object.keys(slide).sort()).toEqual(['canvas', 'type']);
  });

  it('is independent of the generated content: same outline, different elements, same semantics', () => {
    const outline = classified({
      slideType: 'content',
      contentRole: 'explanation',
      contentKind: 'concept',
    });
    const other = { elements: [], background: { type: 'solid' as const, color: '#000000' } };
    const a = slideContentOf(buildCompleteScene(outline, content, [], 'stage-1'));
    const b = slideContentOf(buildCompleteScene(outline, other, [], 'stage-1'));
    expect([a.canvas.type, a.contentRole, a.contentKind]).toEqual([
      b.canvas.type,
      b.contentRole,
      b.contentKind,
    ]);
  });

  it('omits out-of-contract values instead of inventing a fallback', () => {
    const slide = slideContentOf(
      buildCompleteScene(
        classified({
          slideType: 'two_column',
          contentRole: 'summary',
          contentKind: 'guided',
        } as unknown as Partial<SceneOutline>),
        content,
        [],
        'stage-1',
      ),
    );
    expect(slide.canvas).not.toHaveProperty('type');
    expect(slide.contentRole).toBe('summary');
    // `summary` defines no kinds: the stray kind is dropped, none is invented.
    expect(slide).not.toHaveProperty('contentKind');

    const unknownRole = buildCompleteScene(
      classified({
        slideType: 'content',
        contentRole: 'lesson_introduction',
        contentKind: 'concept',
      } as unknown as Partial<SceneOutline>),
      content,
      [],
      'stage-1',
    );
    const unknownRoleSlide = slideContentOf(unknownRole);
    expect(unknownRoleSlide).not.toHaveProperty('contentRole');
    expect(unknownRoleSlide).not.toHaveProperty('contentKind');
    expect(validateScene(unknownRole)).toEqual({ valid: true });
  });

  it('leaves quiz, interactive and pbl scenes byte-for-byte unaffected', () => {
    const stray = { slideType: 'content', contentRole: 'check_understanding' } as const;
    const cases: Array<[SceneOutline, GeneratedSceneContent]> = [
      [quizOutline(), { questions: [] }],
      [widgetOutline(), { html: '<p>hi</p>', widgetType: 'simulation' }],
      [pblOutline(), { projectV2: { id: 'project-1' } } as unknown as GeneratedSceneContent],
    ];
    for (const [outline, generated] of cases) {
      const plain = buildCompleteScene(outline, generated, [], 'stage-1', { sceneId: 'fixed' });
      const withStray = buildCompleteScene({ ...outline, ...stray }, generated, [], 'stage-1', {
        sceneId: 'fixed',
      });
      const strip = (scene: typeof plain) => ({ ...scene, createdAt: 0, updatedAt: 0 });
      expect(strip(withStray)).toEqual(strip(plain));
      expect(JSON.stringify(withStray)).not.toContain('contentRole');
      expect(JSON.stringify(withStray)).not.toContain('slideType');
      expect(withStray?.type).toBe(outline.type);
    }
  });

  it('carries authored assistance beside the canvas, only for a role that allows it', () => {
    const assistance = {
      hint: '<p>Check the units</p>',
      explanation: '<p>Convert, then divide</p>',
    };
    const independent = classified({
      slideType: 'content',
      contentRole: 'practice',
      contentKind: 'independent',
    });
    const built = buildCompleteScene(independent, { ...content, assistance }, [], 'stage-1');
    expect(slideContentOf(built).assistance).toEqual(assistance);
    expect(slideContentOf(built).canvas).not.toHaveProperty('assistance');
    expect(validateScene(built)).toEqual({ valid: true });
    expect(() => assertGeneratedSlideScene(built!)).not.toThrow();

    const example = classified({ slideType: 'content', contentRole: 'example' });
    const other = buildCompleteScene(example, { ...content, assistance }, [], 'stage-1');
    expect(slideContentOf(other)).not.toHaveProperty('assistance');
  });

  it('assertGeneratedSlideScene fails a new scene with missing semantics instead of shipping it', () => {
    const build = (semantics: Partial<SceneOutline>) =>
      buildCompleteScene(classified(semantics), content, [], 'stage-1')!;
    // Unclassified, instructional-without-role, and independent practice without assistance.
    for (const semantics of [
      {},
      { slideType: 'content' },
      { slideType: 'content', contentRole: 'practice', contentKind: 'independent' },
    ] as Partial<SceneOutline>[]) {
      expect(() => assertGeneratedSlideScene(build(semantics))).toThrow(
        /OUTLINE_SLIDE_SEMANTICS_INVALID/,
      );
    }
    // The structural-only exception, and non-slide scenes, pass.
    expect(() => assertGeneratedSlideScene(build({ slideType: 'transition' }))).not.toThrow();
    const quiz = buildCompleteScene(quizOutline(), { questions: [] }, [], 'stage-1')!;
    expect(() => assertGeneratedSlideScene(quiz)).not.toThrow();
  });
});
