import { describe, it, expect } from 'vitest';
import {
  SLIDE_CONTENT_KINDS,
  SLIDE_CONTENT_KINDS_BY_ROLE,
  SLIDE_CONTENT_ROLES,
  isSlideContentKind,
  isSlideContentKindForRole,
  isSlideContentRole,
  isSlideType,
  validateGeneratedSlideSemantics,
  validateScene,
  validateSlideContentSemantics,
  type SlideContent,
  type SlideContentSemantics,
  type ValidationResult,
} from '@openmaic/dsl';

const errors = (r: ValidationResult) => (r.valid ? [] : r.errors.map((e) => e.path));

const VALID_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['explanation', 'concept'],
  ['explanation', 'definition'],
  ['explanation', 'rule'],
  ['explanation', 'observation'],
  ['activity', 'investigation'],
  ['activity', 'source_analysis'],
  ['activity', 'reflection'],
  ['activity', 'production'],
  ['practice', 'guided'],
  ['practice', 'independent'],
  ['practice', 'higher_order'],
];

const INVALID_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['example', 'concept'],
  ['summary', 'guided'],
  ['procedure', 'observation'],
  ['orientation', 'reflection'],
  ['worked_example', 'guided'],
  ['check_understanding', 'independent'],
  // A real kind, but of a different role.
  ['explanation', 'guided'],
  ['activity', 'concept'],
  ['practice', 'investigation'],
];

describe('slide content role/kind vocabulary', () => {
  it('pins the agreed roles', () => {
    expect([...SLIDE_CONTENT_ROLES]).toEqual([
      'orientation',
      'explanation',
      'example',
      'worked_example',
      'procedure',
      'activity',
      'practice',
      'check_understanding',
      'summary',
    ]);
  });

  it('does not treat learning objectives as a role of their own', () => {
    expect(isSlideContentRole('learning_objectives')).toBe(false);
  });

  it('pins the agreed kinds per role; all other roles have none', () => {
    expect(SLIDE_CONTENT_KINDS_BY_ROLE).toEqual({
      orientation: [],
      explanation: ['concept', 'definition', 'rule', 'observation'],
      example: [],
      worked_example: [],
      procedure: [],
      activity: ['investigation', 'source_analysis', 'reflection', 'production'],
      practice: ['guided', 'independent', 'higher_order'],
      check_understanding: [],
      summary: [],
    });
  });

  it('has a kinds entry for every role, and the flat kind list is their exact union', () => {
    expect(Object.keys(SLIDE_CONTENT_KINDS_BY_ROLE).sort()).toEqual(
      [...SLIDE_CONTENT_ROLES].sort(),
    );
    const fromTable = Object.values(SLIDE_CONTENT_KINDS_BY_ROLE).flat();
    expect([...fromTable].sort()).toEqual([...SLIDE_CONTENT_KINDS].sort());
    // No kind is shared between roles, so a kind always identifies its role.
    expect(new Set(fromTable).size).toBe(fromTable.length);
  });

  it('keeps scene-type, slide-type and layout vocabulary out of the semantic unions', () => {
    const foreign = [
      'slide',
      'quiz',
      'interactive',
      'pbl',
      'cover',
      'contents',
      'transition',
      'content',
      'end',
    ];
    for (const value of foreign) {
      expect(isSlideContentRole(value)).toBe(false);
      expect(isSlideContentKind(value)).toBe(false);
    }
  });

  it('guards reject non-strings', () => {
    for (const value of [undefined, null, 0, {}, []]) {
      expect(isSlideContentRole(value)).toBe(false);
      expect(isSlideContentKind(value)).toBe(false);
      expect(isSlideContentKindForRole('explanation', value)).toBe(false);
    }
  });

  it.each(VALID_PAIRS)('isSlideContentKindForRole accepts %s + %s', (role, kind) => {
    expect(isSlideContentRole(role) && isSlideContentKindForRole(role, kind)).toBe(true);
  });

  it.each(INVALID_PAIRS)('isSlideContentKindForRole rejects %s + %s', (role, kind) => {
    expect(isSlideContentRole(role) && isSlideContentKindForRole(role, kind)).toBe(false);
  });

  it('binds role and kind at the type level for producers', () => {
    const ok: SlideContentSemantics = { contentRole: 'practice', contentKind: 'guided' };
    const roleOnly: SlideContentSemantics = { contentRole: 'summary' };
    // @ts-expect-error — `summary` has no content kinds
    const bad: SlideContentSemantics = { contentRole: 'summary', contentKind: 'guided' };
    // @ts-expect-error — `concept` specializes `explanation`, not `example`
    const crossed: SlideContentSemantics = { contentRole: 'example', contentKind: 'concept' };
    // A well-formed pairing is assignable onto the flat persisted fields.
    const content: Pick<SlideContent, 'contentRole' | 'contentKind'> = ok;
    expect([ok, roleOnly, bad, crossed, content]).toHaveLength(5);
  });
});

