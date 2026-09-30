/**
 * Chemistry (plan §10.3): a separate grammar; letter reading (D-9), Arabic
 * counts in the «اثنين» register (O-1, superseding D-9a), no compound, ion or
 * quantity name ever (O-2, superseding D-9b), compositional reading of every
 * formula (FR-016, AS-004) and the trap list.
 */
import { describe, expect, it } from 'vitest';

import { ELEMENT_SYMBOLS } from '@/lib/speech/scientific/chemistry/elements';
import { chemistryFormulaKind } from '@/lib/speech/scientific/chemistry/grammar';
import { canonicalFormula, ChemFault, parseChemistry } from '@/lib/speech/scientific/chemistry/parse';
import { verbaliseChemistry } from '@/lib/speech/scientific/chemistry/verbalise-ar';
import { loadPolicyPack, POLICY_MANIFEST, POLICY_TABLE_FILES } from '@/lib/speech/scientific/policy';
import { codes, prepared, render, TEST_POLICY } from './helpers';

describe('trap list (CO/Co/No/In/He/I/As/Be)', () => {
  it.each([
    // P7: an all-capitals run of one-letter symbols is not chemistry evidence.
    ['CO', null],
    ['Co', 'ambiguous'],
    ['NO', null],
    ['WHO', null],
    ['B12', null],
    ['NaCl', 'formula'],
    ['CO2', 'formula'],
    ['H-H', 'formula'],
    ['No', 'ambiguous'],
    ['In', 'ambiguous'],
    ['He', 'ambiguous'],
    ['I', 'ambiguous'],
    ['As', 'ambiguous'],
    ['Be', 'ambiguous'],
    ['co', null],
    ['pH', 'notation'],
    ['H2O', 'formula'],
    ['O2', 'formula'],
    ['Na+', 'formula'],
  ])('%s → %s', (run, kind) => {
    expect(chemistryFormulaKind(run)).toBe(kind);
  });

  it('never corrects case and never promotes an English-looking word', () => {
    expect(prepared('الغاز CO سام بينما Co فلز', 'CHEMISTRY')).toBe('الغاز CO سام بينما سي أو فلز');
    expect(prepared('الغاز $CO$ سام', 'CHEMISTRY')).toBe('الغاز سي أو سام');
    // An English phrase does not parse as a formula as a whole: it stays prose.
    expect(render('He said No', 'CHEMISTRY').preparedText).toBe('He said No');
    // Isolated in Arabic prose, the same symbols are letters with a warning.
    expect(codes(render('الرمز He والرمز No', 'CHEMISTRY'))).toEqual([
      'SATTS_W_AMBIGUOUS_SYMBOL',
      'SATTS_W_AMBIGUOUS_SYMBOL',
    ]);
    expect(prepared('الكلمة co عادية', 'CHEMISTRY')).toBe('الكلمة co عادية');
  });

  it('chemistry is never delegated to Mathematics, and never active outside Chemistry', () => {
    expect(prepared('الماء H2O', 'MATH')).toBe('الماء إتش 2 أو');
    expect(prepared('الماء H2O', 'CHEMISTRY')).toBe('الماء إتش اثنين أو');
  });
});

describe('parser', () => {
  it('parses coefficients, groups, hydrates, charges, states and arrows', () => {
    const reaction = parseChemistry('2Ca(OH)2(aq) + CuSO4·5H2O -> SO4^{2-}', { inCe: false });
    expect(reaction.arrows).toEqual(['→']);
    const [first, second] = reaction.sides[0]!;
    expect(first).toMatchObject({ coeff: { kind: 'int', value: 2 }, state: 'aq' });
    expect(canonicalFormula(first!.species)).toBe('Ca(OH)2');
    expect(canonicalFormula(second!.species)).toBe('CuSO4·5H2O');
    expect(canonicalFormula(reaction.sides[1]![0]!.species)).toBe('SO4^2-');
  });

  it('accepts every charge spelling', () => {
    for (const text of ['SO4^{2-}', 'SO4^2-', 'SO₄²⁻']) {
      expect(canonicalFormula(parseChemistry(text, { inCe: false }).sides[0]![0]!.species)).toBe('SO4^2-');
    }
    expect(canonicalFormula(parseChemistry('Na+', { inCe: false }).sides[0]![0]!.species)).toBe('Na^+');
  });

  it('rejects unknown elements and malformed input with a typed fault', () => {
    expect(() => parseChemistry('Xy2', { inCe: true })).toThrow(ChemFault);
    expect(() => parseChemistry('H2O)', { inCe: false })).toThrow(ChemFault);
    expect(() => parseChemistry('(H2O', { inCe: false })).toThrow(ChemFault);
  });
});

