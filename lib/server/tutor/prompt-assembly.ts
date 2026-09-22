/**
 * Prompt assembly under the enforced input budget (Kafuo R1 FRD BR-03,
 * BUD-01/02, EFF-02, CTX-03/05; plan §8.1, §8.7; contracts §8).
 *
 * Fixed block order, each block its own system message so the stable head
 * can hit provider prefix caches:
 *
 *   1. rules            `tutor-rules@r1` (byte-stable across turns)
 *   2. academic         subject names, curriculum, grade, academic language
 *   3. grounding        lesson title + Content Units (stable order, no ids);
 *                       Help: scene title/text + Scene units; `insufficient`
 *                       note when evidence was required but is unavailable
 *   4. summary          `context_summary` when compaction produced one
 *   5. history          reduced turns, oldest → newest (user / assistant)
 *   6. turn note        response-language line + safety directive when
 *                       triggered (volatile, so it sits after the stable head)
 *   7. newest message   the student's current message (user)
 *
 * No ids, no timestamps, no tenant/student/unit keys reach the model.
 *
 * Budget: the request is re-counted with EVERY counter of the subject pair
 * and must fit each target's own effective cap (`tighterCapForPolicy`, so a
 * fallback never fails the executor assertion). The reduction ladder (§8.7),
 * each step re-counted, in order:
 *
 *   0. unit_char_cap              units over UNIT_CHAR_CAP are trimmed first
 *   1. drop_oldest_turns          down to HISTORY_FLOOR_TURNS most recent
 *   2. clip_older_tutor_messages  tutor turns older than the 3 most recent → 600 chars
 *   3. drop_summary
 *   4. trim_grounding             least relevant unit first (never adds units)
 *   5. drop_grounding             → groundingMode 'insufficient'
 *   6. drop_recent_turns          the remaining history, oldest first
 *   7. REQUEST_TOO_LARGE          rules + academic + message alone exceed the cap
 *
 * Titles and compaction come through the same entry with `capTokens`, so
 * they are budgeted and shaped identically (plan §8.1 Revision 4).
 */
import type { ModelMessage } from 'ai';

import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import type { CounterKind } from '@/lib/server/teaching-model/subject-policy';
import type { GroundingMode } from '@/lib/persistence/tutor-runtime';
import type { Script } from '@/lib/server/tutor/arabic-text';
import {
  countExactTokens,
  effectiveCap,
  FRAMING,
  HARD_CAP,
  seedProxyRatio,
  tighterCapForPolicy,
  UNIT_CHAR_CAP,
} from '@/lib/server/tutor/token-budget';
import {
  HELP_SCOPE_TEXT,
  INSUFFICIENT_GROUNDING_TEXT,
  PARTIAL_SCENE_COVERAGE_TEXT,
  SAFETY_DIRECTIVE_TEXT,
  TUTOR_RULES_TEXT,
} from '@/lib/server/tutor/tutor-rules';

export const HISTORY_FLOOR_TURNS = 6;
export const UNCLIPPED_RECENT_TURNS = 3;
export const TUTOR_CLIP_CHARS = 600;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Labels are nullable: Kafuo forwards nullable DB columns as-is (a subject
 * without an Arabic name, a lesson without a grade label). A null label is
 * rendered as ABSENT — the line or parenthesis is omitted, never "null".
 */
export interface AcademicBlockInput {
  subjectNameAr: string | null;
  subjectNameEn: string | null;
  curriculumName: string | null;
  curriculumVersionLabel: string | null;
  gradeLabel: string | null;
  /** `ar`, `en`, … (Kafuo `academicLanguage`). */
  academicLanguage: string;
}

export interface GroundingUnitInput {
  /** Official unit title; shown as a heading (no id). */
  title: string | null;
  text: string;
  /** Relevance (retrieval score or overlap); the least relevant unit is trimmed first. */
  score?: number | null;
  /** True when the unit was head-cut at a paragraph boundary (Kafuo or here). */
  truncated?: boolean;
}

export type GroundingInput =
  | { mode: 'none' }
  | { mode: 'insufficient' }
  | {
      mode: 'reuse' | 'retrieved';
      lessonTitle?: string | null;
      units: GroundingUnitInput[];
    }
  | {
      mode: 'scene';
      sceneTitle?: string | null;
      /** Visible Scene text (Help); kept while any grounding remains. */
      sceneText?: string | null;
      units: GroundingUnitInput[];
      /**
       * `partial` when the Scene's units were not all sent (selection under
       * UNIT_CHAR_CAP, or a `partial` lineage): the tutor must not claim
       * complete Scene evidence (HLP-04). Absent / `complete` renders nothing.
       */
      coverage?: 'complete' | 'partial';
    };

