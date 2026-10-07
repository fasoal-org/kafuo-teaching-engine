/**
 * FMT-01: the answer-format contract the mobile app renders as coloured
 * bands. The rules are a template literal, so a single `\(` in the source
 * silently becomes `(` at runtime — these assertions read the runtime text.
 */
import { describe, expect, it } from 'vitest';

import { TUTOR_RULES_TEXT, TUTOR_RULES_VERSION } from '@/lib/server/tutor/tutor-rules';

/** The English half sits before the `---` line, the Arabic half after it. */
const [ENGLISH_RULES, ARABIC_RULES] = TUTOR_RULES_TEXT.split('\n---\n') as [string, string];

describe('tutor rules — answer format (FMT-01)', () => {
  it('is versioned r4', () => {
    expect(TUTOR_RULES_VERSION).toBe('tutor-rules@r4');
    expect(TUTOR_RULES_TEXT.split('\n---\n')).toHaveLength(2);
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

  // r3 (FC-D11): Arabic words inside `\text{}` render as broken, reversed letters.
  it('forbids Arabic words inside math, naming \\text{}, \\mathrm{} and \\operatorname{} in both halves', () => {
    expect(ENGLISH_RULES).toContain('Never put Arabic words inside math');
    expect(ARABIC_RULES).toContain('لا تضع كلمات عربية داخل المعادلة أبدًا');
    for (const half of [ENGLISH_RULES, ARABIC_RULES]) {
      expect(half).toContain('`\\text{}`');
      expect(half).toContain('`\\mathrm{}`');
      expect(half).toContain('`\\operatorname{}`');
    }
  });

  it('shows the wrong form and the right form (words in the sentence, then the formula)', () => {
    const wrong = '`\\[ \\text{القوة} = \\text{الكتلة} \\times \\text{التسارع} \\]`';
    const right = '`\\[ F = m \\times a \\]`';
    expect(ENGLISH_RULES).toContain(`Wrong: ${wrong}`);
    expect(ENGLISH_RULES).toContain('Right: write the words in the sentence');
    expect(ENGLISH_RULES).toContain(right);
    expect(ARABIC_RULES).toContain(`خطأ: ${wrong}`);
    expect(ARABIC_RULES).toContain('الصحيح: اكتب الكلمات في الجملة');
    expect(ARABIC_RULES).toContain(right);
  });

  it('keeps every LaTeX backslash at runtime (no `\\t` turned into a TAB by the template literal)', () => {
    expect(TUTOR_RULES_TEXT).toContain('\\text{');
    expect(TUTOR_RULES_TEXT).toContain('\\times');
    expect(TUTOR_RULES_TEXT).not.toContain('\t');
  });

  // r4 (iOS re-run, 6 Oct 2026): on r3 the tutor still put units
  // (`\text{سم}^2`) and named quantities (`\text{المساحة}`) inside math.
  it('puts units after the math, with a wrong/right pair in both halves', () => {
    const wrong = '`\\(9\\pi\\ \\text{سم}^2\\)`';
    const right = '`\\(9\\pi\\)` سم²';
    expect(ENGLISH_RULES).toContain('Units go after the closing math delimiter');
    expect(ENGLISH_RULES).toContain(`Wrong: ${wrong}`);
    expect(ENGLISH_RULES).toContain(`Right: ${right}`);
    expect(ARABIC_RULES).toContain('اكتب الوحدة بعد علامة إغلاق المعادلة');
    expect(ARABIC_RULES).toContain(`خطأ: ${wrong}`);
    expect(ARABIC_RULES).toContain(`الصحيح: ${right}`);
  });

  it('gives a pattern for formulas of named quantities in both halves', () => {
    expect(ENGLISH_RULES).toContain('first name each quantity with one letter');
    expect(ENGLISH_RULES).toContain('or say the relation as a sentence outside the math');
    expect(ARABIC_RULES).toContain('سمِّ كل كمية أولًا بحرف واحد');
    expect(ARABIC_RULES).toContain('أو قل العلاقة جملةً خارج المعادلة');
    for (const half of [ENGLISH_RULES, ARABIC_RULES]) {
      expect(half).toContain('`\\[ م = \\pi ر^2 \\]`');
      expect(half).toContain('`\\[ \\text{المساحة} = \\pi r^2 \\]`');
      expect(half).toContain('`\\frac{\\text{…}}{\\text{…}}`');
    }
  });

  // r3 (TE-4): «القاعدة» came before «مثال».
  it('states the exact heading order for two or more headings in both halves', () => {
    expect(ENGLISH_RULES).toContain(
      'With two or more headings the order is exactly تعريف → مثال → القاعدة (Definition → Example → Rule)',
    );
    expect(ARABIC_RULES).toContain(
      'مع عنوانين أو أكثر يكون الترتيب بالضبط: تعريف ثم مثال ثم القاعدة',
    );
  });
});
