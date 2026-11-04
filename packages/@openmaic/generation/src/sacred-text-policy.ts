/**
 * The Quran and hadith policy block of the learner-text prompts (Kafuo plan
 * `quran-text-handling-rules-plan-2026-11-04`, rules Q-4, Q-6, Q-9, Q-15, and
 * the review fix plan S-6 and S-9).
 *
 * Two modes, chosen by the caller (owner decision S-9):
 * - `full`: the fixed rule text (`snippets/sacred-text-policy.md`) in the
 *   system prompt and the quotes the scene may show, verbatim, in the user
 *   prompt — for a lesson with quotes, or an Arabic / Islamic-studies subject;
 * - `short`: one line only (`snippets/sacred-text-short-line.md`), "never
 *   invent a verse or hadith", for every other run.
 * Absent → every prompt renders byte-identically to before the rule.
 */
import { loadSnippet } from './prompts/loader.js';

/** One protected quote, exactly as the approved source prints it. */
export interface SacredQuotePromptEntry {
  kind: 'quran' | 'hadith';
  /** The exact span; a verse includes its ﴿ ﴾. */
  text: string;
  reference?: string | null;
  /** The Content Unit the quote belongs to. */
  contentUnitId?: string;
}

export interface SacredTextPromptContext {
  quotes: readonly SacredQuotePromptEntry[];
  /** S-9: `short` renders only the one-line rule; the default is `full`. */
  mode?: 'full' | 'short';
}

const NONE =
  '(none for this part: quote no Quran verse and no hadith here) / (لا شيء لهذا الجزء: لا تقتبس آية ولا حديثًا هنا)';

/** S-6: a quote whose book prints no reference must not get an invented one. */
const NO_REFERENCE =
  '(no reference in the book: write none and never invent one / لا مرجع له في الكتاب: لا تكتب مرجعًا ولا تخترعه)';

function describe(quote: SacredQuotePromptEntry): string {
  const label = quote.kind === 'quran' ? 'Quran / آية' : 'Hadith / حديث';
  const reference = quote.reference?.trim() ? quote.reference.trim() : NO_REFERENCE;
  return `- ${label}: ${quote.text.trim()} — ${reference}`;
}

/**
 * Template variables for the policy. `citedUnitIds` limits the list to the
 * quotes of the units a scene cites; `null` lists every quote (the outline).
 */
export function sacredTextVars(
  context: SacredTextPromptContext | undefined,
  citedUnitIds: readonly string[] | null,
): Record<string, unknown> {
  if (!context) return {};
  if (context.mode === 'short') return { hasSacredTextShortLine: true };
  const cited = citedUnitIds ? new Set(citedUnitIds.map(String)) : null;
  // A quote without a unit (a source with no units) is offered to every scene.
  const quotes = context.quotes.filter(
    (quote) =>
      !cited || quote.contentUnitId === undefined || cited.has(String(quote.contentUnitId)),
  );
  return {
    hasSacredTextPolicy: true,
    sacredQuotesText: quotes.length > 0 ? quotes.map(describe).join('\n') : NONE,
  };
}

/**
 * The same policy for a prompt built outside the template engine (the PBL
 * planner, S-6): the system preamble and the user-prompt quote list, or empty
 * strings without a context. Each non-empty value carries its own separator.
 */
export function sacredTextPromptBlocks(
  context: SacredTextPromptContext | undefined,
  citedUnitIds: readonly string[] | null,
): { system: string; user: string } {
  const vars = sacredTextVars(context, citedUnitIds);
  if (vars.hasSacredTextShortLine) {
    return { system: `${loadSnippet('sacred-text-short-line')}\n\n`, user: '' };
  }
  if (!vars.hasSacredTextPolicy) return { system: '', user: '' };
  return {
    system: `${loadSnippet('sacred-text-policy')}\n\n`,
    user: `\n\n## Protected quotes (copy exactly, never explain) / النصوص المحمية (تُنقل حرفيًا ولا تُشرح)\n\n${String(vars.sacredQuotesText)}`,
  };
}
