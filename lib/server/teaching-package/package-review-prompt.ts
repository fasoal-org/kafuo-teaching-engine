/**
 * The package reviewer's prompt, output schema and validator
 * (ai-reviewer-layer plan §4.2, §4.3, D-4, D-9).
 *
 * Order, for prompt caching: the fixed instructions + checklist (system), then
 * the book units (a cache-marked stable block), then the slides. A re-review
 * (Phase 3) sends the same system and book block and only the changed slides
 * with their neighbours.
 *
 * The validator is the authority: an answer that does not parse, names an
 * unknown check, or targets a slide that was not sent is `unusable_output`,
 * which the executor answers with the fallback route.
 */
import type {
  ReviewBookUnit,
  ReviewSlide,
} from '@/lib/server/teaching-package/package-review-input';

export const PACKAGE_REVIEW_PROMPT_VERSION = 'package-review-v1';

/**
 * g5.v10 (learner-first plan W5, owner D-2.9): the rubric version of a g5.v10 package's
 * review. Every other package keeps `package-review-v1`, byte for byte (D-9 B).
 */
export const PACKAGE_REVIEW_PROMPT_VERSION_V2 = 'package-review-v2';

export const SLIDE_CHECKS = ['S1', 'S2', 'S3', 'S4', 'S5'] as const;
/**
 * g5.v10 only: the weak-student checks no book comparison can see. S6 (screen and
 * narration agree, every item shown is explained) is auto-fixable; S7 (attempt before
 * solution, claim before counterexample, one reading per symbol, no image-appearance
 * narration) is the teacher's.
 */
export const LEARNER_FIRST_SLIDE_CHECKS = ['S6', 'S7'] as const;
/**
 * A deterministic finding the server itself states (21 Nov 2026): a scene kept with a
 * generation issue (a placeholder, no narration, missing audio, …) is a must-fix finding
 * named `G1`, so the fix loop regenerates that slide once. Never part of the reviewer's
 * rubric: the model never answers it, and the fix loop decides it from the live scene.
 */
export const GENERATION_ISSUE_CHECK = 'G1' as const;
/**
 * A second deterministic server finding (21 Nov 2026, D2): the book prints Latin labels on
 * a slide's cited units and the canvas wrote them in Arabic letters
 * (`labelScriptChanged`). Named LABEL_SCRIPT_CHANGED in the finding's text; decided from
 * the live scene after the one regeneration, exactly like G1.
 */
export const LABEL_SCRIPT_CHECK = 'G2' as const;
/** The question checks a package quiz Scene is reviewed with (plan §4.3). */
export const PACKAGE_QUIZ_CHECKS = ['Q1', 'Q2', 'Q5'] as const;
export type PackageReviewCheck =
  | (typeof SLIDE_CHECKS)[number]
  | (typeof LEARNER_FIRST_SLIDE_CHECKS)[number]
  | (typeof PACKAGE_QUIZ_CHECKS)[number]
  | typeof GENERATION_ISSUE_CHECK
  | typeof LABEL_SCRIPT_CHECK;
/** The `package-review-v1` codes (every package but g5.v10). */
export const PACKAGE_REVIEW_CHECKS: readonly PackageReviewCheck[] = [
  ...SLIDE_CHECKS,
  ...PACKAGE_QUIZ_CHECKS,
];
/** The `package-review-v2` codes (g5.v10). */
export const PACKAGE_REVIEW_CHECKS_V2: readonly PackageReviewCheck[] = [
  ...SLIDE_CHECKS,
  ...LEARNER_FIRST_SLIDE_CHECKS,
  ...PACKAGE_QUIZ_CHECKS,
];
export type FindingSeverity = 'high' | 'medium' | 'low';

export interface ReviewerFinding {
  /** The Scene id; `''` only for an S5 finding about a part missing from the whole package. */
  targetId: string;
  check: PackageReviewCheck;
  severity: FindingSeverity;
  bookEvidence: { quote: string; unitId: string | null };
  whatIsWrong: string;
  fixNote: string;
}

