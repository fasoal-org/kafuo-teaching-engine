/**
 * Table reading direction — one rule every renderer applies to a `table` element.
 *
 * A table normally follows the direction of the page it sits on, so in a
 * right-to-left lesson its first column is presented on the right. A table whose
 * header row is written entirely in Latin letters, digits and mathematical
 * symbols — a logic truth table (`p | q | p ∧ q`), a formula table — is read the
 * way the textbook prints it: left to right, first column on the left (teacher
 * feedback on the Saudi grade-10 logic lessons, owner decision 23 Nov 2026).
 * A header with any Arabic text, or any other script, keeps the page direction.
 *
 * Pure and dependency-free; takes `unknown` so a server can test stored JSON.
 */

/**
 * Characters a Latin/symbol header may contain besides ASCII letters and digits:
 * whitespace, ASCII punctuation, math symbols (∼ ¬ ∧ ∨ → ↔ ⇒ ⇔ − × ≤ …), Greek
 * letters, primes, the degree sign, the middle dot and the ellipsis.
 */
const SYMBOL_CHARS = /^[\s\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E\p{Sm}\p{Script=Greek}′″‴°·…]$/u;
const ASCII_LETTER_OR_DIGIT = /^[A-Za-z0-9]$/;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** A cell's visible text: tags removed, common entities decoded, trimmed. */
export function tableCellPlainText(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, body: string) => {
      if (body[0] === '#') {
        const code =
          body[1] === 'x' || body[1] === 'X'
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : entity;
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
    })
    .trim();
}

/**
 * Whether a text is made only of Latin letters, digits, spaces and math/logic
 * symbols (∼ ~ ¬ ∧ ∨ → ↔ ⇒ ⇔ ( ) , = + − …), with at least one letter, digit or
 * symbol. Arabic letters and Arabic-Indic digits are never part of it.
 */
export function isLatinSymbolText(text: string): boolean {
  let meaningful = false;
  for (const char of text) {
    if (ASCII_LETTER_OR_DIGIT.test(char)) {
      meaningful = true;
      continue;
    }
    if (!SYMBOL_CHARS.test(char)) return false;
    if (!/\s/.test(char)) meaningful = true;
  }
  return meaningful;
}

function spanOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 1;
}

/**
 * Whether a table's header row (`data[0]`) is entirely Latin/math-symbol text, so
 * the table renders left to right on any page. Every visible header cell must be
 * non-empty Latin/symbol text; cells a merge covers (a `colspan`/`rowspan` of 0,
 * or as many empty cells as the header's colspans span) are skipped. An empty,
 * missing or malformed header is never Latin.
 */
export function isLatinSymbolHeaderTable(data: unknown): boolean {
  if (!Array.isArray(data)) return false;
  const header: unknown = data[0];
  if (!Array.isArray(header) || header.length === 0) return false;
  let covered = 0;
  let empty = 0;
  let latin = 0;
  for (const cell of header) {
    if (!cell || typeof cell !== 'object') {
      empty += 1;
      continue;
    }
    const record = cell as { text?: unknown; colspan?: unknown; rowspan?: unknown };
    const colspan = spanOf(record.colspan);
    const rowspan = spanOf(record.rowspan);
    // The model's own merge convention keeps covered cells with a span of 0.
    if (colspan <= 0 || rowspan <= 0) continue;
    if (colspan > 1) covered += Math.floor(colspan) - 1;
    const text = tableCellPlainText(record.text);
    if (!text) {
      empty += 1;
      continue;
    }
    if (!isLatinSymbolText(text)) return false;
    latin += 1;
  }
  return latin > 0 && empty <= covered;
}

/** A logic connective: negation, and, or, implication, equivalence. */
const LOGIC_CONNECTIVE = /[∼~¬∧∨→↔⇒⇔]/u;

/**
 * Whether a table is a logic truth table: a Latin/symbol header
 * (`isLatinSymbolHeaderTable`) with a logic connective in at least one header cell
 * (`p | q | ∼p ∨ q`). This is the table the renderers draw left to right; a
 * physics or data table (`t (s) | v (m/s)`, `2020 | 2021`) keeps the page direction.
 */
export function isTruthTableHeader(data: unknown): boolean {
  if (!isLatinSymbolHeaderTable(data)) return false;
  const header = (data as unknown[])[0] as unknown[];
  return header.some(
    (cell) =>
      !!cell &&
      typeof cell === 'object' &&
      LOGIC_CONNECTIVE.test(tableCellPlainText((cell as { text?: unknown }).text)),
  );
}
