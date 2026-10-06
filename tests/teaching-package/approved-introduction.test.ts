/**
 * The student lesson-entry introduction projected from an APPROVED Teaching
 * Package version: approved-only, tenant/item scoped, keyed on the Teaching Model,
 * and never partial.
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  projectApprovedIntroduction,
  readApprovedIntroduction,
} from '@/lib/server/teaching-package/approved-introduction';
import type { AppScene } from '@/lib/types/stage';
import type { TeachingPackageVersion } from '@/lib/types/teaching-package';
import { makeSlideScene } from '../agent-runtime/_stage-fixtures';

const mocks = vi.hoisted(() => ({
  readVersion: vi.fn(),
  loadDocument: vi.fn(),
}));

vi.mock('@/lib/persistence/teaching-package', () => ({ readVersion: mocks.readVersion }));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: {} }),
}));
vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getOwnerScopedDocumentStore: async () => ({ loadDocument: mocks.loadDocument }),
}));

const G5_V3 = { key: 'g5', version: 'g5.v3' };

function p(text: string): string {
  return `<p style="text-align:right;">${text}</p>`;
}

function slide(
  id: string,
  order: number,
  stageKey: string,
  title: string,
  texts: string[],
): AppScene {
  const base = makeSlideScene(id, 'stage-1', order, title);
  const content = base.content as { canvas: { elements: unknown[] } };
  content.canvas.elements = texts.map((html, i) => ({
    id: `${id}-t${i}`,
    type: 'text',
    content: html,
    left: 0,
    top: i * 40,
    width: 600,
    height: 40,
    rotate: 0,
    defaultFontName: 'Inter',
    defaultColor: '#111',
  }));
  return { ...base, teachingStage: { key: stageKey, flowIndex: order - 1 } } as AppScene;
}

function lesson284Scenes(): AppScene[] {
  return [
    slide('s1', 1, 'lesson_opener', 'التبرير الاستقرائي والتخمين', [
      p('<strong>التبرير الاستقرائي والتخمين</strong>'),
      p('<strong>إذا تكررت ملاحظة واحدة في إجابات كثير من الزبائن، فماذا يمكن أن نتوقع؟</strong>'),
      p('<strong>من الإجابات إلى توقّع</strong>'),
      p('تُجمع آراء الزبائن عن منتج، ثم تُبحث عن أنماط متكررة.'),
      p('<strong>الفكرة الكبرى:</strong> أمثلة متعددة تساعد على بناء تخمين.'),
      p('<strong>نمط متكرر</strong>'),
    ]),
    slide('s2', 2, 'lesson_learning_map', 'ماذا سنتعلم؟', [
      p('<strong>ماذا سنتعلم؟</strong>'),
      p('<strong>كيف ننتقل من ملاحظة بيانات متكررة إلى تخمين يمكن الوثوق به؟</strong>'),
      p('تساعدنا الأنماط في البيانات على تفسير مواقف من حولنا.'),
      p('<strong>في هذا الدرس، ستتعلّم أن:</strong>'),
      p('١. تحلل البيانات لتبني تخمينًا.') + p('٢. تستخدم مثالًا مضادًا.'),
      p('<strong>مسار التفكير</strong>'),
    ]),
    slide('s3', 3, 'outcome_visual_explanations', 'شرح', [p('هذا شرح لا يدخل المقدمة.')]),
  ];
}

function version(overrides: Partial<TeachingPackageVersion> = {}): TeachingPackageVersion {
  return {
    id: 'tpv-approved0001',
    tenantId: '7',
    learningItem: { type: 'lesson', id: '123' },
    version: 1,
    status: 'approved',
    currentStageId: 'stage-1',
    currentAttemptId: null,
    teachingModel: G5_V3,
    predecessorVersionId: null,
    supersededByVersionId: null,
    submittedStageRev: 1,
    createdAt: 0,
    updatedAt: 0,
    submittedAt: 0,
    approvedAt: 0,
    supersededAt: null,
    discardedAt: null,
    ...overrides,
  };
}

const REQUEST = {
  versionId: 'tpv-approved0001',
  tenantId: '7',
  learningItem: { type: 'lesson' as const, id: '123' },
};

function codeOf(error: unknown): string | undefined {
  return error instanceof TeachingPackageError ? error.code : undefined;
}

describe('projectApprovedIntroduction (g5.v3)', () => {
  it('maps opener → context, learning-map preamble → why, objectives → overview', () => {
    const intro = projectApprovedIntroduction(G5_V3, lesson284Scenes());

    expect(intro.context).toBe(
      [
        'إذا تكررت ملاحظة واحدة في إجابات كثير من الزبائن، فماذا يمكن أن نتوقع؟',
        'تُجمع آراء الزبائن عن منتج، ثم تُبحث عن أنماط متكررة.',
        'الفكرة الكبرى: أمثلة متعددة تساعد على بناء تخمين.',
      ].join('\n'),
    );
    expect(intro.whyThisLesson).toBe(
      [
        'كيف ننتقل من ملاحظة بيانات متكررة إلى تخمين يمكن الوثوق به؟',
        'تساعدنا الأنماط في البيانات على تفسير مواقف من حولنا.',
      ].join('\n'),
    );
    expect(intro.overview).toBe(
      ['١. تحلل البيانات لتبني تخمينًا.', '٢. تستخدم مثالًا مضادًا.'].join('\n'),
    );
  });

  it('never leaks titles, headings, lead-ins, labels or teaching scenes', () => {
    const intro = projectApprovedIntroduction(G5_V3, lesson284Scenes());
    const all = `${intro.context}\n${intro.whyThisLesson}\n${intro.overview}`;
    for (const excluded of [
      'التبرير الاستقرائي والتخمين',
      'ماذا سنتعلم؟',
      'من الإجابات إلى توقّع',
      'في هذا الدرس، ستتعلّم أن:',
      'نمط متكرر',
      'مسار التفكير',
      'هذا شرح لا يدخل المقدمة.',
    ]) {
      expect(all.split('\n')).not.toContain(excluded);
    }
  });

  it('finds an objectives list laid out one element per objective', () => {
    const scenes = [
      slide('s1', 1, 'lesson_opener', 'Look Back, Move Forward', [
        p('<strong>Which part of Unit 1 do you feel most confident about?</strong>'),
        p('Unit 1 connected past events, present effects, global issues, and time expressions.'),
      ]),
      slide('s2', 2, 'lesson_learning_map', 'What You Will Learn', [
        p('<strong>What You Will Learn</strong>'),
        p('<strong>What can your Unit 1 learning tell you about your next step?</strong>'),
        p('This reflection helps you turn past learning into a clear plan for continued progress.'),
        p('<strong>1</strong> Reflect on your Unit 1 learning experiences.'),
        p('<strong>2</strong> Identify the language skills and grammar you understand well.'),
        p('<strong>Reflection loop</strong>'),
      ]),
    ];

    const intro = projectApprovedIntroduction({ key: 'g5', version: 'g5.v4' }, scenes);

    expect(intro.whyThisLesson).toBe(
      [
        'What can your Unit 1 learning tell you about your next step?',
        'This reflection helps you turn past learning into a clear plan for continued progress.',
      ].join('\n'),
    );
    expect(intro.overview).toBe(
      [
        '1 Reflect on your Unit 1 learning experiences.',
        '2 Identify the language skills and grammar you understand well.',
      ].join('\n'),
    );
  });

  it('finds a plain-sentence list after its lead-in', () => {
    const scenes = [
      slide('s1', 1, 'lesson_opener', 'Big Changes', [
        p('<strong>What events can change the future of an entire society?</strong>'),
      ]),
      slide('s2', 2, 'lesson_learning_map', 'What You Will Learn', [
        p('<strong>How do major events reshape the way people live?</strong>'),
        p('This lesson connects regional history with global change.'),
        p('<strong>Events → Effects → Change</strong>'),
        p('<strong>By the end, you can…</strong>'),
        p('Identify key events: Saudi unification, UAE federation, and Space Race milestones.'),
        p('Explain effects and connect global issues to evidence.'),
      ]),
    ];

    const intro = projectApprovedIntroduction({ key: 'g5', version: 'g5.v4' }, scenes);

    expect(intro.whyThisLesson).toBe(
      [
        'How do major events reshape the way people live?',
        'This lesson connects regional history with global change.',
      ].join('\n'),
    );
    expect(intro.overview).toBe(
      [
        'Identify key events: Saudi unification, UAE federation, and Space Race milestones.',
        'Explain effects and connect global issues to evidence.',
      ].join('\n'),
    );
  });

  it('keeps a sentence written under its heading, and prefers numbers to paragraphs', () => {
    const scenes = [
      slide('s1', 1, 'lesson_opener', 'Pair Work', [p('<strong>How can one fact become a useful question?</strong>')]),
      slide('s2', 2, 'lesson_learning_map', 'What You Will Learn', [
        p('<strong>How can one factual sentence lead to a clear question?</strong>') +
          p('Today, you will turn information into meaningful questions and answers.'),
        p('<strong>Why it matters</strong>') + p('Readers use facts to understand a text.'),
        p('<strong>1. Find a fact</strong>') + p('Identify factual sentences in a text.'),
        p('<strong>2. Build a question</strong>') + p('Choose the question word that fits.'),
      ]),
    ];

    const intro = projectApprovedIntroduction({ key: 'g5', version: 'g5.v4' }, scenes);

    expect(intro.whyThisLesson).toBe(
      [
        'How can one factual sentence lead to a clear question?',
        'Today, you will turn information into meaningful questions and answers.',
        'Readers use facts to understand a text.',
      ].join('\n'),
    );
    expect(intro.overview).toBe(
      ['Identify factual sentences in a text.', 'Choose the question word that fits.'].join('\n'),
    );
  });

  it('finds a one-objective list', () => {
    const scenes = lesson284Scenes().map((scene) =>
      scene.teachingStage?.key === 'lesson_learning_map'
        ? slide('s2', 2, 'lesson_learning_map', 'ماذا سنتعلم؟', [
            p('<strong>كيف ننتقل من ملاحظة بيانات متكررة إلى تخمين يمكن الوثوق به؟</strong>'),
            p('١. تحلل البيانات لتبني تخمينًا.'),
          ])
        : scene,
    );

    expect(projectApprovedIntroduction(G5_V3, scenes).overview).toBe(
      '١. تحلل البيانات لتبني تخمينًا.',
    );
  });

  it('projects g5.v4 exactly as g5.v3: the opener and learning map are unchanged', () => {
    expect(projectApprovedIntroduction({ key: 'g5', version: 'g5.v4' }, lesson284Scenes())).toEqual(
      projectApprovedIntroduction(G5_V3, lesson284Scenes()),
    );
  });

  it('projects g5.v5 exactly as g5.v3: the opener and learning map are unchanged', () => {
    expect(projectApprovedIntroduction({ key: 'g5', version: 'g5.v5' }, lesson284Scenes())).toEqual(
      projectApprovedIntroduction(G5_V3, lesson284Scenes()),
    );
  });

  it('fails closed for a teaching model with no projection', () => {
    expect(() =>
      projectApprovedIntroduction({ key: 'g5', version: 'g5.v1' }, lesson284Scenes()),
    ).toThrow(expect.objectContaining({ code: 'INTRODUCTION_FLOW_UNSUPPORTED' }));
  });

  it('refuses a partial introduction', () => {
    const withoutMap = lesson284Scenes().filter(
      (scene) => scene.teachingStage?.key !== 'lesson_learning_map',
    );
    try {
      projectApprovedIntroduction(G5_V3, withoutMap);
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe('INTRODUCTION_INCOMPLETE');
      expect((error as TeachingPackageError).details).toEqual({
        missing: ['whyThisLesson', 'overview'],
      });
    }
  });
});

describe('readApprovedIntroduction', () => {
  beforeEach(() => {
    mocks.readVersion.mockReset();
    mocks.loadDocument.mockReset();
    mocks.loadDocument.mockResolvedValue({ scenes: lesson284Scenes() });
  });

  it('reads the approved version, tenant-scoped', async () => {
    mocks.readVersion.mockResolvedValue(version());
    const result = await readApprovedIntroduction({} as never, REQUEST);
    expect(mocks.readVersion).toHaveBeenCalledWith({}, 'tpv-approved0001', { tenantId: '7' });
    expect(result.versionId).toBe('tpv-approved0001');
    expect(result.teachingModel).toEqual(G5_V3);
    expect(result.introduction.overview).toContain('١. تحلل البيانات');
  });

  it.each(['draft', 'in_review', 'rejected', 'superseded', 'discarded'] as const)(
    'refuses a %s version and never reads its stage',
    async (status) => {
      mocks.readVersion.mockResolvedValue(version({ status }));
      await expect(readApprovedIntroduction({} as never, REQUEST)).rejects.toMatchObject({
        code: 'TEACHING_PACKAGE_NOT_APPROVED',
      });
      expect(mocks.loadDocument).not.toHaveBeenCalled();
    },
  );

  it('answers NOT_FOUND for another item or an unknown/foreign version', async () => {
    mocks.readVersion.mockResolvedValue(version({ learningItem: { type: 'lesson', id: '999' } }));
    await expect(readApprovedIntroduction({} as never, REQUEST)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    mocks.readVersion.mockResolvedValue(null);
    await expect(readApprovedIntroduction({} as never, REQUEST)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('answers STAGE_NOT_LIVE when the approved stage is gone', async () => {
    mocks.readVersion.mockResolvedValue(version());
    mocks.loadDocument.mockResolvedValue(null);
    await expect(readApprovedIntroduction({} as never, REQUEST)).rejects.toMatchObject({
      code: 'STAGE_NOT_LIVE',
    });
  });
});

describe('GET /api/teaching-packages/[id]/introduction', () => {
  const SERVICE_KEY = 'svc-introduction';
  const BASE = 'http://localhost/api/teaching-packages/tpv-approved0001/introduction';

  async function get(query: string) {
    const { GET } = await import('@/app/api/teaching-packages/[id]/introduction/route');
    return GET(
      new NextRequest(`${BASE}?${query}`, {
        headers: { authorization: `Bearer ${SERVICE_KEY}` },
      }),
      { params: Promise.resolve({ id: 'tpv-approved0001' }) },
    );
  }

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', 'postgres://introduction-test');
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
    mocks.readVersion.mockReset();
    mocks.loadDocument.mockReset();
    mocks.loadDocument.mockResolvedValue({ scenes: lesson284Scenes() });
  });

  it('returns the approved introduction for the full scope', async () => {
    mocks.readVersion.mockResolvedValue(version());
    const res = await get('tenantId=7&learningItemType=lesson&learningItemId=123');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.versionId).toBe('tpv-approved0001');
    expect(Object.keys(body.introduction).sort()).toEqual([
      'context',
      'overview',
      'whyThisLesson',
    ]);
  });

  it('maps a non-approved version to 409', async () => {
    mocks.readVersion.mockResolvedValue(version({ status: 'draft' }));
    const res = await get('tenantId=7&learningItemType=lesson&learningItemId=123');
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'TEACHING_PACKAGE_NOT_APPROVED' },
    });
  });

  it('refuses a request without the Learning Item scope', async () => {
    const res = await get('tenantId=7');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(mocks.readVersion).not.toHaveBeenCalled();
  });
});
