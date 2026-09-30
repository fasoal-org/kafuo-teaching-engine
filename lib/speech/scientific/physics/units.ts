/**
 * Physics unit recognition (plan §10.2). A unit is recognised ONLY in unit
 * position: directly after a number (or a power of ten), optionally after a
 * LaTeX space or inside `\text{}`/`\mathrm{}`. A lone letter anywhere else is
 * a symbol, never a unit (ambiguity rule 1). Units are never converted.
 */
import type { UnitFactor, UnitMatch, UnitNode } from '../math/parse';
import { isLatinLetter } from '../normalise';
import { matchBrace, superscriptValue } from '../math/tokenize';
import { canonicalToken, policyTokens } from '../policy';

/**
 * Recognition comes from the dictionary keys, whatever their approval status
 * (upgrade plan P2 item 4): a unit or prefix added to `units.json` /
 * `prefixes.json` is recognised without a code change. Only the wording is
 * gated by approval.
 */
const UNITS = policyTokens('unit');
const PREFIXES = policyTokens('prefix');

/** Every recognised unit key (tests, tooling). */
export const UNIT_KEYS: readonly string[] = [...UNITS];
/** Every recognised prefix key and alias (tests, tooling). */
export const PREFIX_KEYS: readonly string[] = [...PREFIXES];

function isUnitLetter(ch: string | undefined): boolean {
  return ch !== undefined && (isLatinLetter(ch) || ch === 'Ω' || ch === 'μ' || ch === 'µ');
}

/**
 * Splits one letter run into prefix + unit. A run that is itself a unit wins
 * (`min`, `Pa`, `cd`), so a prefix reading is used only when the whole run is
 * not a unit (`km`, `ms`, `kWh`). Returns `null` when the run is not a unit.
 */
export function splitUnitToken(run: string): { prefix: string | null; unit: string } | null {
  const normalised = run.replace(/µ/g, 'μ');
  if (UNITS.has(normalised)) return { prefix: null, unit: normalised };
  const prefix = normalised[0]!;
  const rest = normalised.slice(1);
  if (PREFIXES.has(prefix) && UNITS.has(rest) && !rest.startsWith('°')) {
    return { prefix: canonicalToken('prefix', prefix), unit: rest };
  }
  return null;
}

function readPower(src: string, i: number): { power: number; end: number } | null {
  // Unicode superscripts: ² ³ ⁻¹ …
  if (superscriptValue(src[i] ?? '') !== undefined) {
    let text = '';
    let j = i;
    while (j < src.length && superscriptValue(src[j]!) !== undefined) {
      text += superscriptValue(src[j]!);
      j += 1;
    }
    const value = Number(text);
    return Number.isInteger(value) && text !== '-' && text !== '+' ? { power: value, end: j } : null;
  }
  if (src[i] === '^') {
    let j = i + 1;
    let text = '';
    if (src[j] === '{') {
      const close = matchBrace(src, j);
      if (close < 0) return null;
      text = src.slice(j + 1, close - 1).trim();
      j = close;
    } else {
      if (src[j] === '-' || src[j] === '−') {
        text = '-';
        j += 1;
      }
      if (!/[0-9]/.test(src[j] ?? '')) return null;
      text += src[j];
      j += 1;
    }
    const value = Number(text.replace('−', '-'));
    return Number.isInteger(value) ? { power: value, end: j } : null;
  }
  return null;
}

const TEXT_WRAPPERS = ['\\text{', '\\mathrm{', '\\textrm{'];

/** `\text{…}` / `\mathrm{…}` at `i`: its trimmed content and the index after it. */
function readWrapped(src: string, i: number): { inner: string; end: number } | null {
  const wrapper = TEXT_WRAPPERS.find((w) => src.startsWith(w, i));
  if (!wrapper) return null;
  const close = matchBrace(src, i + wrapper.length - 1);
  if (close < 0) return null;
  return { inner: src.slice(i + wrapper.length, close - 1).trim(), end: close };
}

/**
 * `^\circ C`, `^{\circ}C`, `°C`, `℃`, and the same for Fahrenheit (P9): the
 * temperature unit at `i` (`°C` / `°F`) and the index after it.
 */