export interface ReviewerAnswer {
  summary: string;
  findings: ReviewerFinding[];
}

const TEXT_MAX = 2_000;
const QUOTE_MAX = 1_200;
const SUMMARY_MAX = 3_000;
const FINDINGS_MAX = 80;

const PACKAGE_REVIEW_INSTRUCTIONS = `You are the senior subject reviewer of a Saudi school lesson ("Teaching Package") that was generated from a textbook. You read the book text the lesson was built from and check every slide and every in-lesson quiz against a fixed checklist. You only report real errors; you never report taste or style preferences that the checklist does not name.

CHECKLIST (use exactly these codes)
- S1: The slide and its narration match the book. Nothing is added that the book does not say, and nothing contradicts it.
- S2: Every calculation and worked example is right. Re-solve each one yourself, step by step, before you judge it.
- S3: The numbers, values and givens are the book's (not changed, not invented).
- S4: The Arabic is clear and in the agreed Saudi spoken teaching style, with no English leftovers, no internal labels or ids, and no placeholder text.
- S5: Every lesson part of the book is present, in book order. Report a part that is missing or out of order.
- Q1 (quiz slides): solve the question yourself. The marked answer is right, and no other option is also right.
- Q2 (quiz slides): the question is clear and has one reading.
- Q5 (quiz slides): the explanation is correct.

RULES
- Quote the book for every finding (book_evidence.quote: the exact words, at most two sentences; book_evidence.unit_id: the unit id, or "" when the book is one block). If the book says nothing about it, quote the closest relevant words and say so.
- what_is_wrong: one or two sentences in Arabic for the teacher: what is wrong and what the book says.
- fix_note: one instruction in Arabic that a slide writer can follow to fix exactly this error (for S2, include the correct working and the correct result). It must not ask to add, remove or move slides.
- severity: high = a student would learn something false or a wrong answer is marked right; medium = misleading or unclear; low = a small language or style slip.
- target_id: the slide id exactly as given. For S5 about a part missing from the whole lesson, use "".
- Never report the same error twice. A slide with no error gets no finding.
- summary: one short paragraph in Arabic for the teacher: what you checked, how many errors, and the most important one. If there are no errors, say so plainly.
- Answer with JSON only, matching the schema.`;

/** The JSON schema sent as native structured output (Anthropic) and enforced by `validate`. */
export const PACKAGE_REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings'],
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['target_id', 'check', 'severity', 'book_evidence', 'what_is_wrong', 'fix_note'],
        properties: {
          target_id: { type: 'string' },
          check: { type: 'string', enum: [...PACKAGE_REVIEW_CHECKS] },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          book_evidence: {
            type: 'object',
            additionalProperties: false,
            required: ['quote', 'unit_id'],
            properties: { quote: { type: 'string' }, unit_id: { type: 'string' } },
          },
          what_is_wrong: { type: 'string' },
          fix_note: { type: 'string' },
        },
      },
    },
  },
};

/**
 * The schema, verbatim, at the end of the fixed instructions. Only Anthropic
 * receives it as native structured output (`execute.ts`); GPT-6 Sol answers in
 * text mode, so it must read the exact key names here (review finding H-1).
 */
export function schemaInstruction(schema: Record<string, unknown>): string {
  return `OUTPUT: exactly one JSON object that matches this JSON schema, with these exact key names. No markdown, no code fence, no text before or after it.\n${JSON.stringify(schema)}`;
}

export const PACKAGE_REVIEW_SYSTEM = `${PACKAGE_REVIEW_INSTRUCTIONS}\n\n${schemaInstruction(PACKAGE_REVIEW_SCHEMA)}`;

// ── g5.v10: package-review-v2 (learner-first plan W5) ─────────────────────────────────

const V1_S5_LINE =
  '- S5: Every lesson part of the book is present, in book order. Report a part that is missing or out of order.';
