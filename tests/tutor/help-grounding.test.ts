import { describe, expect, it } from 'vitest';

import { extractKeywords } from '@/lib/server/tutor/arabic-text';
import {
  assessSceneScope,
  SCOPE_MIN_KEYWORDS,
  selectHelpUnits,
  type HelpUnitCandidate,
} from '@/lib/server/tutor/help-grounding';
import { UNIT_CHAR_CAP } from '@/lib/server/tutor/token-budget';

/**
 * Help unit selection (FRD HLP-02/04; plan §8.3, §11 row "Scene-grounded
 * Help and lineage"): the 10,000-char cap, stable cited order, the
 * truncation flag, Scene-only candidates and keyword prioritisation.
 */

const AR = 'تُقاس القوة بوحدة النيوتن وتساوي الكتلة مضروبة في التسارع. ';
const EN = 'A fraction names equal parts of a whole; the denominator counts the parts. ';

function repeat(sentence: string, chars: number): string {
  let out = '';
  while (out.length < chars) out += sentence;
  return out.slice(0, chars);
}

function unit(unitId: string, text: string, title: string | null = null): HelpUnitCandidate {
  return { unitId, title, text };
}

describe('selectHelpUnits', () => {
  it('takes every candidate untouched, in cited order, when the total is within the cap', () => {
    const candidates = [unit('u-3', 'ثالث'), unit('u-1', 'أول'), unit('u-2', 'ثاني')];
    const result = selectHelpUnits({ candidates, question: 'اشرح', cap: UNIT_CHAR_CAP });
    expect(result.units.map((u) => u.unitId)).toEqual(['u-3', 'u-1', 'u-2']);
    expect(result).toMatchObject({
      totalChars: candidates.reduce((sum, c) => sum + c.text.length, 0),
      truncated: false,
      capped: false,
      droppedUnitIds: [],
    });
    expect(result.units.every((u) => !u.truncated)).toBe(true);
  });

  it('selects a subset under the cap by keyword overlap and re-sorts the picks to cited order', () => {
    const candidates = [
      unit('u-a', repeat(EN, 4_000), 'Fractions'),
      unit('u-b', `${repeat(AR, 3_900)} قانون نيوتن الثاني`, 'القوة'),
      unit('u-c', `${repeat(EN, 3_900)} the numerator counts the shaded parts`, 'Numerator'),
      unit('u-d', repeat(AR, 4_000), 'التسارع'),
    ];
    const result = selectHelpUnits({
      candidates,
      question: 'What does the numerator count in a fraction?',
      sceneTitle: 'Fractions',
      cap: UNIT_CHAR_CAP,
    });
    expect(result.capped).toBe(true);
    expect(result.totalChars).toBeLessThanOrEqual(UNIT_CHAR_CAP);
    // u-c (question keywords) and u-a (scene title + "fraction") outrank the Arabic units;
    // the picks come back in CITED order, not score order.
    expect(result.units.map((u) => u.unitId)).toEqual(['u-a', 'u-c']);
    expect(result.droppedUnitIds).toEqual(['u-b', 'u-d']);
    expect(result.truncated).toBe(false);
  });

  it('breaks score ties by cited order (greedy, stable)', () => {
    const candidates = [
      unit('u-1', repeat(AR, 4_000)),
      unit('u-2', repeat(AR, 4_000)),
      unit('u-3', repeat(AR, 4_000)),
    ];
    const result = selectHelpUnits({ candidates, question: 'اشرح لي', cap: UNIT_CHAR_CAP });
    expect(result.units.map((u) => u.unitId)).toEqual(['u-1', 'u-2']);
    expect(result.droppedUnitIds).toEqual(['u-3']);
    expect(result.totalChars).toBe(8_000);
  });

  it('keeps filling with smaller lower-ranked units that still fit (greedy under the cap)', () => {
    const candidates = [
      unit('u-big', repeat(`${EN} denominator. `, 9_000), 'Big'),
      unit('u-mid', repeat(EN, 5_000), 'Mid'),
      unit('u-small', repeat(AR, 900), 'Small'),
    ];
    const result = selectHelpUnits({ candidates, question: 'denominator', cap: UNIT_CHAR_CAP });
    expect(result.units.map((u) => u.unitId)).toEqual(['u-big', 'u-small']);
    expect(result.totalChars).toBe(9_900);
  });

  it('head-cuts a single oversized unit at the last paragraph boundary and flags it', () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => `فقرة ${i + 1}: ${repeat(AR, 1_000)}`);
    const giant = unit('u-giant', paragraphs.join('\n\n'), 'كبير');
    expect(giant.text.length).toBeGreaterThan(UNIT_CHAR_CAP);
    const result = selectHelpUnits({ candidates: [giant], question: 'القوة', cap: UNIT_CHAR_CAP });
    expect(result.units).toHaveLength(1);
    const [kept] = result.units;
    expect(kept!.unitId).toBe('u-giant');
    expect(kept!.truncated).toBe(true);
    expect(kept!.chars).toBeLessThanOrEqual(UNIT_CHAR_CAP);
    expect(kept!.text.endsWith(repeat(AR, 1_000))).toBe(true);
    expect(giant.text.startsWith(kept!.text)).toBe(true);
    expect(result).toMatchObject({ truncated: true, capped: true, totalChars: kept!.chars });
  });

  it('when every candidate alone exceeds the cap, head-cuts the best-scored one only', () => {
    const candidates = [
      unit('u-1', repeat(AR, 12_000), 'أول'),
      unit('u-2', `${repeat(EN, 11_000)}\n\ndenominator`, 'second'),
    ];
    const result = selectHelpUnits({ candidates, question: 'the denominator', cap: UNIT_CHAR_CAP });
    expect(result.units.map((u) => [u.unitId, u.truncated])).toEqual([['u-2', true]]);
    expect(result.units[0]!.chars).toBeLessThanOrEqual(UNIT_CHAR_CAP);
    expect(result.droppedUnitIds).toEqual(['u-1']);
  });

  it('never returns a unit outside the Scene candidates, and never invents one', () => {
    const candidates = [unit('u-x', repeat(EN, 6_000)), unit('u-y', repeat(EN, 6_000))];
    const result = selectHelpUnits({
      candidates,
      question: 'photosynthesis chlorophyll',
      cap: UNIT_CHAR_CAP,
    });
    const ids = new Set(candidates.map((c) => c.unitId));
    for (const kept of result.units) expect(ids.has(kept.unitId)).toBe(true);
    expect(result.units.length + result.droppedUnitIds.length).toBe(candidates.length);
    expect(selectHelpUnits({ candidates: [], question: 'x' })).toEqual({
      units: [],
      totalChars: 0,
      truncated: false,
      droppedUnitIds: [],
      capped: false,
    });
  });

  it('prioritises by the question first, then the Scene title and visible step text', () => {
    const candidates = [
      unit('u-step', repeat(`${AR} الكتلة المحفوظة في التفاعل. `, 4_900), 'الكتلة'),
      unit('u-q', repeat(`${EN} velocity. `, 4_900), 'Velocity'),
      unit('u-none', repeat(AR, 4_900), 'آخر'),
    ];
    const byQuestion = selectHelpUnits({
      candidates,
      question: 'what is velocity?',
      visibleStepText: 'المحفوظة',
      cap: UNIT_CHAR_CAP,
    });
    expect(byQuestion.units.map((u) => u.unitId)).toEqual(['u-step', 'u-q']);
    expect(byQuestion.units.find((u) => u.unitId === 'u-q')!.score).toBeGreaterThan(
      byQuestion.units.find((u) => u.unitId === 'u-step')!.score,
    );
    const byStep = selectHelpUnits({
      candidates,
      question: 'اشرح',
      visibleStepText: 'الكتلة المحفوظة',
      cap: 6_000,
    });
    expect(byStep.units.map((u) => u.unitId)).toEqual(['u-step']);
  });
});

