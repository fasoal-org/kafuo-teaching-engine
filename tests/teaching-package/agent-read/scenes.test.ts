/**
 * Agent read API scene projection (Kafuo Agent API A3), on realistic fixtures:
 * a chemistry slide (H₂SO₄, Fe³⁺), a table, a quiz whose explanation names
 * another option, a slide that lost its textbook image, narration with one
 * failed line, overlapping text boxes and a stage-wide Skill requirement
 * failing on three scenes.
 */
import { describe, expect, it } from 'vitest';

import {
  findLayoutOverlaps,
  MIN_OVERLAP_AREA_PX,
} from '@/lib/server/teaching-package/agent-read/layout';
import {
  projectAgentScenes,
  type SceneRegenerationSummary,
} from '@/lib/server/teaching-package/agent-read/scenes';
import { collectSkillRequirementChecks } from '@/lib/server/teaching-package/agent-read/skills';
import { stampReviewedDigests } from '@/lib/server/teaching-package/package-review';
import { sceneEditDigest } from '@/lib/server/teaching-package/package-review-input';
import type { AppScene } from '@/lib/types/stage';
import type { SourceVisualManifestEntry, TeachingFlowEntry } from '@/lib/types/teaching-package';
import { makeSlideScene } from '../../agent-runtime/_stage-fixtures';

const STAGE = 'stage-chem';
const BOOK_IMAGE = '/api/classroom-media/stage-chem/media/src_3_a1b2.png';
const FEYNMAN = { skillId: 'feynman-learning', version: 'v1' };
const LECTURE = { skillId: 'lecture-style', version: 'v1' };

const manifest: SourceVisualManifestEntry[] = [
  {
    id: 'src-3',
    contentResourceId: '641',
    pageNumber: 53,
    mimeType: 'image/png',
    sha256: 'f'.repeat(64),
    servingPath: BOOK_IMAGE,
    sourceContentUnitIds: ['5012'],
    sourceBlockIds: ['61530'],
  },
];

function slide(id: string, order: number, elements: unknown[], extra: Partial<AppScene> = {}) {
  const base = makeSlideScene(id, STAGE, order, `شريحة ${order}`);
  return {
    ...base,
    content: {
      ...(base.content as object),
      type: 'slide',
      contentRole: 'explanation',
      canvas: { ...(base.content as { canvas: object }).canvas, type: 'content', elements },
    },
    ...extra,
  } as AppScene;
}

function text(id: string, html: string, box: [number, number, number, number]) {
  const [left, top, width, height] = box;
  return { id, type: 'text', content: html, left, top, width, height, rotate: 0 };
}

const chemistry = slide(
  'scene-chem',
  1,
  [
    text(
      'el-1',
      '<p>حمض الكبريتيك H<sub>2</sub>SO<sub>4</sub> كتلته المولية ٩٨٫٠٨ g/mol</p>',
      [60, 60, 600, 80],
    ),
    // Overlaps el-1 by 300 × 40 px.
    text('el-2', '<p>أيون الحديد Fe<sup>3+</sup></p>', [360, 100, 400, 60]),
    {
      id: 'el-3',
      type: 'image',
      src: BOOK_IMAGE,
      left: 680,
      top: 200,
      width: 280,
      height: 200,
      rotate: 0,
      fixedRatio: true,
    },
    {
      id: 'el-4',
      type: 'table',
      left: 60,
      top: 300,
      width: 500,
      height: 120,
      rotate: 0,
      colWidths: [0.5, 0.5],
      cellMinHeight: 30,
      outline: {},
      data: [
        [
          { id: 'c1', colspan: 1, rowspan: 1, text: 'المادة' },
          { id: 'c2', colspan: 1, rowspan: 1, text: 'الصيغة' },
        ],
        [
          { id: 'c3', colspan: 1, rowspan: 1, text: 'الماء' },
          { id: 'c4', colspan: 1, rowspan: 1, text: 'H<sub>2</sub>O' },
        ],
      ],
    },
    // Decorative: a text-less shape over everything and a line — never an overlap.
    { id: 'el-5', type: 'shape', left: 0, top: 0, width: 1000, height: 562, rotate: 0, path: '' },
    {
      id: 'el-6',
      type: 'line',
      left: 60,
      top: 150,
      width: 600,
      height: 1,
      start: [0, 0],
      end: [600, 0],
    },
  ],
  {
    outlineId: 'o-chem',
    sourceContentUnitIds: ['5012'],
    actions: [
      {
        id: 'a1',
        type: 'speech',
        text: 'الكتلة المولية 98.08 غرامًا لكل مول.',
        audioId: 'asset-1',
      },
      {
        id: 'a2',
        type: 'speech',
        text: 'وأيون الحديد شحنته 3+.',
        audioId: 'asset-2',
        audioInvalidated: true,
      },
      { id: 'a3', type: 'speech', text: 'لنحسب 6.02×10²³ جسيمًا.' },
    ] as AppScene['actions'],
    generationIssues: [
      {
        code: 'NARRATION_AUDIO_FAILED',
        message: 'narration audio could not be generated for 1 of 3 spoken line(s)',
      },
    ],
  },
);

