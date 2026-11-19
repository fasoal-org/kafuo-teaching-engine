/**
 * g5.v10 (learner-first plan W2): the narration is checked against its own canvas and
 * re-rolled; what is still wrong after the last attempt marks the scene and never fails
 * it. Cases are item 208's slides (15 Nov 2026).
 */
import { describe, expect, it, vi } from 'vitest';

import {
  canvasLatinLetters,
  formatLearnerFirstNarrationCorrection,
  itemElementIds,
  LATIN_LETTER_READINGS,
  validateLearnerFirstNarration,
  type NarrationCanvasElement,
} from '@/lib/server/speech/learner-first-narration';
import { LATIN_LETTER_READINGS as PROMPT_TABLE } from '@/packages/@openmaic/generation/src/learner-first';
import {
  generateRegisterCompliantActions,
  learnerFirstNarrationCheck,
} from '@/lib/server/classroom-generation';
import { resolveSpeechRegisterPolicy } from '@/lib/server/speech/register-policy';

const SOLUTION: NarrationCanvasElement[] = [
  { id: 't', type: 'text', text: 'حل تحقق ٢أ: مجموع عددين زوجيين' },
  { id: 'a', type: 'text', text: 'أمثلة على جمع عددين زوجيين ٢ + ٤ = ٦' },
  { id: 'b', type: 'text', text: 'تحقق ٢ب: العلاقة بين أطوال القطع AB = CD و CD = EF' },
  { id: 'c', type: 'text', text: 'تحقق ٢ج: مجموع مربعي عددين كليين متتاليين' },
];

const speech = (text: string) => ({ type: 'speech', text });
const spot = (elementId: string) => ({ type: 'spotlight', elementId });