describe('assessSceneScope (HLP-04)', () => {
  const units = [
    unit('u-1', 'قانون حفظ الكتلة: كتلة المتفاعلات تساوي كتلة النواتج.', 'حفظ الكتلة'),
  ];

  it('keeps short follow-ups and overlapping questions in scope', () => {
    expect(assessSceneScope({ question: 'اشرح تاني', units }).decision).toBe('in_scope');
    expect(assessSceneScope({ question: 'a hint please', units }).decision).toBe('in_scope');
    expect(
      assessSceneScope({ question: 'ليه كتلة المتفاعلات تساوي كتلة النواتج دايمًا؟', units }),
    ).toMatchObject({ decision: 'in_scope' });
    expect(assessSceneScope({ question: '؟؟', units })).toEqual({
      decision: 'in_scope',
      overlap: 0,
      keywordCount: 0,
      cue: null,
    });
    // A continuation / answer-check cue stays anchored even with several unrelated keywords.
    expect(assessSceneScope({ question: 'اشرح تاني بمثال تاني من فضلك', units })).toMatchObject({
      decision: 'in_scope',
      cue: 'continuation',
    });
    expect(
      assessSceneScope({ question: 'is my answer right: twelve grams stay twelve grams', units }),
    ).toMatchObject({ decision: 'in_scope', cue: 'answer_check' });
  });

  it('flags a real content question with zero overlap with the Scene as outside it', () => {
    const result = assessSceneScope({
      question: 'How does photosynthesis convert sunlight into glucose inside chloroplasts?',
      sceneTitle: 'حفظ الكتلة',
      visibleStepText: 'كتلة المتفاعلات تساوي كتلة النواتج',
      units,
    });
    expect(result).toMatchObject({ decision: 'outside_scene', overlap: 0, cue: null });
    expect(result.keywordCount).toBeGreaterThanOrEqual(3);
  });

  it('FC-A05: «ما هو قانون أوم في الكهرباء؟» on the inductive-reasoning opening Scene is outside it (exactly 3 keywords, no overlap)', () => {
    // Android staging run 2026-10-07, FCE-006: Mathematics lesson «التبرير الاستقرائي
    // والتخمين», Scene 1 (FCE-006-lesson-runner.png: slide text + opening narration).
    const sceneTitle = 'التبرير الاستقرائي والتخمين';
    const visibleStepText = [
      'التبرير الاستقرائي والتخمين',
      'سؤال تمهيدي: ماذا يمكن أن نعرف من تكرار نمط في بيانات العملاء؟',
      'لماذا يهمنا ذلك؟ تحليل البيانات يساعد على الوصول إلى نتائج وتوقعات. نستخدم الأنماط لفهم ما قد يحدث لاحقًا.',
      'الفكرة التي سنبنيها: نبدأ من أمثلة وبيانات محددة. نصل منها إلى نتيجة عامة أو تخمين.',
      'رسالتنا: النمط المتكرر في البيانات قد يقودنا إلى توقع معقول، لكنه يحتاج إلى فحص ودليل.',
      'عدد الزبائن في الأيام الثلاثة الأخيرة من كل أسبوع. رسم بياني يوضح نمط عدد الزبائن خلال الأشهر.',
      'السلام عليكم يا شباب، حياكم الله. درسنا اليوم عن التبرير الاستقرائي والتخمين، ونبدأ بسؤال بسيط: إذا تكرر نمط معيّن في بيانات العملاء، وش ممكن نعرف منه؟',
    ].join('\n');
    const sceneUnits = [
      unit(
        'cu-why',
        'لاحظ صاحب صالون حلاقة أن عدد الزبائن في أيام الخميس والجمعة والسبت يزداد خلال الأشهر الستة الأخيرة، فتوقع أنه سيحتاج إلى حلاقين إضافيين في هذه الأيام. يستعمل المحللون في أبحاث التسويق البيانات المتكررة لوضع تخمينات حول سلوك العملاء.',
        'لماذا؟',
      ),
      unit(
        'cu-def',
        'التبرير الاستقرائي: تبرير يستعمل عددًا من الأمثلة والملاحظات المحددة للوصول إلى نتيجة عامة. التخمين: عبارة غير مثبتة يُعتقد أنها صحيحة، تُبنى على الملاحظة. مثال: اكتب وصفًا للنمط ثم أوجد العدد التالي في المتتابعة 2، 4، 12، 48، 240. كل عدد يساوي العدد السابق مضروبًا في 2 ثم 3 ثم 4 ثم 5، فالعدد التالي 1440.',
        'التبرير الاستقرائي والتخمين',
      ),
      unit(
        'cu-counter',
        'لإثبات أن التخمين خاطئ يكفي إيجاد مثال واحد يكون فيه الفرض صحيحًا والنتيجة غير صحيحة، ويسمى مثالًا مضادًا. مثال: التخمين «مجموع أي عددين أوليين عدد زوجي» خاطئ؛ لأن 2 + 3 = 5.',
        'المثال المضاد',
      ),
    ];
    const question = 'ما هو قانون أوم في الكهرباء؟';
    // The keywords the rule sees: exactly SCOPE_MIN_KEYWORDS (3), none of them in the Scene.
    expect(extractKeywords(question)).toEqual(['قانون', 'اوم', 'كهرباء']);
    expect(SCOPE_MIN_KEYWORDS).toBe(3);
    const reference = new Set(
      extractKeywords(
        [sceneTitle, visibleStepText, ...sceneUnits.map((u) => `${u.title} ${u.text}`)].join(' '),
      ),
    );
    expect(extractKeywords(question).filter((keyword) => reference.has(keyword))).toEqual([]);

    expect(assessSceneScope({ question, sceneTitle, visibleStepText, units: sceneUnits })).toEqual({
      decision: 'outside_scene',
      overlap: 0,
      keywordCount: 3,
      cue: null,
    });
  });

  it('counts the Scene title and visible step text as Scene evidence', () => {
    const result = assessSceneScope({
      question: 'explain the shaded parts numerator denominator',
      sceneTitle: 'Fractions: the numerator and the denominator',
      units: [unit('u-ar', repeat(AR, 200))],
    });
    expect(result.decision).toBe('in_scope');
    expect(result.overlap).toBeGreaterThan(0);
  });
});

