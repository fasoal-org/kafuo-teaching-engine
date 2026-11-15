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
