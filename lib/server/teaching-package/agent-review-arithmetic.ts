/**
 * The restricted arithmetic of the agent book review (Kafuo Agent API D2a, design
 * §4): a model finding's `computation {givens, expression, claimed}` is recomputed
 * here, never trusted. A recursive-descent parser over numbers (Latin or
 * Arabic-Indic digits, `.`/`٫`, `×10^n`, `×10ⁿ`, `e±n`), `+ − × ÷ * / · ^ ( )`,
 * unary minus, the givens' names and the profile constants. There is no `eval`,
 * no function call, no property access: anything else is a parse failure, and a
 * failure means "code can't verify" (the finding stays MEDIUM).
 *
 * Units are tracked as base-symbol exponents (`g/mol`, `mol·L⁻¹`, `g mol^-1`):
 * `×`/`÷` combine them, `+`/`−` and `^` (non-integer) require them to agree.
 * Pure: no I/O.
 */

export type Units = Readonly<Record<string, number>>;

export interface Quantity {
  value: number;
  units: Units;
}

export interface Given {
  name: string;
  value: string | number;
  unit?: string | null;
}

export type RecomputeResult =
  | { ok: true; value: number; units: Units }
  | { ok: false; reason: string };

const SUPERSCRIPT: Record<string, string> = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
  '⁻': '-',
  '⁺': '+',
};

/** Latin digits, `.` decimals, `^(n)` for superscript runs, ASCII operators. */
export function normalizeArithmetic(text: string): string {
  return (
    text
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
      .replace(/٫/g, '.')
      .replace(/٬/g, '')
      .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+/g, (run) => `^(${[...run].map((c) => SUPERSCRIPT[c]).join('')})`)
      .replace(/[−–]/g, '-')
      // A Latin `x` is a times sign only between a number and a power of ten (`6.02 x 10^23`).
      .replace(/(?<=\d\s*)x(?=\s*10\b)/g, '*')
      .replace(/[×·⋅]/g, '*')
      .replace(/÷/g, '/')
  );
}

const EMPTY: Units = {};

function combine(a: Units, b: Units, sign: 1 | -1): Units {
  const out: Record<string, number> = { ...a };
  for (const [unit, power] of Object.entries(b)) {
    const next = (out[unit] ?? 0) + sign * power;
    if (next === 0) delete out[unit];
    else out[unit] = next;
  }
  return out;
}

function scale(a: Units, by: number): Units {
  const out: Record<string, number> = {};
  for (const [unit, power] of Object.entries(a)) out[unit] = power * by;
  return out;
}

export function sameUnits(a: Units, b: Units): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if ((a[key] ?? 0) !== (b[key] ?? 0)) return false;
  return true;
}

/** `g/mol`, `mol·L⁻¹`, `g mol^-1`, `atoms` → exponents. Unknown shapes → null. */
export function parseUnits(unit: string | null | undefined): Units | null {
  if (!unit || unit.trim() === '') return EMPTY;
  const text = normalizeArithmetic(unit).replace(/\*/g, ' ');
  const [numerator, ...denominators] = text.split('/');
  let units: Units = EMPTY;
  const apply = (part: string, sign: 1 | -1): boolean => {
    for (const token of part.trim().split(/\s+/).filter(Boolean)) {
      const match = /^([A-Za-z؀-ۿ°%]+)(?:\^\(?(-?\d+)\)?)?$/.exec(token);
      if (!match) return false;
      units = combine(units, { [match[1]!]: Number(match[2] ?? 1) }, sign);
    }
    return true;
  };
  if (!apply(numerator ?? '', 1)) return null;
  for (const part of denominators) if (!apply(part, -1)) return null;
  return units;
}

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'op'; value: string };

