import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { PdfImage, SceneOutline } from '@openmaic/generation';

import type { AppStage } from '@/lib/document-store/persistence-types';
import { guideAnswerContextOf } from '@/lib/server/teaching-package/guide-answer-context';
import {
  insertOneScene,
  type InsertOneSceneInput,
} from '@/lib/server/teaching-package/insert-one-scene';
import type { AppScene } from '@/lib/types/stage';
import { makeSlideScene } from '../agent-runtime/_stage-fixtures';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/**
 * Reviewer-generated slide plan §10.3: the NEW slide is generated from the
 * normalized planned outline with no caller edit mode, only the eligible
 * images, fallback Actions refused, the narration mark on a voiced package,
 * and the minted `ins_…` outline id.
 */

const STAGE = 'stage-ios';
const stage: AppStage = { id: STAGE, name: 'Lesson', createdAt: 1, updatedAt: 1 } as AppStage;

const outline: SceneOutline = {
  id: 'ins_new',
  type: 'slide',
  order: 3,
  title: 'Friction',
  description: 'brief',
  keyPoints: ['a', 'b', 'c'],
  slideType: 'content',
  contentRole: 'explanation',
  contentKind: 'concept',
  teachingStage: { key: 'explain', flowIndex: 1 },
  sourceContentUnitIds: ['cu_3'],
  suggestedImageIds: ['src-1'],
};

const images: PdfImage[] = [
  { id: 'src-1', src: '/media/stage-ios/src-1.png', pageNumber: 1 } as PdfImage,
  { id: 'src-2', src: '/media/stage-ios/src-2.png', pageNumber: 2 } as PdfImage,
];

function run(overrides: Partial<InsertOneSceneInput> = {}) {
  const generateContent = vi.fn(async () => ({
    elements: [
      {
        id: 'text-1',
        type: 'text',
        content: '<p>Friction</p>',
        left: 10,
        top: 10,
        width: 300,
        height: 50,
        rotate: 0,
        defaultFontName: 'Inter',
        defaultColor: '#111111',
      },
    ],
  }));
  const generateActions = vi.fn(async () => [
    { id: 'a1', type: 'speech', text: 'Friction slows things.' },
  ]);
  const input: InsertOneSceneInput = {
    outline,
    newSceneId: 'scene_new',
    scenes: [
      makeSlideScene('s1', STAGE, 1),
      makeSlideScene('s2', STAGE, 2),
      makeSlideScene('s3', STAGE, 3),
    ],
    stage,
    eligibleImages: images,
    aiCallFor: () => async () => '',
    registerPolicy: null,
    generateContent: generateContent as never,
    generateActions: generateActions as never,
    now: () => 42,
    ...overrides,
  };
  return { input, generateContent, generateActions };
}

