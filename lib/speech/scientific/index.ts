/**
 * Scientific Speech Renderer (plan §9): a pure, deterministic transform from
 * the authored narration to provider-bound prepared text, for Arabic
 * Mathematics, Physics and Chemistry lessons.
 *
 * - No I/O, no clock, no randomness, no model: the same input and policy pack
 *   always give byte-identical output (FR-006).
 * - The general path (`subjectCode === null`) is the identity (FR-004).
 * - Prose outside expressions is copied verbatim; only a single space may be
 *   inserted where an expression meets adjacent text (FR-007).
 * - Every expression failure is contained: that expression is read literally
 *   with a warning, never omitted (FR-030); a non-empty narration never yields
 *   empty prepared text without a blocking error (FR-009).
 * - The input is never mutated; the prepared text is recomputed, never stored
 *   (plan §8.5).
 */
import {
  MAX_EXPRESSIONS_PER_ACTION,
  MAX_EXPRESSION_PREPARED_CHARS,
  MAX_EXPRESSION_SOURCE_CHARS,
  MAX_ORIGINAL_CHARS,
  MAX_PREPARED_CHARS,
  expansionAllowance,
} from './bounds';
import type { ScientificSubjectCode, SpeechContext } from './context';
import { detectExpressions, type ExpressionCandidate } from './detect';
import { literalReading } from './literal';
import { parseMath, ParseFault, type MathParseOptions } from './math/parse';
import { verbaliseMath } from './math/verbalise-ar';
import { normaliseInput, stripBidiControls } from './normalise';
import { physicsHooks, renderPhysics } from './physics/grammar';
import { matchUnit } from './physics/units';
import { writeUnit } from './physics/verbalise-ar';
import { chemistryHooks, renderChemistry } from './chemistry/grammar';
import { loadPolicyPack, type PolicyPack } from './policy';
import type { FallbackReason, RenderedSpan, SpeechRenderResult } from './result';
import { reviewGuards } from './review-guards';
import { makeWarning, type RenderWarning, type RenderWarningCode } from './warnings';
import type { VerbaliseContext, Writer } from './writer';
import type { DetectHooks } from './detect';

export type { SpeechContext, ScientificSubjectCode } from './context';
export type { FallbackReason, RenderedSpan, SpeechRenderResult } from './result';
export type { RenderWarning, RenderWarningCode } from './warnings';
export { loadPolicyPack } from './policy';

/** What a subject grammar supplies to the renderer. */
export interface SubjectGrammar {
  hooks: DetectHooks;
  /** Renders one expression; throws {@link ParseFault} on anything it cannot read. */
  render(
    source: string,
    candidate: ExpressionCandidate,
    ctx: VerbaliseContext,
  ): { writer: Writer; maxDepth: number; tokens: number };
}

function mathGrammar(options: MathParseOptions): SubjectGrammar['render'] {
  return (source, candidate, ctx) => {
    // P6 item 4: a number with a unit is a quantity in Mathematics too (O-7 evidence rule).
    const parsed = parseMath(source, {
      ...options,
      leadingBinary: candidate.leadingBinary === true,
      matchUnit,
      onAmbiguousUnit: (unit) => ctx.warn('SATTS_W_AMBIGUOUS_UNIT', unit),
    });
    const writer = verbaliseMath(parsed.node, { ...ctx, writeUnit: (unit, w) => writeUnit(ctx, unit, w) });
    return { writer, maxDepth: parsed.maxDepth, tokens: parsed.tokens.length };
  };
}

const GRAMMARS: Readonly<Partial<Record<ScientificSubjectCode, SubjectGrammar>>> = {
  MATH: { hooks: physicsHooks, render: mathGrammar({ arabicLetters: true }) },
  PHYSICS: {
    hooks: physicsHooks,
    render: (source, candidate, ctx) =>
      renderPhysics(source, ctx, { arabicLetters: true, leadingBinary: candidate.leadingBinary === true }),
  },
  CHEMISTRY: {
    hooks: chemistryHooks,
    render: renderChemistry,
  },
};

interface RenderedExpression {
  text: string;
  fallback: boolean;
  fallbackReason?: FallbackReason;
  atomic: boolean;
  maxDepth: number;
  tokens: number;
}

function generalResult(original: string, warnings: RenderWarning[] = [], path: 'general' | 'scientific' = 'general', policyVersion: string | null = null): SpeechRenderResult {
  return {
    preparedText: original,
    spans: [
      {
        kind: 'prose',
        source: { start: 0, end: original.length },
        prepared: { start: 0, end: original.length },
        atomic: false,
        fallback: false,
      },
    ],
    warnings,
    blocking: null,
    stats: {
      originalChars: original.length,
      preparedChars: original.length,
      expressions: 0,
      expressionsFallback: 0,
      fallbackReasons: noFallbacks(),
      maxDepth: 0,
      elapsedTokens: 0,
      proposedEntriesUsed: 0,
    },
    policyVersion,
    path,
  };
}

