/**
 * Arabic reading of Physics unit expressions (plan §10.2): prefix + unit name,
 * powers preserved (`km²` → «كيلومتر مربع», `m/s²` → «متر لكل ثانية تربيع»),
 * never converted. Wordings come from `units.json` / `prefixes.json`.
 *
 * When any entry the reading needs is unusable (missing, or `proposed` in
 * production), the unit is spoken in its authored literal form (`m/s²`)
 * instead of a half-worded reading that would drop the division or the power
 * (FR-030). The missing-entry warnings are still recorded.
 */
import type { UnitFactor, UnitNode } from '../math/parse';
import { structuralWord } from '../numbers/read';
import type { PolicyRole } from '../policy';
import { label, speak, type VerbaliseContext, type Writer } from '../writer';

/**
 * The one-word name of a unit power 2 / 3: «مربع» / «مكعب» after a numerator
 * unit, «تربيع» / «تكعيب» after a denominator unit. An accessible denominator
 * has none: its «مرفوعة للقوة ‹n›» is composed from `power` and the number
 * word, never stored as a template (review finding 6).
 */
function namedPower(ctx: VerbaliseContext, power: number, inDenominator: boolean): string | null {
  if (power !== 2 && power !== 3) return null;
  if (!inDenominator) return power === 2 ? 'unit-squared' : 'unit-cubed';
  if (ctx.mode === 'accessible') return null;
  return power === 2 ? 'squared' : 'cubed';
}

function writeFactor(ctx: VerbaliseContext, w: Writer, factor: UnitFactor, inDenominator: boolean): void {
  w.sem('unit', `${factor.prefix ?? ''}${factor.unit}`);
  const unit = speak(ctx, 'unit', factor.unit, factor.unit);
  const prefix = factor.prefix ? speak(ctx, 'prefix', factor.prefix, factor.prefix) : '';
  // Arabic writes a prefixed unit as one word: كيلومتر، ملي‌ثانية …
  w.word(`${prefix}${unit}`);
  if (factor.power === 1) return;
  w.sem('upow', String(factor.power));
  const named = namedPower(ctx, factor.power, inDenominator);
  if (named !== null) {
    w.word(label(ctx, named));
    return;
  }
  w.word(label(ctx, 'power'));
  if (factor.power < 0) w.word(label(ctx, 'neg', '-'));
  const magnitude = Math.abs(factor.power);
  w.word(structuralWord(ctx, magnitude) ?? String(magnitude));
}

/** Every policy entry the worded reading of `factor` consults. */
function factorEntries(ctx: VerbaliseContext, factor: UnitFactor, inDenominator: boolean): Array<[PolicyRole, string]> {
  const entries: Array<[PolicyRole, string]> = [['unit', factor.unit]];
  if (factor.prefix) entries.push(['prefix', factor.prefix]);
  const named = namedPower(ctx, factor.power, inDenominator);
  if (named !== null) entries.push(['label', named]);
  else if (factor.power !== 1) {
    entries.push(['label', 'power']);
    if (factor.power < 0) entries.push(['label', 'neg']);
    const magnitude = Math.abs(factor.power);
    if (magnitude <= 12) entries.push(['number', String(magnitude)]);
  }
  return entries;
}

/** The authored unit as one plain-text token: `m/s²`, `N·m`, `s^-1`. */
function literalUnit(unit: UnitNode): string {
  return unit.source.replace(/\\cdot/g, '·').replace(/[{}]/g, '');
}

export function writeUnit(ctx: VerbaliseContext, unit: UnitNode, w: Writer): void {
  const entries: Array<[PolicyRole, string]> = [
    ...unit.num.flatMap((factor) => factorEntries(ctx, factor, false)),
    ...(unit.den.length > 0 ? [['label', 'per'] as [PolicyRole, string]] : []),
    ...unit.den.flatMap((factor) => factorEntries(ctx, factor, true)),
  ];
  const missing = entries.filter(
    ([role, token]) => ctx.policy.resolve({ role, token, domain: ctx.domain }, ctx.mode) === null,
  );
  if (missing.length > 0) {
    for (const [role, token] of missing) ctx.warn('SATTS_W_MISSING_DICTIONARY_ENTRY', `${role}:${token}`);
    // Same semantic tokens as the worded reading (mode parity, FR-019).
    const sem = (factor: UnitFactor) => {
      w.sem('unit', `${factor.prefix ?? ''}${factor.unit}`);
      if (factor.power !== 1) w.sem('upow', String(factor.power));
    };
    unit.num.forEach(sem);
    if (unit.den.length > 0) w.sem('per');
    unit.den.forEach(sem);
    w.word(literalUnit(unit));
    return;
  }
  unit.num.forEach((factor) => writeFactor(ctx, w, factor, false));
  if (unit.den.length > 0) {
    w.sem('per');
    w.word(label(ctx, 'per'));
    unit.den.forEach((factor) => writeFactor(ctx, w, factor, true));
  }
}
