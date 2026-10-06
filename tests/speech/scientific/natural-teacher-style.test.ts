/**
 * Natural Teacher Style review (30 Sep 2026): chemical bonds (DEC-052) and
 * subscripts that are part of a symbol's identity (DEC-053). Conventional
 * readings apply only where the parser has placed the notation in that role;
 * nothing is named.
 */
import { describe, expect, it } from 'vitest';

import { prepared } from './helpers';
import { r1Violations } from './r1';

const both = ['natural', 'accessible'] as const;

describe('Natural Teacher Style: bonds and identity subscripts', () => {
  it('1: \\ce{CH2=CH2} reads the double bond conventionally', () => {
    expect(prepared('\\ce{CH2=CH2}', 'CHEMISTRY')).toBe('سي إتش اثنين رابطة ثنائية سي إتش اثنين');
  });

  it('2: single, double and triple bonds', () => {
    expect(prepared('H-H', 'CHEMISTRY')).toBe('إتش رابطة أحادية إتش');
    expect(prepared('O=O', 'CHEMISTRY')).toBe('أو رابطة ثنائية أو');
    expect(prepared('N≡N', 'CHEMISTRY')).toBe('إن رابطة ثلاثية إن');
    expect(prepared('\\ce{HC#CH}', 'CHEMISTRY')).toBe('إتش سي رابطة ثلاثية سي إتش');
  });

  it('3: `=` and `-` outside Chemistry keep their operator reading', () => {
    expect(prepared('$a = b - c$', 'MATH')).toBe('ألف يساوي باء ناقص جيم');
    expect(prepared('O=O', 'MATH')).toBe('أو يساوي أو');
    expect(prepared('H-H', 'PHYSICS')).toBe('إتش ناقص إتش');
  });

  it('4: ambiguous `-` / `=` is never promoted to a bond', () => {
    for (const [text, reading] of [
      ['A-B', 'إيه ناقص بي'], // not elements
      ['A=B', 'إيه يساوي بي'],
      ['H - H', 'إتش ناقص إتش'], // spaced: an operator, not a bond
      ['$x = 5$', 'إكس يساوي 5'],
      ['الطول 3-4 سم', 'الطول 3 ناقص 4 سم'],
    ] as const) {
      expect(prepared(text, 'CHEMISTRY')).toBe(reading);
    }
    // `C-14` is an isotope mass, not a bond.
    expect(prepared('C-14', 'CHEMISTRY')).toBe('سي أربعة عشر');
  });

  it('5: $k_B T$ keeps the subscript and the product audible', () => {
    expect(prepared('$k_B T$', 'PHYSICS')).toBe('كيه تحت بي في تي');
    expect(prepared('$2 k_B T$', 'PHYSICS')).toBe('2 كيه تحت بي في تي');
    expect(prepared('$E_k$', 'PHYSICS')).toBe('إي تحت كيه');
    expect(prepared('$V_{max}$', 'PHYSICS')).toBe('ڤي تحت إم إيه إكس');
    expect(prepared('K_c', 'CHEMISTRY')).toBe('كيه تحت سي');
  });

  it('6: the symbol is never named («ثابت بولتزمان», «درجة الحرارة»)', () => {
    for (const mode of both) {
      const reading = prepared('$k_B T$', 'PHYSICS', mode);
      for (const name of ['ثابت', 'بولتزمان', 'درجة', 'الحرارة']) expect(reading).not.toContain(name);
      expect(r1Violations('$E = k_B T$', 'PHYSICS', mode)).toEqual([]);
    }
  });

  it('7: Chemistry counts keep their count reading, never «تحت»', () => {
    for (const mode of both) {
      expect(prepared('H₂O', 'CHEMISTRY', mode)).not.toContain('تحت');
      expect(prepared('$CO_2$', 'CHEMISTRY', mode)).not.toContain('تحت');
    }
    expect(prepared('H₂O', 'CHEMISTRY')).toBe('إتش اثنين أو');
    expect(prepared('$CO_2$', 'CHEMISTRY')).toBe('سي أو اثنين');
    // Letter counts in a general formula, and a group count, are counts too.
    for (const mode of both) {
      for (const formula of ['$C_nH_{2n+2}$', 'C_nH_{2n}', '$C_xH_yO_z$', '$(CH_2)_n$']) {
        expect(prepared(formula, 'CHEMISTRY', mode), formula).not.toContain('تحت');
      }
    }
    expect(prepared('$C_nH_{2n+2}$', 'CHEMISTRY')).toBe('سي إن، إتش، 2 إن زائد 2');
    // A constant's letter subscript in a Chemistry lesson is still identity.
    expect(prepared('$K_c = K_p$', 'CHEMISTRY')).toBe('كيه تحت سي يساوي كيه تحت بي');
  });

  it('8: other subscript readings do not change', () => {
    // Math indexing and number indices keep the positional reading.
    expect(prepared('$a_n$', 'MATH')).toBe('ألف نون');
    expect(prepared('حيث x_1 هو الحل الأول.', 'MATH')).toBe('حيث سين واحد هو الحل الأول.');
    expect(prepared('$v_0 t$', 'PHYSICS')).toBe('ڤي صفر تي');
    expect(prepared('$m_1 g$', 'PHYSICS')).toBe('إم واحد جي');
    // Accessible mode keeps «الدليل» and its end word.
    expect(prepared('$k_B T$', 'PHYSICS', 'accessible')).toBe('كيه الدليل بي، نهاية الدليل، تي');
    expect(prepared('$k_B + 1$', 'PHYSICS')).toBe('كيه تحت بي، زائد 1');
  });
});