describe('learner-first narration checks', () => {
  it('pins the server letter table to the prompt table', () => {
    expect(LATIN_LETTER_READINGS).toEqual(PROMPT_TABLE);
  });

  it('finds the labelled items of a slide, not its numbered steps', () => {
    expect(itemElementIds(SOLUTION)).toEqual(['b', 'c']);
    expect(
      itemElementIds([
        { id: '1', type: 'text', text: 'أ) التخمين الجبري' },
        { id: '2', type: 'text', text: 'ب) التخمين الهندسي' },
        { id: '3', type: 'text', text: '١. نختار n = ١' },
        { id: '4', type: 'text', text: 'السؤال ٧: حاصل ضرب عددين زوجيين' },
      ]),
    ).toEqual(['1', '2', '4']);
  });

  it('flags a solution slide whose narration explains item أ only (item 208 slide 10)', () => {
    const issues = validateLearnerFirstNarration(
      [spot('a'), speech('اثنين زائد أربعة يساوي ستة، وستة عدد زوجي.')],
      SOLUTION,
    );
    expect(issues.map((issue) => issue.code)).toEqual(['NARRATION_ITEM_MISSING']);
    expect(issues[0]!.evidence).toContain('element b, c');
  });

  it('passes when every item element is pointed to', () => {
    expect(
      validateLearnerFirstNarration(
        [
          spot('b'),
          speech('القطعة إيه بي تساوي سي دي.'),
          spot('c'),
          speech('مربع واحد زائد مربع اثنين.'),
        ],
        SOLUTION,
      ),
    ).toEqual([]);
  });

  it('flags an image described by colours and positions (item 208 slide 5)', () => {
    const issues = validateLearnerFirstNarration(
      [speech('الصورة تعرض مسارات زرقاء متقطعة ونقاط خضراء قرب الزاوية السفلية اليسرى.')],
      [{ id: 'img', type: 'image', text: '' }],
    );
    expect(issues.map((issue) => issue.code)).toEqual(['IMAGE_APPEARANCE_NARRATION']);
  });

  it('flags Latin letters read with Arabic letter names (item 208 slides 18–19)', () => {
    const canvas: NarrationCanvasElement[] = [
      { id: 'q', type: 'text', text: 'إذا كان ∠ABE ≅ ∠DBC فإنهما متقابلتان بالرأس' },
    ];
    const issues = validateLearnerFirstNarration(
      [speech('المعطى إن الزاوية ألف باء هاء تطابق الزاوية دال باء جيم.')],
      canvas,
    );
    expect(issues.map((issue) => issue.code)).toEqual(['SYMBOL_READING_ARABIC_NAME']);
    expect(canvasLatinLetters(canvas)).toEqual(new Set(['A', 'B', 'E', 'D', 'C']));
  });

  it('never flags a year read in words, nor English letter names', () => {
    const canvas: NarrationCanvasElement[] = [
      { id: 'q', type: 'text', text: 'النقطة A والقطعة AB' },
    ];
    expect(
      validateLearnerFirstNarration(
        [
          speech('في عام ألف وأربعمئة وتسعة عشر كان السعر عشرين.'),
          speech('النقطة إيه والقطعة إيه بي.'),
        ],
        canvas,
      ),
    ).toEqual([]);
  });

  it("finds the book's own labels «(1A)», «1B» and «(١أ)» (review MED-4)", () => {
    expect(
      itemElementIds([
        { id: '1', type: 'text', text: '(1A) متتابعة أشهر: صفر، رجب' },
        { id: '2', type: 'text', text: '1B 10, 4, -2, -8' },
        { id: '3', type: 'text', text: '(١أ) متتابعة' },
        { id: '4', type: 'text', text: '10 cm طول الضلع' },
      ]),
    ).toEqual(['1', '2', '3']);
  });

  it('ignores LaTeX commands, entities and units as symbols, and «العدد ألف» (review MED-5)', () => {
    expect(
      canvasLatinLetters([{ id: 'q', type: 'text', text: '\\sin x \\le 1 &lt; طول ١٠ cm' }]),
    ).toEqual(new Set(['X']));
    const canvas: NarrationCanvasElement[] = [{ id: 'q', type: 'text', text: 'النقطة A' }];
    expect(validateLearnerFirstNarration([speech('العدد ألف أكبر من تسعمئة.')], canvas)).toEqual(
      [],
    );
    expect(
      validateLearnerFirstNarration([speech('النقطة ألف على المستقيم.')], canvas).map(
        (i) => i.code,
      ),
    ).toEqual(['SYMBOL_READING_ARABIC_NAME']);
  });

  it('allows a colour the slide itself prints as data (review MED-5)', () => {
    const canvas: NarrationCanvasElement[] = [
      { id: 'img', type: 'image', text: '' },
      { id: 't', type: 'text', text: 'في الكيس ٣ كرات حمراء و٢ زرقاء' },
    ];
    expect(
      validateLearnerFirstNarration([speech('في الصورة ثلاث كرات حمراء وكرتان زرقاء.')], canvas),
    ).toEqual([]);
  });

  it('asks a try-it slide to read its items, never to solve them (review HIGH-2)', () => {
    const issue = [{ code: 'NARRATION_ITEM_MISSING' as const, evidence: 'b, c' }];
    expect(formatLearnerFirstNarrationCorrection(issue, SOLUTION, 'check_understanding')).toContain(
      'never solve an item',
    );
    expect(formatLearnerFirstNarrationCorrection(issue, SOLUTION, 'worked_example')).toContain(
      'explain it fully',
    );
  });

  it('writes one correction line per issue, with the letter readings', () => {
    const text = formatLearnerFirstNarrationCorrection(
      [{ code: 'SYMBOL_READING_ARABIC_NAME', evidence: 'ألف باء' }],
      [{ id: 'q', type: 'text', text: 'AB' }],
    );
    expect(text).toContain('SYMBOL_READING_ARABIC_NAME');
    expect(text).toContain('A «إيه»');
    expect(text).toContain('B «بي»');
  });
});