function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const rest = text.slice(at);
    const space = /^\s+/.exec(rest);
    if (space) {
      at += space[0].length;
      continue;
    }
    const number = /^(\d+(?:\.\d+)?|\.\d+)(?:[eE]([+-]?\d+))?/.exec(rest);
    if (number) {
      tokens.push({ kind: 'num', value: Number(number[0]) });
      at += number[0].length;
      continue;
    }
    const name = /^[A-Za-z_؀-ۿ][A-Za-z0-9_؀-ۿ]*/.exec(rest);
    if (name) {
      tokens.push({ kind: 'name', value: name[0] });
      at += name[0].length;
      continue;
    }
    if ('+-*/^()'.includes(rest[0]!)) {
      tokens.push({ kind: 'op', value: rest[0]! });
      at += 1;
      continue;
    }
    return null;
  }
  return tokens;
}

class ParseError extends Error {}

/**
 * Recompute `expression` from the givens and the constants. Names resolve to a
 * given first, then a constant (case-sensitive). Never throws.
 */
/**
 * A profile constant: a number, or `"6.02×10^23 mol^-1"` (the number, then its
 * unit). Null when it is neither (it is then skipped, never fatal).
 */
export function parseConstant(raw: string | number): Quantity | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw, units: EMPTY } : null;
  const split = /^\s*([^A-Za-z؀-ۿ]+?)\s*([A-Za-z؀-ۿ].*)?$/.exec(raw);
  const value = parseNumber(split?.[1] ?? raw);
  const units = parseUnits(split?.[2] ?? null);
  return value.ok && units !== null ? { value: value.value, units } : null;
}

export function recompute(input: {
  expression: string;
  givens?: readonly Given[];
  constants?: Readonly<Record<string, string | number>>;
  /** Told the name of every constant skipped as unparsable (logging; never its value). */
  onSkippedConstant?: (name: string) => void;
}): RecomputeResult {
  const tokens = tokenize(normalizeArithmetic(input.expression));
  if (!tokens || tokens.length === 0) return { ok: false, reason: 'unparsable expression' };
  if (tokens.length > 400) return { ok: false, reason: 'expression too long' };

  const names = new Map<string, Quantity>();
  const define = (name: string, raw: string | number, unit: string | null | undefined) => {
    const value = typeof raw === 'number' ? { ok: true as const, value: raw } : parseNumber(raw);
    const units = parseUnits(unit ?? null);
    if (!value.ok || units === null) throw new ParseError(`given ${name} is not a number`);
    names.set(name, { value: value.value, units });
  };
  // One bad profile constant must not stop every computation: it is skipped
  // (and reported), so only an expression that USES it fails, as an unknown name.
  for (const [name, raw] of Object.entries(input.constants ?? {})) {
    const constant = parseConstant(raw);
    if (constant) names.set(name, constant);
    else input.onSkippedConstant?.(name);
  }
  try {
    for (const given of input.givens ?? []) define(given.name, given.value, given.unit);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'bad given' };
  }

  let at = 0;
  const peek = () => tokens[at];
  const take = () => tokens[at++];

  const expr = (): Quantity => {
    let left = term();
    for (
      let token = peek();
      token?.kind === 'op' && (token.value === '+' || token.value === '-');
      token = peek()
    ) {
      take();
      const right = term();
      if (!sameUnits(left.units, right.units)) throw new ParseError('units do not match in a sum');
      left = {
        value: token.value === '+' ? left.value + right.value : left.value - right.value,
        units: left.units,
      };
    }
    return left;
  };
  const term = (): Quantity => {
    let left = factor();
    for (
      let token = peek();
      token?.kind === 'op' && (token.value === '*' || token.value === '/');
      token = peek()
    ) {
      take();
      const right = factor();
      left =
        token.value === '*'
          ? { value: left.value * right.value, units: combine(left.units, right.units, 1) }
          : { value: left.value / right.value, units: combine(left.units, right.units, -1) };
    }
    return left;
  };
  const factor = (): Quantity => {
    const base = unary();
    const token = peek();
    if (token?.kind === 'op' && token.value === '^') {
      take();
      const power = factor();
      if (Object.keys(power.units).length > 0) throw new ParseError('an exponent has units');
      if (!Number.isInteger(power.value) && Object.keys(base.units).length > 0) {
        throw new ParseError('a non-integer power of a quantity with units');
      }
      return { value: base.value ** power.value, units: scale(base.units, power.value) };
    }
    return base;
  };
  const unary = (): Quantity => {
    const token = peek();
    if (token?.kind === 'op' && (token.value === '-' || token.value === '+')) {
      take();
      const inner = unary();
      return token.value === '-' ? { value: -inner.value, units: inner.units } : inner;
    }
    return primary();
  };
  const primary = (): Quantity => {
    const token = take();
    if (!token) throw new ParseError('unexpected end');
    if (token.kind === 'num') return { value: token.value, units: EMPTY };
    if (token.kind === 'name') {
      const known = names.get(token.value);
      if (!known) throw new ParseError(`unknown name ${token.value}`);
      return known;
    }
    if (token.value === '(') {
      const inner = expr();
      const close = take();
      if (close?.kind !== 'op' || close.value !== ')') throw new ParseError('missing )');
      return inner;
    }
    throw new ParseError(`unexpected ${token.value}`);
  };

  try {
    const result = expr();
    if (at !== tokens.length) return { ok: false, reason: 'trailing input' };
    if (!Number.isFinite(result.value)) return { ok: false, reason: 'not a finite number' };
    return { ok: true, value: result.value, units: result.units };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'unparsable' };
  }
}

