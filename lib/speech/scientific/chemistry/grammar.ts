/**
 * The Chemistry grammar (plan §10.3), active for subject CHEMISTRY only.
 * `\ce{}` content is always chemical; a bare Latin run is chemical only when
 * it parses completely as a formula AND meets a promotion rule, which defends
 * against English/letter traps (`CO`/`Co`, `No`, `In`, `He`, `I`, `As`, `Be`).
 * Case is significant and never corrected. `\pu{}` and other runs (numbers
 * with units, `pH = 7`) use the Physics reading.
 */
import type { ExpressionCandidate } from '../detect';
import { ParseFault } from '../math/parse';
import { matchBrace } from '../math/tokenize';
import { renderPhysics } from '../physics/grammar';
import { unitAt, unitEnd } from '../physics/units';
import type { VerbaliseContext, Writer } from '../writer';
import { ChemFault, isPromoted, parseChemistry } from './parse';
import { verbaliseAmbiguousSymbol, verbaliseChemistry } from './verbalise-ar';

/** Formula-shaped (upper-case start, letters and counts only) with at least one count. */
function looksLikeFormula(run: string): boolean {
  return /^[A-Z][A-Za-z0-9₀-₉()[\]]*$/.test(run) && /[0-9₀-₉]/.test(run);
}

/**
 * A run that parses but shows no chemistry evidence: a lone element symbol
 * (`He`, `No`, `I`) is read as letters with a warning; an all-capitals run
 * (`WHO`, `CPU`, `ON`, `CO`) or `B12` stays prose (P7 item 1).
 */
function ambiguousOrProse(run: string): 'ambiguous' | null {
  return /^[A-Z][a-z]?$/.test(run) ? 'ambiguous' : null;
}

/** Does the text parse as chemistry at all (`$…$` content is evidence enough)? */
function parsesAsChemistry(source: string): boolean {
  try {
    parseChemistry(source, { inCe: false });
    return true;
  } catch {
    return false;
  }
}

/** Chemistry notation read as its letters, with no warning (P9): `pH`, `Ka`, `Ksp` … */
const NOTATION = new Set(['pH', 'pOH', 'pKa', 'pKb', 'Ka', 'Kb', 'Kc', 'Kp', 'Ksp', 'Kw']);

/** Detection hook: is this bare run a formula, an ambiguous lone symbol, or neither? */
export function chemistryFormulaKind(run: string): 'formula' | 'ambiguous' | 'notation' | null {
  if (NOTATION.has(run)) return 'notation';
  try {
    const reaction = parseChemistry(run, { inCe: false });
    return isPromoted(reaction) ? 'formula' : ambiguousOrProse(run);
  } catch (error) {
    if (error instanceof ChemFault && error.kind === 'unknown-element' && looksLikeFormula(run)) {
      return 'formula';
    }
    return null;
  }
}

export function renderChemistry(
  source: string,
  candidate: ExpressionCandidate,
  ctx: VerbaliseContext,
): { writer: Writer; maxDepth: number; tokens: number } {
  if (candidate.command === 'pu') return renderPhysics(source, ctx);
  // `$\ce{…}$`: an explicit chemistry command wrapped in math delimiters.
  const wrapped = /^\\(ce|pu)\{/.exec(source);
  if (candidate.kind === 'delimited' && wrapped && matchBrace(source, 3) === source.length) {
    const inner = source.slice(4, -1);
    const command = wrapped[1] as 'ce' | 'pu';
    return renderChemistry(inner, { ...candidate, kind: 'ce', command }, ctx);
  }
  // Delimited content that parses as chemistry uses this grammar (`$…$` is
  // chemistry evidence, P7 item 1); math stays math.
  const chemical =
    candidate.kind === 'ce' ||
    candidate.reason === 'formula' ||
    (candidate.kind === 'delimited' && (chemistryFormulaKind(source) === 'formula' || parsesAsChemistry(source)));
  if (chemical) {
    let writer: Writer;
    try {
      writer = verbaliseChemistry(parseChemistry(source, { inCe: candidate.kind === 'ce' }), ctx).writer;
    } catch (error) {
      if (error instanceof ChemFault) {
        throw new ParseFault(error.kind === 'unknown-element' ? 'unknown-element' : error.kind, error.detail);
      }
      throw error;
    }
    return { writer, maxDepth: 0, tokens: source.length };
  }
  if (candidate.reason === 'symbol') {
    ctx.warn('SATTS_W_AMBIGUOUS_SYMBOL', source);
    return { writer: verbaliseAmbiguousSymbol(source, ctx), maxDepth: 0, tokens: 1 };
  }
  if (candidate.reason === 'notation') {
    return { writer: verbaliseAmbiguousSymbol(source, ctx), maxDepth: 0, tokens: 1 };
  }
  return renderPhysics(source, ctx);
}

export const chemistryHooks = {
  formulaKind: chemistryFormulaKind,
  unitAt,
  unitEnd,
};
