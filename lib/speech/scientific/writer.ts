/**
 * Output builder shared by every verbaliser. Words are joined by single
 * spaces; a pause (`،`) or colon glues to the word before it; a prefix such as
 * `لـ` or `و` glues to the word after it. Alongside the text it records the
 * *semantic tokens* each reading emits (numbers, letters, operators, units,
 * elements …), which the mode-parity property compares (plan §9.2, FR-019).
 */
import type { RenderWarningCode } from './warnings';
import type { PolicyDomain, PolicyPack, PolicyReading, PolicyRole } from './policy';

type Part = { text: string; kind: 'word' | 'pause' | 'colon' | 'prefix' | 'suffix'; operator?: boolean };

export interface WriterOptions {
  /**
   * Natural mode: a pause is an audible scope boundary (O-6: «سين زائد واحد،
   * الكل تربيع»). In accessible mode pauses are everywhere, so only an end word
   * («نهاية المقام», «إغلاق القوس») closes a scope.
   */
  pauseClosesScope?: boolean;
  /**
   * Accessible mode (upgrade plan P4 item 9): a construct that ended silently
   * gets its end word («نهاية الكسر») when more words follow, and an operator
   * word ends a one-word exponent or index.
   */
  speakScopeEnds?: boolean;
  /**
   * Natural mode (upgrade plan P5, O-6): a construct that ended silently is
   * closed by a short pause when more words follow («كاف باء، تي»,
   * «سين أُس نون، زائد واحد», «سالب، سين تربيع»).
   */
  pauseEndsScope?: boolean;
}

interface PendingScope {
  kind: string;
  /** The construct's end word, resolved only when it must be spoken. */
  close?: () => string;
}

/** Constructs whose silent end an operator word makes audible (accessible mode). */
const SCRIPT_SCOPES: ReadonlySet<string> = new Set(['pow', 'sub']);

export class Writer {
  private readonly parts: Part[] = [];
  readonly semantic: string[] = [];
  /**
   * Scope trace (upgrade plan P0): constructs that ended without an audible
   * end. If another word follows before a boundary, the listener cannot tell
   * where the construct stopped (`\frac{1}{2}x` heard as 1/(2x)).
   */
  private pendingScopes: PendingScope[] = [];
  /** Constructs that ended silently and were followed by more words. */
  readonly scopeViolations: string[] = [];

  constructor(private readonly options: WriterOptions = {}) {}

  private flushScopes(): void {
    if (this.pendingScopes.length === 0) return;
    const pending = this.pendingScopes;
    this.pendingScopes = [];
    if (this.options.speakScopeEnds) {
      // The outermost construct's end also ends every construct inside it.
      const close = pending[pending.length - 1]!.close?.() ?? '';
      if (close.trim()) {
        this.pause();
        this.parts.push({ text: close.trim(), kind: 'word' });
        this.pause();
        return;
      }
    }
    if (this.options.pauseEndsScope && this.parts.length > 0) {
      this.pause();
      return;
    }
    this.scopeViolations.push(...pending.map((scope) => scope.kind));
  }

  word(text: string): this {
    const trimmed = text.trim();
    if (trimmed) {
      this.flushScopes();
      this.parts.push({ text: trimmed, kind: 'word' });
    }
    return this;
  }

  /**
   * A word that itself marks where the enclosing structure ends or its next
   * part starts («ومقامه», «نهاية الأس», «إغلاق القوس», a relation): it closes
   * every pending scope audibly.
   */
  boundary(text: string): this {
    const trimmed = text.trim();
    if (trimmed) {
      this.pendingScopes = [];
      this.parts.push({ text: trimmed, kind: 'word' });
    }
    return this;
  }

  /** Appends another writer's words and semantic tokens (a nested reading). */
  append(other: Writer): this {
    for (const part of other.parts) {
      if (part.kind === 'word') this.word(part.text);
      else if (part.kind === 'pause') this.pause();
      else if (part.kind === 'prefix') this.prefix(part.text);
      else if (part.kind === 'suffix') this.suffix(part.text);
      else this.colon();
    }
    this.semantic.push(...other.semantic);
    return this;
  }

  /** Opens a traced construct (ordered parity token only). */
  beginScope(kind: string): this {
    this.semantic.push(`<${kind}`);
    return this;
  }

  /**
   * Ends a traced construct. `closed` says whether its spoken form already
   * ends audibly (an end word, or a single dictionary word such as «نصف»);
   * `close` is its end word, spoken later only if more words follow.
   */
  endScope(kind: string, closed: boolean, close?: () => string): this {
    this.semantic.push(`${kind}>`);
    if (closed) this.pendingScopes = [];
    else this.pendingScopes.push({ kind, ...(close ? { close } : {}) });
    return this;
  }

  /**
   * An operator word (`+`, `×`, `÷` …). In accessible mode it ends a one-word
   * exponent or index («مرفوعة للقوة اثنين زائد …»); a silent fraction still
   * needs its end word.
   */
  operator(text: string): this {
    if (this.options.speakScopeEnds) {
      this.pendingScopes = this.pendingScopes.filter((scope) => !SCRIPT_SCOPES.has(scope.kind));
    }
    this.word(text);
    const last = this.parts[this.parts.length - 1];
    if (last && text.trim()) last.operator = true;
    return this;
  }

  /** Was the last thing written an operator word (`+`, `×` …)? */
  get afterOperator(): boolean {
    return this.parts[this.parts.length - 1]?.operator === true;
  }

