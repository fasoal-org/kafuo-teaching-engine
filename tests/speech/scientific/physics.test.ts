/**
 * Physics (plan §10.2): units only in unit position, prefixes and powers
 * preserved, symbols read as letters, and the empty quantity-expansion set
 * (FR-013, AS-002).
 */
import { describe, expect, it } from 'vitest';

import { POLICY_TABLE_FILES } from '@/lib/speech/scientific/policy';
import { matchUnit, splitUnitToken } from '@/lib/speech/scientific/physics/units';
import { codes, prepared, render } from './helpers';

describe('Physics units', () => {
  it('splits prefix + unit, preferring a whole-unit reading', () => {
    expect(splitUnitToken('km')).toEqual({ prefix: 'k', unit: 'm' });
    expect(splitUnitToken('min')).toEqual({ prefix: null, unit: 'min' });
    expect(splitUnitToken('Pa')).toEqual({ prefix: null, unit: 'Pa' });
    expect(splitUnitToken('kWh')).toEqual({ prefix: 'k', unit: 'Wh' });
    expect(splitUnitToken('us')).toEqual({ prefix: 'μ', unit: 's' });
    expect(splitUnitToken('xyz')).toBeNull();
  });

  it('matches compound units with powers and a denominator', () => {
    const match = matchUnit('9.8 m/s²', 3);
    expect(match?.unit.num).toEqual([{ unit: 'm', prefix: null, power: 1 }]);
    expect(match?.unit.den).toEqual([{ unit: 's', prefix: null, power: 2 }]);
    expect(matchUnit('5 N·m', 1)?.unit.num.map((f) => f.unit)).toEqual(['N', 'm']);
    expect(matchUnit('5 mx', 1)).toBeNull();
  });

  it('never converts a unit: the authored prefix and power are spoken', () => {
    expect(prepared('المساحة 2 mm² هنا', 'PHYSICS')).toBe('المساحة 2 مليمتر مربع هنا');
    expect(prepared('الطول 3 cm فقط', 'PHYSICS')).toBe('الطول 3 سنتيمتر فقط');
  });
});

describe('Physics ambiguity rules (§10.2)', () => {
  it('rule 1: a lone letter not after a number is a symbol', () => {
    expect(prepared('حيث m الكتلة', 'PHYSICS')).toBe('حيث إم الكتلة');
  });
  it('rule 2: a unit token after a number is a unit', () => {
    expect(prepared('خلال 5 s فقط', 'PHYSICS')).toBe('خلال 5 ثانية فقط');
  });
  it('rule 3: min is a minute only after a number', () => {
    expect(prepared('بعد 3 min', 'PHYSICS')).toBe('بعد 3 دقيقة');
  });
  it('rule 4: °C and a bare degree after a number', () => {
    expect(prepared('عند 100 °C و 45°', 'PHYSICS')).toBe('عند 100 درجة سيليزية و 45 درجة');
  });
  it('rule 5: scientific e only between digits', () => {
    expect(prepared('القيمة 2e3 هنا', 'PHYSICS')).toBe('القيمة 2 في 10 أُس ثلاثة هنا');
    expect(prepared('الثابت e مهم', 'PHYSICS')).toBe('الثابت إي مهم');
  });
});

describe('FR-013 / AS-002: no quantity expansion without approved trust', () => {
  it('the quantity-expansions table is gone from the pack (O-2, R1)', () => {
    expect(POLICY_TABLE_FILES['quantity-expansions.json']).toBeUndefined();
  });

  it('F = ma reads letters, even when the prose defines the symbols', () => {
    for (const text of ['F = ma', 'حيث F القوة و m الكتلة: F = ma']) {
      const result = render(text, 'PHYSICS');
      const expressions = result.spans
        .filter((s) => s.kind === 'expression')
        .map((s) => result.preparedText.slice(s.prepared.start, s.prepared.end));
      for (const reading of expressions) {
        for (const quantity of ['القوة', 'الكتلة', 'التسارع', 'مضروب']) {
          expect(reading).not.toContain(quantity);
        }
      }
      expect(result.preparedText).toContain('إف يساوي إم إيه');
      expect(codes(result)).toEqual([]);
    }
  });

  it('Mathematics keeps its own letter convention; Physics uses Latin letter names', () => {
    expect(prepared('x = 2', 'MATH')).toBe('سين يساوي 2');
    expect(prepared('x = 2', 'PHYSICS')).toBe('إكس يساوي 2');
  });
});

describe('P6: units and O-7 evidence', () => {
  it.each([
    ['إذا كان x = 5s', 'إذا كان إكس يساوي 5 إس'],
    ['الشغل W = 3N', 'الشغل دبليو يساوي 3 إن'],
    ['الزمن t = 2s', 'الزمن تي يساوي 2 إس'],
    ['بوحدة m/s', 'بوحدة إم على إس'],
  ])('ambiguous: %s is read as its symbols, with a review warning', (text, reading) => {
    const result = render(text, 'PHYSICS');
    expect(result.preparedText).toBe(reading);
    expect(codes(result)).toContain('SATTS_W_AMBIGUOUS_UNIT');
  });

  it.each([
    ['خلال 5 s فقط', 'خلال 5 ثانية فقط'],
    ['المسافة 5km', 'المسافة 5 كيلومتر'],
    ['المساحة 5m²', 'المساحة 5 متر مربع'],
    ['السرعة 3m/s', 'السرعة 3 متر لكل ثانية'],
    ['الطول $9.8\\,\\text{m}$', 'الطول 9 فاصلة 8 متر'],
  ])('evidence: %s is a unit, with no warning', (text, reading) => {
    const result = render(text, 'PHYSICS');
    expect(result.preparedText).toBe(reading);
    expect(codes(result)).not.toContain('SATTS_W_AMBIGUOUS_UNIT');
  });

  it('compound units: a bracketed denominator, spaced factors, `\\text{}` powers', () => {
    expect(prepared('السعة 4186 J/(kg·K)', 'PHYSICS')).toBe('السعة 4186 جول لكل كيلوجرام كلفن');
    expect(prepared('السرعة 3 m s⁻¹', 'PHYSICS')).toBe('السرعة 3 متر ثانية أُس سالب واحد');
    expect(prepared('التسارع $9.8\\,\\text{m/s}^2$', 'PHYSICS')).toBe('التسارع 9 فاصلة 8 متر لكل ثانية تربيع');
    expect(prepared('الطول 5 \\mu m', 'PHYSICS')).toBe('الطول 5 ميكرومتر');
    expect(prepared('الحرارة 25 ℃ و $25^\\circ C$', 'PHYSICS')).toBe('الحرارة 25 درجة سيليزية و 25 درجة سيليزية');
    expect(prepared('العدد 6.02 × 10^23', 'PHYSICS')).toBe('العدد 6 فاصلة 02 في 10 أُس 23');
  });

  it('Mathematics reads a number with a unit, under the same rule', () => {
    expect(prepared('المساحة 25 cm²', 'MATH')).toBe('المساحة 25 سنتيمتر مربع');
    expect(prepared('نحسب 2 x + 1', 'MATH')).toBe('نحسب 2 سين زائد 1');
  });

  it('R1: symbols stay letters and no quantity name is ever added', () => {
    expect(prepared('القانون F = ma', 'PHYSICS')).toBe('القانون إف يساوي إم إيه');
  });
});