/** Help quick actions (contracts §5): a soft hint, never a mode switch. */
export type HelpIntentHint = 'explain' | 'simplify' | 'hint' | 'check_answer';

export const HELP_INTENT_HINTS: readonly HelpIntentHint[] = [
  'explain',
  'simplify',
  'hint',
  'check_answer',
];

export function isHelpIntentHint(value: unknown): value is HelpIntentHint {
  return typeof value === 'string' && (HELP_INTENT_HINTS as readonly string[]).includes(value);
}

export interface HistoryTurnInput {
  student: string;
  /** `null` when the turn has no completed tutor reply (it is still context). */
  tutor: string | null;
}

export interface HistoryInput {
  /** `context_summary` covering turns older than `turns`. */
  summary?: string | null;
  /** Oldest → newest; the current student message is NOT part of it. */
  turns: HistoryTurnInput[];
}

export interface AssemblePolicy {
  primary: { counterKind: CounterKind; modelString: string };
  fallback: { counterKind: CounterKind; modelString: string };
}

export interface AssembleCounters {
  /** Calibrated proxy ratio for the pair's proxy model; seed/default when absent. */
  proxyRatio?: number | null;
}

export interface TurnDirectives {
  /** Script of the student's newest message (BR-03 response-language rule). */
  responseScript?: Script | null;
  /** Kafuo/Mobile locale hint: a tie-breaker only, never authoritative. */
  localeHint?: string | null;
  /** The experiment guard triggered on the student message. */
  safetyTriggered?: boolean;
  /** Help quick action (HLP-03): a soft hint about what the student wants. */
  intentHint?: HelpIntentHint | null;
}

export interface AssembleTutorPromptInput {
  /** Defaults to `TUTOR_RULES_TEXT`; titles/compaction pass their own. */
  rules?: string;
  academic: AcademicBlockInput | null;
  grounding: GroundingInput;
  history: HistoryInput;
  message: string;
  policy: AssemblePolicy;
  counters?: AssembleCounters;
  directives?: TurnDirectives;
  /** Help: adds the Scene-scope instruction to the grounding block. */
  helpMode?: boolean;
  /** Tighter cap for bounded calls (title ≤ 300); never above the pair's tighter cap. */
  capTokens?: number;
}

export type ReductionStep =
  | 'unit_char_cap'
  | 'drop_oldest_turns'
  | 'clip_older_tutor_messages'
  | 'drop_summary'
  | 'trim_grounding'
  | 'drop_grounding'
  | 'drop_recent_turns';

export interface AssembledBudget {
  estimate: number;
  counterKind: CounterKind;
  effectiveCap: number;
  hardCap: number;
}

export interface AssembledTutorPrompt {
  messages: ModelMessage[];
  budget: AssembledBudget;
  /** Ladder steps that changed the request, in the order they were applied. */
  reductions: ReductionStep[];
  groundingMode: GroundingMode;
  /** What was actually sent: units in their kept order (never more than given). */
  grounding: { units: GroundingUnitInput[]; totalChars: number; truncated: boolean };
  history: { turnsIncluded: number; turnsDropped: number; summaryIncluded: boolean };
}

// ---------------------------------------------------------------------------
// Block rendering (no ids anywhere)
// ---------------------------------------------------------------------------

function languageName(tag: string): string {
  const base = tag.toLowerCase().split(/[-_]/)[0];
  if (base === 'ar') return 'Arabic (العربية)';
  if (base === 'en') return 'English';
  if (base === 'fr') return 'French';
  return tag;
}

function present(value: string | null | undefined): string | null {
  return value && value.trim() ? value.trim() : null;
}

export function renderAcademicBlock(academic: AcademicBlockInput): string {
  const lines = ['## Academic context / السياق الأكاديمي'];
  const names = [present(academic.subjectNameAr), present(academic.subjectNameEn)].filter(
    (name): name is string => name !== null,
  );
  if (names.length) lines.push(`Subject / المادة: ${names.join(' — ')}`);
  const curriculum = present(academic.curriculumName);
  const version = present(academic.curriculumVersionLabel);
  if (curriculum || version) {
    lines.push(
      `Curriculum / المنهج: ${curriculum ?? ''}${curriculum && version ? ' ' : ''}${version ? `(${version})` : ''}`.trimEnd(),
    );
  }
  const grade = present(academic.gradeLabel);
  if (grade) lines.push(`Grade / الصف: ${grade}`);
  lines.push(
    `Academic language / اللغة الأكاديمية: ${languageName(academic.academicLanguage)}`,
    'Language policy: official terminology and curriculum facts follow the academic language; reply in the language the student writes in unless asked otherwise.',
  );
  return lines.join('\n');
}

