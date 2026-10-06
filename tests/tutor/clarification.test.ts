import { describe, expect, it } from 'vitest';

import {
  clarificationText,
  clarificationTitle,
  matchClarificationReply,
} from '@/lib/server/tutor/grounding/clarification';

/**
 * Deterministic clarification (discovery-first P7, FRD §9, D-8 (a)): a fixed
 * bilingual template by the student's script, ≤ 3 human-readable titles, and
 * the follow-up matcher (ordinal or title).
 */

const TITLES = ['التبرير والبرهان', 'المثال المضاد', 'الاستدلال'];

describe('clarificationText', () => {
  it('Arabic for Arabic, English for English, both for mixed/script-less text; numbered, ≤ 3 titles', () => {
    const ar = clarificationText('اشرحلي المثال المضاد', TITLES);
    expect(ar).toBe(
      [
        'سؤالك قد يخص أكثر من موضوع في المنهج. أي موضوع تقصد؟',
        '1. التبرير والبرهان',
        '2. المثال المضاد',
        '3. الاستدلال',
        'اكتب رقم الموضوع أو اسمه.',
      ].join('\n'),
    );
    const en = clarificationText('explain the counterexample', ['Reasoning', 'Counterexamples']);
    expect(en).toContain(
      'Which one do you mean?\n1. Reasoning\n2. Counterexamples\nReply with the number or the topic name.',
    );
    expect(en).not.toMatch(/[؀-ۿ]/);
    const both = clarificationText('123', TITLES.slice(0, 2));
    expect(both).toContain('أي موضوع تقصد؟');
    expect(both).toContain('Which one do you mean?');
    expect(clarificationText('س', [...TITLES, 'رابع'])).not.toContain('رابع');
    // Deterministic: the same input gives the same bytes.
    expect(clarificationText('اشرحلي المثال المضاد', TITLES)).toBe(ar);
  });

  it('a single candidate asks for confirmation', () => {
    expect(clarificationText('ما هو النقض؟', ['المثال المضاد'])).toBe(
      'لست متأكدًا من الموضوع الذي تقصده. هل تقصد «المثال المضاد»؟\nاكتب 1 للتأكيد، أو أعد صياغة سؤالك.',
    );
  });

  it('titles are one bounded line; empty titles are dropped', () => {
    expect(clarificationTitle('  المثال\n المضاد ')).toBe('المثال المضاد');
    expect(clarificationTitle('')).toBeNull();
    expect(clarificationTitle(null)).toBeNull();
    expect(clarificationTitle('ن'.repeat(200))!.length).toBe(80);
  });
});

describe('matchClarificationReply', () => {
  it('ordinals: digits (Latin and Arabic-Indic), «الأول/التاني/الثاني/الثالث/التالت», first/second/third, with an optional «رقم»/"option"', () => {
    const cases: Array<[string, number]> = [
      ['1', 0],
      ['2', 1],
      ['٣', 2],
      ['٢.', 1],
      ['الأول', 0],
      ['التاني', 1],
      ['الثاني', 1],
      ['الثالث', 2],
      ['التالت', 2],
      ['رقم 2', 1],
      ['الموضوع الأول', 0],
      ['second', 1],
      ['option 3', 2],
      ['3rd', 2],
    ];
    for (const [reply, index] of cases) {
      expect({ reply, choice: matchClarificationReply(reply, TITLES) }).toEqual({
        reply,
        choice: { index, by: 'ordinal' },
      });
    }
  });

  it('an ordinal beyond the list, or a sentence containing a number, is not a choice', () => {
    expect(matchClarificationReply('3', TITLES.slice(0, 2))).toBeNull();
    expect(matchClarificationReply('4', TITLES)).toBeNull();
    expect(matchClarificationReply('عندي 2 سؤال', TITLES)).toBeNull();
    expect(matchClarificationReply('تاني', TITLES)).toBeNull();
  });

  it('titles: equal, contained, or every keyword inside exactly one title', () => {
    expect(matchClarificationReply('المثال المضاد', TITLES)).toEqual({ index: 1, by: 'title' });
    expect(matchClarificationReply('أقصد «التبرير والبرهان» لو سمحت', TITLES)).toEqual({
      index: 0,
      by: 'title',
    });
    expect(matchClarificationReply('المضاد', TITLES)).toEqual({ index: 1, by: 'title' });
    expect(matchClarificationReply('الدوال', TITLES)).toBeNull();
    expect(matchClarificationReply('شكرا', TITLES)).toBeNull();
    expect(matchClarificationReply('ليه؟', TITLES)).toBeNull();
    // A keyword shared by two titles is ambiguous: not a choice.
    expect(matchClarificationReply('الدوال', ['الدوال الخطية', 'الدوال التربيعية'])).toBeNull();
  });
});
