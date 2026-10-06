/**
 * Golden runner (plan §17): every reference case, both reading modes, against
 * hand-written expectations. Cases are `proposed` drafts pending reviewer
 * approval (FRD §28); they run against the test-only policy that allows
 * proposed entries.
 */
import { describe, expect, it } from 'vitest';

import { codes, loadGolden, render } from './helpers';

const CASES = loadGolden();

describe('golden reference cases', () => {
  it('has unique ids and every FRD §28 field', () => {
    const ids = new Set<string>();
    for (const c of CASES) {
      expect(ids.has(c.id), c.id).toBe(false);
      ids.add(c.id);
      for (const key of [
        'subject',
        'language',
        'original',
        'expressionBoundaries',
        'expected',
        'semanticExpansionAllowed',
        'expectedWarnings',
        'expectedBlocking',
        'reviewerApproval',
      ]) {
        expect(c, `${c.id} missing ${key}`).toHaveProperty(key);
      }
      // No case may claim reviewer approval inside this run (goal prompt constraint 9).
      expect(c.reviewerApproval).toBe('pending');
      expect(c.status).toBe('proposed');
    }
  });

  describe.each(CASES.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    it.each(['natural', 'accessible'] as const)('%s reading', (mode) => {
      const result = render(c.original, c.subject, mode);
      expect(result.preparedText, `${c.id} ${mode}`).toBe(c.expected[mode]);
      expect(codes(result)).toEqual([...c.expectedWarnings].sort());
      expect(result.blocking?.code ?? null).toBe(c.expectedBlocking);
      const expressions = result.spans
        .filter((span) => span.kind === 'expression')
        .map((span) => c.original.slice(span.source.start, span.source.end));
      expect(expressions).toEqual(c.expressionBoundaries);
    });
  });
});

describe('reference set coverage (FRD §28 minimum counts)', () => {
  it('meets every category minimum', () => {
    const count = (category: string) => CASES.filter((c) => c.category === category).length;
    const minimums: Record<string, number> = {
      'prose-numbers': 10,
      'math-basic': 15,
      'math-structure': 20,
      'physics-symbols': 15,
      'physics-units': 15,
      'chem-elements': 20,
      'chem-reactions': 20,
      malformed: 15,
      modes: 10,
    };
    for (const [category, minimum] of Object.entries(minimums)) {
      expect(count(category), category).toBeGreaterThanOrEqual(minimum);
    }
  });
});

describe('Arabic-letter golden cases are idempotent (G6)', () => {
  it.each(CASES.filter((c) => c.file === 'arabic.jsonl').map((c) => [c.id, c] as const))('%s', (_id, c) => {
    for (const mode of ['natural', 'accessible'] as const) {
      const once = render(c.original, c.subject, mode);
      expect(render(once.preparedText, c.subject, mode).preparedText).toBe(once.preparedText);
    }
  });
});