function noFallbacks(): Record<FallbackReason, number> {
  return { notation: 0, policy: 0, bound: 0, fault: 0 };
}

function reasonFor(code: RenderWarningCode | null): FallbackReason {
  if (code === 'SATTS_W_BOUND_EXCEEDED') return 'bound';
  if (code === 'SATTS_W_RENDERER_FAULT') return 'fault';
  return 'notation';
}

const NO_SPACE_BEFORE = new Set(['.', ',', '،', '؛', '؟', '!', ':', ')', ']', '»', '"', "'", '\n']);
const NO_SPACE_AFTER = new Set(['(', '[', '«', '"', "'", '\n', 'ـ']);

function isWhitespace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

export function renderScientificSpeech(
  input: { context: SpeechContext },
  policy: PolicyPack = loadPolicyPack(input.context.language),
): SpeechRenderResult {
  const { context } = input;
  const original = context.originalText;
  const subject = context.subjectCode;
  const grammar = subject ? GRAMMARS[subject] : undefined;
  if (!subject || !grammar) return generalResult(original);

  if (original.length > MAX_ORIGINAL_CHARS) {
    return generalResult(
      original,
      [makeWarning('SATTS_W_BOUND_EXCEEDED', 0, original.length, 'action length')],
      'scientific',
      policy.policyVersion,
    );
  }

  const warnings: RenderWarning[] = [];
  let proposedEntriesUsed = 0;
  let candidates = detectExpressions(original, subject, grammar.hooks);
  if (candidates.length > MAX_EXPRESSIONS_PER_ACTION) {
    const first = candidates[MAX_EXPRESSIONS_PER_ACTION]!;
    warnings.push(makeWarning('SATTS_W_BOUND_EXCEEDED', first.start, original.length, 'expression count'));
    candidates = candidates.slice(0, MAX_EXPRESSIONS_PER_ACTION);
  }

  const renderOne = (candidate: ExpressionCandidate): RenderedExpression => {
    const local: RenderWarning[] = [];
    const warn = (code: RenderWarningCode, detail?: string) =>
      local.push(makeWarning(code, candidate.start, candidate.end, detail));
    const ctx: VerbaliseContext = {
      policy,
      mode: context.readingMode,
      // Resolution domain (upgrade plan P2): the lesson subject.
      domain: subject,
      warn,
      noteProposed: () => {
        proposedEntriesUsed += 1;
      },
    };
    const inner = original.slice(candidate.innerStart, candidate.innerEnd);
    // `$10^{-3}$ kg`: a unit just outside the delimiters belongs to the value (P6 item 3).
    const withUnit = candidate.unitSuffix
      ? `${inner} ${original.slice(candidate.unitSuffix.start, candidate.unitSuffix.end)}`
      : inner;
    const source = stripBidiControls(normaliseInput(withUnit));

    const literal = (code: RenderWarningCode | null, detail?: string): RenderedExpression => {
      local.length = 0;
      if (code) warn(code, detail);
      // Arabic-letter variables are read by name in Mathematics and Physics only.
      const writer = literalReading(source, ctx, { arabicLetters: subject !== 'CHEMISTRY' });
      const text = writer.toString();
      return {
        text,
        fallback: true,
        fallbackReason: reasonFor(code),
        atomic: text.length <= MAX_EXPRESSION_PREPARED_CHARS,
        maxDepth: 0,
        tokens: 0,
      };
    };

    let rendered: RenderedExpression;
    if (candidate.kind === 'ce' && subject !== 'CHEMISTRY') {
      // `\ce{}`/`\pu{}` outside a Chemistry lesson: an unsupported command.
      rendered = literal('SATTS_W_UNSUPPORTED_NOTATION', 'chemistry command outside Chemistry');
    } else if (source.length > MAX_EXPRESSION_SOURCE_CHARS) {
      rendered = literal('SATTS_W_BOUND_EXCEEDED', 'expression length');
    } else {
      try {
        const out = grammar.render(source, candidate, ctx);
        const text = out.writer.toString();
        rendered =
          text.length > expansionAllowance(source.length, context.readingMode)
            ? literal('SATTS_W_BOUND_EXCEEDED', 'expansion')
            : local.some((w) => w.code === 'SATTS_W_MISSING_DICTIONARY_ENTRY')
              ? // Parsed, but a wording was unusable and spoken literally.
                { text, fallback: true, fallbackReason: 'policy', atomic: true, maxDepth: out.maxDepth, tokens: out.tokens }
              : { text, fallback: false, atomic: true, maxDepth: out.maxDepth, tokens: out.tokens };
      } catch (error) {
        if (error instanceof ParseFault) {
          const code: RenderWarningCode =
            error.kind === 'unsupported'
              ? 'SATTS_W_UNSUPPORTED_NOTATION'
              : error.kind === 'unknown-command'
                ? 'SATTS_W_UNKNOWN_COMMAND'
                : error.kind === 'unknown-element'
                  ? 'SATTS_W_UNKNOWN_ELEMENT'
                : error.kind === 'bound'
                  ? 'SATTS_W_BOUND_EXCEEDED'
                  : 'SATTS_W_MALFORMED_EXPRESSION';
          rendered = literal(code, error.detail);
        } else {
          rendered = literal('SATTS_W_RENDERER_FAULT', error instanceof Error ? error.name : 'fault');
        }
      }
    }
    if (!rendered.atomic) warn('SATTS_W_BOUND_EXCEEDED', 'prepared expression length');
    // An expression that reads as nothing keeps its source: never silently omitted.
    if (!rendered.text.trim()) {
      rendered = { ...rendered, text: source.trim(), fallback: true, fallbackReason: rendered.fallbackReason ?? 'notation' };
    }
    // Constructs the audit found misread without a warning (upgrade plan P0 item 5).
    for (const id of reviewGuards(source, subject, candidate)) warn('SATTS_W_UNVERIFIED_READING', id);
    warnings.push(...local);
    return rendered;
  };

  let prepared = '';
  const spans: RenderedSpan[] = [];
  let cursor = 0;
  let maxDepth = 0;
  let tokens = 0;
  let fallbacks = 0;
  const fallbackReasons = noFallbacks();

  const pushProse = (start: number, end: number) => {
    if (end <= start) return;
    const from = prepared.length;
    prepared += original.slice(start, end);
    spans.push({
      kind: 'prose',
      source: { start, end },
      prepared: { start: from, end: prepared.length },
      atomic: false,
      fallback: false,
    });
  };

  for (const candidate of candidates) {
    pushProse(cursor, candidate.start);
    const rendered = renderOne(candidate);
    if (rendered.fallback) {
      fallbacks += 1;
      fallbackReasons[rendered.fallbackReason ?? 'notation'] += 1;
    }
    maxDepth = Math.max(maxDepth, rendered.maxDepth);
    tokens += rendered.tokens;
    const from = prepared.length;
    const before = prepared[prepared.length - 1];
    let text = rendered.text;
    if (prepared.length > 0 && !isWhitespace(before) && !NO_SPACE_AFTER.has(before!)) text = ` ${text}`;
    const after = original[candidate.end];
    if (after !== undefined && !isWhitespace(after) && !NO_SPACE_BEFORE.has(after)) text = `${text} `;
    prepared += text;
    spans.push({
      kind: 'expression',
      subject,
      source: { start: candidate.start, end: candidate.end },
      prepared: { start: from, end: prepared.length },
      atomic: rendered.atomic,
      fallback: rendered.fallback,
      ...(rendered.fallback ? { fallbackReason: rendered.fallbackReason ?? 'notation' } : {}),
    });
    cursor = candidate.end;
  }
  pushProse(cursor, original.length);
  if (spans.length === 0) {
    spans.push({
      kind: 'prose',
      source: { start: 0, end: 0 },
      prepared: { start: 0, end: 0 },
      atomic: false,
      fallback: false,
    });
  }

  if (prepared.length > MAX_PREPARED_CHARS) {
    warnings.push(makeWarning('SATTS_W_BOUND_EXCEEDED', 0, original.length, 'prepared length'));
  }
  if (proposedEntriesUsed > 0) {
    warnings.push(
      makeWarning('SATTS_W_UNPROMOTED_POLICY_ENTRY', 0, original.length, `entries:${proposedEntriesUsed}`),
    );
  }
  const blocking =
    original.trim() !== '' && prepared.trim() === ''
      ? { code: 'SATTS_E_EMPTY_RESULT' as const, message: 'prepared text is empty for a non-empty narration' }
      : null;

  return {
    preparedText: prepared,
    spans,
    warnings,
    blocking,
    stats: {
      originalChars: original.length,
      preparedChars: prepared.length,
      expressions: candidates.length,
      expressionsFallback: fallbacks,
      fallbackReasons,
      maxDepth,
      elapsedTokens: tokens,
      proposedEntriesUsed,
    },
    policyVersion: policy.policyVersion,
    path: 'scientific',
  };
}