function renderUnit(unit: GroundingUnitInput): string {
  const heading = unit.title && unit.title.trim() ? `### ${unit.title.trim()}` : '### —';
  const note = unit.truncated
    ? '\n(excerpt — the unit was cut at a paragraph boundary / مقتطف)'
    : '';
  return `${heading}\n${unit.text.trim()}${note}`;
}

export function renderGroundingBlock(
  grounding: GroundingInput,
  units: GroundingUnitInput[],
  helpMode: boolean,
): string | null {
  if (grounding.mode === 'none') return null;
  if (grounding.mode === 'insufficient') {
    return helpMode
      ? `${HELP_SCOPE_TEXT}\n\n${INSUFFICIENT_GROUNDING_TEXT}`
      : INSUFFICIENT_GROUNDING_TEXT;
  }
  const lines: string[] = [];
  if (helpMode || grounding.mode === 'scene') lines.push(HELP_SCOPE_TEXT, '');
  lines.push('## Curriculum grounding / نصوص المنهج');
  if (grounding.mode === 'scene') {
    if (grounding.sceneTitle) lines.push(`Scene / المشهد: ${grounding.sceneTitle}`);
    if (grounding.sceneText && grounding.sceneText.trim()) {
      lines.push('### Visible scene text / نص المشهد', grounding.sceneText.trim());
    }
  } else if (grounding.lessonTitle) {
    lines.push(`Lesson / الدرس: ${grounding.lessonTitle}`);
  }
  if (units.length === 0 && grounding.mode !== 'scene') return INSUFFICIENT_GROUNDING_TEXT;
  lines.push(
    'The following approved curriculum units are the only source of lesson facts for this turn.',
  );
  if (grounding.mode === 'scene' && grounding.coverage === 'partial') {
    lines.push(PARTIAL_SCENE_COVERAGE_TEXT);
  }
  for (const unit of units) lines.push('', renderUnit(unit));
  return lines.join('\n');
}

const INTENT_HINT_LINES: Record<HelpIntentHint, string> = {
  explain: 'Quick action (soft hint, the message itself decides): the student asked to EXPLAIN.',
  simplify:
    'Quick action (soft hint, the message itself decides): the student asked for a SIMPLER explanation — simpler wording, same academic facts.',
  hint: 'Quick action (soft hint, the message itself decides): the student asked for a HINT ONLY — do not reveal the full solution.',
  check_answer:
    'Quick action (soft hint, the message itself decides): the student asked to CHECK THEIR ANSWER — evaluate it honestly; never "correct" a correct answer.',
};

function renderSummaryBlock(summary: string): string {
  return `## Earlier in this conversation / ما سبق في المحادثة\n${summary.trim()}`;
}

export function responseLanguageLine(directives: TurnDirectives | undefined): string | null {
  const script = directives?.responseScript ?? null;
  const hint = directives?.localeHint ?? null;
  if (script === 'ar') return 'The student is writing in Arabic: reply in Arabic.';
  if (script === 'en') return 'The student is writing in English: reply in English.';
  if (script === 'mixed') {
    return 'The student mixes Arabic and English: reply in the dominant language of the message and keep official terms in the academic language.';
  }
  if (hint)
    return `The student's message has no clear script: reply in ${languageName(hint)} (the app locale), unless the conversation shows otherwise.`;
  return "The student's message has no clear script: reply in the academic language.";
}

function renderTurnNote(directives: TurnDirectives | undefined): string | null {
  const lines: string[] = [];
  const language = responseLanguageLine(directives);
  if (language) lines.push(language);
  if (directives?.intentHint) lines.push(INTENT_HINT_LINES[directives.intentHint]);
  if (directives?.safetyTriggered) lines.push(SAFETY_DIRECTIVE_TEXT);
  return lines.length ? lines.join('\n\n') : null;
}

// ---------------------------------------------------------------------------
// Budget over the pair (memoised per message text)
// ---------------------------------------------------------------------------

interface PairBudget {
  fits: boolean;
  estimate: number;
  counterKind: CounterKind;
  effectiveCap: number;
}