function readDegreeUnit(src: string, i: number): { unit: string; end: number } | null {
  if (src[i] === '℃') return { unit: '°C', end: i + 1 };
  if (src[i] === '℉') return { unit: '°F', end: i + 1 };
  let j = i;
  if (src[j] === '°') j += 1;
  else if (src.startsWith('^\\circ', j)) j += 6;
  else if (src.startsWith('^{\\circ}', j)) j += 8;
  else return null;
  while (src[j] === ' ') j += 1;
  if ((src[j] === 'C' || src[j] === 'F') && !isUnitLetter(src[j + 1])) return { unit: `°${src[j]}`, end: j + 1 };
  const wrapped = readWrapped(src, j);
  return wrapped && (wrapped.inner === 'C' || wrapped.inner === 'F') ? { unit: `°${wrapped.inner}`, end: wrapped.end } : null;
}

function readFactor(src: string, i: number): { factor: UnitFactor; end: number } | null {
  let j = i;
  let run = '';
  let prefix: string | null = null;
  const degree = readDegreeUnit(src, j);
  if (degree && UNITS.has(degree.unit)) {
    run = degree.unit;
    j = degree.end;
  } else if (src.startsWith('\\mu', j) && !isLatinLetter(src[j + 3])) {
    // `\mu m`, `\mu\text{m}`: the micro prefix written as a command (P6 item 5).
    prefix = 'μ';
    j += 3;
    while (src[j] === ' ' || src.startsWith('\\,', j)) j += src[j] === ' ' ? 1 : 2;
    const wrapped = readWrapped(src, j);
    if (wrapped) {
      run = wrapped.inner;
      j = wrapped.end;
    } else {
      while (j < src.length && isUnitLetter(src[j])) {
        run += src[j];
        j += 1;
      }
    }
    if (!UNITS.has(run)) return null;
  } else {
    while (j < src.length && isUnitLetter(src[j])) {
      run += src[j];
      j += 1;
    }
  }
  if (!run || isUnitLetter(src[j])) return null;
  const split = prefix ? { prefix, unit: run } : splitUnitToken(run);
  if (!split) return null;
  const power = readPower(src, j);
  return {
    factor: { unit: split.unit, prefix: split.prefix, power: power?.power ?? 1 },
    end: power?.end ?? j,
  };
}

/** `·`, `⋅`, `*`, `\cdot` between two unit factors. */
function readProductSeparator(src: string, i: number): number | null {
  if (src[i] === '·' || src[i] === '⋅' || src[i] === '*') return i + 1;
  if (src.startsWith('\\cdot', i)) return i + 5;
  return null;
}

/** Spacing between two unit factors (`m s⁻¹`, `m\,s^{-2}`): the index after it, or `i`. */
function skipFactorSpace(src: string, i: number): number {
  let j = i;
  for (;;) {
    if (src[j] === ' ' || src[j] === '\u00a0' || src[j] === '~') j += 1;
    else if (src[j] === '\\' && (src[j + 1] === ',' || src[j + 1] === ';' || src[j + 1] === ' ')) j += 2;
    else return j;
  }
}

/** The next factor after `j` (joined by `·` or by spacing), or `null`. */
function nextFactor(src: string, j: number): { factor: UnitFactor; end: number } | null {
  const sep = readProductSeparator(src, j);
  if (sep !== null) return readFactor(src, skipFactorSpace(src, sep));
  const spaced = skipFactorSpace(src, j);
  if (spaced === j) return null;
  const next = readFactor(src, spaced);
  // A spaced factor must stand alone: `N m`, never the start of a word.
  return next && !/[0-9A-Za-z]/.test(src[next.end] ?? '') ? next : null;
}

/**
 * A unit expression starting exactly at `i` (P6 item 1): factors joined by
 * `·` or spacing, optionally `/` and a denominator — one factor, or a
 * bracketed group `/(kg·K)`.
 */
