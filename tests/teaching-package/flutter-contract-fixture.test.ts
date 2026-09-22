/**
 * RSS Wave 6 (§9.2a, T-16) — the cross-solution contract fixture.
 *
 * The Flutter classroom pins a Stage document in
 * `Zakrly-mobile-app/test/features/classroom/fixtures/te_contract_stage.json`.
 * That file is NOT hand-written: it is what the Teaching Engine's real scene
 * builder emits for one slide of every assistance-relevant variant plus a
 * structural slide, a legacy (unclassified) slide and a quiz, after passing the
 * DSL validators. This test regenerates the document and fails when the two
 * drift, so a contract change on this side cannot silently break the app.
 *
 * It is a TE-BUILT fixture, not a live capture: the live-endpoint capture of
 * §9.2(b) still has to be taken from a real environment.
 *
 * Re-seed (after a reviewed contract change):
 *   UPDATE_TE_CONTRACT_FIXTURE=1 pnpm vitest run tests/teaching-package/flutter-contract-fixture.test.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateGeneratedSlideSemantics, validateScene } from '@openmaic/dsl';
import { buildCompleteScene, type SceneOutline } from '@openmaic/generation';

const FIXTURE = resolve(
  process.cwd(),
  '../Zakrly-mobile-app/test/features/classroom/fixtures/te_contract_stage.json',
);

const text = (content: string) => ({
  id: 'text-1',
  type: 'text' as const,
  left: 60,
  top: 60,
  width: 880,
  height: 76,
  content,
  rotate: 0,
  lineHeight: 1.5,
  fill: '',
  vertical: false,
  defaultFontName: 'Arial',
  defaultColor: '#333333',
});

function outline(order: number, extra: Partial<SceneOutline>): SceneOutline {
  return {
    id: `outline_${order}`,
    type: 'slide',
    title: `Scene ${order}`,
    description: 'planner note — never delivered',
    keyPoints: ['k'],
    order,
    ...extra,
  };
}

const ASSISTANCE = {
  hint: '<p>انظر إلى الوحدات</p>',
  help: '<p>السرعة تربط المسافة بالزمن</p>',
  explanation: '<p>اقسم ١٢ على ١٫٥ لتحصل على ٨ كم/س</p>',
};

function buildDocument() {
  const plan: Array<[SceneOutline, { assistance?: typeof ASSISTANCE }]> = [
    [
      outline(1, {
        slideType: 'cover',
        contentRole: 'orientation',
        visualPlan: { mode: 'native' },
      }),
      {},
    ],
    // Kafuo R1 P4: a generated Scene cites the Content Units it was grounded
    // in (`sourceContentUnitIds`, optional; absent = unknown on the app side).
    [
      outline(2, {
        slideType: 'content',
        contentRole: 'worked_example',
        sourceContentUnitIds: ['2900', '2901'],
      }),
      {},
    ],
    [outline(3, { slideType: 'content', contentRole: 'practice', contentKind: 'guided' }), {}],
    [
      outline(4, { slideType: 'content', contentRole: 'practice', contentKind: 'independent' }),
      { assistance: ASSISTANCE },
    ],
    [
      outline(5, { slideType: 'content', contentRole: 'check_understanding' }),
      { assistance: { hint: ASSISTANCE.hint } as typeof ASSISTANCE },
    ],
    [outline(6, { slideType: 'transition' }), {}],
  ];
  const scenes = plan.map(([planned, generated], index) => {
    const scene = buildCompleteScene(
      planned,
      { elements: [text(`<p>محتوى ${index + 1}</p>`)], ...generated } as never,
      [],
      'stage-contract',
      { sceneId: `scene-${index + 1}` },
    )!;
    // Exactly what a generation path asserts before persisting.
    expect(validateGeneratedSlideSemantics(scene.content), planned.id).toEqual({ valid: true });
    expect(validateScene(scene), planned.id).toEqual({ valid: true });
    return { ...scene, createdAt: 1, updatedAt: 1, content: stabilise(scene.content) };
  });

  // A legacy slide: persisted before classification existed. Never re-classified.
  const legacy = buildCompleteScene(
    outline(7, {}),
    { elements: [text('<p>Legacy</p>')] } as never,
    [],
    'stage-contract',
    { sceneId: 'scene-7' },
  )!;
  const quiz = buildCompleteScene(
    { ...outline(8, {}), type: 'quiz' },
    { questions: [] },
    [],
    'stage-contract',
    { sceneId: 'scene-8' },
  )!;

  return {
    stage: {
      id: 'stage-contract',
      name: 'السرعة المتوسطة',
      createdAt: 1,
      updatedAt: 1,
      language: 'ar',
      textDirection: 'rtl',
    },
    scenes: [
      ...scenes,
      { ...legacy, createdAt: 1, updatedAt: 1, content: stabilise(legacy.content) },
      { ...quiz, createdAt: 1, updatedAt: 1 },
    ],
  };
}

/** Random canvas ids are the only non-deterministic bytes the builder emits. */
function stabilise<T>(content: T): T {
  const copy = structuredClone(content) as { canvas?: { id?: string } };
  if (copy.canvas) copy.canvas.id = 'canvas';
  return copy as T;
}

describe('Flutter contract fixture (TE-built)', () => {
  it('matches what the Teaching Engine builder emits today', () => {
    const document = `${JSON.stringify(buildDocument(), null, 2)}\n`;
    // Planner documents are not learner delivery: the fixture is `{ stage, scenes }`.
    expect(document).not.toContain('planner note');
    expect(document).not.toContain('visualPlan');

    if (process.env.UPDATE_TE_CONTRACT_FIXTURE === '1') {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, document);
    }
    if (!existsSync(dirname(dirname(FIXTURE)))) return; // the app repo is not checked out here
    expect(readFileSync(FIXTURE, 'utf-8')).toBe(document);
  });
});