const lostImage = slide('scene-lost', 2, [text('el-7', '<p>الشكل 2-9</p>', [60, 60, 400, 60])], {
  outlineId: 'o-lost',
});

const quiz = {
  id: 'scene-quiz',
  stageId: STAGE,
  order: 3,
  title: 'جرّب بنفسك',
  type: 'quiz',
  content: {
    type: 'quiz',
    questions: [
      {
        id: 'q1',
        type: 'single',
        question: '<p>كم كتلة Na في 40.0 g من NaCl؟</p>',
        options: [
          { value: 'A', label: '15.7 g' },
          { value: 'B', label: '24.3 g' },
        ],
        // The key says A, the explanation argues for B: exposed, never "fixed".
        answer: ['A'],
        analysis: 'الإجابة الصحيحة (ب) لأن نسبة الصوديوم 39.3%',
        points: 2,
      },
      { id: 'q2', type: 'short_answer', question: 'اكتب صيغة الماء', answer: ['H2O'] },
    ],
  },
  actions: [],
} as unknown as AppScene;

const bankQuiz = {
  ...quiz,
  id: 'scene-bank',
  order: 4,
  questionSource: 'bank',
  content: { type: 'quiz', questions: [] },
  teachingStage: { key: 'outcome_check_understanding', flowIndex: 3 },
  learningObjectives: [{ objectiveRef: 'obj-17', snapshot: {}, capturedAt: 1 }],
} as unknown as AppScene;

const outline = {
  outlines: [
    {
      id: 'o-chem',
      type: 'slide',
      visualPlan: { mode: 'image' },
      suggestedImageIds: ['src-3'],
      sourceBlockIds: ['61520'],
    },
    { id: 'o-lost', type: 'slide', visualPlan: { mode: 'native' } },
  ],
  sourceVisuals: manifest,
} as never;

const version = {
  id: 'tpv-1',
  version: 2,
  status: 'draft',
  currentStageId: STAGE,
  learningItem: { type: 'lesson', id: '218' },
};