function createPairCounter(
  policy: AssemblePolicy,
  counters: AssembleCounters | undefined,
  capOverride: number | undefined,
) {
  const memo = new Map<string, number>();
  const perMessage = (text: string): number => {
    if (!text) return 0;
    let count = memo.get(text);
    if (count === undefined) {
      count =
        countExactTokens([{ role: 'user', content: text }]) - FRAMING.perMessage - FRAMING.fixed;
      memo.set(text, count);
    }
    return count;
  };
  const targets = [policy.primary, policy.fallback];
  const tighter = tighterCapForPolicy(policy);
  const cap = capOverride === undefined ? tighter : Math.min(capOverride, tighter);
  return (messages: ModelMessage[]): PairBudget => {
    let exact = FRAMING.fixed + FRAMING.perMessage * messages.length;
    for (const message of messages) {
      exact += perMessage(typeof message.content === 'string' ? message.content : '');
    }
    let fits = true;
    let binding: { estimate: number; counterKind: CounterKind; margin: number } | null = null;
    const seen = new Set<CounterKind>();
    for (const target of targets) {
      if (seen.has(target.counterKind)) continue;
      seen.add(target.counterKind);
      const estimate =
        target.counterKind === 'exact'
          ? exact
          : Math.ceil(exact * (counters?.proxyRatio ?? seedProxyRatio(target.modelString)));
      const targetCap = Math.min(effectiveCap(target.counterKind), cap);
      if (estimate > targetCap) fits = false;
      const margin = targetCap - estimate;
      if (!binding || margin < binding.margin) {
        binding = { estimate, counterKind: target.counterKind, margin };
      }
    }
    return {
      fits,
      estimate: binding!.estimate,
      counterKind: binding!.counterKind,
      effectiveCap: cap,
    };
  };
}

// ---------------------------------------------------------------------------
// Unit selection helpers (trim only — never add)
// ---------------------------------------------------------------------------

function leastRelevantIndex(units: readonly GroundingUnitInput[]): number {
  let index = units.length - 1;
  let best = Number.POSITIVE_INFINITY;
  const scored = units.some((unit) => typeof unit.score === 'number');
  if (!scored) return index;
  for (let i = 0; i < units.length; i += 1) {
    const score = typeof units[i]!.score === 'number' ? (units[i]!.score as number) : -Infinity;
    if (score <= best) {
      best = score;
      index = i;
    }
  }
  return index;
}

/** Head-cut a single oversized unit at the last paragraph boundary under the cap. */
export function headCutUnit(unit: GroundingUnitInput, maxChars: number): GroundingUnitInput {
  if (unit.text.length <= maxChars) return unit;
  const head = unit.text.slice(0, maxChars);
  const boundary = head.lastIndexOf('\n\n');
  const cut = boundary > maxChars * 0.4 ? head.slice(0, boundary) : head;
  return { ...unit, text: cut.trimEnd(), truncated: true };
}