const V1_Q1_LINE =
  '- Q1 (quiz slides): solve the question yourself. The marked answer is right, and no other option is also right.';
const V1_FIX_NOTE_LINE =
  '- fix_note: one instruction in Arabic that a slide writer can follow to fix exactly this error (for S2, include the correct working and the correct result). It must not ask to add, remove or move slides.';

/** The v1 rubric with the weak-student checks (owner decisions D-2, D-3, D-5, 15 Nov 2026). */
function learnerFirstInstructions(): string {
  if (
    !PACKAGE_REVIEW_INSTRUCTIONS.includes(V1_S5_LINE) ||
    !PACKAGE_REVIEW_INSTRUCTIONS.includes(V1_Q1_LINE) ||
    !PACKAGE_REVIEW_INSTRUCTIONS.includes(V1_FIX_NOTE_LINE)
  ) {
    throw new Error('package-review-v1 no longer holds the lines package-review-v2 extends');
  }
  return PACKAGE_REVIEW_INSTRUCTIONS.replace(
    V1_S5_LINE,
    [
      "- S5: Every lesson part of the book is present, in book order. Report a part that is missing or out of order. The lesson deliberately teaches only a selection of the book's exercises (about six, easiest first) and leaves out the opening boxes «فيما سبق», «والآن» and «المفردات»: never report those as missing.",
      '- S6: The narration agrees with what the slide shows and explains EVERY item the slide shows (أ، ب، ج …). Report a narration that skips an item, or that says something the screen contradicts (a different direction, name, shape or number).',
      '- S7: The slide serves a weak student: a claim is stated before it is tested or a counterexample is given; Latin letters are read by their English names in Arabic script and the same symbol is read the same way; an image is explained as mathematics, never by its colours or position on the page; a check or exercise is attempted by the learner before its solution is shown; a drawing respects its givens (segments or angles given as equal are drawn equal).',
      // g5.v10 quality plan W1 (15 Nov 2026): item 208's review called one checked case a proof.
      '- (S2 also covers a conjecture called true, «التخمين صحيح», because one example satisfies it: examples support a conjecture, they never prove it.)',
    ].join('\n'),
  )
    .replace(V1_Q1_LINE, `${V1_Q1_LINE}\n- (S6 and S7 apply to slides only.)`)
    .replace(
      V1_FIX_NOTE_LINE,
      [
        // W1: item 208's fix notes dropped the month wrap (f6) and prescribed average change (f15).
        V2_FIX_NOTE_LINE,
        '- PICTURES AND DRAWINGS lists what a slide shows besides its text: a book picture by its id (you cannot see its content), a chart with its values, drawn segments with their lengths, arrows and text-free shapes. Never report a listed picture, chart or drawing as missing, and never ask to remove the narration about a listed picture.',
      ].join('\n'),
    );
}

const V2_FIX_NOTE_LINE =
  '- fix_note: one instruction in Arabic that a slide writer can follow to fix exactly this error (for S2, include the correct working and the correct result, keeping EVERY step of it, such as the wrap round a cycle or each subtraction). Use only the methods the book or this lesson teaches; never an average change or any other method the lesson did not teach. Write its numbers in the digits the slide already uses. It must not ask to add, remove or move slides.';
const V1_S2_LINE =
  '- S2: Every calculation and worked example is right. Re-solve each one yourself, step by step, before you judge it.';

/**
 * g5.v11 (teacher-guide answer referee plan §8.6, owner 16 Nov 2026): the v2 rubric, with
 * S2 and Q1 changed from "re-solve" to "compare with the guide answer; flag only" for an
 * item whose slide carries a «إجابة دليل المعلم» line, and fix notes that state only the
 * correct final answer, never a method. Every other item keeps the v2 checks.
 */
