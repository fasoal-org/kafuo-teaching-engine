/**
 * The Physics grammar (plan §10.2): the Mathematics grammar plus quantities
 * with units, vectors and scientific notation. Symbols are always read as
 * letters (Latin letter names): V1 ships an EMPTY approved quantity-expansion
 * set, so `F = ma` is «إف يساوي إم إيه», never "force equals…" (FR-013).
 */
import { parseMath, type MathParseOptions } from '../math/parse';
import { verbaliseMath } from '../math/verbalise-ar';
import type { VerbaliseContext, Writer } from '../writer';
import { isBareCompoundUnit, matchUnit, unitAt, unitEnd } from './units';
import { writeUnit } from './verbalise-ar';

export function renderPhysics(
  source: string,
  ctx: VerbaliseContext,
  options: Pick<MathParseOptions, 'arabicLetters' | 'leadingBinary'> = {},
): { writer: Writer; maxDepth: number; tokens: number } {
  const parsed = parseMath(source, {
    ...options,
    physics: true,
    matchUnit,
    onAmbiguousUnit: (unit) => ctx.warn('SATTS_W_AMBIGUOUS_UNIT', unit),
  });
  // O-7: `m/s` with no value is read as its symbols, with a review warning.
  if (isBareCompoundUnit(source)) ctx.warn('SATTS_W_AMBIGUOUS_UNIT', source.trim());
  // Symbols are read by their Latin letter names in the lesson's domain
  // (PHYSICS, or CHEMISTRY for `\pu{}` and non-formula runs).
  const writer = verbaliseMath(parsed.node, {
    ...ctx,
    writeUnit: (unit, w) => writeUnit(ctx, unit, w),
  });
  return { writer, maxDepth: parsed.maxDepth, tokens: parsed.tokens.length };
}

export const physicsHooks = { unitAt, unitEnd };
