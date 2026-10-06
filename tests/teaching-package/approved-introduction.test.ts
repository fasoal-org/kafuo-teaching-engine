/**
 * The student lesson-entry introduction projected from an APPROVED (or pinned, now
 * superseded) Teaching Package version: approved/superseded only, tenant/item scoped,
 * keyed on the Teaching Model, and never partial.
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

/** The introduction slides of published lessons 160, 164, 179 and 178, copied element by
 *  element from their approved stages (each `p()` group is one text element). */
const G5_V6 = { key: 'g5', version: 'g5.v6' };

function item160Scenes(): AppScene[] {
  return [
    slide('s1', 1, 'lesson_opener', 'لماذا نحتاج إلى المنطق؟', [
      p('<strong>لماذا نحتاج إلى المنطق؟</strong>'),
      p('<strong>سؤال نبدأ به</strong>') + p('هل العبارة «أبها مدينة سعودية» صحيحة أم خاطئة؟'),
      p('<strong>مثال واقعي: مدن المملكة العربية السعودية</strong>'),
      p('<strong>الفكرة الأساسية</strong>') +
        p('• لكل عبارة خبرية قيمة صواب واحدة: صحيحة أو خاطئة.') +
        p('• المنطق يساعدنا على تنظيم الأحكام والتبرير بوضوح.'),
      p('<strong>نبحث عن حكم واضح، ثم نبرره بدليل.</strong>'),
    ]),
    slide('s2', 2, 'lesson_learning_map', 'ماذا سنتعلم؟', [
      p('<strong>ماذا سنتعلم؟</strong>'),
      p('<strong>كيف نعرف قيمة عبارة منطقية مركبة؟</strong>') +
        p('سنحوّلها إلى خطوات واضحة يمكن فحصها وتفسيرها.'),
      p('<strong>أهدافنا</strong>') +
        p('• نحدد قيم الصواب لعبارات الوصل والفصل باستخدام جداول الصواب.') +
        p('• ننشئ جداول صواب للعبارات المركبة المعقدة ونفسر نتائجها.') +
        p('• نمثل العبارات المنطقية بأشكال فن ونفسر العلاقات بينها.'),
      p('<strong>مسار الدرس</strong>') +
        p('العبارات المنطقية') +
        p('← جداول الصواب') +
        p('← أشكال فن'),
      p('<strong>منطق نراه، نختبره، ثم نفسره</strong>'),
    ]),
  ];
}

function item164Scenes(): AppScene[] {
  return [
    slide('s1', 1, 'lesson_opener', 'الكيمياء والمادة', [
      p('<strong>الكيمياء والمادة</strong>'),
      p('<strong>سؤال تمهيدي</strong>') + p('ما المواد التي يتكوّن منها كل ما حولنا؟'),
      p('<strong>الكيمياء تدرس</strong>') +
        p('الأنواع المختلفة من المادة والتغيرات التي تطرأ عليها، من حولنا في الحياة اليومية.'),
      p('<strong>في هذا الدرس</strong>') +
        p('• نربط الكيمياء بأشياء مألوفة من حياتنا اليومية.') +
        p('• نبحث عن المواد التي تكوّن العالم من حولنا.'),
      p('<strong>الفكرة الإطارية</strong>') + p('فهم المادة يساعدنا على تفسير العالم من حولنا.'),
    ]),
    slide('s2', 2, 'lesson_learning_map', 'ماذا سنتعلم؟', [
      p('<strong>ماذا سنتعلم؟</strong>'),
      p('<strong>كيف نفهم المادة من حولنا؟</strong>') +
        p('نبدأ من خصائصها التي نلاحظها، ثم ننتقل إلى ما يحدث تحت المجهر.'),
      p('<strong>في نهاية الدرس، سنتمكن من:</strong>') +
        p('١. نقارن بين الكتلة والوزن.') +
        p('٢. نشرح أهمية وصف المادة تحت المجهر لعلم الكيمياء.') +
        p('٣. نحدد فروع علم الكيمياء والمجالات التي تدرسها.'),
      p('<strong>مسار الدرس</strong>'),
      p('المادة وخواصها'),
      p('المستوى تحت المجهري'),
      p('فروع الكيمياء'),
      p('<strong>الكيمياء تربط بين ما نراه وما يحدث في المادة.</strong>'),
    ]),
  ];
}