function guideAnswerInstructions(): string {
  const v2 = learnerFirstInstructions();
  if (!v2.includes(V1_S2_LINE) || !v2.includes(V1_Q1_LINE) || !v2.includes(V2_FIX_NOTE_LINE)) {
    throw new Error('package-review-v2 no longer holds the lines the g5.v11 rubric changes');
  }
  return v2
    .replace(
      V1_S2_LINE,
      "- S2: Every calculation and worked example is right. For an item whose slide gives a «إجابة دليل المعلم» line, do not re-solve it: compare the final answer the slide reaches with that guide answer and report only a disagreement; also report a working that does not use the lesson's own method, or that is bent to reach the answer. Every other item: re-solve it yourself, step by step, before you judge it.",
    )
    .replace(
      V1_Q1_LINE,
      '- Q1 (quiz slides): for a question on an item with a «إجابة دليل المعلم» line, do not re-solve it: compare the marked answer with that guide answer and report only a disagreement, or another option that is also right. Every other question: solve it yourself; the marked answer is right, and no other option is also right.',
    )
    .replace(
      V2_FIX_NOTE_LINE,
      [
        "- fix_note: one instruction in Arabic that a slide writer can follow to fix exactly this error. For S2 or Q1 on an item with a «إجابة دليل المعلم» line, state ONLY the correct final answer of that item; never prescribe a method or a working. For any other S2, include the correct working and the correct result, keeping EVERY step of it, such as the wrap round a cycle or each subtraction. Use only the methods the book or this lesson teaches; never an average change or any other method the lesson did not teach. Write its numbers in the digits the slide already uses. Never mention the teacher guide («دليل المعلم») in a fix_note. A fix_note for a check_understanding slide, or for a quiz's question text, never states any answer: the learner reads them before the try. It must not ask to add, remove or move slides.",
        '- «إجابة دليل المعلم (<item>): <answer>» lines are the checked official answers of the items a slide solves or asks, for you only: a learner never sees them. Never report a slide for not showing that line, and ignore a line whose item is not on that slide.',
        // Owner, 17 Nov 2026: the guide's model answers of proofs and open questions.
        "- «الإجابة النموذجية في دليل المعلم (<item>، برهان|إجابة ممكنة): <text>» lines are the teacher guide's model answer of an item a solution slide solves, for you only. For S2 on that item, check the slide's proof or answer against it: report a step, claim or conclusion that contradicts it, or a proof that leaves out a step it needs. A different correct proof, or another correct answer to a «إجابة ممكنة» item, is not an error. Its fix_note gives the correct step or claim in the lesson's own words; it never copies the model answer whole and never mentions the guide.",
        // Owner, 17 Nov 2026: the guide's answer drawings.
        "- «[رسمة الإجابة من دليل المعلم معروضة]» in a solution slide's visuals is the teacher guide's drawing of that item's answer, shown there on purpose, after the try; a «(<item>، رسمة)» line says an item's guide answer is a drawing. Never report a slide for showing or not showing it, never ask to redraw it, and never ask to add, copy or describe it on a check_understanding slide or in a quiz.",
      ].join('\n'),
    );
}

/** The JSON schema of a `package-review-v2` answer: v1's, with the v2 codes. */
export const PACKAGE_REVIEW_SCHEMA_V2: Record<string, unknown> = JSON.parse(
  JSON.stringify(PACKAGE_REVIEW_SCHEMA).replace(
    JSON.stringify([...PACKAGE_REVIEW_CHECKS]),
    JSON.stringify([...PACKAGE_REVIEW_CHECKS_V2]),
  ),
) as Record<string, unknown>;

export const PACKAGE_REVIEW_SYSTEM_V2 = `${learnerFirstInstructions()}\n\n${schemaInstruction(PACKAGE_REVIEW_SCHEMA_V2)}`;

/** g5.v11: the v2 schema and codes, with the guide-answer rubric (`guideAnswerInstructions`). */
export const PACKAGE_REVIEW_SYSTEM_V11 = `${guideAnswerInstructions()}\n\n${schemaInstruction(PACKAGE_REVIEW_SCHEMA_V2)}`;

