import { describe, expect, it, vi } from 'vitest';

import type { AppDocumentOutline, AppStage } from '@/lib/document-store/persistence-types';
import { resolveSpeechRegisterPolicy } from '@/lib/server/speech/register-policy';
import { regenerateOneScene } from '@/lib/server/teaching-package/regenerate-one-scene';
import { liftSlideImages } from '@/lib/server/teaching-package/scene-regeneration-images';
import type { AppScene } from '@/lib/types/stage';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/**
 * AT-G + AT-I (single-slide-regeneration-plan §7): the REAL slide content and
 * Action generators run; only the model boundary (`aiCallFor`) is stubbed.
 */

const STAGE_ID = 'stage-regen-unit';
const SRC_3 = `/api/classroom-media/${STAGE_ID}/media/src_3_abcdef12.jpg`;
const SRC_7 = `/api/classroom-media/${STAGE_ID}/media/src_7_99887766.jpg`;
const FOREIGN = 'https://example.com/fabricated.png';
const INSTRUCTION = 'اجعل الشرح أبسط وأضف مثالاً من الحياة اليومية INSTRUCTION-MARK';
const REASON_MARK = 'REASON-MARK the slide had a wrong formula';
const SAUDI =
  'طيب يا شباب، خلونا الحين نشوف هذي الصورة مع بعض. لو ركزنا شوي بنلاحظ النمط اللي يتكرر، وهذا اللي نبي نفهمه اليوم عشان نبني عليه بعدين.';

const ACTIONS_PROMPT = /^# (Slide|Quiz|Interactive|PBL).*Action Generator/m;

function image(src: string, id = 'img-el') {
  return {
    id,
    type: 'image',
    src,
    left: 500,
    top: 100,
    width: 300,
    height: 200,
    rotate: 0,
    fixedRatio: true,
  };
}

function preImage(elements: unknown[] = [image(SRC_3)]): AppScene {
  return {
    id: 'scene-1',
    stageId: STAGE_ID,
    outlineId: 'o1',
    order: 1,
    title: 'الأنماط',
    type: 'slide',
    createdAt: 1,
    updatedAt: 1,
    content: {
      type: 'slide',
      contentRole: 'example',
      canvas: {
        id: 'canvas-1',
        type: 'content',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#fafafa',
          themeColors: ['#123456'],
          fontColor: '#111111',
          fontName: 'Tajawal',
        },
        elements: [
          {
            id: 't1',
            type: 'text',
            content: '<p>الأنماط</p>',
            left: 60,
            top: 60,
            width: 400,
            height: 60,
            rotate: 0,
            defaultFontName: 'Tajawal',
            defaultColor: '#111',
          },
          ...elements,
        ],
      },
    },
    actions: [{ id: 'a1', type: 'speech', text: SAUDI }],
    learningObjectives: [
      { objectiveRef: 'lo-1', snapshot: { statement: 'يتعرف الأنماط' }, capturedAt: 1 },
    ],
    sourceContentUnitIds: ['cu-1'],
  } as unknown as AppScene;
}

const stage = {
  id: STAGE_ID,
  name: 'Stage',
  createdAt: 1,
  updatedAt: 1,
  language: 'ar',
  subjectCode: 'MATH',
  textDirection: 'rtl',
  languageDirective: 'stage directive',
} as unknown as AppStage;