function item179Scenes(): AppScene[] {
  return [
    slide('s1', 1, 'lesson_opener', 'إعراب الفعل المضارع', [
      p('<strong>إعراب الفعل المضارع</strong>'),
      p('<strong>سؤال تمهيدي:</strong>') + p('كيف نعرف حركة الفعل المضارع في الجملة؟'),
      p('يتغير إعراب الفعل المضارع بحسب ما يسبقه من أدوات.') +
        p('وفهم الإعراب يساعدنا على فهم المعنى وكتابة الجمل كتابة سليمة.'),
      p('<strong>الفكرة الكبرى:</strong> تتبدل حركة الفعل، فيتبدل موقعه ومعناه في الجملة.'),
      p('<strong>انتقال الفعل بين الحالات</strong>'),
      p('<strong>مرفوع</strong>'),
      p('<strong>منصوب</strong>'),
      p('<strong>مجزوم</strong>'),
      p('الأداة التي تسبق الفعل تساعدنا على تحديد حركته.'),
    ]),
    slide('s2', 2, 'lesson_learning_map', 'ماذا سنتعلم؟', [
      p('<strong>ماذا سنتعلم؟</strong>'),
      p('<strong>كيف نعرف إعراب الفعل المضارع؟</strong>') +
        p('سنكتشف ذلك من خلال أمثلة نكتبها ونحللها.'),
      p('<strong>سنتعلم أن:</strong>') +
        p('١. نتعرّف أنواع الفعل المضارع وعلامات إعرابه.') +
        p('٢. نكتب جملاً تتضمن أفعالاً مضارعة، ونحدّد علامات إعرابها.') +
        p('٣. نستخدم أسلوب الشرط، ونحدّد الفعل المضارع وعلامة إعرابه.'),
      p('<strong>مسار التعلّم</strong>'),
      p('<strong>أسلوب الشرط</strong>'),
      p('<strong>الكتابة والتطبيق</strong>'),
      p('<strong>المفاهيم الأساسية</strong>'),
      p(
        '<strong>الفكرة الكبرى: نفهم إعراب الفعل المضارع لنستخدمه بدقّة في كلامنا وكتاباتنا.</strong>',
      ),
    ]),
  ];
}

function item178Scenes(): AppScene[] {
  return [
    slide('s1', 1, 'lesson_opener', 'الجملة الاسمية ونواسخها', [
      p('<strong>الجملة الاسمية ونواسخها</strong>'),
      p('<strong>سؤال تمهيدي</strong>') +
        p('ماذا يحدث للجملة «المستشارُ مؤتمنٌ» إذا دخلت عليها «كان» أو «إنَّ»؟'),
      p('<strong>لماذا يهمنا ذلك؟</strong>') +
        p('الجملة الاسمية أساس مهم لفهم المعنى والإعراب في النصوص العربية.'),
      p('<strong>الفكرة الكبرى</strong>') +
        p('تأمل المخطط: تتغير حركة المبتدأ والخبر بحسب الناسخ الداخل على الجملة.'),
    ]),
    slide('s2', 2, 'lesson_learning_map', 'خريطة التعلم', [
      p('<strong>خريطة التعلم</strong>'),
      p('<strong>كيف نكتشف وظيفة كل كلمة في الجملة؟</strong>') +
        p('سنستعين بخريطة تساعدنا على الفهم والتحليل والتصحيح.'),
      p(
        '<strong>فكرة الدرس:</strong> ننتقل من معرفة المكونات إلى استخدامها في قراءة الجمل وصياغتها بصورة صحيحة.',
      ),
      p('<strong>في نهاية الدرس سأستطيع أن:</strong>'),
      p('١. أحدد مكونات الجملة الاسمية وعلامات إعرابها عند استخدام الأفعال الناسخة.') +
        p('٢. أميز بين الجملة الفعلية والجملة الاسمية، وأفهم عمل الأفعال والحروف الناسخة.') +
        p('٣. أحلل الجمل الاسمية وأصلح الأخطاء النحوية فيها.'),
      p('<strong>مسار الدرس</strong>'),
      p('<strong>المكونات</strong>') + p('وعلامات الإعراب'),
      p('<strong>التمييز</strong>') + p('بين أنواع الجمل'),
      p('<strong>التحليل</strong>') + p('والتصحيح'),
      p('<strong>الفكرة الكبرى</strong>') + p('فهم وظيفة الكلمة يجعلنا نقرأ الجملة ونكتبها بدقة.'),
    ]),
  ];
}