// ── g5.v12: the reviewer sees the book's own figures (RV-1, 27 Nov 2026) ──────────────

/** The g5.v12 rubric version (its g5.v11 rubric plus the book figures). */
export const PACKAGE_REVIEW_PROMPT_VERSION_V12 = 'package-review-v12';

const V2_PICTURES_LINE =
  '- PICTURES AND DRAWINGS lists what a slide shows besides its text: a book picture by its id (you cannot see its content), a chart with its values, drawn segments with their lengths, arrows and text-free shapes. Never report a listed picture, chart or drawing as missing, and never ask to remove the narration about a listed picture.';

/** The title that opens the book-figure parts of a g5.v12 review (RV-1). */
export const BOOK_FIGURES_HEADING =
  'BOOK FIGURES (pictures cut from the book pages of the units the slides cite; the book, like its text):';

/**
 * Page images (contract 27 Nov 2026): the title that opens a g5.v12 review's images when
 * they include whole book pages.
 */
export const BOOK_PAGES_HEADING =
  'BOOK PAGES (the whole book pages of this lesson or of the units the slides cite, and pictures cut from pages not shown whole; the book, like its text):';

/** RV-1: said under the heading when a figure of the lesson could not be loaded. */
export const BOOK_FIGURES_INCOMPLETE_NOTE =
  'NOTE: some figures of this book could not be loaded; never report a figure as missing or wrong only because it is not shown here.';

/**
 * One book figure's label, right before its picture (RV-1). A whole page (contract
 * 27 Nov 2026) names its page number and the cut pictures it holds, so a slide's src_N
 * maps to it.
 */
export function bookFigureLabel(figure: {
  name: string;
  unitIds: readonly string[];
  pageNumber: number | null;
  kind?: 'page';
  covers?: readonly string[];
}): string {
  if (figure.kind === 'page') {
    return `<<BOOK PAGE ${figure.pageNumber ?? '?'} | unit_id=${figure.unitIds.join(',')} | figures=${
      figure.covers && figure.covers.length > 0 ? figure.covers.join(',') : '-'
    }>>`;
  }
  return `<<BOOK FIGURE ${figure.name} | unit_id=${figure.unitIds.join(',')} | page=${
    figure.pageNumber ?? '?'
  }>>`;
}

/**
 * RV-1 (owner §2, 27 Nov 2026): the g5.v11 rubric, with the book figures of the units the
 * slides cite. The v2 sentence «a book picture by its id (you cannot see its content)» now
 * says the reviewer sees that picture when it is sent, and one rule says how to judge and
 * quote a figure. g5.v11 and every earlier rubric stay byte for byte (pinned by a test).
 */
function bookFigureInstructions(): string {
  const v11 = guideAnswerInstructions();
  if (!v11.includes(V2_PICTURES_LINE)) {
    throw new Error(
      'package-review-v11 no longer holds the picture line package-review-v12 extends',
    );
  }
  return v11.replace(
    V2_PICTURES_LINE,
    [
      '- PICTURES AND DRAWINGS lists what a slide shows besides its text: a book picture by its id (src_N: when a BOOK FIGURE with the same src_N is sent, or a BOOK PAGE whose label lists that src_N, you see that picture there; otherwise you cannot see its content), a chart with its values, drawn segments with their lengths, arrows and text-free shapes. Never report a listed picture, chart or drawing as missing, and never ask to remove the narration about a listed picture.',
      `- BOOK FIGURES: between the book text and the slides, after the line «${BOOK_FIGURES_HEADING}», each picture follows its label <<BOOK FIGURE src_N | unit_id=… | page=…>>. They are the book, exactly like its text: check every value, label, given and drawing that a slide, its narration or a quiz takes from a figure against that figure (S1, S3, S6). For a finding you read from a figure, book_evidence.quote is «[الشكل src_N]» followed by what the figure shows, and book_evidence.unit_id is its unit. A figure sent here and not shown on a slide is not an error by itself. When no figure of a unit is sent, judge that unit from its text alone.`,
      `- BOOK PAGES: instead of the figures, the whole book pages may be sent, after the line «${BOOK_PAGES_HEADING}», each after its label <<BOOK PAGE N | unit_id=… | figures=src_…>> (figures= names the cut pictures that page holds; a picture of a page not sent whole may still follow as a BOOK FIGURE). A page is the book, exactly like its text: check every value, label, given, table and drawing a slide, its narration or a quiz takes from it (S1, S3, S6). For a finding you read from a page, book_evidence.quote is «[الصفحة N]» (N is the number in that page's BOOK PAGE label, never the page number printed on the page) followed by what the page shows (or «[الشكل src_N]» when it is one of the pictures the label lists), and book_evidence.unit_id is its unit. A page may hold more than the slides teach: what a page shows and no slide does is judged as for the book text, never as an error only because the page shows it.`,
    ].join('\n'),
  );
}