function snapshot(overrides: Record<string, unknown> = {}): AppDocumentOutline {
  return {
    outlines: [
      {
        id: 'o1',
        order: 1,
        type: 'slide',
        title: 'الأنماط',
        description: 'Explain patterns from the figure.',
        keyPoints: ['patterns'],
        slideType: 'content',
        contentRole: 'example',
        suggestedImageIds: ['src-3'],
        visualPlan: { mode: 'image' },
        ...overrides,
      },
    ],
    sourceVisuals: [
      {
        id: 'src-3',
        contentResourceId: '1',
        pageNumber: 3,
        mimeType: 'image/jpeg',
        sha256: 'abcdef12',
        servingPath: SRC_3,
        description: 'a figure of a pattern',
      },
      {
        id: 'src-7',
        contentResourceId: '1',
        pageNumber: 7,
        mimeType: 'image/jpeg',
        sha256: '99887766',
        servingPath: SRC_7,
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  } as unknown as AppDocumentOutline;
}

function content(elements: unknown[]) {
  return JSON.stringify({
    elements: [
      { type: 'text', content: 'الأنماط حولنا', left: 60, top: 60, width: 400, height: 60 },
      ...elements,
    ],
    remark: '',
  });
}

function model(contentReply: string, speech = SAUDI) {
  const prompts: Array<{ stage: string; system: string; user: string }> = [];
  const aiCallFor = (stageLabel: string) => async (system: string, user: string) => {
    prompts.push({ stage: stageLabel, system, user });
    if (ACTIONS_PROMPT.test(system)) return JSON.stringify([{ type: 'text', content: speech }]);
    return contentReply;
  };
  return { prompts, aiCallFor };
}

const policy = resolveSpeechRegisterPolicy({ language: 'ar', subjectCode: 'MATH' });

async function run(
  contentReply: string,
  options: { pre?: AppScene; outline?: AppDocumentOutline; speech?: string } = {},
) {
  const pre = options.pre ?? preImage();
  const stub = model(contentReply, options.speech);
  const result = await regenerateOneScene({
    scene: pre,
    scenes: [pre],
    stage,
    outlineSnapshot: options.outline ?? snapshot(),
    instruction: INSTRUCTION,
    aiCallFor: stub.aiCallFor,
    registerPolicy: policy,
    refuseFallbackActions: true,
    now: () => 42,
  });
  return { result, prompts: stub.prompts, pre };
}

function imageSrcs(scene: AppScene): string[] {
  if (scene.content.type !== 'slide') return [];
  return scene.content.canvas.elements
    .filter((element) => element.type === 'image')
    .map((element) => (element as unknown as { src: string }).src);
}

describe('regenerateOneScene — AT-G', () => {
  it('sends the instruction to the content model, never the reason, and keeps every invariant', async () => {
    const { result, prompts, pre } = await run(content([image('src-3', 'x')]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const contentPrompt = prompts.find((prompt) => prompt.stage === 'scene-content:slide');
    expect(contentPrompt?.user).toContain('INSTRUCTION-MARK');
    expect(contentPrompt?.user).toContain('EDIT MODE');
    for (const prompt of prompts) {
      expect(prompt.system + prompt.user).not.toContain(REASON_MARK);
      expect(prompt.system + prompt.user).not.toContain('REASON-MARK');
    }
    const scene = result.scene;
    expect(scene.id).toBe(pre.id);
    expect(scene.order).toBe(pre.order);
    expect(scene.outlineId).toBe('o1');
    expect(scene.learningObjectives).toEqual(pre.learningObjectives);
    expect(scene.sourceContentUnitIds).toEqual(['cu-1']);
    expect(scene.createdAt).toBe(1);
    if (scene.content.type !== 'slide' || pre.content.type !== 'slide') throw new Error('slide');
    expect(scene.content.canvas.type).toBe('content');
    expect(scene.content.contentRole).toBe('example');
    expect(scene.content.canvas.id).toBe('canvas-1');
    expect(scene.content.canvas.theme).toEqual(pre.content.canvas.theme);
    expect(scene.actions?.find((action) => action.type === 'speech')?.text).toBe(SAUDI);
  });

  it('carries the language directive and the RTL contract into the content prompt', async () => {
    const { prompts } = await run(content([image('src-3', 'x')]));
    const contentPrompt = prompts.find((prompt) => prompt.stage === 'scene-content:slide')!;
    expect(contentPrompt.system + contentPrompt.user).toContain(policy!.directive.slice(0, 40));
    expect(contentPrompt.system + contentPrompt.user).toMatch(/right-to-left|RTL/i);
  });

  it('an unparsable content answer fails with SCENE_CONTENT_GENERATION_FAILED and no Action call', async () => {
    const { result, prompts } = await run('not json');
    expect(result).toMatchObject({ ok: false, code: 'SCENE_CONTENT_GENERATION_FAILED' });
    expect(prompts.filter((prompt) => ACTIONS_PROMPT.test(prompt.system))).toHaveLength(0);
  });

  it('persistent MSA narration fails with SPEECH_REGISTER_NONCOMPLIANT after three Action calls', async () => {
    const msa =
      'مرحبًا بكم يا طلاب. لنبدأ بسؤال بسيط: ماذا يمكن أن تكشفه إجابات مجموعة من الأشخاص؟ قد تبدو الإجابات منفصلة، لكن عند جمعها قد يظهر بينها اتجاه أو نمط يستحق الانتباه.';
    const { result, prompts } = await run(content([image('src-3', 'x')]), { speech: msa });
    expect(result).toMatchObject({ ok: false, code: 'SPEECH_REGISTER_NONCOMPLIANT' });
    expect(prompts.filter((prompt) => ACTIONS_PROMPT.test(prompt.system))).toHaveLength(3);
  });

  it('refuses fallback Actions (an unusable Action answer) with SCENE_ACTION_GENERATION_FAILED', async () => {
    const pre = preImage();
    const prompts: string[] = [];
    const result = await regenerateOneScene({
      scene: pre,
      scenes: [pre],
      stage,
      outlineSnapshot: snapshot(),
      instruction: INSTRUCTION,
      aiCallFor: () => async (system) => {
        prompts.push(system);
        return ACTIONS_PROMPT.test(system) ? 'garbage' : content([image('src-3', 'x')]);
      },
      registerPolicy: policy,
      refuseFallbackActions: true,
    });
    expect(result).toMatchObject({ ok: false, code: 'SCENE_ACTION_GENERATION_FAILED' });
  });

  it('refuses a non-slide Scene', async () => {
    const quiz = {
      ...preImage(),
      type: 'quiz',
      content: { type: 'quiz', questions: [] },
    } as unknown as AppScene;
    const { result } = await run(content([]), { pre: quiz });
    expect(result).toMatchObject({ ok: false, code: 'SCENE_TYPE_NOT_REGENERABLE' });
  });
});

describe('regenerateOneScene — AT-I book images', () => {
  it('src-3 round-trips to exactly its serving path', async () => {
    const { result } = await run(content([image('src-3', 'x')]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(imageSrcs(result.scene)).toEqual([SRC_3]);
  });

  it('with two authorized visuals, keeping only one passes', async () => {
    const outline = snapshot({ suggestedImageIds: ['src-3', 'src-7'] });
    const { result } = await run(content([image('src-7', 'x')]), { outline });
    expect(result.ok).toBe(true);
    if (result.ok) expect(imageSrcs(result.scene)).toEqual([SRC_7]);
  });

  it('swapping to an unassigned src-7 removes it → ORIENTATION_VISUAL_MISSING', async () => {
    const { result } = await run(content([image('src-7', 'x')]));
    expect(result).toMatchObject({ ok: false, code: 'ORIENTATION_VISUAL_MISSING' });
  });

  it('a fabricated https image is removed; the slide passes while an authorized visual remains', async () => {
    const { result } = await run(content([image('src-3', 'x'), image(FOREIGN, 'y')]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(imageSrcs(result.scene)).toEqual([SRC_3]);
  });

  it('a gen_img placeholder is removed: passes beside an authorized visual, fails alone', async () => {
    const kept = await run(content([image('src-3', 'x'), image('gen_img_1', 'y')]));
    expect(kept.result.ok).toBe(true);
    if (kept.result.ok) expect(imageSrcs(kept.result.scene)).toEqual([SRC_3]);
    const alone = await run(content([image('gen_img_1', 'y')]));
    expect(alone.result).toMatchObject({ ok: false, code: 'ORIENTATION_VISUAL_MISSING' });
  });

  it('no resolvable suggested id → SOURCE_VISUAL_UNRESOLVED with zero model calls', async () => {
    const { result, prompts } = await run(content([]), {
      outline: snapshot({ suggestedImageIds: ['src-99'] }),
    });
    expect(result).toMatchObject({ ok: false, code: 'SOURCE_VISUAL_UNRESOLVED' });
    expect(prompts).toHaveLength(0);
  });

  it('a textbook-visual slide whose canvas keeps only a non-textbook image → ORIENTATION_VISUAL_MISSING', async () => {
    const pre = preImage([image(SRC_3), image(FOREIGN, 'img-foreign')]);
    const { result } = await run(content([image('img_1', 'y')]), { pre });
    expect(result).toMatchObject({ ok: false, code: 'ORIENTATION_VISUAL_MISSING' });
  });

  it('a slide without a visual plan keeps its non-textbook baseline image through the img_K mapping', async () => {
    const pre = preImage([image(FOREIGN, 'img-foreign')]);
    const outline = snapshot({ suggestedImageIds: undefined, visualPlan: undefined });
    const { result, prompts } = await run(content([image('img_1', 'y')]), { pre, outline });
    expect(result.ok).toBe(true);
    if (result.ok) expect(imageSrcs(result.scene)).toEqual([FOREIGN]);
    // The baseline the model saw referenced the id, not the URL.
    const user = prompts.find((prompt) => prompt.stage === 'scene-content:slide')!.user;
    expect(user).toContain('img_1');
  });

  it('lifting never puts a non-textbook image in assignedImages', () => {
    const lifted = liftSlideImages({
      canvas: { elements: [image(SRC_3), image(FOREIGN, 'f')] },
      sourceVisuals: snapshot().sourceVisuals,
      suggestedImageIds: ['src-3'],
      visualPlan: { mode: 'image' },
    });
    expect(lifted.ok).toBe(true);
    if (!lifted.ok) return;
    expect(lifted.lifted.assignedImages.map((entry) => entry.id)).toEqual(['src-3']);
    expect(lifted.lifted.imageMapping).toEqual({ 'src-3': SRC_3, img_1: FOREIGN });
    expect(lifted.lifted.baseline.elements.map((el) => (el as { src?: string }).src)).toEqual([
      'src-3',
      'img_1',
    ]);
  });

  it('no media-generation call runs', async () => {
    const media = await import('@/lib/server/classroom-media-generation');
    const spies = Object.keys(media)
      .filter((key) => typeof (media as Record<string, unknown>)[key] === 'function')
      .map((key) => vi.spyOn(media as Record<string, (...args: unknown[]) => unknown>, key));
    await run(content([image('src-3', 'x'), image('gen_img_1', 'y')]));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
