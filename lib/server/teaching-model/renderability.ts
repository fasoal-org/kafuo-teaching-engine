/**
 * Student-visible renderability (Kafuo R1 plan §7.3, review finding F3).
 *
 * The FRD names "empty or unrenderable output" as a fallback trigger and
 * forbids quality comparison. So this check is deliberately narrow and
 * deterministic: it says whether text can be SHOWN at all — not whether it
 * is a good answer. Two failure classes:
 *
 *  1. nothing to render: only whitespace, markup (HTML tags, markdown
 *     scaffolding, code fences), punctuation — no letter or digit survives;
 *  2. wrong-script garbage: a meaningful share of the characters are
 *     replacement (U+FFFD), private-use, unassigned or control characters,
 *     which is what a mis-decoded or corrupted stream looks like.
 *
 * Short, weak or off-target answers pass. Structured output is checked by
 * the caller's own `validate` through `checkStructuredOutput`.
 */

/**
 * Characters that mean "this is not text" when they appear in volume:
 * replacement, private-use, unassigned, and control characters other than
 * tab/newline/carriage return.
 */
const GARBAGE_RE = /[�\p{Co}\p{Cn}\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/gu;
/** Ratio of garbage characters above which the text is treated as corrupted. */
const GARBAGE_SHARE = 0.02;

const MARKUP_RE = /<\/?[a-zA-Z][^>]*>|```[\s\S]*?```|`+|[#*_~>|\-=+\\[\]()]+/g;

export interface RenderabilityVerdict {
  renderable: boolean;
  reason: 'ok' | 'empty' | 'markup_only' | 'garbage';
}

export function checkTextRenderability(text: string): RenderabilityVerdict {
  const trimmed = text.trim();
  if (!trimmed) return { renderable: false, reason: 'empty' };

  const garbage = trimmed.match(GARBAGE_RE)?.length ?? 0;
  if (garbage / trimmed.length > GARBAGE_SHARE) return { renderable: false, reason: 'garbage' };

  // Strip markup, then require at least one letter or digit in any script.
  const stripped = trimmed.replace(MARKUP_RE, '');
  if (!/[\p{L}\p{N}]/u.test(stripped)) return { renderable: false, reason: 'markup_only' };

  return { renderable: true, reason: 'ok' };
}

export function isRenderableText(text: string): boolean {
  return checkTextRenderability(text).renderable;
}

export type StructuredCheck =
  | { ok: true; parsed: unknown }
  | { ok: false; reason: 'empty' | 'invalid'; error: string };

/**
 * Structured output: the caller's `validate(text)` returns the parsed value
 * or throws when the text is unusable (unparsable, schema-invalid). Any throw
 * is `unusable_output` for the executor — a bad model answer, never a crash.
 */
export function checkStructuredOutput(
  text: string,
  validate: (text: string) => unknown,
): StructuredCheck {
  if (!text.trim()) return { ok: false, reason: 'empty', error: 'empty output' };
  try {
    return { ok: true, parsed: validate(text) };
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