  /**
   * The next item must be a pause: the word just written (a sign) may apply to
   * the first symbol only or to the whole construct that follows (`-x²`).
   */
  markAmbiguousStart(kind: string): this {
    this.pendingScopes.push({ kind: `${kind}-start` });
    return this;
  }

  /** A short pause (`،`), dropped at the start and never doubled. */
  pause(): this {
    const last = this.parts[this.parts.length - 1];
    if (last && last.kind !== 'pause' && last.kind !== 'colon' && last.kind !== 'prefix') {
      this.parts.push({ text: '،', kind: 'pause' });
    }
    if (this.options.pauseClosesScope && last) this.pendingScopes = [];
    return this;
  }

  colon(): this {
    const last = this.parts[this.parts.length - 1];
    if (last && (last.kind === 'word' || last.kind === 'suffix')) this.parts.push({ text: ':', kind: 'colon' });
    return this;
  }

  /** A clitic glued to the following word (`لـ`, `و`). */
  prefix(text: string): this {
    if (text) {
      this.flushScopes();
      this.parts.push({ text, kind: 'prefix' });
    }
    return this;
  }

  /**
   * A literal closing symbol glued to the word before it (`)`, `|`). Used only
   * by the missing-entry literal forms, e.g. «√ (x + 1)».
   */
  suffix(text: string): this {
    const last = this.parts[this.parts.length - 1];
    if (!text) return this;
    // A closing symbol ends the literal group it belongs to.
    this.pendingScopes = [];
    if (last && (last.kind === 'word' || last.kind === 'suffix')) this.parts.push({ text, kind: 'suffix' });
    else this.parts.push({ text, kind: 'word' });
    return this;
  }

  sem(kind: string, value = ''): this {
    this.semantic.push(value ? `${kind}:${value}` : kind);
    return this;
  }

  get isEmpty(): boolean {
    return !this.parts.some((part) => part.kind === 'word');
  }

  toString(): string {
    // Trailing pauses/colons/prefixes carry nothing at the end of an expression.
    const parts = [...this.parts];
    while (
      parts.length > 0 &&
      parts[parts.length - 1]!.kind !== 'word' &&
      parts[parts.length - 1]!.kind !== 'suffix'
    ) {
      parts.pop();
    }
    let out = '';
    let glueNext = true;
    for (const part of parts) {
      if (part.kind === 'pause' || part.kind === 'colon' || part.kind === 'suffix') {
        out += part.text;
        glueNext = false;
        continue;
      }
      if (!glueNext) out += ' ';
      out += part.text;
      glueNext = part.kind === 'prefix';
    }
    return out;
  }
}

/** What a verbaliser needs from its caller: the policy, the mode, the subject and a warning sink. */
export interface VerbaliseContext {
  policy: PolicyPack;
  mode: 'natural' | 'accessible';
  /** The lesson subject: the resolution domain (upgrade plan P2). */
  domain: PolicyDomain;
  /** Records a warning against the current expression. */
  warn(code: RenderWarningCode, detail?: string): void;
  /** Counts proposed (unapproved) entries consulted. */
  noteProposed(): void;
}

/**
 * The role-aware reading of `token` (upgrade plan P2): resolved by role and
 * lesson subject, or `null` when no usable entry exists — in which case
 * `SATTS_W_MISSING_DICTIONARY_ENTRY` is recorded (plan §14.1).
 */
export function speakOrNull(
  ctx: VerbaliseContext,
  role: PolicyRole,
  token: string,
  reading: PolicyReading = 'spoken',
): string | null {
  const found = ctx.policy.resolve({ role, token, domain: ctx.domain }, ctx.mode, reading);
  if (!found) {
    ctx.warn('SATTS_W_MISSING_DICTIONARY_ENTRY', `${role}:${token}`);
    return null;
  }
  if (found.proposed) ctx.noteProposed();
  return found.text;
}

/**
 * Like {@link speakOrNull}, with the literal form spoken when the entry is
 * unusable: the symbol itself, so a missing entry never drops content (FR-030).
 */
export function speak(
  ctx: VerbaliseContext,
  role: PolicyRole,
  token: string,
  fallback: string,
  reading: PolicyReading = 'spoken',
): string {
  return speakOrNull(ctx, role, token, reading) ?? fallback;
}

/** Operator glyphs are `operator`s; named structural words are `label`s. */
function labelRole(key: string): PolicyRole {
  // Any single glyph (`+`, `·`, `∈`, `∠` …) is an operator; words are labels.
  return /^[^\p{L}\p{N}]$/u.test(key) ? 'operator' : 'label';
}

/**
 * A structural label or operator word, or `null` when no usable entry exists
 * — in which case `SATTS_W_MISSING_DICTIONARY_ENTRY` is recorded. A usable
 * entry may legitimately be empty in one mode (accessible-only labels).
 * Callers whose label carries content (an operator, a script, a fraction, a
 * root, an arrow, a charge …) must then speak a literal form instead, so a
 * missing entry never silently drops content (FR-030). Chemistry labels are
 * resolved in the CHEMISTRY domain by the same key.
 */
export function labelOrNull(ctx: VerbaliseContext, key: string): string | null {
  return speakOrNull(ctx, labelRole(key), key);
}

/**
 * Like {@link labelOrNull} for structural labels that may legitimately be
 * empty in one mode. `fallback` is the literal form spoken when the entry is
 * unusable: the symbol for a content-bearing label, `''` only for a pure
 * decoration (`power-end`, `numerator`, `root-end` …).
 */
export function label(ctx: VerbaliseContext, key: string, fallback = ''): string {
  return labelOrNull(ctx, key) ?? fallback;
}
