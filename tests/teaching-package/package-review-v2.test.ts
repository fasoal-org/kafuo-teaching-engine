/**
 * g5.v10 (learner-first plan W5, owner D-2.9 and D-5, 15 Nov 2026): a g5.v10 package is
 * reviewed with package-review-v2 — the weak-student checks S6/S7 and an S5 that knows
 * the deliberate omissions. Every other package keeps package-review-v1 byte for byte.
 */
import { describe, expect, it } from 'vitest';

import { teacherOnlyReason } from '@/lib/server/teaching-package/package-review-fix-loop';
import {
  PACKAGE_REVIEW_CHECKS,
  PACKAGE_REVIEW_CHECKS_V2,
  PACKAGE_REVIEW_PROMPT_VERSION,
  PACKAGE_REVIEW_PROMPT_VERSION_V2,
  PACKAGE_REVIEW_SCHEMA,
  PACKAGE_REVIEW_SCHEMA_V2,
  PACKAGE_REVIEW_SYSTEM,
  PACKAGE_REVIEW_SYSTEM_V2,
  parseReviewerAnswer,
  renderSlidesBlock,
} from '@/lib/server/teaching-package/package-review-prompt';
import { sceneToReviewSlide } from '@/lib/server/teaching-package/package-review-input';
import type { AppScene } from '@/lib/types/stage';

const enumOf = (schema: Record<string, unknown>) =>
  (
    schema.properties as {
      findings: { items: { properties: { check: { enum: string[] } } } };
    }
  ).findings.items.properties.check.enum;

const answer = (check: string) =>
  JSON.stringify({
    summary: 'ملخص',
    findings: [
      {
        target_id: 's10',
        check,
        severity: 'high',
        book_evidence: { quote: 'نص', unit_id: '6236' },
        what_is_wrong: 'الكلام يشرح البند أ فقط.',
        fix_note: 'اشرح البندين ب و ج.',
      },
    ],
  });