describe('projectAgentScenes', () => {
  const regenerations = new Map<string, SceneRegenerationSummary>([
    [
      'scene-lost',
      {
        sceneId: 'scene-lost',
        status: 'succeeded',
        actorRef: 'agent:42',
        requestedAt: Date.UTC(2026, 10, 22, 7, 15),
        completedAt: Date.UTC(2026, 10, 22, 7, 16),
        // The slide had the book figure before the regeneration dropped it.
        previousScene: slide('scene-lost', 2, [
          {
            id: 'old',
            type: 'image',
            src: BOOK_IMAGE,
            left: 0,
            top: 0,
            width: 10,
            height: 10,
            rotate: 0,
          },
        ]),
      },
    ],
  ]);
  const body = projectAgentScenes({
    version,
    revision: 9921,
    scenes: [bankQuiz, quiz, lostImage, chemistry],
    outline,
    flow: null,
    governed: false,
    regenerations,
  });
  const byId = new Map(body.scenes.map((scene) => [scene.scene_id, scene]));

  it('answers the envelope with the canvas size and the revision as a string', () => {
    expect(body).toMatchObject({
      version_id: 'tpv-1',
      version_number: 2,
      status: 'draft',
      stage_id: STAGE,
      revision: '9921',
      slide_width: 1000,
      slide_height: 562.5,
    });
    expect(body.scenes.map((scene) => [scene.scene_id, scene.slide_number])).toEqual([
      ['scene-chem', 1],
      ['scene-lost', 2],
      ['scene-quiz', 3],
      ['scene-bank', 4],
    ]);
  });

  it('flattens the chemistry slide to Unicode, keeps the markup and extracts numbers', () => {
    const chem = byId.get('scene-chem')!;
    expect(chem.kind).toBe('slide');
    expect(chem.slide_type).toBe('content');
    expect(chem.content_role).toBe('explanation');
    expect(chem.text).toContain('H₂SO₄');
    expect(chem.text).toContain('Fe³⁺');
    expect(chem.rich).toContain('H<sub>2</sub>SO<sub>4</sub>');
    expect(chem.numbers).toEqual([98.08]);
    expect(chem.part_ids).toEqual(['5012']);
    expect(chem.source_block_ids).toEqual(['61520', '61530']);
    expect(chem.reviewed_scene_digest).toBe(sceneEditDigest(chemistry));
    // Review of 7d7dddc6 (MEDIUM-1): a finding the review stamped on the unchanged slide
    // carries the very digest the Agent API reads back, so Kafuo's `stale` is false.
    const [stamped] = stampReviewedDigests(
      [
        {
          id: 'f1',
          targetId: 'scene-chem',
          targetTitle: 't',
          targetOrder: 1,
          check: 'S1',
          severity: 'high',
          bookEvidence: { quote: 'q', unitId: null },
          whatIsWrong: 'w',
          fixNote: 'n',
          status: 'open',
          teacherReason: null,
        },
      ],
      [chemistry],
    );
    expect(stamped!.sceneDigest).toBe(chem.reviewed_scene_digest);
  });

  it('maps elements: boxes, the textbook image and its source blocks, the table rows', () => {
    const elements = new Map(byId.get('scene-chem')!.elements.map((el) => [el.id, el]));
    expect(elements.get('el-1')!.bbox).toEqual([60, 60, 660, 140]);
    expect(elements.get('el-3')).toMatchObject({
      type: 'image',
      source: 'textbook',
      source_block_ids: ['61530'],
      bbox: [680, 200, 960, 400],
    });
    expect(elements.get('el-4')).toMatchObject({
      type: 'table',
      rows: [
        ['المادة', 'الصيغة'],
        ['الماء', 'H₂O'],
      ],
      text: 'المادة | الصيغة\nالماء | H₂O',
    });
    expect(elements.get('el-4')!.rich).toContain('H<sub>2</sub>O');
  });

  it('reports the overlapping text boxes only, never decoration', () => {
    expect(byId.get('scene-chem')!.layout).toEqual({
      overlaps: [{ a: 'el-1', b: 'el-2', area_px: 300 * 40 }],
      overflow: null,
    });
  });

  it('marks narration audio per line: the one failed line, an invalidated one missing', () => {
    // The scene's mark counts 1 of 3 lines without audio: exactly line 3.
    const lines = byId.get('scene-chem')!.narration.lines;
    expect(lines.map((line) => [line.index, line.audio.status])).toEqual([
      [1, 'ok'],
      [2, 'missing'],
      [3, 'failed'],
    ]);
    expect(lines[2]!.numbers).toEqual([6.02e23]);
    expect(byId.get('scene-chem')!.review_flags[0]!.code).toBe('NARRATION_AUDIO_FAILED');
  });

  it('last_changed keeps the landed regeneration while a later one runs', () => {
    const running = projectAgentScenes({
      version,
      revision: 1,
      scenes: [lostImage],
      outline,
      flow: null,
      governed: false,
      regenerations: new Map([
        [
          'scene-lost',
          {
            sceneId: 'scene-lost',
            status: 'running',
            actorRef: 'agent:43',
            requestedAt: Date.UTC(2026, 10, 22, 9, 0),
            completedAt: null,
            previousScene: lostImage,
            lastSucceeded: { actorRef: 'agent:42', at: Date.UTC(2026, 10, 22, 7, 16) },
          },
        ],
      ]),
    });
    expect(running.scenes[0]!.last_changed).toEqual({
      at: '2026-11-22T07:16:00.000Z',
      by: 'agent:42',
      how: 'regenerate_slide',
    });
    // The running attempt started from a slide with no book image: only the outline decides.
    expect(running.scenes[0]!.textbook_image).toEqual({ expected: false, present: false });
  });

  it('a line without audio is missing (not failed) when the scene has no audio failure', () => {
    const plain = projectAgentScenes({
      version,
      revision: 1,
      scenes: [{ ...chemistry, generationIssues: undefined }],
      outline,
      flow: null,
      governed: false,
    });
    expect(plain.scenes[0]!.narration.lines.map((line) => line.audio.status)).toEqual([
      'ok',
      'missing',
      'missing',
    ]);
  });

  it('textbook_image: present on the chemistry slide; expected but absent on the slide that lost it', () => {
    expect(byId.get('scene-chem')!.textbook_image).toEqual({ expected: true, present: true });
    expect(byId.get('scene-lost')!.textbook_image).toEqual({ expected: true, present: false });
    expect(byId.get('scene-lost')!.last_changed).toEqual({
      at: '2026-11-22T07:16:00.000Z',
      by: 'agent:42',
      how: 'regenerate_slide',
    });
    // Neither an outline entry nor a regeneration record: unknown.
    const unknown = projectAgentScenes({
      version,
      revision: 1,
      scenes: [{ ...lostImage, outlineId: undefined }],
      outline,
      flow: null,
      governed: false,
    });
    expect(unknown.scenes[0]!.textbook_image).toEqual({ expected: null, present: false });
    expect(byId.get('scene-quiz')!.textbook_image).toBeNull();
  });

  it('returns the quiz key as stored, even when the explanation names another option', () => {
    expect(byId.get('scene-quiz')!.quiz).toEqual({
      source: 'scene',
      items: [
        {
          id: 'q1',
          stem: 'كم كتلة Na في 40.0 g من NaCl؟',
          type: 'single',
          options: [
            { id: 'A', text: '15.7 g' },
            { id: 'B', text: '24.3 g' },
          ],
          correct_option_ids: ['A'],
          correct_value: null,
          correct_values: [],
          explanation: 'الإجابة الصحيحة (ب) لأن نسبة الصوديوم 39.3%',
          points: 2,
        },
        {
          id: 'q2',
          stem: 'اكتب صيغة الماء',
          type: 'short_answer',
          options: [],
          correct_option_ids: [],
          correct_value: 'H2O',
          correct_values: ['H2O'],
          explanation: null,
          points: null,
        },
      ],
    });
    // A bank quiz: no items in TE, but every reference Kafuo fetches them by.
    expect(byId.get('scene-bank')!.quiz).toEqual({
      source: 'bank',
      items: null,
      bank_ref: {
        learning_item_type: 'lesson',
        learning_item_id: '218',
        version_id: 'tpv-1',
        scene_id: 'scene-bank',
        teaching_stage: { key: 'outcome_check_understanding', flow_index: 3 },
        objective_refs: ['obj-17'],
      },
    });
    expect(byId.get('scene-chem')!.quiz).toBeNull();
  });

  it('legacy (no flow): skills from the scene, no checks, no alignment confirmation needed', () => {
    expect(byId.get('scene-chem')!.skills).toEqual({
      primary: null,
      supporting: [],
      allowed: [],
      checks: [],
    });
    expect(byId.get('scene-chem')!.validation).toEqual({
      state: 'validation-required',
      needs_alignment_confirmation: false,
    });
  });
});

