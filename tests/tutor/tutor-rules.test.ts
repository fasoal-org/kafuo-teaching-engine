/**
 * FMT-01: the answer-format contract the mobile app renders as coloured
 * bands. The rules are a template literal, so a single `\(` in the source
 * silently becomes `(` at runtime — these assertions read the runtime text.
 */
import { describe, expect, it } from 'vitest';

import { TUTOR_RULES_TEXT, TUTOR_RULES_VERSION } from '@/lib/server/tutor/tutor-rules';

describe('tutor rules — answer format (FMT-01)', () => {
  it('is versioned r2', () => {
    expect(TUTOR_RULES_VERSION).toBe('tutor-rules@r2');
  });

  it('names the fixed section headings in both languages', () => {
    for (const heading of [
      '### تعريف',
      '### مثال',
      '### القاعدة',
      '### Definition',
      '### Example',
      '### Rule',
    ]) {
      expect(TUTOR_RULES_TEXT).toContain(heading);
    }
  });

  it('keeps the LaTeX delimiters intact at runtime', () => {
    expect(TUTOR_RULES_TEXT).toContain('\\( … \\)');
    expect(TUTOR_RULES_TEXT).toContain('\\[ … \\]');
    expect(TUTOR_RULES_TEXT).toContain('\\(1+3=4\\)');
    expect(TUTOR_RULES_TEXT).not.toContain('inline as `( … )`');
  });

  it('keeps sections optional so short replies stay short', () => {
    expect(TUTOR_RULES_TEXT).toContain('Sections are optional');
    expect(TUTOR_RULES_TEXT).toContain('الأقسام اختيارية');
  });
});