describe('validateScene — slide content semantics', () => {
  const withContent = (content: Record<string, unknown>) => ({
    id: 'sc1',
    stageId: 'st1',
    type: 'slide',
    title: 'Intro',
    order: 0,
    content,
  });
  const scene = (extra: Record<string, unknown>) =>
    withContent({ type: 'slide', canvas: { id: 'c' }, ...extra });

  it('accepts a legacy slide scene with no contentRole, contentKind or Slide.type', () => {
    expect(validateScene(scene({}))).toEqual({ valid: true });
  });

  it('accepts a legacy slide scene that has only the canvas Slide.type', () => {
    const legacy = withContent({ type: 'slide', canvas: { id: 'c', type: 'contents' } });
    expect(validateScene(legacy)).toEqual({ valid: true });
  });

  it.each(SLIDE_CONTENT_ROLES.map((role) => [role]))('accepts role %s without a kind', (role) => {
    expect(validateScene(scene({ contentRole: role }))).toEqual({ valid: true });
  });

  it.each(VALID_PAIRS)('accepts %s + %s', (contentRole, contentKind) => {
    expect(validateScene(scene({ contentRole, contentKind }))).toEqual({ valid: true });
  });

  it.each(INVALID_PAIRS)('rejects %s + %s', (contentRole, contentKind) => {
    const r = validateScene(scene({ contentRole, contentKind }));
    expect(r.valid).toBe(false);
    expect(errors(r)).toEqual(['/content/contentKind']);
  });

  it('rejects an unknown role, reporting it once', () => {
    const r = validateScene(scene({ contentRole: 'learning_objectives', contentKind: 'concept' }));
    expect(errors(r)).toEqual(['/content/contentRole']);
  });

  it('rejects an unknown kind', () => {
    const r = validateScene(scene({ contentRole: 'explanation', contentKind: 'bogus' }));
    expect(errors(r)).toEqual(['/content/contentKind']);
  });

  it('rejects a kind without a role', () => {
    const r = validateScene(scene({ contentKind: 'concept' }));
    expect(errors(r)).toEqual(['/content/contentKind']);
  });

  it('rejects non-string values', () => {
    expect(errors(validateScene(scene({ contentRole: 3 })))).toEqual(['/content/contentRole']);
    expect(errors(validateScene(scene({ contentRole: 'practice', contentKind: null })))).toEqual([
      '/content/contentKind',
    ]);
  });

  it('still reports a missing canvas alongside bad semantics', () => {
    const bad = withContent({ type: 'slide', contentRole: 'summary', contentKind: 'guided' });
    expect(errors(validateScene(bad))).toEqual(['/content/canvas', '/content/contentKind']);
  });

  it('does not apply slide semantics to other scene kinds', () => {
    const quiz = {
      ...scene({}),
      type: 'quiz',
      content: { type: 'quiz', questions: [], contentRole: 'bogus', contentKind: 'bogus' },
    };
    expect(validateScene(quiz)).toEqual({ valid: true });
  });
});

