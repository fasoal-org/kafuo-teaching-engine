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
  normalizeSceneDigits,
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
});