/** The introduction slides of published sections 171 and 172, copied element by element
 *  (HTML as stored) from their approved stages. Their objectives carry no full stop. */
function section171Scenes(): AppScene[] {
  return [
    slide('s1', 1, 'lesson_opener', '7 About You', [
      '<p style="font-size:36px;"><strong>7 About You</strong></p>',
      '<p style="font-size:20px;color:#24538A;"><strong>What could you learn about a classmate by asking one thoughtful question?</strong></p>',
      '<p style="font-size:18px;"><strong>Look for connections</strong></p>',
      '<p style="font-size:18px;">A question can open a window into families, relatives, cities, countries, and personal experiences.</p>',
      '<p style="font-size:16px;"><strong>Today:</strong> Notice meaningful connections • Ask respectfully • Listen for a story behind the answer</p>',
      '<p style="font-size:16px;text-align:center;"><strong>BIG IDEA</strong></p>',
      '<p style="font-size:16px;text-align:center;">Asking and answering questions helps people understand one another.</p>',
    ]),
    slide('s2', 2, 'lesson_learning_map', 'What You Will Learn', [
      '<p style="font-size:36px;"><strong>What You Will Learn</strong></p>',
      '<p style="font-size:24px;"><strong>How can two people learn about each other through a respectful conversation?</strong></p>',
      '<p style="font-size:18px;">In this lesson, you will practice partner dialogue about family backgrounds, migration, relatives, and places people have visited.</p>',
      '<p style="font-size:20px;text-align:center;"><strong>A dialogue is a shared exchange</strong></p>',
      '<p style="font-size:18px;text-align:center;"><strong>Ask</strong></p>',
      '<p style="font-size:18px;text-align:center;"><strong>Answer</strong></p>',
      '<p style="font-size:18px;text-align:center;">Then switch roles.</p>',
      '<p style="font-size:18px;"><strong>Big idea:</strong> Effective dialogue means asking with curiosity, listening carefully, and giving both partners space to speak.</p>',
      '<p style="font-size:16px;"><strong>By the end, you can:</strong></p><p style="font-size:16px;">• ask and answer questions with a partner</p><p style="font-size:16px;">• check your understanding of effective dialogue</p>',
    ]),
  ];
}

