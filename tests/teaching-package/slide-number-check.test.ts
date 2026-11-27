/**
 * g5.v12 (critical items 27 Nov 2026, QZ-4): a slide's numbers against its cited book
 * text — a record for the reviewer, never a gate.
 */
import { describe, expect, it } from 'vitest';

import { slideNumberFindings } from '@/lib/server/teaching-package/slide-number-check';

const BOOK = new Map([
  ['u1', 'الضغط: صندوق وزنه ٦٠٠ نيوتن على مساحة ٢ م². الضغط = ٣٠٠ باسكال.'],
  ['u2', 'ماذا قرأت؟\n(١) احسب ضغط صندوق وزنه 900 N على 3 m².'],
]);

const slide = (
  id: string,
  role: string,
  lines: string[],
  units: string[],
): Parameters<typeof slideNumberFindings>[0][number] => ({
  id,
  outlineId: `o-${id}`,
  title: id,
  type: 'slide',
  sourceContentUnitIds: units,
  content: {
    type: 'slide',
    contentRole: role,
    canvas: {
      elements: lines.map((line, index) => ({
        id: `t${index}`,
        type: 'text',
        content: `<p>${line}</p>`,
      })),
    },
  },
});

describe('slideNumberFindings', () => {
  it('flags a wrong number on a teaching slide (the fixture), naming the slide and the number', () => {
    const findings = slideNumberFindings(
      [slide('s1', 'explanation', ['وزن الصندوق 600 N', 'الضغط = 350 Pa'], ['u1'])],
      BOOK,
    );
    expect(findings).toEqual([{ sceneId: 's1', outlineId: 'o-s1', title: 's1', numbers: [350] }]);
  });

  it('accepts the book’s own numbers in any digit form, and a try-it slide’s book question', () => {
    expect(
      slideNumberFindings(
        [
          slide('s1', 'explanation', ['وزن الصندوق ٦٠٠ N', 'الضغط = 300 Pa'], ['u1']),
          slide('s2', 'check_understanding', ['احسب ضغط صندوق وزنه ٩٠٠ N'], ['u2']),
        ],
        BOOK,
      ),
    ).toEqual([]);
    expect(
      slideNumberFindings([slide('s2', 'check_understanding', ['وزنه 950 N'], ['u2'])], BOOK),
    ).toHaveLength(1);
  });

  it('never judges a solution slide, a slide citing no text, a quiz or a small whole number', () => {
    expect(
      slideNumberFindings(
        [
          slide('sol', 'worked_example', ['الضغط = 1234 Pa'], ['u1']),
          slide('none', 'explanation', ['1234'], ['u9']),
          { ...slide('q', 'explanation', ['1234'], ['u1']), type: 'quiz' },
          slide('steps', 'explanation', ['الخطوة 3', 'الخطوة 4'], ['u1']),
        ],
        BOOK,
      ),
    ).toEqual([]);
  });
});
