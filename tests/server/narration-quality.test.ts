/**
 * Narration quality for Teaching Package Generation: TTS-ready scientific
 * speech (no raw notation), a Saudi register that a token marker cannot fake,
 * and topic signposting validated against the same transition the prompt
 * announced.
 */
import { describe, expect, it } from 'vitest';

import {
  resolveSpeechRegisterPolicy,
  resolveSpokenScriptOptions,
  validateSpeechRegister,
} from '@/lib/server/speech/register-policy';
import {
  formatNarrationSignpostingCorrection,
  validateNarrationSignposting,
  type NarrationSceneContext,
} from '@/lib/server/speech/narration-signposting';

const policy = (subjectCode: string) =>
  resolveSpeechRegisterPolicy({ language: 'ar-SA', subjectCode })!;
const codes = (texts: string[], subjectCode: string) =>
  validateSpeechRegister(texts, policy(subjectCode)).map((issue) => issue.code);

describe('scientific speech: raw notation is rejected, spoken forms accepted', () => {
  it.each([
    [
      'MATH',
      'طيب، عندنا x² + 5 = 14',
      'طيب، عندنا سين تربيع زائد خمسة يساوي أربعة عشر.',
      'x² + 5 = 14',
    ],
    [
      'PHYSICS',
      'الحين نعوض في F = ma وتكون النتيجة 20 N',
      'الحين نعوض في المعادلة: إف يساوي إم في إيه، ويطلع معنا إن القوة تساوي عشرين نيوتن.',
      'F = ma',
    ],
    [
      'CHEMISTRY',
      'يتكون الماء من H₂O',
      'طيب، الماء صيغته إتش اثنين أو، ويتكون من ذرتين هيدروجين وذرة أكسجين.',
      'H₂O',
    ],
  ])('%s', (subject, rejected, accepted, evidence) => {
    const issues = validateSpeechRegister([rejected], policy(subject));
    expect(issues.map((issue) => issue.code)).toEqual(['RAW_SPOKEN_NOTATION']);
    expect(issues[0]!.evidence).toContain(evidence);
    expect(validateSpeechRegister([accepted], policy(subject))).toEqual([]);
  });

  it('detects LaTeX, fractions, relations, roots, quantities and reactions; bounded evidence', () => {
    const issue = validateSpeechRegister(
      ['عندنا \\frac{3}{4} و $x^2$، وكمان 3/4 و x ≥ 5 و √9 و 9.8 m/s² وأيضا 1 + 1 = 2 و 2 + 2 = 4'],
      policy('PHYSICS'),
    ).find((found) => found.code === 'RAW_SPOKEN_NOTATION')!;
    expect(issue.evidence.length).toBeLessThanOrEqual(5);
    expect(issue.evidence).toContain('\\frac{3}{4}');
    expect(validateSpeechRegister(['2H₂ + O₂ → 2H₂O'], policy('CHEMISTRY'))[0]?.evidence).toEqual([
      '2H₂ + O₂ → 2H₂O',
    ]);
  });

  it('ordinary prose, plain numbers, times, percentages and lone letters are not rejected', () => {
    expect(codes(['طيب، بنحل 12 تمرين الحين، وخذوا ٣ دقائق، والساعة 10:30 نكمل.'], 'MATH')).toEqual(
      [],
    );
    expect(codes(['يعني خمسين بالمية، أو 50% تقريبًا.'], 'MATH')).toEqual([]);
    expect(codes(['طيب، النقطة A والنقطة B على المستقيم.'], 'MATH')).toEqual([]);
  });

  it('Arabic-Indic numbers, times and percentages are prose; an Arabic-Indic fraction is not', () => {
    expect(codes(['يعني ٥٠٪ تقريبًا، والساعة ١٠:٣٠، وتسعة فاصلة ثمانية أو ٩٫٨.'], 'MATH')).toEqual(
      [],
    );
    expect(codes(['الكسر ٣/٤ هنا.'], 'MATH')).toEqual(['RAW_SPOKEN_NOTATION']);
  });

  it('only Mathematics, Physics and Chemistry are checked for notation', () => {
    expect(codes(['طيب، الحين نشوف x² + 5 = 14'], 'BIOLOGY')).toEqual([]);
    const msa = resolveSpeechRegisterPolicy({ language: 'ar', subjectCode: 'ARABIC' })!;
    expect(msa.notationSubject).toBeNull();
  });
});