function section172Scenes(): AppScene[] {
  return [
    slide('s1', 1, 'lesson_opener', 'Stories Behind Where We Come From', [
      '<p style="font-size:28px; line-height:1.35;"><strong>Stories Behind<br/>Where We Come From</strong></p>',
      '<p style="font-size:20px; line-height:1.5;"><strong>What can a family background<br/>tell us about a person’s life?</strong></p>',
      '<p style="font-size:16px;"><strong>THE CONVERSATION</strong></p>',
      '<p style="font-size:16px;">Hans and Saud connect through family roots, places, work, and belonging.</p>',
      '<p style="font-size:16px;"><strong>Look for:</strong></p><p style="font-size:16px;">• family roots and places</p><p style="font-size:16px;">• work, belonging, and meaningful conversation</p>',
      '<p style="font-size:16px; color:#2454a6;"><strong>Big idea:</strong> Personal background can help people start meaningful conversations.</p>',
      '<p style="font-size:14px; text-align:center;"><strong>Humboldt University<br/>Berlin</strong></p>',
    ]),
    slide('s2', 2, 'lesson_learning_map', 'What You Will Learn', [
      '<p style="font-size:36px;"><strong>What You Will Learn</strong></p>',
      '<p style="font-size:24px;"><strong>How can you help someone feel at home in a new community?</strong></p>',
      '<p style="font-size:18px;">You will explore a real conversation about family backgrounds and practise speaking with confidence.</p>',
      '<p style="font-size:16px;text-align:center;"><strong>My family is from…</strong></p>',
      '<p style="font-size:16px;text-align:center;"><strong>I fit in because…</strong></p>',
      '<p style="font-size:14px;text-align:center;">Listen • clarify • connect</p>',
      '<p style="font-size:20px;"><strong>Big idea:</strong> Meaningful conversation grows when you listen carefully, emphasize key words, and add information naturally.</p>',
      '<p style="font-size:16px;color:#ffffff;text-align:center;"><strong>1  Study the model</strong></p>',
      '<p style="font-size:16px;color:#ffffff;text-align:center;"><strong>2  Clarify expressions</strong></p>',
      '<p style="font-size:16px;color:#ffffff;text-align:center;"><strong>3  Role-play together</strong></p>',
    ]),
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

  it('finds a bulleted list whose heading shares its element (lesson 160)', () => {
    const intro = projectApprovedIntroduction(G5_V6, item160Scenes());

    expect(intro.whyThisLesson).toBe(
      ['كيف نعرف قيمة عبارة منطقية مركبة؟', 'سنحوّلها إلى خطوات واضحة يمكن فحصها وتفسيرها.'].join(
        '\n',
      ),
    );
    expect(intro.overview).toBe(
      [
        '• نحدد قيم الصواب لعبارات الوصل والفصل باستخدام جداول الصواب.',
        '• ننشئ جداول صواب للعبارات المركبة المعقدة ونفسر نتائجها.',
        '• نمثل العبارات المنطقية بأشكال فن ونفسر العلاقات بينها.',
      ].join('\n'),
    );
    expect(intro.context).toBe('نبحث عن حكم واضح، ثم نبرره بدليل.');
  });

  it('finds a numbered list whose lead-in shares its element (lesson 179)', () => {
    const intro = projectApprovedIntroduction(G5_V6, item179Scenes());

    expect(intro.whyThisLesson).toBe(
      ['كيف نعرف إعراب الفعل المضارع؟', 'سنكتشف ذلك من خلال أمثلة نكتبها ونحللها.'].join('\n'),
    );
    expect(intro.overview).toBe(
      [
        '١. نتعرّف أنواع الفعل المضارع وعلامات إعرابه.',
        '٢. نكتب جملاً تتضمن أفعالاً مضارعة، ونحدّد علامات إعرابها.',
        '٣. نستخدم أسلوب الشرط، ونحدّد الفعل المضارع وعلامة إعرابه.',
        'الفكرة الكبرى: نفهم إعراب الفعل المضارع لنستخدمه بدقّة في كلامنا وكتاباتنا.',
      ].join('\n'),
    );
  });

  it('reads an opener of heading-plus-sentence elements per line (lesson 164)', () => {
    const intro = projectApprovedIntroduction(G5_V6, item164Scenes());

    expect(intro.context).toBe(
      [
        'ما المواد التي يتكوّن منها كل ما حولنا؟',
        'الأنواع المختلفة من المادة والتغيرات التي تطرأ عليها، من حولنا في الحياة اليومية.',
        '• نربط الكيمياء بأشياء مألوفة من حياتنا اليومية.',
        '• نبحث عن المواد التي تكوّن العالم من حولنا.',
        'فهم المادة يساعدنا على تفسير العالم من حولنا.',
      ].join('\n'),
    );
    expect(intro.whyThisLesson).toBe(
      [
        'كيف نفهم المادة من حولنا؟',
        'نبدأ من خصائصها التي نلاحظها، ثم ننتقل إلى ما يحدث تحت المجهر.',
      ].join('\n'),
    );
    expect(intro.overview).toBe(
      [
        '١. نقارن بين الكتلة والوزن.',
        '٢. نشرح أهمية وصف المادة تحت المجهر لعلم الكيمياء.',
        '٣. نحدد فروع علم الكيمياء والمجالات التي تدرسها.',
        'الكيمياء تربط بين ما نراه وما يحدث في المادة.',
      ].join('\n'),
    );
  });

  it('projects a lesson the block rules already read exactly as before (lesson 178)', () => {
    expect(projectApprovedIntroduction(G5_V6, item178Scenes())).toEqual({
      context: [
        'لماذا يهمنا ذلك؟',
        'الجملة الاسمية أساس مهم لفهم المعنى والإعراب في النصوص العربية.',
      ].join('\n'),
      whyThisLesson: [
        'كيف نكتشف وظيفة كل كلمة في الجملة؟',
        'سنستعين بخريطة تساعدنا على الفهم والتحليل والتصحيح.',
        'فكرة الدرس: ننتقل من معرفة المكونات إلى استخدامها في قراءة الجمل وصياغتها بصورة صحيحة.',
      ].join('\n'),
      overview: [
        '١. أحدد مكونات الجملة الاسمية وعلامات إعرابها عند استخدام الأفعال الناسخة.',
        '٢. أميز بين الجملة الفعلية والجملة الاسمية، وأفهم عمل الأفعال والحروف الناسخة.',
        '٣. أحلل الجمل الاسمية وأصلح الأخطاء النحوية فيها.',
        'فهم وظيفة الكلمة يجعلنا نقرأ الجملة ونكتبها بدقة.',
      ].join('\n'),
    });
  });

  it('keeps bulleted objectives that carry no full stop (section 171)', () => {
    expect(projectApprovedIntroduction(G5_V6, section171Scenes())).toEqual({
      context: [
        'What could you learn about a classmate by asking one thoughtful question?',
        'A question can open a window into families, relatives, cities, countries, and personal experiences.',
        'Asking and answering questions helps people understand one another.',
      ].join('\n'),
      whyThisLesson: [
        'How can two people learn about each other through a respectful conversation?',
        'In this lesson, you will practice partner dialogue about family backgrounds, migration, relatives, and places people have visited.',
        'Then switch roles.',
        'Big idea: Effective dialogue means asking with curiosity, listening carefully, and giving both partners space to speak.',
      ].join('\n'),
      overview: [
        '• ask and answer questions with a partner',
        '• check your understanding of effective dialogue',
      ].join('\n'),
    });
  });

  it('keeps numbered objectives that carry no full stop (section 172)', () => {
    expect(projectApprovedIntroduction(G5_V6, section172Scenes())).toEqual({
      context: [
        'What can a family background tell us about a person’s life?',
        'Hans and Saud connect through family roots, places, work, and belonging.',
        'Big idea: Personal background can help people start meaningful conversations.',
      ].join('\n'),
      whyThisLesson: [
        'How can you help someone feel at home in a new community?',
        'You will explore a real conversation about family backgrounds and practise speaking with confidence.',
        'Big idea: Meaningful conversation grows when you listen carefully, emphasize key words, and add information naturally.',
      ].join('\n'),
      overview: ['1 Study the model', '2 Clarify expressions', '3 Role-play together'].join('\n'),
    });
  });

  it('projects every lesson that already projected exactly as before the overview fallback', () => {
    const lessons: Array<[string, () => AppScene[], { context: string[]; whyThisLesson: string[]; overview: string[] }]> = [
      [
        '160',
        item160Scenes,
        {
          context: ['نبحث عن حكم واضح، ثم نبرره بدليل.'],
          whyThisLesson: [
            'كيف نعرف قيمة عبارة منطقية مركبة؟',
            'سنحوّلها إلى خطوات واضحة يمكن فحصها وتفسيرها.',
          ],
          overview: [
            '• نحدد قيم الصواب لعبارات الوصل والفصل باستخدام جداول الصواب.',
            '• ننشئ جداول صواب للعبارات المركبة المعقدة ونفسر نتائجها.',
            '• نمثل العبارات المنطقية بأشكال فن ونفسر العلاقات بينها.',
          ],
        },
      ],
      [
        '164',
        item164Scenes,
        {
          context: [
            'ما المواد التي يتكوّن منها كل ما حولنا؟',
            'الأنواع المختلفة من المادة والتغيرات التي تطرأ عليها، من حولنا في الحياة اليومية.',
            '• نربط الكيمياء بأشياء مألوفة من حياتنا اليومية.',
            '• نبحث عن المواد التي تكوّن العالم من حولنا.',
            'فهم المادة يساعدنا على تفسير العالم من حولنا.',
          ],
          whyThisLesson: [
            'كيف نفهم المادة من حولنا؟',
            'نبدأ من خصائصها التي نلاحظها، ثم ننتقل إلى ما يحدث تحت المجهر.',
          ],
          overview: [
            '١. نقارن بين الكتلة والوزن.',
            '٢. نشرح أهمية وصف المادة تحت المجهر لعلم الكيمياء.',
            '٣. نحدد فروع علم الكيمياء والمجالات التي تدرسها.',
            'الكيمياء تربط بين ما نراه وما يحدث في المادة.',
          ],
        },
      ],
      [
        '178',
        item178Scenes,
        {
          context: [
            'لماذا يهمنا ذلك؟',
            'الجملة الاسمية أساس مهم لفهم المعنى والإعراب في النصوص العربية.',
          ],
          whyThisLesson: [
            'كيف نكتشف وظيفة كل كلمة في الجملة؟',
            'سنستعين بخريطة تساعدنا على الفهم والتحليل والتصحيح.',
            'فكرة الدرس: ننتقل من معرفة المكونات إلى استخدامها في قراءة الجمل وصياغتها بصورة صحيحة.',
          ],
          overview: [
            '١. أحدد مكونات الجملة الاسمية وعلامات إعرابها عند استخدام الأفعال الناسخة.',
            '٢. أميز بين الجملة الفعلية والجملة الاسمية، وأفهم عمل الأفعال والحروف الناسخة.',
            '٣. أحلل الجمل الاسمية وأصلح الأخطاء النحوية فيها.',
            'فهم وظيفة الكلمة يجعلنا نقرأ الجملة ونكتبها بدقة.',
          ],
        },
      ],
      [
        '179',
        item179Scenes,
        {
          context: [
            'يتغير إعراب الفعل المضارع بحسب ما يسبقه من أدوات.',
            'وفهم الإعراب يساعدنا على فهم المعنى وكتابة الجمل كتابة سليمة.',
            'الفكرة الكبرى: تتبدل حركة الفعل، فيتبدل موقعه ومعناه في الجملة.',
            'الأداة التي تسبق الفعل تساعدنا على تحديد حركته.',
          ],
          whyThisLesson: [
            'كيف نعرف إعراب الفعل المضارع؟',
            'سنكتشف ذلك من خلال أمثلة نكتبها ونحللها.',
          ],
          overview: [
            '١. نتعرّف أنواع الفعل المضارع وعلامات إعرابه.',
            '٢. نكتب جملاً تتضمن أفعالاً مضارعة، ونحدّد علامات إعرابها.',
            '٣. نستخدم أسلوب الشرط، ونحدّد الفعل المضارع وعلامة إعرابه.',
            'الفكرة الكبرى: نفهم إعراب الفعل المضارع لنستخدمه بدقّة في كلامنا وكتاباتنا.',
          ],
        },
      ],
    ];

    for (const [item, scenes, expected] of lessons) {
      expect(projectApprovedIntroduction(G5_V6, scenes()), `lesson ${item}`).toEqual({
        context: expected.context.join('\n'),
        whyThisLesson: expected.whyThisLesson.join('\n'),
        overview: expected.overview.join('\n'),
      });
    }
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

  it('answers for a superseded version, so a published item keeps its pinned introduction', async () => {
    mocks.readVersion.mockResolvedValue(
      version({ status: 'superseded', supersededByVersionId: 'tpv-approved0002', supersededAt: 1 }),
    );
    const result = await readApprovedIntroduction({} as never, REQUEST);
    expect(result.versionId).toBe('tpv-approved0001');
    expect(result.introduction.overview).toContain('١. تحلل البيانات');
  });

  it.each(['draft', 'in_review', 'rejected', 'discarded'] as const)(
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