describe('stage-wide Skill requirement', () => {
  const flow: TeachingFlowEntry[] = [
    {
      stage: 'lesson_introduction',
      instructions: 'i',
      skillPolicy: {
        required: [],
        preferred: [],
        allowed: [FEYNMAN, LECTURE],
        combinationRestrictions: [],
      },
    },
    {
      stage: 'outcome_visual_explanations',
      instructions: 'v',
      skillPolicy: {
        required: [{ skill: FEYNMAN, role: 'primary', scope: 'every_instructional_scene' }],
        preferred: [],
        allowed: [FEYNMAN, LECTURE],
        combinationRestrictions: [],
      },
    },
  ] as TeachingFlowEntry[];

  const at = (id: string, order: number, flowIndex: number, primary = LECTURE) =>
    ({
      ...slide(id, order, []),
      teachingStage: { key: flow[flowIndex]!.stage, flowIndex },
      teachingSkills: { primary, classification: 'instructional' },
    }) as AppScene;
  const scenes = [
    at('s1', 1, 0),
    at('s2', 2, 1),
    at('s3', 3, 1),
    at('s4', 4, 1, FEYNMAN),
    at('s5', 5, 1),
  ];

  it('is one check naming every failing scene', () => {
    expect(collectSkillRequirementChecks(scenes, flow)).toEqual([
      expect.objectContaining({
        code: 'SKILL_REQUIREMENT_UNSATISFIED',
        required: 'feynman-learning@v1',
        role: 'primary',
        scope: 'every_instructional_scene',
        teaching_stage_key: 'outcome_visual_explanations',
        flow_index: 1,
        failing_scene_ids: ['s2', 's3', 's5'],
      }),
    ]);
  });

  it('lands on each failing scene, not on the passing ones', () => {
    const body = projectAgentScenes({
      version,
      revision: 1,
      scenes,
      outline: null,
      flow,
      governed: true,
    });
    const checksOf = (id: string) =>
      body.scenes
        .find((scene) => scene.scene_id === id)!
        .skills.checks.filter((check) => check.code === 'SKILL_REQUIREMENT_UNSATISFIED');
    for (const id of ['s2', 's3', 's5']) {
      expect(checksOf(id)).toHaveLength(1);
      expect(checksOf(id)[0]!.failing_scene_ids).toEqual(['s2', 's3', 's5']);
    }
    expect(checksOf('s4')).toEqual([]);
    const s2 = body.scenes.find((scene) => scene.scene_id === 's2')!;
    expect(s2.skills).toMatchObject({
      primary: 'lecture-style@v1',
      supporting: [],
      allowed: ['feynman-learning@v1', 'lecture-style@v1'],
    });
    expect(s2.teaching_stage).toEqual({ key: 'outcome_visual_explanations', flow_index: 1 });
    // Governed and never validated: confirmation is needed.
    expect(s2.validation).toEqual({
      state: 'validation-required',
      needs_alignment_confirmation: true,
    });
  });
});