describe('Saudi register: judged on the whole narration', () => {
  const FORMAL_WITH_ONE_MARKER = [
    'طيب. في هذا الدرس سوف نقوم بدراسة القوة المحصلة المؤثرة على الأجسام، ولدينا العديد من الأمثلة التي توضح ذلك.',
    'لنبدأ الآن بتعريف القوة المحصلة، إذ يتعين علينا أولًا معرفة جميع القوى المؤثرة على الجسم، ومن ثم فإننا نقوم بجمعها جمعًا متجهيًا للحصول على النتيجة النهائية الصحيحة.',
  ];

  it('a long formal narration with one superficial Saudi marker is rejected', () => {
    const issues = validateSpeechRegister(FORMAL_WITH_ONE_MARKER, policy('PHYSICS'));
    expect(issues.map((issue) => issue.code)).toEqual(['FORMAL_NARRATION']);
    expect(issues[0]!.evidence).toEqual(expect.arrayContaining(['سوف', 'لدينا']));
  });

  it('short natural educational speech passes without slang in every segment', () => {
    expect(
      validateSpeechRegister(
        ['هذي هي القوة المحصلة.', 'نجمع القوى مع بعض.', 'طيب، واضح؟'],
        policy('PHYSICS'),
      ),
    ).toEqual([]);
  });

  it('natural Saudi narration with an occasional formal word passes', () => {
    expect(
      validateSpeechRegister(
        [
          'طيب يا شباب، الحين ننتقل لموضوع القوة المحصلة. القوة المحصلة هي مجموع القوى اللي تأثر على الجسم، وعشان نحسبها نجمع القوى مع بعض.',
          'خلونا نشوف مثال بسيط: عندنا قوة عشرة نيوتن لليمين وقوة أربعة نيوتن لليسار، فيطلع معنا إن المحصلة ستة نيوتن لليمين، وهذا لدينا في الكتاب كمان.',
        ],
        policy('PHYSICS'),
      ),
    ).toEqual([]);
  });

  it('subject ARABIC keeps Modern Standard Arabic and accepts MSA narration', () => {
    const msa = resolveSpeechRegisterPolicy({ language: 'ar', subjectCode: 'ARABIC' })!;
    expect(msa.register).toBe('msa');
    expect(validateSpeechRegister(FORMAL_WITH_ONE_MARKER, msa)).toEqual([]);
  });
});

describe('resolveSpokenScriptOptions', () => {
  it('Arabic with a policy → Arabic script with its register; other languages → other; else none', () => {
    expect(resolveSpokenScriptOptions('ar', policy('MATH'))).toEqual({
      language: 'arabic',
      register: 'saudi-white-spoken',
    });
    expect(
      resolveSpokenScriptOptions(
        'ar',
        resolveSpeechRegisterPolicy({ language: 'ar', subjectCode: 'ARABIC' }),
      ),
    ).toEqual({ language: 'arabic', register: 'msa' });
    expect(resolveSpokenScriptOptions('en-US', null)).toEqual({ language: 'other' });
    expect(resolveSpokenScriptOptions('ar', null)).toBeUndefined();
    expect(resolveSpokenScriptOptions(undefined, null)).toBeUndefined();
  });
});

