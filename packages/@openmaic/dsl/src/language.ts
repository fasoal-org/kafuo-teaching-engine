/**
 * Content language and text direction — stage-level presentation metadata.
 *
 * `Stage.language` is the language of instruction as a BCP-47 tag, copied from
 * the authoritative lesson/curriculum metadata of whoever requested the course
 * (never inferred from generated content, and not to be confused with
 * `Stage.languageDirective`, which is free-form prose for the generator).
 * `Stage.textDirection` is the base direction resolved from that tag by
 * {@link resolveTextDirection} — resolved once, at generation, so every
 * consumer (any renderer, in any language) reads one answer instead of
 * re-deriving it, and none of them needs to look at slide text to find out
 * which way a lesson reads.
 *
 * Both fields are optional and additive. Documents written before they existed
 * simply lack them, and absence means "unknown": readers keep whatever
 * behavior they had and must not fabricate a direction. Like the slide
 * semantics fields, the addition changes the meaning of no existing field and
 * does not bump `DSL_VERSION`.
 *
 * Direction is independent of slide semantics (`Slide.type`, `contentRole`,
 * `contentKind`): it applies to every slide alike and is never derived from
 * them, nor they from it.
 *
 * No runtime dependencies. Pure types + pure functions only.
 */

/** Base text direction of a course's content. */
export type TextDirection = 'ltr' | 'rtl';

/** Frozen set of every valid {@link TextDirection}. */
export const TEXT_DIRECTIONS = ['ltr', 'rtl'] as const satisfies readonly TextDirection[];

/** Narrow an unknown value to a valid {@link TextDirection}. */
export function isTextDirection(value: unknown): value is TextDirection {
  return typeof value === 'string' && (TEXT_DIRECTIONS as readonly string[]).includes(value);
}

/**
 * Primary language subtags whose default script is written right-to-left
 * (ISO 639-1/-3): Arabic, Hebrew, Persian, Urdu, Pashto, Sindhi, Uyghur,
 * Yiddish, Divehi, Central Kurdish, Syriac/Aramaic, N'Ko, Kashmiri, Dari and
 * Rohingya, with their three-letter equivalents.
 */
const RTL_LANGUAGES: ReadonlySet<string> = new Set([
  'ar',
  'ara',
  'arc',
  'ckb',
  'dv',
  'div',
  'fa',
  'fas',
  'per',
  'prs',
  'he',
  'heb',
  'iw',
  'ks',
  'nqo',
  'ps',
  'pus',
  'rhg',
  'sd',
  'snd',
  'syr',
  'ug',
  'uig',
  'ur',
  'urd',
  'yi',
  'yid',
]);

/** ISO 15924 script subtags written right-to-left. */
const RTL_SCRIPTS: ReadonlySet<string> = new Set([
  'adlm',
  'arab',
  'aran',
  'hebr',
  'mand',
  'nkoo',
  'rohg',
  'samr',
  'syrc',
  'thaa',
]);

/**
 * Resolve the base text direction of a BCP-47 language tag, deterministically
 * and from the tag alone.
 *
 * An explicit script subtag decides when present (`az-Arab` → rtl, `ku-Latn`,
 * `ar-Latn` → ltr); otherwise the primary language subtag does (`ar`, `ar-SA`,
 * `he`, `fa`, `ur` → rtl; everything else → ltr). Case and `_` separators are
 * tolerated.
 *
 * Returns `undefined` — never a guessed direction — for a value that is not a
 * usable language tag (empty, non-string, or a primary subtag that is not a
 * 2–3 letter language code, e.g. a language *name* like "Arabic").
 */
export function resolveTextDirection(languageTag: unknown): TextDirection | undefined {
  if (typeof languageTag !== 'string') return undefined;
  const subtags = languageTag.trim().toLowerCase().split(/[-_]/);
  const primary = subtags[0] ?? '';
  if (!/^[a-z]{2,3}$/.test(primary)) return undefined;

  // The script subtag, when present, is the 4-letter subtag right after the
  // language (and its optional 3-letter extlangs).
  const script = subtags.slice(1).find((subtag) => /^[a-z]{4}$/.test(subtag));
  if (script !== undefined) return RTL_SCRIPTS.has(script) ? 'rtl' : 'ltr';

  return RTL_LANGUAGES.has(primary) ? 'rtl' : 'ltr';
}