describe('assessSceneScope: questions about the current step stay in the Scene (FC-A05 follow-up)', () => {
  // The same inductive-reasoning opening Scene as the Ohm's-law case above, kept short: none of
  // the generic words below («أهم», «فكرة», «المقصود», «كلام», «الخطوة») appear in it.
  const sceneTitle = 'التبرير الاستقرائي والتخمين';
  const visibleStepText =
    'نبدأ من أمثلة وبيانات محددة. نصل منها إلى نتيجة عامة أو تخمين. النمط المتكرر في البيانات قد يقودنا إلى توقع معقول، لكنه يحتاج إلى فحص ودليل.';
  const units = [
    unit(
      'cu-def',
      'التبرير الاستقرائي: تبرير يستعمل عددًا من الأمثلة والملاحظات المحددة للوصول إلى نتيجة عامة. التخمين: عبارة غير مثبتة يُعتقد أنها صحيحة.',
      'التبرير الاستقرائي',
    ),
  ];
  const scope = (question: string) =>
    assessSceneScope({ question, sceneTitle, visibleStepText, units });

  it.each([
    // cls_int_test.dart:95, the integration journey's in-scene Help question.
    'إيه أهم فكرة في الخطوة دي؟',
    'ما أهم فكرة في هذه الخطوة؟',
    'إيه المقصود بالكلام ده في الخطوة دي؟',
    'وضحلي الفكرة دي بالمثال اللي في الشريحة دي',
    'What is the main idea of this step?',
  ])('«%s» is about the Scene', (question) => {
    expect(scope(question).decision).toBe('in_scope');
  });

  it('generic words alone never make a question "outside" (no pointer, no Scene keyword)', () => {
    expect(scope('إيه أهم فكرة والمقصود بالكلام؟')).toMatchObject({
      decision: 'in_scope',
      keywordCount: 0,
    });
  });

  it('a real off-Scene topic is still outside, even with generic words around it', () => {
    expect(scope('ما أهم استخدامات قانون أوم في الكهرباء؟')).toMatchObject({
      decision: 'outside_scene',
      overlap: 0,
      cue: null,
    });
    expect(scope('ما هو قانون أوم في الكهرباء؟').decision).toBe('outside_scene');
  });
});
