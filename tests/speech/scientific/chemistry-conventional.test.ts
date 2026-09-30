/**
 * DEC-052: SATTS gives recognised Chemistry notation its conventional
 * teacher-style reading (`→` «ينتج», `↑` «يتصاعد», `Δ` «بالتسخين», bonds
 * «رابطة …»). It never adds entity-level meaning (no compound or quantity
 * names), and it never guesses when the role is unclear.
 */
import { describe, expect, it } from 'vitest';

import { prepared, render } from './helpers';
import { r1Violations } from './r1';

const both = ['natural', 'accessible'] as const;

describe('Chemistry conventional readings (DEC-052)', () => {
  it('1: recognised reaction notation gets its conventional reading, in both modes', () => {
    for (const mode of both) {
      expect(prepared('\\ce{N2 + 3H2 <=> 2NH3}', 'CHEMISTRY', mode)).toContain('في حالة اتزان مع');
      expect(prepared('Ag+ + Cl- → AgCl↓', 'CHEMISTRY', mode)).toMatch(/ينتج.*يترسب$/);
      expect(prepared('\\ce{CH2=CH2}', 'CHEMISTRY', mode)).toContain('رابطة ثنائية');
      expect(prepared('Cu2+ + 2e- → Cu', 'CHEMISTRY', mode)).toContain('إلكترون');
    }
    expect(prepared('الروابط H-H و N≡N', 'CHEMISTRY')).toBe('الروابط إتش رابطة أحادية إتش و إن رابطة ثلاثية إن');
  });

  it('2: the same symbols outside a recognised Chemistry role keep their own reading', () => {
    expect(prepared('$\\lim_{x \\to 0} x$', 'MATH')).toBe('نهاية سين، عندما سين تقترب من 0');
    expect(prepared('$\\Delta T$', 'PHYSICS')).toBe('دلتا تي');
    // Δ that is not an arrow condition stays «دلتا», even in Chemistry.
    expect(prepared('$\\Delta H = -286 kJ$', 'CHEMISTRY')).toBe('دلتا إتش يساوي سالب 286 كيلوجول');
    expect(prepared('$a - b = c$', 'MATH')).toBe('ألف ناقص باء يساوي جيم');
    // In a Chemistry lesson, a minus or an equals that is not a bond stays an operator.
    expect(prepared('$5 - 3 = 2$', 'CHEMISTRY')).toBe('5 ناقص 3 يساوي 2');
    expect(prepared('$\\Delta H = H_2 - H_1$', 'CHEMISTRY')).not.toMatch(/رابطة|ينتج|بالتسخين/);
    expect(prepared('درجة الحرارة ↑', 'CHEMISTRY')).not.toContain('يتصاعد');
    for (const [text, subject] of [
      ['\\ce{2H2 + O2 -> 2H2O}', 'PHYSICS'],
      ['السعر → الطلب', 'MATH'],
      ['الاتجاه ↑ ثم →', 'PHYSICS'],
    ] as const) {
      for (const mode of both) {
        const reading = prepared(text, subject, mode);
        for (const word of ['ينتج', 'يتصاعد', 'بالتسخين', 'رابطة']) expect(reading, `${subject} ${text}`).not.toContain(word);
        expect(r1Violations(text, subject, mode)).toEqual([]);
      }
    }
  });

  it('3: formulas are still read by their symbols, never named', () => {
    const text = 'Zn + 2HCl → ZnCl2 + H2↑ و \\ce{NaCl(aq)} و H₂O';
    for (const mode of both) expect(r1Violations(text, 'CHEMISTRY', mode)).toEqual([]);
    expect(prepared('H₂O', 'CHEMISTRY')).toBe('إتش اثنين أو');
    expect(prepared('\\ce{NaCl}', 'CHEMISTRY')).toBe('إن إيه سي إل');
  });

  it('4: unclear notation falls back to the neutral reading instead of guessing', () => {
    // Not a parsed reaction (no element evidence): the literal arrow name.
    const unparsed = render('\\ce{A + B -> C}', 'CHEMISTRY');
    expect(unparsed.spans.find((s) => s.kind === 'expression')?.fallbackReason).toBe('notation');
    expect(unparsed.preparedText).toBe('إيه زائد بي سهم سي');
    // Arrows and conditions with no conventional reading keep their symbols.
    expect(prepared('\\ce{2NO2 <- N2O4}', 'CHEMISTRY')).toContain('سهم لليسار');
    expect(prepared('\\ce{2H2O2 ->[MnO2] 2H2O + O2}', 'CHEMISTRY')).toBe(
      'اثنين إتش اثنين أو اثنين، إم إن أو اثنين فوق السهم، ينتج اثنين إتش اثنين أو زائد أو اثنين',
    );
  });

  it('5: the four reviewed natural readings', () => {
    expect(prepared('Zn + 2HCl → ZnCl2 + H2↑', 'CHEMISTRY')).toBe(
      'زد إن زائد اثنين إتش سي إل ينتج زد إن سي إل اثنين زائد إتش اثنين يتصاعد',
    );
    expect(prepared('التفاعل 2H2+O2->2H2O', 'CHEMISTRY')).toBe('التفاعل اثنين إتش اثنين زائد أو اثنين ينتج اثنين إتش اثنين أو');
    expect(prepared('الاختزال Cu2+ + 2e- → Cu', 'CHEMISTRY')).toBe('الاختزال سي يو، بشحنة موجب اثنين زائد اثنين إلكترون ينتج سي يو');
    expect(prepared('التفاعل \\ce{CaCO3 ->[\\Delta] CaO + CO2}', 'CHEMISTRY')).toBe(
      'التفاعل سي إيه سي أو ثلاثة، بالتسخين، ينتج سي إيه أو زائد سي أو اثنين',
    );
  });
});