function readUnitExpression(src: string, i: number): { unit: Omit<UnitNode, 'source'>; end: number } | null {
  const first = readFactor(src, i);
  if (!first) return null;
  const num: UnitFactor[] = [first.factor];
  const den: UnitFactor[] = [];
  let j = first.end;
  let target = num;
  for (;;) {
    const next = nextFactor(src, j);
    if (next) {
      target.push(next.factor);
      j = next.end;
      continue;
    }
    if (src[j] === '/' && target === num) {
      if (src[j + 1] === '(') {
        const group = readFactor(src, j + 2);
        if (!group) break;
        const factors = [group.factor];
        let k = group.end;
        for (let more = nextFactor(src, k); more; more = nextFactor(src, k)) {
          factors.push(more.factor);
          k = more.end;
        }
        if (src[k] !== ')') break;
        den.push(...factors);
        target = den;
        j = k + 1;
        continue;
      }
      const next = readFactor(src, j + 1);
      if (!next) break;
      target = den;
      den.push(next.factor);
      j = next.end;
      continue;
    }
    break;
  }
  return { unit: { num, den }, end: j };
}

/** Skips the spacing allowed between a number and its unit. */
function skipUnitSpace(src: string, i: number): number {
  let j = i;
  for (;;) {
    if (src[j] === ' ' || src[j] === '\u00a0' || src[j] === '~') j += 1;
    else if (src[j] === '\\' && (src[j + 1] === ',' || src[j + 1] === ';' || src[j + 1] === ' ')) j += 2;
    else if (src.startsWith('\\quad', j)) j += 5;
    else return j;
  }
}

/** `\text{m/s}^2`: a power written after the wrapper belongs to the unit's last factor. */
function withTrailingPower(unit: Omit<UnitNode, 'source'>, src: string, end: number): { unit: Omit<UnitNode, 'source'>; end: number } {
  const power = readPower(src, end);
  if (!power) return { unit, end };
  const list = unit.den.length > 0 ? unit.den : unit.num;
  const last = list[list.length - 1]!;
  if (last.power !== 1) return { unit, end };
  list[list.length - 1] = { ...last, power: power.power };
  return { unit, end: power.end };
}

/**
 * Matches a unit expression in unit position at `pos` (right after a number).
 *
 * O-7 (P6 item 3): a symbol is a unit only on evidence — spacing after the
 * value, a prefix or multi-letter unit, a power, a compound unit, or a
 * `\text{}`/`\mathrm{}` wrapper. A single letter glued to the number
 * (`5s`, `3N`) is `ambiguous`: the caller reads the letter and warns.
 */
export function matchUnit(src: string, pos: number): UnitMatch | null {
  const start = skipUnitSpace(src, pos);
  const wrapped = readWrapped(src, start);
  if (wrapped) {
    const parsed = readUnitExpression(wrapped.inner, 0);
    if (!parsed || parsed.end !== wrapped.inner.length) return null;
    const powered = withTrailingPower(parsed.unit, src, wrapped.end);
    return { end: powered.end, unit: { ...powered.unit, source: src.slice(start, powered.end) } };
  }
  const parsed = readUnitExpression(src, start);
  if (!parsed) return null;
  // The unit must end at a boundary: not glued to further letters or digits.
  const after = src[parsed.end];
  if (after !== undefined && (isUnitLetter(after) || /[0-9]/.test(after))) return null;
  const unit = { ...parsed.unit, source: src.slice(start, parsed.end) };
  const [only] = unit.num;
  const glued = start === pos;
  const ambiguous =
    glued && unit.den.length === 0 && unit.num.length === 1 && only!.prefix === null && only!.power === 1 && /^[A-Za-z]$/.test(only!.unit);
  return { end: parsed.end, unit, ...(ambiguous ? { ambiguous: true } : {}) };
}

/** Detection hook: is there a unit (with evidence) in unit position at `pos` of `src`? */
export function unitAt(src: string, pos: number): boolean {
  const match = matchUnit(src, pos);
  return match !== null && match.ambiguous !== true;
}

/** Detection hook: the end of a unit (with evidence) at `pos`, or -1. */
export function unitEnd(src: string, pos: number): number {
  const match = matchUnit(src, pos);
  return match && match.ambiguous !== true ? match.end : -1;
}

/**
 * A compound unit written with no value (`m/s`, `kg·m`): read as its symbols,
 * never guessed to be a unit (O-7).
 */
export function isBareCompoundUnit(src: string): boolean {
  const text = src.trim();
  if (/[0-9]/.test(text)) return false;
  const parsed = readUnitExpression(text, 0);
  return parsed !== null && parsed.end === text.length && parsed.unit.num.length + parsed.unit.den.length >= 2;
}
