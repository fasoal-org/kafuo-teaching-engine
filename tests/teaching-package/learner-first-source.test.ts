/**
 * g5.v10 (learner-first plan W2): the parser's English figure descriptions never reach
 * a prompt (D-6 A), and a lesson keeps one digit style, the book's (TD-4).
 */
import { describe, expect, it } from 'vitest';

import {
  detectLessonDigitStyle,
  isProviderImageDescription,
  normalizeDigits,
  normalizeDigitsInHtml,
  normalizeQuizPoints,
  normalizeSceneDigits,
  packageDigitStyle,
  providerSafeImageDescription,
  stripProviderImageDescriptions,
} from '@/lib/server/teaching-package/learner-first-source';

// Item 208's unit 6234 «تحقق من فهمك» as parsed (15 Nov 2026).
const UNIT_6234 = [
  '(1A) متتابعة أشهر: صفر، رجب، ذو الحجة، جمادى الأولى، . . . . .',
  '(1B) 10, 4, -2, -8, . . . . .',
  '(1C)',
  '',
  'A sequence of three blue triangles showing recursive subdivision. The first triangle is labeled 1. The second is labeled 3. The third is labeled 9. A dotted line follows, indicating the sequence continues. 1 3 9 Three blue-outlined triangular diagrams are arranged from left to right.',
  '',
  'لوضع تخمينات جبرية أو هندسية يجب أن تقدم أمثلة.',
].join('\n');

describe('provider figure descriptions (D-6 A)', () => {
  it('drops the English figure description from an Arabic unit and keeps everything else', () => {
    const stripped = stripProviderImageDescriptions(UNIT_6234, 'ar-SA');
    expect(stripped).not.toContain('blue triangles');
    expect(stripped).toContain('(1A) متتابعة أشهر');
    expect(stripped).toContain('(1B) 10, 4, -2, -8');
    expect(stripped).toContain('لوضع تخمينات جبرية');
  });

  it('keeps short Latin lines, formulas, markers and mixed Arabic/English vocabulary', () => {
    for (const line of [
      'التبرير الاستقرائي inductive reasoning التخمين conjecture المثال المضاد counterexample',
      'a) If n is a real number, then n^2 > n = 1 is a counterexample to the claim given here',
      '[[CONTENT_UNIT 6234 kind=try_it part=2 and some more English words here to be long]]',
      'Inductive Reasoning and Conjecture',
    ]) {
      expect(isProviderImageDescription(line)).toBe(false);
    }
  });

  it('keeps code samples and English quotations in an Arabic lesson (review MED-6)', () => {
    for (const line of [
      'print("The total is", total) and then return the value to the caller safely',
      'SELECT name, grade FROM students WHERE grade > 90 ORDER BY name ASC;',
      'To be or not to be, that is the question whether tis nobler in the mind to suffer',
    ]) {
      expect(isProviderImageDescription(line)).toBe(false);
    }
  });

  it('never strips an English lesson, and drops a description offered as an image description', () => {
    expect(stripProviderImageDescriptions(UNIT_6234, 'en-US')).toBe(UNIT_6234);
    const description = UNIT_6234.split('\n')[4]!;
    expect(providerSafeImageDescription(description, 'ar-SA')).toBeUndefined();
    expect(providerSafeImageDescription('مثلثات زرقاء', 'ar-SA')).toBe('مثلثات زرقاء');
  });
});