describe('topic signposting', () => {
  const TITLES = [
    'مقدمة في الحركة',
    'قانون نيوتن الأول',
    'القوة المحصلة',
    'القوة المحصلة على سطح مائل',
    'مثال على قانون نيوتن الثاني',
    'تمارين',
    'ملخص الدرس',
  ];
  const scene = (
    pageIndex: number,
    extra: Partial<NarrationSceneContext['outline']> = {},
  ): NarrationSceneContext => ({
    outline: { type: 'slide', title: TITLES[pageIndex - 1]!, keyPoints: [], ...extra },
    ctx: { pageIndex, totalPages: TITLES.length, allTitles: TITLES },
  });
  const check = (texts: string[], at: NarrationSceneContext) =>
    validateNarrationSignposting(texts, at).map((issue) => issue.code);

  it('narration must exist', () => {
    expect(check([], scene(3))).toEqual(['NARRATION_MISSING']);
  });

  it('first scene: greets and introduces the lesson topic', () => {
    expect(check(['هلا والله يا شباب، اليوم بنتعرف على الحركة وقوانين نيوتن.'], scene(1))).toEqual(
      [],
    );
  });

  it('a new topic must be announced and named before it is explained', () => {
    expect(
      check(['القوة المحصلة هي مجموع القوى المؤثرة على الجسم.', 'ونحسبها بالجمع.'], scene(3)),
    ).toEqual(['TOPIC_NOT_SIGNALED']);
    expect(
      check(
        [
          'طيب، الحين ننتقل لموضوع القوة المحصلة. القوة المحصلة هي مجموع القوى اللي تأثر على الجسم.',
        ],
        scene(3),
      ),
    ).toEqual([]);
    // Arabic morphology: «القوى المحصلة» names the same topic.
    expect(check(['خلونا الحين نتعرف على القوى المحصلة وكيف نحسبها.'], scene(3))).toEqual([]);
  });

  it('a continuation needs no title repetition', () => {
    expect(
      check(['ونكمل الحين، بعد ما عرفنا الفكرة الأساسية نشوف السطح المائل.'], scene(4)),
    ).toEqual([]);
  });

  it('a worked example announces the example', () => {
    const example = scene(5, { contentRole: 'worked_example' });
    expect(check(['طيب، خلونا ناخذ مثال على قانون نيوتن الثاني.'], example)).toEqual([]);
    expect(check(['عندنا جسم كتلته خمسة كيلوجرام يتحرك.'], example)).toEqual([
      'TOPIC_NOT_SIGNALED',
    ]);
  });

  it('a practice scene (and a quiz) announces practice', () => {
    const practice = scene(6, { type: 'quiz' });
    expect(check(['الحين نجرب سؤال على الفكرة اللي أخذناها.'], practice)).toEqual([]);
    expect(check(['الجسم يتحرك بسرعة ثابتة إذا كانت المحصلة صفر.'], practice)).toEqual([
      'TOPIC_NOT_SIGNALED',
    ]);
  });

  it('natural quiz and summary openings are accepted (no false rejection)', () => {
    for (const opening of [
      'خلونا نتأكد من فهمنا للي أخذناه.',
      'طيب، نشيك على فهمنا بسرعة.',
      'يلا نشوف وش فهمنا من الدرس.',
    ]) {
      expect(check([opening], scene(6, { type: 'quiz' }))).toEqual([]);
    }
    for (const opening of [
      'نسترجع اللي أخذناه اليوم.',
      'نرجع على أهم الأفكار اللي مرت علينا.',
      'وفي الختام، تذكروا إن القوة تغير الحركة.',
    ]) {
      expect(check([opening], scene(7, { contentRole: 'summary' }))).toEqual([]);
    }
  });

  it('a summary scene announces the summary', () => {
    const summary = scene(7, { contentRole: 'summary' });
    expect(check(['وقبل ما نختم، خلونا نلخص أهم النقاط.'], summary)).toEqual([]);
    expect(check(['القوة المحصلة تغير حالة الجسم الحركية.'], summary)).toEqual([
      'TOPIC_NOT_SIGNALED',
    ]);
  });

  it('a middle scene does not greet again', () => {
    expect(check(['أهلًا يا شباب، ونكمل الحين السطح المائل.'], scene(4))).toEqual([
      'REPEATED_GREETING',
    ]);
  });

  it('the correction names the scene, its role and transition, and the required opening', () => {
    const at = scene(3, { contentRole: 'explanation' });
    const issues = validateNarrationSignposting(['القوة المحصلة هي مجموع القوى.'], at);
    const correction = formatNarrationSignpostingCorrection(issues, at);
    expect(correction).toContain('Scene 3 of 7 «القوة المحصلة»');
    expect(correction).toContain('role: explanation');
    expect(correction).toContain('transition: new-topic');
    expect(correction).toContain('announce the move to the new topic and name it');
    expect(correction).toContain('NEW TOPIC (page 3 of 7)');
  });
});
