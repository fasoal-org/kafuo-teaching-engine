/**
 * Seeded, dependency-free generator for the property suite (plan §17: vitest
 * plus a small seeded generator; no new dependency). mulberry32 PRNG.
 */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
export const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

const LETTERS = ['x', 'y', 'a', 'b', 'c', 'n', 'm', 'k'];
const GREEK = ['\\alpha', '\\theta', 'π', 'β'];

/** A well-formed Mathematics expression from the V1 grammar. */
export function mathExpression(rng: Rng, depth = 0): string {
  const leaf = () => {
    const r = rng();
    if (r < 0.45) return String(int(rng, 0, 99));
    if (r < 0.55) return `${int(rng, 0, 9)}.${int(rng, 0, 99)}`;
    if (r < 0.9) return pick(rng, LETTERS);
    return pick(rng, GREEK);
  };
  if (depth >= 3) return leaf();
  const sub = () => mathExpression(rng, depth + 1);
  switch (int(rng, 0, 12)) {
    case 0:
      return leaf();
    case 1:
      return `${sub()} + ${sub()}`;
    case 2:
      return `${sub()} - ${sub()}`;
    case 3:
      return `${pick(rng, LETTERS)}^${int(rng, 2, 9)}`;
    case 4:
      return `${pick(rng, LETTERS)}^{${sub()}}`;
    case 5:
      return `\\frac{${sub()}}{${sub()}}`;
    case 6:
      return `\\sqrt{${sub()}}`;
    case 7:
      return `(${sub()} + ${sub()})`;
    case 8:
      return `|${sub()}|`;
    case 9:
      return `${int(rng, 2, 9)}${pick(rng, LETTERS)}`;
    case 10:
      return `${pick(rng, LETTERS)}_${int(rng, 1, 9)}`;
    case 11:
      return `${sub()} \\times ${sub()}`;
    default:
      return `-${leaf()}`;
  }
}

export function mathRelation(rng: Rng): string {
  const expr = mathExpression(rng);
  return rng() < 0.5 ? expr : `${expr} ${pick(rng, ['=', '≤', '≥', '<', '>', '≠'])} ${mathExpression(rng)}`;
}

const PROSE = ['نحسب', 'إذا كان', 'فإن', 'ثم نجد أن', 'لاحظ أن', 'الناتج هو', 'في المثال', 'وبالتالي'];

/** Arabic prose with 1–3 embedded expressions, some `$…$`-delimited. */
export function narration(rng: Rng, expression: (rng: Rng) => string = mathRelation): string {
  const parts: string[] = [pick(rng, PROSE)];
  const count = int(rng, 1, 3);
  for (let i = 0; i < count; i += 1) {
    const expr = expression(rng);
    parts.push(rng() < 0.3 ? `$${expr}$` : expr);
    parts.push(pick(rng, PROSE));
  }
  return `${parts.join(' ')}.`;
}

const NOISE = 'xy1234567890+-=^_{}()[]|\\/.,:;!؟ ،abcfrac sqrt ∫∑√²³₁αβ'.split('');

/** Arbitrary noise: used for robustness properties only (no idempotence claim). */
export function noise(rng: Rng): string {
  const length = int(rng, 1, 60);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += rng() < 0.3 ? pick(rng, [' نص ', ' و ', '\\frac', '\\sqrt', '\\foo', '$']) : pick(rng, NOISE);
  }
  return out;
}

const UNITS = ['m', 's', 'kg', 'm/s', 'm/s²', 'N', 'J', 'kW', 'km/h', '°C', 'Pa', 'N·m', 'mA', 'Ω'];

/** A Physics expression: equations of symbols and quantities with units. */
export function physicsExpression(rng: Rng): string {
  const quantity = () => `${int(rng, 1, 999)}${rng() < 0.3 ? `.${int(rng, 0, 9)}` : ''} ${pick(rng, UNITS)}`;
  switch (int(rng, 0, 4)) {
    case 0:
      return quantity();
    case 1:
      return `${pick(rng, ['F', 'v', 'a', 'E', 'P', 'I'])} = ${quantity()}`;
    case 2:
      return `${int(rng, 1, 9)} × 10^{${int(rng, -12, 12)}} ${pick(rng, UNITS)}`;
    case 3:
      return `${pick(rng, ['F', 'E', 'W', 'p'])} = ${pick(rng, ['m', 'F', 'I'])}${pick(rng, ['a', 'd', 'v', 'R'])}`;
    default:
      return `\\vec{${pick(rng, ['F', 'v', 'a'])}}`;
  }
}