describe('insertOneScene', () => {
  it('builds the new slide under the minted ids, without any caller edit mode', async () => {
    const { input, generateContent } = run();
    const result = await insertOneScene(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene).toMatchObject({
      id: 'scene_new',
      outlineId: 'ins_new',
      order: 3,
      type: 'slide',
      teachingStage: { key: 'explain', flowIndex: 1 },
      sourceContentUnitIds: ['cu_3'],
    });
    const options = (
      generateContent.mock.calls[0] as unknown as [unknown, unknown, Record<string, unknown>]
    )[2];
    expect(options).not.toHaveProperty('editDirective');
    expect(options).not.toHaveProperty('baselineContent');
    // Only the eligible images the plan selected.
    expect((options.assignedImages as PdfImage[]).map((image) => image.id)).toEqual(['src-1']);
  });

  it('a g5.v8 package generates the inserted slide under the visible-working rule', async () => {
    const optionsFor = async (teachingModel?: { key: string; version: string }) => {
      const { input, generateContent } = run(teachingModel ? { teachingModel } : {});
      await insertOneScene(input);
      return (
        generateContent.mock.calls[0] as unknown as [unknown, unknown, Record<string, unknown>]
      )[2];
    };
    expect(await optionsFor({ key: 'g5', version: 'g5.v8' })).toMatchObject({
      visibleWorkingSteps: true,
    });
    expect(await optionsFor({ key: 'g5', version: 'g5.v7' })).not.toHaveProperty(
      'visibleWorkingSteps',
    );
    expect(await optionsFor()).not.toHaveProperty('visibleWorkingSteps');
  });

  it('g5.v12 (W2.5, review LOW-1): the inserted slide’s canvas and narration get bookPartOpener; v11 never', async () => {
    const callsFor = async (teachingModel: { key: string; version: string }) => {
      const { input, generateContent, generateActions } = run({ teachingModel });
      await insertOneScene(input);
      const at = (spy: { mock: { calls: unknown[][] } }, index: number) =>
        spy.mock.calls.map((call) => call[index] as Record<string, unknown>);
      return { content: at(generateContent, 2), actions: at(generateActions, 3) };
    };
    const v12 = await callsFor({ key: 'g5', version: 'g5.v12' });
    expect(v12.content.length).toBeGreaterThan(0);
    expect(v12.actions.length).toBeGreaterThan(0);
    for (const options of [...v12.content, ...v12.actions]) {
      expect(options.bookPartOpener).toBe(true);
    }
    const v11 = await callsFor({ key: 'g5', version: 'g5.v11' });
    expect(v11.content.length).toBeGreaterThan(0);
    expect(v11.actions.length).toBeGreaterThan(0);
    for (const options of [...v11.content, ...v11.actions]) {
      expect(options).not.toHaveProperty('bookPartOpener');
    }
  });

  it('places a sentinel for the new slide in the Actions page context', async () => {
    const { input, generateActions } = run();
    await insertOneScene(input);
    const ctx = (
      generateActions.mock.calls[0] as unknown as [
        unknown,
        unknown,
        unknown,
        { ctx: Record<string, unknown> },
      ]
    )[3].ctx;
    expect(ctx).toMatchObject({ pageIndex: 3, totalPages: 4 });
  });

  it('refuses model-free fallback Actions', async () => {
    const generateActions = vi.fn(
      async (
        _o: unknown,
        _c: unknown,
        _a: unknown,
        options: { onFallback: (info: { code: string }) => void },
      ) => {
        options.onFallback({ code: 'invalid-json' });
        return [];
      },
    );
    const { input } = run({ generateActions: generateActions as never });
    const result = await insertOneScene(input);
    expect(result).toMatchObject({ ok: false, code: 'SCENE_ACTION_GENERATION_FAILED' });
  });

  it('a voiced package marks the new slide for the existing audio repair (D-11)', async () => {
    const voiced = {
      ...makeSlideScene('s1', STAGE, 1),
      actions: [{ id: 'sp', type: 'speech', text: 'hello', audioId: 'aud-1' }],
    } as unknown as AppScene;
    const { input } = run({ scenes: [voiced, makeSlideScene('s2', STAGE, 2)] });
    const result = await insertOneScene(input);
    expect(result.ok && result.scene.generationIssues?.[0]?.code).toBe('NARRATION_AUDIO_FAILED');
    const silent = await insertOneScene(run().input);
    expect(silent.ok && silent.scene.generationIssues).toBeFalsy();
  });

  it('an empty content answer fails without assembling a slide', async () => {
    const { input } = run({ generateContent: vi.fn(async () => null) as never });
    expect(await insertOneScene(input)).toMatchObject({
      ok: false,
      code: 'SCENE_CONTENT_GENERATION_FAILED',
    });
  });
});