describe('package-review-v2 (g5.v10)', () => {
  it('leaves package-review-v1 unchanged: no S6/S7 in its prompt or schema', () => {
    expect(PACKAGE_REVIEW_PROMPT_VERSION).toBe('package-review-v1');
    expect(PACKAGE_REVIEW_PROMPT_VERSION_V2).toBe('package-review-v2');
    expect(PACKAGE_REVIEW_SYSTEM).not.toContain('- S6');
    expect(PACKAGE_REVIEW_SYSTEM).not.toContain('- S7');
    expect(enumOf(PACKAGE_REVIEW_SCHEMA)).toEqual([...PACKAGE_REVIEW_CHECKS]);
    expect(PACKAGE_REVIEW_CHECKS).not.toContain('S6');
  });

  it('adds the weak-student checks and the deliberate omissions to v2', () => {
    expect(PACKAGE_REVIEW_SYSTEM_V2).toContain(
      '- S6: The narration agrees with what the slide shows',
    );
    expect(PACKAGE_REVIEW_SYSTEM_V2).toContain('explains EVERY item');
    expect(PACKAGE_REVIEW_SYSTEM_V2).toContain('- S7: The slide serves a weak student');
    expect(PACKAGE_REVIEW_SYSTEM_V2).toContain('never report those as missing');
    expect(PACKAGE_REVIEW_SYSTEM_V2).toContain('«فيما سبق», «والآن» and «المفردات»');
    expect(enumOf(PACKAGE_REVIEW_SCHEMA_V2)).toEqual([...PACKAGE_REVIEW_CHECKS_V2]);
    expect(PACKAGE_REVIEW_CHECKS_V2).toEqual([
      'S1',
      'S2',
      'S3',
      'S4',
      'S5',
      'S6',
      'S7',
      'Q1',
      'Q2',
      'Q5',
    ]);
  });

  it('W1: v2 fix notes keep every step and the book methods; v1 is unchanged', () => {
    expect(PACKAGE_REVIEW_SYSTEM_V2).toContain('keeping EVERY step of it');
    expect(PACKAGE_REVIEW_SYSTEM_V2).toContain('never an average change');
    expect(PACKAGE_REVIEW_SYSTEM_V2).toContain(
      'Never report a listed picture, chart or drawing as missing',
    );
    expect(PACKAGE_REVIEW_SYSTEM_V2).toContain('they never prove it');
    expect(PACKAGE_REVIEW_SYSTEM_V2).toContain('a drawing respects its givens');
    // The v1 fix-note line is replaced, never kept next to the v2 one.
    expect(PACKAGE_REVIEW_SYSTEM_V2).not.toContain(
      'include the correct working and the correct result). It must not',
    );
    for (const phrase of ['keeping EVERY step', 'PICTURES AND DRAWINGS', 'never prove it']) {
      expect(PACKAGE_REVIEW_SYSTEM).not.toContain(phrase);
    }
  });

  it('W1: the reviewer reads the pictures, chart values and segment lengths (v2 only)', () => {
    // Shapes from item 208's Terra package (stage-GE2lqOIJPw0l): slide 10 drew the given
    // AB = CD = EF as 175/150/130 px; Luna slide 28 held the production chart.
    const scene = {
      id: 's10',
      order: 10,
      title: 'تحقق 2',
      type: 'slide',
      content: {
        type: 'slide',
        canvas: {
          elements: [
            { id: 't1', type: 'text', content: '<p>AB = CD و CD = EF</p>' },
            {
              id: 'i1',
              type: 'image',
              src: '/api/classroom-media/stage-GE2lqOIJPw0l/media/src_6_b20e3dad.jpg',
            },
            { id: 'l1', type: 'line', start: [0, 0], end: [175, 0], points: ['dot', 'dot'] },
            { id: 'l2', type: 'line', start: [0, 0], end: [150, 0], points: ['dot', 'dot'] },
            { id: 'l3', type: 'line', start: [0, 0], end: [130, 0], points: ['dot', 'dot'] },
            { id: 'l4', type: 'line', start: [40, 0], end: [0, 0], points: ['', 'arrow'] },
            {
              id: 'c1',
              type: 'chart',
              chartType: 'scatter',
              data: { labels: ['2017', '2018'], series: [[5, 7.2]], legends: ['عدد القطع'] },
            },
            { id: 'p1', type: 'shape', path: 'M 0 0 L 1 0 L 1 1 Z' },
          ],
        },
      },
      actions: [],
    } as unknown as AppScene;
    const slide = sceneToReviewSlide(scene);
    expect(slide.visuals).toEqual([
      '[صورة من الكتاب معروضة: src_6]',
      '[رسم بياني (scatter): عدد القطع: 2017 → 5، 2018 → 7.2]',
      '[قطع مستقيمة مرسومة، أطوالها بالبكسل: 175، 150، 130]',
      '[أسهم مرسومة: 1]',
      '[أشكال مرسومة بلا نص (نقاط، مستطيلات، دوائر): 1]',
    ]);
    expect(slide.visibleText).toBe('AB = CD و CD = EF');
    expect(renderSlidesBlock([slide])).not.toContain('PICTURES AND DRAWINGS');
    expect(renderSlidesBlock([slide])).not.toContain('src_6');
    const v2 = renderSlidesBlock([slide], undefined, { learnerFirst: true });
    expect(v2).toContain('PICTURES AND DRAWINGS:\n[صورة من الكتاب معروضة: src_6]');
    expect(v2).toContain('175، 150، 130');
    // A text-only slide has no visuals field at all.
    const plain = sceneToReviewSlide({
      ...scene,
      content: { type: 'slide', canvas: { elements: [{ id: 't', type: 'text', content: 'x' }] } },
    } as unknown as AppScene);
    expect(plain).not.toHaveProperty('visuals');
  });

  it('accepts an S6 finding only on a v2 review', () => {
    const scope = { slideIds: new Set(['s10']), quizIds: new Set<string>() };
    expect(() => parseReviewerAnswer(answer('S6'), scope)).toThrow('unknown check S6');
    const parsed = parseReviewerAnswer(answer('S6'), { ...scope, learnerFirst: true });
    expect(parsed.findings.map((finding) => finding.check)).toEqual(['S6']);
  });

  it('auto-fixes S6 and leaves S7 to the teacher', () => {
    const slides = [{ id: 's10', sceneType: 'slide' }] as never;
    const finding = (check: string) => ({ targetId: 's10', check }) as never;
    expect(teacherOnlyReason(finding('S6'), slides)).toBeNull();
    expect(teacherOnlyReason(finding('S7'), slides)).toBe('REGENERATION_REFUSED');
    expect(teacherOnlyReason(finding('S1'), slides)).toBeNull();
  });
});