const ELEMENTS = ['H', 'O', 'C', 'N', 'Na', 'Cl', 'Ca', 'S', 'Fe', 'Cu', 'K', 'Mg'];

function formula(rng: Rng): string {
  let out = '';
  for (let i = 0, n = int(rng, 1, 3); i < n; i += 1) {
    out += pick(rng, ELEMENTS);
    if (rng() < 0.6) out += String(int(rng, 2, 9));
  }
  if (rng() < 0.15) out += `(OH)${int(rng, 2, 3)}`;
  return out;
}

/** A Chemistry expression: formulae, ions, states and reactions. */
export function chemistryExpression(rng: Rng): string {
  const term = () => `${rng() < 0.3 ? int(rng, 2, 4) : ''}${formula(rng)}${rng() < 0.2 ? pick(rng, ['(aq)', '(s)', '(g)', '(l)']) : ''}`;
  switch (int(rng, 0, 3)) {
    case 0:
      return `${formula(rng)}${String(int(rng, 2, 4))}`;
    case 1:
      return `${term()} + ${term()} ${pick(rng, ['→', '->', '⇌'])} ${term()}`;
    case 2:
      return `\\ce{${term()} + ${term()} -> ${term()}}`;
    default:
      return `${pick(rng, ['Na', 'K', 'Cl', 'SO4', 'NH4', 'Fe'])}${pick(rng, ['⁺', '⁻', '²⁺', '²⁻', '^{3+}'])}`;
  }
}

const ARABIC_VARIABLES = ['س', 'ص', 'ع', 'أ', 'ب', 'جـ', 'د', 'هـ', 'ك', 'ن', 'ر'];

/** A Mathematics expression with Arabic-letter variables (D-1, D-10). */
export function arabicMathExpression(rng: Rng): string {
  const v = () => pick(rng, ARABIC_VARIABLES);
  switch (int(rng, 0, 10)) {
    case 0:
      return `${v()} = ${int(rng, 0, 99)}`;
    case 1:
      return `${int(rng, 2, 9)}${v()} + ${int(rng, 1, 20)} = ${int(rng, 1, 99)}`;
    case 2:
      return `${v()}² + ${v()}² = ${int(rng, 1, 99)}`;
    case 3:
      return `${v()} ≠ ${int(rng, 0, 9)}`;
    case 4:
      return `|${v()} - ${int(rng, 1, 9)}|`;
    case 5:
      return `√${v()}`;
    case 6:
      return `د(س) = ${int(rng, 2, 9)}س + ${int(rng, 1, 9)}`;
    case 7:
      return `${v()}(${v()} + ${int(rng, 1, 9)})`;
    case 8:
      return `\\frac{${v()}}{${int(rng, 2, 9)}} + ${pick(rng, ['½', '⅓', '¾'])}`;
    case 9:
      return `${int(rng, 2, 9)} ${v()} - ${v()}³ ≤ ${int(rng, 1, 9)}`;
    default:
      return `${v()} × ${v()} = ${mathExpression(rng)}`;
  }
}

const ARABIC_NOISE = [
  'س',
  'ص',
  'هـ',
  '2س',
  'س²',
  'د(',
  ' و ',
  'ـ',
  'أ)',
  '(أ)',
  'م/ث',
  '1445هـ',
  ' - ',
  ' + ',
  '½',
  '¾',
  'وس',
  'ص 12',
];

/** Arbitrary noise mixing Arabic letters, markers and math glyphs (robustness only). */
export function arabicNoise(rng: Rng): string {
  const length = int(rng, 1, 60);
  let out = '';
  for (let i = 0; i < length; i += 1) out += rng() < 0.5 ? pick(rng, ARABIC_NOISE) : pick(rng, NOISE);
  return out;
}