describe('O-2: no compound, ion or quantity name (D-9b superseded)', () => {
  const inputs = [
    '2H2 + O2 -> 2H2O',
    'CH4 + 2O2 -> CO2 + 2H2O',
    'HCl + NaOH -> NaCl + H2O',
    'C3H8O',
    'Na^+ + Cl^- -> NaCl',
    'CaCO3(s) -> CaO(s) + CO2(g)',
    'Fe2O3 + 3CO -> 2Fe + 3CO2',
  ];

  it('the semantic-name tables are gone from the pack', () => {
    for (const file of ['compounds.json', 'ions.json', 'quantity-expansions.json']) {
      expect(POLICY_MANIFEST.files).not.toContain(file);
      expect(POLICY_TABLE_FILES[file]).toBeUndefined();
    }
  });

  it('every reading is the notation only: letters, counts, charges, states and arrows', () => {
    for (const input of inputs) {
      for (const mode of ['natural', 'accessible'] as const) {
        const { writer } = verbaliseChemistry(parseChemistry(input, { inCe: true }), {
          policy: TEST_POLICY,
          mode,
          domain: 'CHEMISTRY',
          warn: () => {},
          noteProposed: () => {},
        });
        for (const name of ['ماء', 'الميثان', 'كلوريد', 'أكسيد', 'أيون', 'حمض', 'هيدروكسيد', 'كربونات']) {
          expect(writer.toString(), `${input} ${mode}`).not.toContain(name);
        }
      }
    }
  });

  it('AS-004: every formula is read by element and count, with no warning', () => {
    const result = render('المركب C₃H₈O جديد', 'CHEMISTRY');
    expect(result.preparedText).toBe('المركب سي ثلاثة إتش ثمانية أو جديد');
    expect(codes(result)).toEqual([]);
  });

  it('AS-003: a reaction keeps reactants, products, counts and direction', () => {
    const natural = prepared('2H₂ + O₂ → 2H₂O', 'CHEMISTRY');
    // DEC-052: the reaction arrow's conventional reading; `+` stays «زائد».
    expect(natural).toBe('اثنين إتش اثنين زائد أو اثنين ينتج اثنين إتش اثنين أو');
    expect(natural.indexOf('ينتج')).toBeGreaterThan(natural.indexOf('أو اثنين'));
  });
});

describe('D-9 letters and O-1 counts', () => {
  it('every Latin letter of every element symbol has a chem-letters entry', () => {
    const pack = loadPolicyPack('ar', { allowProposed: true });
    for (const symbol of ELEMENT_SYMBOLS) {
      for (const ch of symbol) expect(pack.has('chem-letters', ch), `${symbol}:${ch}`).toBe(true);
    }
    expect(ELEMENT_SYMBOLS.size).toBe(118);
  });

  it('O-1: counts 1–20, coefficients and charges are Arabic in the «اثنين» register', () => {
    const pack = loadPolicyPack('ar', { allowProposed: true });
    for (let n = 0; n <= 20; n += 1) expect(pack.has('numbers-structural', `nom:${n}`), `nom:${n}`).toBe(true);
    expect(POLICY_TABLE_FILES['chem-letters.json']!.entries.some((e) => e.key.startsWith('count:'))).toBe(false);
    expect(prepared('الأيون SO₄²⁻', 'CHEMISTRY')).toBe('الأيون إس أو أربعة، بشحنة سالب اثنين');
    expect(prepared('الصيغة C₆H₁₂O₆ هنا', 'CHEMISTRY')).toBe('الصيغة سي ستة إتش اثني عشر أو ستة هنا');
    expect(prepared('الكبريت S₂₀ هنا', 'CHEMISTRY')).toBe('الكبريت إس عشرين هنا');
  });
});