describe('one digit style per lesson (TD-4)', () => {
  it('detects the book style: Western at 60 % or more, otherwise Arabic-Indic', () => {
    expect(detectLessonDigitStyle(['8:30 صباحًا، 9:10 صباحًا', 'التكلفة 4.50'])).toBe('western');
    expect(detectLessonDigitStyle(['٤، ١٠، ١٨', 'والحد 54'])).toBe('arabic-indic');
    expect(detectLessonDigitStyle([])).toBe('arabic-indic');
    // No digits in the source: the lesson language decides (review LOW-8).
    expect(detectLessonDigitStyle(['بلا أرقام'], 'ar-SA')).toBe('arabic-indic');
    expect(detectLessonDigitStyle(['no digits'], 'en-US')).toBe('western');
  });

  it('never converts a digit glued to a Latin letter (1A, H2O, x2) (review LOW-8)', () => {
    expect(normalizeDigits('البند 1A والماء H2O و x2 والعدد 15', 'arabic-indic')).toBe(
      'البند 1A والماء H2O و x2 والعدد ١٥',
    );
  });

  it('converts digits and the decimal separator both ways', () => {
    expect(normalizeDigits('الحد التالي ١١٫٢٥ ريالًا، و٥٤ قطعة', 'western')).toBe(
      'الحد التالي 11.25 ريالًا، و54 قطعة',
    );
    expect(normalizeDigits('4.2 ريالات و 10:15', 'arabic-indic')).toBe('٤٫٢ ريالات و ١٠:١٥');
  });

  it('changes only the text between HTML tags, never attributes or entities', () => {
    expect(
      normalizeDigitsInHtml('<p style="font-size:32px;">العدد ٤٥ &#1234;</p>', 'western'),
    ).toBe('<p style="font-size:32px;">العدد 45 &#1234;</p>');
  });

  it('normalises a slide canvas and a quiz in place', () => {
    const slide = {
      type: 'slide',
      content: {
        canvas: {
          elements: [
            { type: 'text', content: '<p>٤ + ٣ = ٧</p>' },
            { type: 'latex', latex: '٤٫٢' },
            { type: 'shape', text: { content: '<p>٢٠٢٧</p>' } },
          ],
        },
      },
    };
    normalizeSceneDigits(slide, 'western');
    expect(slide.content.canvas.elements[0]).toMatchObject({ content: '<p>4 + 3 = 7</p>' });
    expect(slide.content.canvas.elements[1]).toMatchObject({ latex: '4.2' });
    expect(slide.content.canvas.elements[2]).toMatchObject({ text: { content: '<p>2027</p>' } });

    const quiz = {
      type: 'quiz',
      content: {
        questions: [
          {
            question: 'ما الحد التالي: 4، 7، 10؟',
            analysis: 'الفرق 3',
            options: [{ label: '13' }],
          },
        ],
      },
    };
    normalizeSceneDigits(quiz, 'arabic-indic');
    expect(quiz.content.questions[0]).toMatchObject({
      question: 'ما الحد التالي: ٤، ٧، ١٠؟',
      analysis: 'الفرق ٣',
      options: [{ label: '١٣' }],
    });
  });

  it('quality plan W5: table cells and chart labels too (item 208 slide 14 «١٤١٩ | ٢٠»)', () => {
    const scene = {
      type: 'slide',
      content: {
        canvas: {
          elements: [
            { type: 'table', data: [[{ text: '١٤١٩' }, { text: '٢٠' }], [{ text: 'السنة' }]] },
            {
              type: 'chart',
              data: { labels: ['٢٠١٧', '٢٠١٨'], legends: ['القطع'], series: [[5, 7.2]] },
            },
          ],
        },
      },
    };
    normalizeSceneDigits(scene, 'western');
    const [table, chart] = scene.content.canvas.elements as Array<Record<string, unknown>>;
    expect(table!.data).toEqual([[{ text: '1419' }, { text: '20' }], [{ text: 'السنة' }]]);
    expect(chart!.data).toEqual({
      labels: ['2017', '2018'],
      legends: ['القطع'],
      series: [[5, 7.2]],
    });
  });

  it('quality plan W5: one point per choice question, two per short answer', () => {
    const quiz = {
      type: 'quiz',
      content: {
        questions: [
          { type: 'single', points: 12 },
          { type: 'multiple', points: 5 },
          { type: 'text', points: 10 },
        ],
      },
    };
    normalizeQuizPoints(quiz);
    expect(quiz.content.questions.map((question) => question.points)).toEqual([1, 1, 2]);
    const slide = { type: 'slide', content: { questions: [{ points: 9 }] } };
    normalizeQuizPoints(slide);
    expect(slide.content.questions[0]!.points).toBe(9);
  });

  it("quality plan W5: a regeneration takes the package's own digit style from its scenes", () => {
    const western = [
      {
        type: 'slide',
        content: { canvas: { elements: [{ content: '<p>1419هـ: 20 ريالًا</p>' }] } },
      },
      { type: 'quiz', content: { questions: [{ question: 'ما سعر 1449؟' }] } },
    ];
    expect(packageDigitStyle(western, 'ar')).toBe('western');
    expect(packageDigitStyle([], 'ar')).toBe('arabic-indic');
  });
});