describe('quality plan W3: single letter names, clock times, a conjecture called proved', () => {
  // The item check (spotlights) is covered above; these cases test the W3 checks only.
  const codes = (lines: string[], canvas: NarrationCanvasElement[]) =>
    validateLearnerFirstNarration(lines.map(speech), canvas)
      .map((issue) => issue.code)
      .filter((code) => code !== 'NARRATION_ITEM_MISSING');

  it("flags item 195's lone «سين», «صاد» and «ألف» for x, y and a", () => {
    const inequality: NarrationCanvasElement[] = [
      { id: 'q', type: 'text', text: 'ب) x ≤ -3   ج) -1 ≤ x ≤ 5' },
    ];
    expect(codes(['سين أصغر من أو يساوي سالب ثلاثة.'], inequality)).toEqual([
      'SYMBOL_READING_ARABIC_NAME',
    ]);
    expect(
      codes(['سالب واحد أصغر من أو يساوي سين، وسين أصغر من أو يساوي خمسة.'], inequality),
    ).toEqual(['SYMBOL_READING_ARABIC_NAME']);
    const fx: NarrationCanvasElement[] = [{ id: 'f', type: 'latex', text: 'f(x)=x^2+8x-24' }];
    expect(codes(['إف للسين تساوي اثنين سين زائد ثلاثة.'], fx)).toEqual([
      'SYMBOL_READING_ARABIC_NAME',
    ]);
    const relation: NarrationCanvasElement[] = [{ id: 'e', type: 'latex', text: '3y + 6x = 18' }];
    expect(codes(['ثلاثة صاد زائد ستة سين يساوي ثمانية عشر.'], relation)).toEqual([
      'SYMBOL_READING_ARABIC_NAME',
    ]);
    const input: NarrationCanvasElement[] = [{ id: 'c', type: 'latex', text: 'f(-3a+8)' }];
    expect(codes(['إف لسالب ثلاثة ألف زائد ثمانية.'], input)).toEqual([
      'SYMBOL_READING_ARABIC_NAME',
    ]);
  });

  it("passes Terra 208's correct readings: item letters, English names and years", () => {
    const prices: NarrationCanvasElement[] = [
      { id: 'a', type: 'text', text: 'أ) أنشئ التمثيل البياني الأنسب' },
      { id: 'b', type: 'text', text: 'ب) ضع تخمينًا لسعر المنتج عام 1449هـ' },
    ];
    expect(
      codes(
        [
          'الفقرة ألف: أنشئ التمثيل البياني الأنسب لعرض هذه البيانات.',
          'الفقرة باء: ضع تخمينًا لسعر المنتج عام ألف وأربعمئة وتسعة وأربعين هجرية.',
        ],
        prices,
      ),
    ).toEqual([]);
    // Slide 21: Latin points A, B, E next to the Arabic item ب.
    const angles: NarrationCanvasElement[] = [
      { id: 'a', type: 'text', text: 'أ) إذا كان n عددًا حقيقيًا فإن −n عدد سالب' },
      { id: 'b', type: 'text', text: 'ب) إذا كانت ∠ABE ≅ ∠DBC فإنهما متقابلتان بالرأس' },
    ];
    expect(
      codes(
        [
          'باء، التخمين: إذا كانت الزاوية إيه بي إي تطابق الزاوية دي بي سي، فإنهما متقابلتان بالرأس.',
          'في الفقرة ألف، التخمين يقول: إذا كان العدد إن عددًا حقيقيًا، فإن سالب إن عدد سالب.',
        ],
        angles,
      ),
    ).toEqual([]);
    // «الإحداثي السيني» is the x-coordinate's own name, and «س» on the canvas is read «سين».
    expect(codes(['نقرأ الإحداثي السيني أولًا.'], [{ id: 'x', type: 'text', text: 'x' }])).toEqual(
      [],
    );
    expect(codes(['سين أكبر من ثلاثة.'], [{ id: 's', type: 'text', text: 'س > 3 أو x' }])).toEqual(
      [],
    );
    // «عشرين ألف» is twenty thousand.
    expect(codes(['الإنتاج عشرين ألف قطعة.'], [{ id: 'a', type: 'text', text: 'a = 2' }])).toEqual(
      [],
    );
  });

  it('flags 8:30 read «ثمانية وثلاثين» (Luna slide 5) and «الثامنة والثلاثون» (Terra slide 3)', () => {
    const buses: NarrationCanvasElement[] = [
      { id: 't', type: 'text', text: '8:30 صباحًا، 9:10، 9:50، 10:30' },
    ];
    expect(codes(['تبدأ بثمانية وثلاثين صباحًا، ثم تسعة وعشر دقائق.'], buses)).toEqual([
      'CLOCK_TIME_READ_AS_NUMBER',
    ]);
    expect(codes(['الموعد الأول الساعة الثامنة والثلاثون دقيقة.'], buses)).toEqual([
      'CLOCK_TIME_READ_AS_NUMBER',
    ]);
    expect(codes(['ثم تسعة وخمسين دقيقة.'], buses)).toEqual(['CLOCK_TIME_READ_AS_NUMBER']);
    // Terra slide 5, read right.
    expect(
      codes(
        [
          'من الثامنة والنصف إلى التاسعة وعشر دقائق أربعون دقيقة، ومنها إلى العاشرة والنصف أربعون دقيقة.',
          'ومن التاسعة وعشر دقائق إلى التاسعة وخمسين دقيقة أربعون دقيقة.',
        ],
        buses,
      ),
    ).toEqual([]);
    // No clock time on the canvas: a number is a number.
    expect(
      codes(['العدد ثمانية وثلاثين زوجي.'], [{ id: 'n', type: 'text', text: '38 عدد زوجي' }]),
    ).toEqual([]);
    expect(
      codes(['تبدأ بعشرة وثلاثين.'], [{ id: 'l', type: 'latex', text: '10{:}30+30=11{:}00' }]),
    ).toEqual(['CLOCK_TIME_READ_AS_NUMBER']);
  });

  it('flags «إذن التخمين صحيح» after a checked case, never a question or a general proof', () => {
    const check: NarrationCanvasElement[] = [{ id: 't', type: 'text', text: 'تحقق: 3 + (−3) = 0' }];
    expect(codes(['إذن التخمين صحيح.'], check)).toEqual(['CONJECTURE_CALLED_PROVED']);
    expect(codes(['هل التخمين صحيح؟ نجرّب.'], check)).toEqual([]);
    expect(codes(['حدّد هل التخمين صحيح أم خاطئ.'], check)).toEqual([]);
    expect(codes(['بما أن b = −a لأي عدد، التخمين صحيح بصورة عامة.'], check)).toEqual([]);
    expect(codes(['التخمين غير صحيح؛ وجدنا مثالًا مضادًا.'], check)).toEqual([]);
  });

  it('review fixes: the book tag, a duration, a proof line, the second name, «ثلاثمئة ألف»', () => {
    // MED-5: «(س٣٥ في كتابك)» is a tag, not the Arabic symbol «س».
    const exercise: NarrationCanvasElement[] = [
      { id: 'e', type: 'text', text: 'تمرين ١ (س٣٥ في كتابك): x + 3 = 7' },
    ];
    expect(codes(['فيصبح سين يساوي أربعة.'], exercise)).toEqual(['SYMBOL_READING_ARABIC_NAME']);
    // MED-6: a duration is not the canvas time 8:30.
    const buses: NarrationCanvasElement[] = [{ id: 't', type: 'text', text: '8:30 ثم 9:05' }];
    expect(codes(['استغرقت الرحلة خمسة وثلاثين دقيقة.'], buses)).toEqual([]);
    expect(codes(['تبدأ بثمانية وثلاثين صباحًا.'], buses)).toEqual(['CLOCK_TIME_READ_AS_NUMBER']);
    // LOW-MED-7: an algebra line on the slide makes the verdict a proof's; a question is not one.
    const check: NarrationCanvasElement[] = [{ id: 'c', type: 'text', text: 'a + b = 0' }];
    expect(
      codes(['بطرح a من الطرفين نحصل على b يساوي سالب a.', 'إذن التخمين صحيح.'], check),
    ).toEqual([]);
    expect(codes(['لنتحقق إن كان التخمين صحيحًا.'], check)).toEqual([]);
    // LOW: the second strong name counts too; «ثلاثمئة ألف» is three hundred thousand.
    const xy: NarrationCanvasElement[] = [{ id: 'x', type: 'text', text: 'x' }];
    expect(codes(['صاد تساوي سين.'], xy)).toEqual(['SYMBOL_READING_ARABIC_NAME']);
    const amount: NarrationCanvasElement[] = [{ id: 'a', type: 'text', text: 'a = 300' }];
    expect(codes(['المبلغ ثلاثمئة ألف ريال.'], amount)).toEqual([]);
  });

  it('writes the corrections of the new issues', () => {
    const text = formatLearnerFirstNarrationCorrection(
      [
        { code: 'CLOCK_TIME_READ_AS_NUMBER', evidence: 'ثمانية وثلاثين' },
        { code: 'CONJECTURE_CALLED_PROVED', evidence: 'إذن التخمين صحيح.' },
      ],
      [],
    );
    expect(text).toContain('8:30 «الثامنة والنصف»');
    expect(text).toContain('say «المثال يؤيد التخمين»');
  });
});