describe('review fixes (A3)', () => {
  it('lists a requirement that names no scene in the stage-level skills_checks', () => {
    const flow = [
      {
        stage: 'outcome_practice',
        instructions: 'p',
        skillPolicy: {
          required: [{ skill: FEYNMAN, role: 'primary', scope: 'flow_position' }],
          preferred: [],
          allowed: [FEYNMAN],
          combinationRestrictions: [],
        },
      },
    ] as TeachingFlowEntry[];
    // No scene sits at the position: the failure names no scene.
    const body = projectAgentScenes({
      version,
      revision: 1,
      scenes: [lostImage],
      outline: null,
      flow,
      governed: true,
    });
    expect(body.skills_checks).toEqual([
      expect.objectContaining({
        code: 'SKILL_REQUIREMENT_UNSATISFIED',
        required: 'feynman-learning@v1',
        scope: 'flow_position',
        failing_scene_ids: [],
      }),
    ]);
    expect(
      body.scenes[0]!.skills.checks.filter((c) => c.code === 'SKILL_REQUIREMENT_UNSATISFIED'),
    ).toEqual([]);
  });

  it('invalidated audio is missing even on a NARRATION_AUDIO_FAILED scene', () => {
    const scene = {
      ...lostImage,
      actions: [
        { id: 'x1', type: 'speech', text: 'سطر', audioId: 'asset-9', audioInvalidated: true },
        { id: 'x2', type: 'speech', text: 'سطر بلا صوت' },
      ],
      generationIssues: [{ code: 'NARRATION_AUDIO_FAILED', message: '1 of 2' }],
    } as AppScene;
    const body = projectAgentScenes({
      version,
      revision: 1,
      scenes: [scene],
      outline: null,
      flow: null,
      governed: false,
    });
    expect(body.scenes[0]!.narration.lines.map((line) => line.audio.status)).toEqual([
      'missing',
      'failed',
    ]);
  });
});

describe('findLayoutOverlaps', () => {
  const box = (
    id: string,
    type: string,
    l: number,
    t: number,
    w: number,
    h: number,
    extra = {},
  ) => ({
    id,
    type,
    left: l,
    top: t,
    width: w,
    height: h,
    ...extra,
  });

  it('ignores a touch below the threshold and background images', () => {
    expect(MIN_OVERLAP_AREA_PX).toBe(100);
    expect(
      findLayoutOverlaps([
        box('a', 'text', 0, 0, 100, 100),
        box('b', 'text', 95, 95, 100, 100), // 5 × 5 = 25 px²
        box('bg', 'image', 0, 0, 1000, 562, { imageType: 'background' }),
      ]),
    ).toEqual([]);
  });

  it('counts a text-bearing shape and an image as content', () => {
    expect(
      findLayoutOverlaps([
        box('s', 'shape', 0, 0, 100, 100, { text: { content: '<p>عنوان</p>' } }),
        box('i', 'image', 50, 50, 100, 100),
      ]),
    ).toEqual([{ a: 's', b: 'i', area_px: 2500 }]);
  });
});