/** g5.v12: the v2 schema and codes, with the g5.v11 rubric and the book figures. */
export const PACKAGE_REVIEW_SYSTEM_V12 = `${bookFigureInstructions()}\n\n${schemaInstruction(PACKAGE_REVIEW_SCHEMA_V2)}`;

/**
 * The JSON text of an answer: a model in text mode may still wrap it in a
 * markdown fence; nothing else is repaired.
 */
export function unwrapJsonAnswer(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  return fenced ? fenced[1]!.trim() : trimmed;
}

/**
 * D-8: the one sentence a reviewer reads when it does not see the whole book.
 * Shared by the package and the question review (LOW-6b), so it names no
 * checklist code.
 */
export const BOOK_TRUNCATED_NOTE =
  'NOTE: this book text was cut to fit one review, so part of the book is missing here; never report a lesson part or a fact as missing from the book only because it is not in this text.';

/**
 * The stable, cache-marked block: the book units, once. A cut book (D-8) adds
 * one sentence saying so; an uncut book renders exactly as before.
 */
export function renderBookBlock(
  units: readonly ReviewBookUnit[],
  options: { truncated?: boolean } = {},
): string {
  const lines = ['BOOK TEXT (the authority):'];
  if (options.truncated) lines.push(BOOK_TRUNCATED_NOTE);
  for (const unit of units) {
    const head = [
      `unit_id=${unit.id}`,
      unit.role ? `role=${unit.role}` : null,
      unit.title ? `title=${unit.title}` : null,
    ]
      .filter(Boolean)
      .join(' | ');
    lines.push(`<<UNIT ${head}>>`, unit.text, '<<END UNIT>>');
  }
  return lines.join('\n');
}

function renderSlide(slide: ReviewSlide, learnerFirst: boolean): string {
  const lines = [
    `<<SLIDE id=${slide.id} | order=${slide.order} | type=${slide.sceneType}${
      slide.contentRole ? ` | contentRole=${slide.contentRole}` : ''
    } | cited_units=${slide.citedUnitIds.join(',') || 'none'}>>`,
    `TITLE: ${slide.title}`,
  ];
  if (slide.visibleText) lines.push('VISIBLE TEXT:', slide.visibleText);
  // g5.v10 quality plan W1: the pictures, charts and drawings, described (v2 only).
  if (learnerFirst && slide.visuals?.length) lines.push('PICTURES AND DRAWINGS:', ...slide.visuals);
  for (const [index, question] of (slide.questions ?? []).entries()) {
    lines.push(`QUESTION ${index + 1}: ${question.question}`);
    for (const option of question.options) lines.push(`  (${option.value}) ${option.label}`);
    lines.push(`  MARKED ANSWER: ${question.answer.join(', ') || 'none'}`);
    if (question.explanation) lines.push(`  EXPLANATION: ${question.explanation}`);
  }
  // g5.v11 (teacher-guide plan §8.6): set only on a g5.v11 package's solving slides.
  if (slide.guideAnswers?.length) lines.push(...slide.guideAnswers);
  if (slide.narration) lines.push('NARRATION:', slide.narration);
  lines.push('<<END SLIDE>>');
  return lines.join('\n');
}