describe('the narration re-roll loop with the learner-first check', () => {
  const slide = {
    elements: [
      { id: 'b', type: 'text', content: '<p>تحقق ٢ب: AB = CD</p>' },
      { id: 'c', type: 'text', content: '<p>تحقق ٢ج: مربعان</p>' },
    ],
  };
  const scene = { title: 'حل تحقق ٢', outlineId: 'o-1' };

  it('re-rolls with the correction until every item is explained', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce([spot('b'), speech('نشرح ب فقط.')])
      .mockResolvedValueOnce([spot('b'), speech('ب.'), spot('c'), speech('ج.')]);
    const actions = await generateRegisterCompliantActions(
      generate,
      null,
      scene,
      undefined,
      undefined,
      learnerFirstNarrationCheck(true, slide),
    );
    expect(generate).toHaveBeenCalledTimes(2);
    expect(String(generate.mock.calls[1]![0])).toContain('NARRATION_ITEM_MISSING');
    expect(actions).toHaveLength(4);
  });

  it('keeps the last answer and marks the scene when the issue survives every attempt', async () => {
    const onUnresolved = vi.fn();
    const generate = vi.fn().mockResolvedValue([spot('b'), speech('ب فقط.')]);
    const actions = await generateRegisterCompliantActions(
      generate,
      null,
      scene,
      undefined,
      undefined,
      learnerFirstNarrationCheck(true, slide, onUnresolved),
    );
    expect(actions).toHaveLength(2);
    expect(onUnresolved).toHaveBeenCalledWith([
      expect.objectContaining({ code: 'NARRATION_ITEM_MISSING' }),
    ]);
  });

  it('returns the earlier register-clean answer instead of failing (review MED-3)', async () => {
    const policy = resolveSpeechRegisterPolicy({ language: 'ar', subjectCode: 'MATH' })!;
    const onUnresolved = vi.fn();
    const clean = [spot('b'), speech('طيب نشوف البند هذا.')];
    const generate = vi
      .fn()
      .mockResolvedValueOnce(clean)
      .mockResolvedValue([spot('b'), spot('c'), speech('ABCDEFGH IJKLMNOP QRSTUV WXYZABCD')]);
    const actions = await generateRegisterCompliantActions(
      generate,
      policy,
      scene,
      undefined,
      undefined,
      learnerFirstNarrationCheck(true, slide, onUnresolved),
    );
    expect(actions).toBe(clean);
    expect(onUnresolved).toHaveBeenCalledWith([
      expect.objectContaining({ code: 'NARRATION_ITEM_MISSING' }),
    ]);
  });

  it('runs once, unchecked, without a policy and without the flag (every earlier version)', async () => {
    const generate = vi.fn().mockResolvedValue([speech('أي كلام.')]);
    expect(learnerFirstNarrationCheck(false, slide)).toBeUndefined();
    await generateRegisterCompliantActions(generate, null, scene);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
