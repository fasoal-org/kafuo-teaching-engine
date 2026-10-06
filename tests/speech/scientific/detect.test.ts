import { describe, expect, it } from 'vitest';

import { detectExpressions } from '@/lib/speech/scientific/detect';

const spans = (text: string) =>
  detectExpressions(text, 'MATH').map((c) => text.slice(c.start, c.end));

describe('expression boundary detection (§9.3)', () => {
  it('finds explicit delimiters first, with the delimiters excluded from the content', () => {
    const text = 'لدينا $x+1$ و \\(y\\) و $$z^2$$ هنا';
    const found = detectExpressions(text, 'MATH');
    expect(found.map((c) => text.slice(c.innerStart, c.innerEnd))).toEqual(['x+1', 'y', 'z^2']);
    expect(found.every((c) => c.kind === 'delimited')).toBe(true);
  });

  it('treats an unpaired or non-math $ as prose', () => {
    expect(spans('السعر $ مرتفع')).toEqual([]);
    expect(spans('من $ إلى $ هنا')).toEqual([]);
  });

  it('bounds runs by Arabic script and sentence punctuation', () => {
    expect(spans('إذا كان x + 1 = 3، فإن x = 2.')).toEqual(['x + 1 = 3', 'x = 2']);
    expect(spans('القيم x = 1, y = 2 هنا')).toEqual(['x = 1', 'y = 2']);
  });

  it('only structural runs are expressions; lone letters are variables in Mathematics', () => {
    expect(spans('العدد 42 والعدد 7')).toEqual([]);
    expect(spans('الرمز x وحده')).toEqual(['x']);
    expect(spans('نستخدم GeoGebra')).toEqual([]);
    expect(spans('الناتج 2x')).toEqual(['2x']);
    expect(spans('الناتج 3.5')).toEqual(['3.5']);
  });

  it('keeps unmatched brackets in the prose and year ranges as prose', () => {
    expect(spans('(حيث x > 0)')).toEqual(['x > 0']);
    expect(spans('من 2020-2024 إلى الآن')).toEqual([]);
  });

  it('includes braced command arguments, even Arabic \\text{}', () => {
    expect(spans('نكتب \\frac{1}{\\text{عدد}} هنا')).toEqual(['\\frac{1}{\\text{عدد}}']);
  });

  it('Arabic-letter variables join an expression only next to math (D-1, D-10)', () => {
    expect(spans('إذا كانت س = 5 فإن 2س + 3 = 13')).toEqual(['س = 5', '2س + 3 = 13']);
    expect(spans('ص = 2س')).toEqual(['ص = 2س']);
    expect(spans('نحسب س² و √ص و د(س) = 1')).toEqual(['س²', '√ص', 'د(س) = 1']);
    expect(spans('نحسب 2 س + 3 و أ + ب')).toEqual(['2 س + 3', 'أ + ب']);
  });

  it('keeps Arabic prose, markers and labels as prose', () => {
    for (const text of [
      'في عام 1445 هـ صدر الكتاب.',
      'في عام 1445هـ صدر الكتاب.',
      'بدأ العام 2024م رسميًا.',
      'الطول 5 م تقريبًا.',
      'انظر ص 12 وص13.',
      'س: احسب. ج: صحيح.',
      '(أ) احسب قيمة س',
      'أ) نبدأ.',
      'س و ص عددان.',
      'فما قيمة س؟',
      'الدالة د(س) مهمة.',
      'السؤال س(1) سهل.',
    ]) {
      expect(spans(text), text).toEqual([]);
    }
    // A unit denominator after a marker letter is not a variable (`م/ث`).
    expect(spans('التسارع 9.8 م/ث² للأرض')).toEqual(['9.8', '/', '²']);
    // Chemistry never promotes Arabic letters.
    expect(detectExpressions('س = 5', 'CHEMISTRY').map((c) => c.start)).toEqual([2]);
  });

  it('marks a leading binary operator after a term, never after punctuation', () => {
    const leading = (text: string) => detectExpressions(text, 'MATH').map((c) => c.leadingBinary === true);
    expect(leading('المجموع وس + 1 هنا')).toEqual([true]);
    expect(leading('الناتج: - 5')).toEqual([false]);
    expect(leading('درجة الحرارة -5')).toEqual([false]);
    // An ordinary word is not a term: a spaced sign after prose stays a sign.
    expect(leading('الناتج هو - 3')).toEqual([false]);
    expect(leading('درجة الحرارة - 5')).toEqual([false]);
    expect(leading('1445 هـ - 3')).toEqual([true]);
  });

  it('never produces overlapping candidates', () => {
    const text = '$x$ \\(y\\) z^2 $$w$$ 2a';
    const found = detectExpressions(text, 'MATH');
    for (let i = 1; i < found.length; i += 1) {
      expect(found[i]!.start).toBeGreaterThanOrEqual(found[i - 1]!.end);
    }
  });
});