/**
 * The variable block. `focusIds` (a re-review) lists the slides to check; the
 * others are context only and must not get findings.
 */
export function renderSlidesBlock(
  slides: readonly ReviewSlide[],
  focusIds?: ReadonlySet<string>,
  options: { learnerFirst?: boolean } = {},
): string {
  const head = focusIds
    ? `RE-REVIEW. Check ONLY these slides: ${[...focusIds].join(', ')}. The other slides are neighbours for context; report nothing about them, and do not use S5.`
    : 'LESSON SLIDES, in order. Check every slide.';
  const learnerFirst = options.learnerFirst === true;
  return [head, ...slides.map((slide) => renderSlide(slide, learnerFirst))].join('\n\n');
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Parse and check one answer. Throws on a malformed answer (→ fallback);
 * drops, never invents, findings outside the reviewed slides.
 */
export function parseReviewerAnswer(
  raw: string,
  scope: {
    slideIds: ReadonlySet<string>;
    quizIds: ReadonlySet<string>;
    focusIds?: ReadonlySet<string>;
    /** g5.v10: `package-review-v2` codes (S6, S7) are accepted. */
    learnerFirst?: boolean;
  },
): ReviewerAnswer {
  const value = JSON.parse(unwrapJsonAnswer(raw)) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('the answer must be a JSON object');
  }
  const summary = text(value.summary, 'summary', SUMMARY_MAX);
  if (!Array.isArray(value.findings)) throw new Error('findings must be an array');
  const findings: ReviewerFinding[] = [];
  const seen = new Set<string>();
  for (const entry of value.findings.slice(0, FINDINGS_MAX) as unknown[]) {
    const f = entry as Record<string, unknown> | null;
    if (!f || typeof f !== 'object') throw new Error('a finding must be an object');
    const check = f.check as PackageReviewCheck;
    const known = scope.learnerFirst ? PACKAGE_REVIEW_CHECKS_V2 : PACKAGE_REVIEW_CHECKS;
    if (!known.includes(check)) throw new Error(`unknown check ${String(f.check)}`);
    const severity = f.severity as FindingSeverity;
    if (severity !== 'high' && severity !== 'medium' && severity !== 'low') {
      throw new Error(`unknown severity ${String(f.severity)}`);
    }
    const targetId = text(f.target_id, 'target_id', 200);
    const evidence = (f.book_evidence ?? {}) as Record<string, unknown>;
    const finding: ReviewerFinding = {
      targetId,
      check,
      severity,
      bookEvidence: {
        quote: text(evidence.quote, 'book_evidence.quote', QUOTE_MAX),
        unitId: text(evidence.unit_id ?? '', 'book_evidence.unit_id', 200) || null,
      },
      whatIsWrong: text(f.what_is_wrong, 'what_is_wrong', TEXT_MAX),
      fixNote: text(f.fix_note, 'fix_note', TEXT_MAX),
    };
    // Scope: a finding on a slide that was not reviewed is dropped, never kept.
    const packageLevelS5 = check === 'S5' && targetId === '' && !scope.focusIds;
    if (!packageLevelS5 && !scope.slideIds.has(targetId)) continue;
    if (scope.focusIds && !scope.focusIds.has(targetId)) continue;
    // A quiz check only on a quiz Scene; a slide check only on a slide Scene.
    const isQuizCheck = (PACKAGE_QUIZ_CHECKS as readonly string[]).includes(check);
    if (targetId && isQuizCheck !== scope.quizIds.has(targetId) && check !== 'S5') continue;
    const key = `${targetId}|${check}|${finding.whatIsWrong}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(finding);
  }
  return { summary, findings };
}