// H-2 (owner rule, 4 Nov 2026): no verse or hadith item on an inserted exercise slide.
describe('insertOneScene — exercise slide without verse items', () => {
  const VERSE = '﴿هُوَ الَّذِي أَنزَلَ عَلَيْكَ الْكِتَابَ مِنْهُ آيَاتٌ مُّحْكَمَاتٌ﴾';
  const pins = [
    {
      kind: 'quran' as const,
      sha256: createHash('sha256').update(VERSE, 'utf8').digest('hex'),
      sourceBlockId: '41',
      contentUnitId: 'cu_3',
      reference: 'سورة آل عمران الآية: 7',
      used: true,
    },
  ];
  const textElement = (content: string) => ({
    id: 'text-1',
    type: 'text',
    content,
    left: 10,
    top: 10,
    width: 300,
    height: 50,
    rotate: 0,
    defaultFontName: 'Tajawal',
    defaultColor: '#111111',
  });
  const insert = (teachingModel: { key: string; version: string }) =>
    insertOneScene(
      run({
        teachingModel,
        sacred: {
          pins,
          sourceTexts: [`1) بيت الشعر الأول\n2) ${VERSE}`],
          exerciseUnitIds: ['cu_3'],
        },
        generateContent: vi.fn(async () => ({
          elements: [textElement(`<p>1) بيت الشعر الأول</p><p>2) ${VERSE}</p>`)],
        })) as never,
        generateActions: vi.fn(async () => [
          { id: 'a1', type: 'speech', text: `قال تعالى: ${VERSE}` },
          { id: 'a2', type: 'speech', text: 'نحل البيت الأول معًا.' },
        ]) as never,
      }).input,
    );

  it('drops the verse item, shown and spoken, and never leaves an empty speech', async () => {
    const result = await insert({ key: 'g5', version: 'g5.v8' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const shown = JSON.stringify(
      result.scene.content.type === 'slide' ? result.scene.content.canvas.elements : [],
    );
    expect(shown).toContain('بيت الشعر الأول');
    expect(shown).not.toMatch(/[﴾﴿]/);
    const speeches = (result.scene.actions ?? []).filter((action) => action.type === 'speech');
    expect(speeches.map((action) => (action as { text: string }).text)).toEqual([
      'نحل البيت الأول معًا.',
    ]);
  });

  it('keeps the verse before g5.v8', async () => {
    const result = await insert({ key: 'g5', version: 'g5.v7' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.scene.content)).toMatch(/﴿/);
  });
});

// g5.v11 (re-review finding 5c): an inserted try-it slide still stating a checked answer
// after its check is kept and marked like the run's, naming the item, never the answer.
describe('insertOneScene — g5.v11 try-it slide still stating the answer', () => {
  const guideAnswers = guideAnswerContextOf({
    teachingModel: { key: 'g5', version: 'g5.v11' },
    snapshot: {
      bookStructure: {
        templateVersionId: '3',
        rules: [],
        units: [
          {
            contentUnitId: '6234',
            kind: 'UNDERSTANDING_CHECK',
            element: 'try_it',
            required: true,
            partIndex: 1,
          },
        ],
      },
      teacherGuide: {
        guideId: 'tg-1',
        items: [
          {
            contentUnitId: '6234',
            label: '1A',
            status: 'approved',
            answer: { type: 'number', value: 12 },
          },
        ],
      },
    },
    units: [{ unitId: '6234', normalizedText: '1A) الأعداد 3، 6، 9 … ما الحد التالي؟' }],
    language: 'ar',
  })!;
  const tryOutline: SceneOutline = {
    ...outline,
    title: 'جرّب',
    contentRole: 'check_understanding',
    sourceContentUnitIds: ['6234'],
  };
  const line = (text: string) => ({
    elements: [
      {
        id: 'text-1',
        type: 'text',
        content: `<p>${text}</p>`,
        left: 10,
        top: 10,
        width: 300,
        height: 50,
        rotate: 0,
        defaultFontName: 'Tajawal',
        defaultColor: '#111111',
      },
    ],
  });
  const insertTry = (canvas: string, speech: string, withGuide = true) => {
    const generateContent = vi.fn(async () => line(canvas));
    const generateActions = vi.fn(async () => [{ id: 'a1', type: 'speech', text: speech }]);
    const { input } = run({
      outline: tryOutline,
      ...(withGuide ? { guideAnswers } : {}),
      generateContent: generateContent as never,
      generateActions: generateActions as never,
    });
    return { result: insertOneScene(input), generateContent, generateActions };
  };
  const leakIssues = (scene: AppScene) =>
    (scene.generationIssues ?? []).filter((issue) => issue.code === 'GUIDE_ANSWER_LEAK');

  it('a canvas still stating it after its check is kept with a GUIDE_ANSWER_LEAK issue', async () => {
    const { result, generateContent } = insertTry('الحد التالي هو 12', 'جرّب بنفسك.');
    const inserted = await result;
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    // First, then once with the check's correction (naming no value).
    expect(generateContent).toHaveBeenCalledTimes(2);
    const correction = (
      generateContent.mock.calls[1] as unknown as [unknown, unknown, { correctiveNote?: string }]
    )[2].correctiveNote;
    expect(correction).toContain('1A');
    expect(correction).not.toMatch(/12|١٢/);
    const issues = leakIssues(inserted.scene);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('item 1A');
    expect(issues[0]!.message).not.toMatch(/12|١٢/);
  });

  it('a narration still stating it after its retry marks the slide too', async () => {
    const { result, generateActions } = insertTry('ما الحد التالي؟', 'الحد التالي هو 12');
    const inserted = await result;
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    expect(generateActions).toHaveBeenCalledTimes(2);
    expect(leakIssues(inserted.scene).map((issue) => issue.message)).toEqual([
      expect.stringContaining('item 1A'),
    ]);
  });

  it('a try-it slide that states no answer, and an insert without the guide, are unmarked', async () => {
    const clean = await insertTry('ما الحد التالي؟', 'جرّب بنفسك.').result;
    expect(clean.ok && clean.scene.generationIssues).toBeFalsy();
    // g5.v10 (no pinned guide): one content call, nothing checked, nothing marked.
    const plain = insertTry('الحد التالي هو 12', 'الحد التالي هو 12', false);
    const inserted = await plain.result;
    expect(plain.generateContent).toHaveBeenCalledTimes(1);
    expect(inserted.ok && inserted.scene.generationIssues).toBeFalsy();
  });
});