/** A number as written (`7.30×10³`, `6.02 × 10^23`, `٤٤٥٫٧`), or a failure. */
export function parseNumber(text: string): { ok: true; value: number } | { ok: false } {
  const tokens = tokenize(normalizeArithmetic(text));
  if (!tokens) return { ok: false };
  const result = recompute({ expression: text });
  return result.ok && Object.keys(result.units).length === 0
    ? { ok: true, value: result.value }
    : { ok: false };
}

/**
 * The claimed value, as written, with its significant-figure tolerance: half the
 * last written digit (`7.30×10³` → ±5, `446` → ±0.5, `445.7` → ±0.05).
 */
export function claimedWithTolerance(
  claimed: string,
): { ok: true; value: number; tolerance: number; unit: string } | { ok: false } {
  const normalized = normalizeArithmetic(claimed).trim();
  const match =
    /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?:\s*\*\s*10\s*\^\s*\(?\s*([+-]?\d+)\s*\)?|[eE]([+-]?\d+))?\s*(.*)$/.exec(
      normalized,
    );
  if (!match) return { ok: false };
  const mantissa = match[1]!;
  const exponent = Number(match[2] ?? match[3] ?? 0);
  const decimals = mantissa.includes('.') ? mantissa.split('.')[1]!.length : 0;
  const value = Number(mantissa) * 10 ** exponent;
  if (!Number.isFinite(value)) return { ok: false };
  return { ok: true, value, tolerance: 0.5 * 10 ** (exponent - decimals), unit: match[4] ?? '' };
}

export type CodeCheck =
  | { verdict: 'disagrees'; computed: number; claimed: number; tolerance: number }
  | { verdict: 'agrees'; computed: number; claimed: number; tolerance: number }
  | { verdict: 'unverifiable'; reason: string };

/**
 * Recompute and compare with `claimed`: `disagrees` only beyond half the last
 * significant digit (and, when the claim names a unit, a unit mismatch counts).
 */
export function checkComputation(input: {
  expression: string;
  claimed: string;
  givens?: readonly Given[];
  constants?: Readonly<Record<string, string | number>>;
  onSkippedConstant?: (name: string) => void;
}): CodeCheck {
  const computed = recompute(input);
  if (!computed.ok) return { verdict: 'unverifiable', reason: computed.reason };
  const claimed = claimedWithTolerance(input.claimed);
  if (!claimed.ok) return { verdict: 'unverifiable', reason: 'unparsable claimed value' };
  const claimedUnits = parseUnits(claimed.unit);
  const unitsDiffer =
    claimed.unit.trim() !== '' &&
    claimedUnits !== null &&
    Object.keys(computed.units).length > 0 &&
    !sameUnits(claimedUnits, computed.units);
  const off = Math.abs(computed.value - claimed.value) > claimed.tolerance;
  const verdict = off || unitsDiffer ? 'disagrees' : 'agrees';
  return {
    verdict,
    computed: computed.value,
    claimed: claimed.value,
    tolerance: claimed.tolerance,
  };
}