describe('P7: chemistry detection and notation', () => {
  it('English prose and acronyms are never promoted (prose-safety set)', () => {
    for (const text of [
      'منظمة WHO وفيروس HIV',
      'المعالج CPU والشبكة CNN',
      'الزر ON والزر IN',
      'فيتامين B12 مفيد',
      'He said No to CO',
    ]) {
      const result = render(text, 'CHEMISTRY', 'accessible');
      expect(result.preparedText, text).not.toContain('صيغة كيميائية');
      expect(result.spans.filter((s) => s.kind === 'expression').length, text).toBe(0);
    }
  });

  it('O-7: a spaced unit after a value is a unit, never an element', () => {
    expect(prepared('عند 300 K', 'CHEMISTRY')).toBe('عند 300 كلفن');
    expect(prepared('القوة 10 N', 'CHEMISTRY')).toBe('القوة 10 نيوتن');
    expect(prepared('نضيف 2 N2 هنا', 'CHEMISTRY')).toBe('نضيف اثنين إن اثنين هنا');
  });

  it('ASCII charges follow the last-digit convention, with a review warning', () => {
    const read = (text: string) => render(text, 'CHEMISTRY');
    expect(read('الأيون Fe3+').preparedText).toBe('الأيون إف إي، بشحنة موجب ثلاثة');
    expect(read('الأيون SO42-').preparedText).toBe('الأيون إس أو أربعة، بشحنة سالب اثنين');
    expect(read('الأيون Cr2O72-').preparedText).toBe('الأيون سي آر اثنين أو سبعة، بشحنة سالب اثنين');
    // A single digit on a polyatomic species is a count with a charge of one.
    expect(read('الأيون NH4+').preparedText).toBe('الأيون إن إتش أربعة، بشحنة موجبة');
    expect(read('الأيون NO3-').preparedText).toBe('الأيون إن أو ثلاثة، بشحنة سالبة');
    expect(codes(read('الأيون Fe3+'))).toContain('SATTS_W_AMBIGUOUS_CHARGE');
    // A written superscript charge is not ambiguous.
    expect(codes(read('الأيون NH₄⁺'))).not.toContain('SATTS_W_AMBIGUOUS_CHARGE');
  });

  it('DEC-052: a parsed bond reads «رابطة أحادية/ثنائية/ثلاثية» (supersedes O-9)', () => {
    expect(prepared('الروابط H-H و O=O و N≡N', 'CHEMISTRY')).toBe('الروابط إتش رابطة أحادية إتش و أو رابطة ثنائية أو و إن رابطة ثلاثية إن');
    expect(prepared('\\ce{CH2=CH2}', 'CHEMISTRY')).toBe('سي إتش اثنين رابطة ثنائية سي إتش اثنين');
    expect(prepared('\\ce{HC#CH}', 'CHEMISTRY')).toBe('إتش سي رابطة ثلاثية سي إتش');
    // A spaced `=` inside \ce is still the reaction arrow (mhchem).
    expect(prepared('\\ce{2H2 + O2 = 2H2O}', 'CHEMISTRY')).toBe('اثنين إتش اثنين زائد أو اثنين ينتج اثنين إتش اثنين أو');
  });

  it('hydrates, coefficients, arrows, states, marks and electrons', () => {
    expect(prepared('البلورة CuSO4.5H2O', 'CHEMISTRY')).toBe('البلورة سي يو إس أو أربعة، مع خمسة إتش اثنين أو');
    expect(prepared('نضيف 0.5H₂O', 'CHEMISTRY')).toBe('نضيف 0 فاصلة 5 إتش اثنين أو');
    expect(prepared('التفاعل 2H2+O2->2H2O', 'CHEMISTRY')).toBe('التفاعل اثنين إتش اثنين زائد أو اثنين ينتج اثنين إتش اثنين أو');
    expect(prepared('المحلول NaCl (aq)', 'CHEMISTRY')).toBe('المحلول إن إيه سي إل محلول مائي');
    expect(prepared('Zn + 2HCl → ZnCl2 + H2↑', 'CHEMISTRY')).toBe('زد إن زائد اثنين إتش سي إل ينتج زد إن سي إل اثنين زائد إتش اثنين يتصاعد');
    expect(prepared('الاختزال Cu2+ + 2e- → Cu', 'CHEMISTRY')).toBe('الاختزال سي يو، بشحنة موجب اثنين زائد اثنين إلكترون ينتج سي يو');
    expect(prepared('الرنين A ↔ B', 'CHEMISTRY')).not.toContain('اتزان');
  });

  it('counts above 20 are composed in the «اثنين» register', () => {
    expect(prepared('السكر C₁₂H₂₂O₁₁', 'CHEMISTRY')).toBe('السكر سي اثني عشر إتش اثنين وعشرين أو أحد عشر');
  });
});