describe('validateSlideContentSemantics', () => {
  it('accepts an object with neither field', () => {
    expect(validateSlideContentSemantics({})).toEqual({ valid: true });
  });
  it('accepts a valid pair and rejects an invalid one', () => {
    expect(
      validateSlideContentSemantics({ contentRole: 'activity', contentKind: 'reflection' }),
    ).toEqual({
      valid: true,
    });
    expect(
      errors(
        validateSlideContentSemantics({ contentRole: 'procedure', contentKind: 'observation' }),
      ),
    ).toEqual(['/contentKind']);
  });
  it('rejects non-objects', () => {
    expect(validateSlideContentSemantics(null).valid).toBe(false);
    expect(validateSlideContentSemantics('explanation').valid).toBe(false);
  });
});

describe('validateGeneratedSlideSemantics (strict, newly generated content only)', () => {
  const slide = (canvasType: unknown, extra: Record<string, unknown> = {}) => ({
    type: 'slide',
    canvas: { id: 'c', elements: [], ...(canvasType !== undefined && { type: canvasType }) },
    ...extra,
  });
  const ASSISTANCE = { hint: '<p>h</p>', explanation: '<p>e</p>' };

  it('requires a slide type, and a role on instructional slides only', () => {
    expect(isSlideType('cover')).toBe(true);
    expect(isSlideType('hero')).toBe(false);
    expect(errors(validateGeneratedSlideSemantics(slide(undefined)))).toEqual(['/canvas/type']);
    expect(errors(validateGeneratedSlideSemantics(slide('hero')))).toContain('/canvas/type');
    for (const type of ['cover', 'content']) {
      expect(errors(validateGeneratedSlideSemantics(slide(type)))).toEqual(['/contentRole']);
    }
    // Structural-only exception: no role is required — but a given one is checked.
    for (const type of ['contents', 'transition', 'end']) {
      expect(validateGeneratedSlideSemantics(slide(type))).toEqual({ valid: true });
    }
    expect(validateGeneratedSlideSemantics(slide('end', { contentRole: 'summary' }))).toEqual({
      valid: true,
    });
    expect(errors(validateGeneratedSlideSemantics(slide('end', { contentRole: 'game' })))).toEqual([
      '/contentRole',
    ]);
  });

  it('requires the kind where the role defines kinds and forbids it elsewhere', () => {
    expect(
      errors(validateGeneratedSlideSemantics(slide('content', { contentRole: 'explanation' }))),
    ).toEqual(['/contentKind']);
    expect(
      errors(
        validateGeneratedSlideSemantics(
          slide('content', { contentRole: 'example', contentKind: 'concept' }),
        ),
      ),
    ).toEqual(['/contentKind']);
  });

  it('allows assistance only with practice / check_understanding and requires it for independent practice', () => {
    const practice = (contentKind: string, extra: Record<string, unknown> = {}) =>
      slide('content', { contentRole: 'practice', contentKind, ...extra });
    expect(
      validateGeneratedSlideSemantics(practice('independent', { assistance: ASSISTANCE })),
    ).toEqual({ valid: true });
    expect(errors(validateGeneratedSlideSemantics(practice('independent')))).toEqual([
      '/assistance/hint',
      '/assistance/explanation',
    ]);
    expect(validateGeneratedSlideSemantics(practice('guided'))).toEqual({ valid: true });
    expect(
      validateGeneratedSlideSemantics(
        slide('content', { contentRole: 'check_understanding', assistance: { hint: 'h' } }),
      ),
    ).toEqual({ valid: true });
    expect(
      errors(
        validateGeneratedSlideSemantics(
          slide('content', { contentRole: 'worked_example', assistance: ASSISTANCE }),
        ),
      ),
    ).toEqual(['/assistance']);
    expect(
      errors(validateGeneratedSlideSemantics(practice('guided', { assistance: { answer: 'x' } }))),
    ).toEqual(['/assistance/answer']);
  });

  it('rejects slide-only fields on non-slide content, while the lenient validator stays tolerant', () => {
    const quiz = { type: 'quiz', questions: [], contentRole: 'practice', assistance: ASSISTANCE };
    expect(errors(validateGeneratedSlideSemantics(quiz))).toEqual(['/contentRole', '/assistance']);
    // Persisted legacy slides (no type, no role) are never judged by the strict check.
    expect(validateSlideContentSemantics({})).toEqual({ valid: true });
  });
});