/** Enforce UNIT_CHAR_CAP by dropping the least relevant units, then head-cutting a lone giant. */
export function capUnitChars(
  units: readonly GroundingUnitInput[],
  maxChars: number = UNIT_CHAR_CAP,
): { units: GroundingUnitInput[]; changed: boolean } {
  let kept = units.map((unit) => ({ ...unit }));
  let changed = false;
  const total = () => kept.reduce((sum, unit) => sum + unit.text.length, 0);
  while (kept.length > 1 && total() > maxChars) {
    kept.splice(leastRelevantIndex(kept), 1);
    changed = true;
  }
  if (kept.length === 1 && kept[0]!.text.length > maxChars) {
    kept = [headCutUnit(kept[0]!, maxChars)];
    changed = true;
  }
  return { units: kept, changed };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function unitsOf(grounding: GroundingInput): GroundingUnitInput[] {
  return grounding.mode === 'none' || grounding.mode === 'insufficient' ? [] : grounding.units;
}

export function assembleTutorPrompt(input: AssembleTutorPromptInput): AssembledTutorPrompt {
  const rules = input.rules ?? TUTOR_RULES_TEXT;
  const helpMode = input.helpMode === true;
  const budgetOf = createPairCounter(input.policy, input.counters, input.capTokens);
  const reductions: ReductionStep[] = [];
  const record = (step: ReductionStep) => {
    if (reductions[reductions.length - 1] !== step) reductions.push(step);
  };

  // Working state
  let groundingMode: GroundingMode = input.grounding.mode;
  const groundingGiven = unitsOf(input.grounding).length > 0 || input.grounding.mode === 'scene';
  const capped = capUnitChars(unitsOf(input.grounding));
  if (capped.changed) record('unit_char_cap');
  let units = capped.units;
  const turns = input.history.turns.map((turn) => ({ ...turn }));
  let summary = input.history.summary?.trim() ? input.history.summary.trim() : null;
  const totalTurns = turns.length;

  const academicBlock = input.academic ? renderAcademicBlock(input.academic) : null;
  const turnNote = renderTurnNote(input.directives);

  const build = (): ModelMessage[] => {
    const messages: ModelMessage[] = [{ role: 'system', content: rules }];
    if (academicBlock) messages.push({ role: 'system', content: academicBlock });
    const groundingInput: GroundingInput =
      groundingMode === 'insufficient'
        ? { mode: 'insufficient' }
        : groundingMode === 'none'
          ? { mode: 'none' }
          : input.grounding;
    const groundingBlock = renderGroundingBlock(groundingInput, units, helpMode);
    if (groundingBlock) messages.push({ role: 'system', content: groundingBlock });
    if (summary) messages.push({ role: 'system', content: renderSummaryBlock(summary) });
    for (const turn of turns) {
      messages.push({ role: 'user', content: turn.student });
      if (turn.tutor !== null && turn.tutor !== '') {
        messages.push({ role: 'assistant', content: turn.tutor });
      }
    }
    if (turnNote) messages.push({ role: 'system', content: turnNote });
    messages.push({ role: 'user', content: input.message });
    return messages;
  };

  let messages = build();
  let budget = budgetOf(messages);
  const refresh = () => {
    messages = build();
    budget = budgetOf(messages);
    return budget.fits;
  };

  if (!budget.fits) {
    // 1. drop the oldest whole turns down to the recent floor
    while (!budget.fits && turns.length > HISTORY_FLOOR_TURNS) {
      turns.shift();
      record('drop_oldest_turns');
      refresh();
    }
    // 2. clip tutor messages older than the three most recent turns
    if (!budget.fits && turns.length > UNCLIPPED_RECENT_TURNS) {
      let clipped = false;
      for (let i = 0; i < turns.length - UNCLIPPED_RECENT_TURNS; i += 1) {
        const tutor = turns[i]!.tutor;
        if (tutor !== null && tutor.length > TUTOR_CLIP_CHARS) {
          turns[i]!.tutor = `${tutor.slice(0, TUTOR_CLIP_CHARS).trimEnd()} …`;
          clipped = true;
        }
      }
      if (clipped) {
        record('clip_older_tutor_messages');
        refresh();
      }
    }
    // 3. drop the summary
    if (!budget.fits && summary) {
      summary = null;
      record('drop_summary');
      refresh();
    }
    // 4. trim grounding from the least relevant end (never adds)
    while (!budget.fits && units.length > 1) {
      units.splice(leastRelevantIndex(units), 1);
      record('trim_grounding');
      refresh();
    }
    // 5. drop grounding entirely → insufficient
    if (
      !budget.fits &&
      groundingGiven &&
      groundingMode !== 'insufficient' &&
      groundingMode !== 'none'
    ) {
      units = [];
      groundingMode = 'insufficient';
      record('drop_grounding');
      refresh();
    }
    // 6. the remaining history, oldest first
    while (!budget.fits && turns.length > 0) {
      turns.shift();
      record('drop_recent_turns');
      refresh();
    }
    // 7. refuse
    if (!budget.fits) {
      throw new TeachingPackageError(
        'REQUEST_TOO_LARGE',
        `the rules, academic context and the student message alone exceed the input budget (${budget.estimate} ${budget.counterKind} tokens > ${budget.effectiveCap})`,
        {
          estimate: budget.estimate,
          counterKind: budget.counterKind,
          effectiveCap: budget.effectiveCap,
        },
      );
    }
  }

  const totalChars = units.reduce((sum, unit) => sum + unit.text.length, 0);
  return {
    messages,
    budget: {
      estimate: budget.estimate,
      counterKind: budget.counterKind,
      effectiveCap: budget.effectiveCap,
      hardCap: HARD_CAP,
    },
    reductions,
    groundingMode,
    grounding: {
      units,
      totalChars,
      truncated: units.some((unit) => unit.truncated === true),
    },
    history: {
      turnsIncluded: turns.length,
      turnsDropped: totalTurns - turns.length,
      summaryIncluded: summary !== null,
    },
  };
}

/** Kafuo `GroundingUnit` / snapshot unit → assembler unit (drops every id). */
export function toGroundingUnitInput(unit: {
  unitTitle?: string | null;
  title?: string | null;
  text: string;
  score?: number | null;
  truncated?: boolean;
}): GroundingUnitInput {
  return {
    title: unit.unitTitle ?? unit.title ?? null,
    text: unit.text,
    ...(typeof unit.score === 'number' ? { score: unit.score } : {}),
    ...(unit.truncated ? { truncated: true } : {}),
  };
}
