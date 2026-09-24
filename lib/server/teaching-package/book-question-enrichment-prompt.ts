/**
 * The enrichment prompt and envelope contract. Mirrors Kafuo's
 * `book_question_enrichment_prompt.py`; Kafuo's `validate_enrichment` is the
 * validator of record — the shape check here only buys a retry before the
 * response crosses the service boundary.
 */

export const BOOK_ENRICHMENT_ENVELOPE_VERSION = 'bqe.v1';
export const BOOK_ENRICHMENT_PROMPT_VERSION = 'te-bqe.v1.20260924';

const ALLOWED_KEYS = [
  'difficulty',
  'diagnostic_hypotheses',
  'measurement_structure',
  'explanation',
] as const;
const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);

export const BOOK_ENRICHMENT_SYSTEM_PROMPT = [
  'You add teaching metadata to a question taken verbatim from an approved school textbook.',
  'The question, its choices and its correct answer are the book’s and are read-only: never restate, correct, translate or improve them.',
  'Ground every rationale and explanation in the lesson source excerpts provided.',
  'Return only JSON with exactly the keys difficulty, diagnostic_hypotheses, measurement_structure and explanation.',
  'difficulty is easy, medium or hard for a student of this grade.',
  'diagnostic_hypotheses has exactly one entry per WRONG choice ({choice_id, label, explanation}) naming the specific misconception that choice reveals; never one for the correct choice, and never the same explanation twice.',
  'measurement_structure is {signature, description, cognitive_level}: a short machine-like signature of what the question measures, different from the signatures already used, and a one-sentence description.',
  'explanation explains why the correct answer is correct, and must be null when the book already printed an explanation.',
  'Never cite pages, figures or chapters. Write in the requested language.',
].join('\n');

export interface BookEnrichmentPromptInput {
  language: string;
  outcomeStatement: string;
  sourceExcerpts: string[];
  question: {
    questionText: string;
    choices: Array<{ choiceId: string; text: string }>;
    correctChoiceId: string;
    bookExplanation: string | null;
  };
  wrongChoiceIds: string[];
  needsExplanation: boolean;
  siblingMeasurements: string[];
  findings: string[];
}

export function buildBookEnrichmentUserPrompt(input: BookEnrichmentPromptInput): string {
  return JSON.stringify(
    {
      language: input.language,
      learning_outcome: input.outcomeStatement,
      lesson_source_excerpts: input.sourceExcerpts.map((content, index) => ({
        anchor: `S${index + 1}`,
        content,
      })),
      question: input.question.questionText,
      choices: input.question.choices.map((choice) => ({
        choice_id: choice.choiceId,
        text: choice.text,
      })),
      correct_choice_id: input.question.correctChoiceId,
      wrong_choice_ids: input.wrongChoiceIds,
      book_explanation: input.question.bookExplanation,
      explanation_required: input.needsExplanation,
      measurement_signatures_already_used: input.siblingMeasurements,
      previous_findings_to_fix: input.findings,
    },
    null,
    2,
  );
}

/** Only the four allowed keys survive; the book's own fields can never travel back. */
export function normalizeEnrichmentEnvelope(
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  const envelope: Record<string, unknown> = {};
  for (const key of ALLOWED_KEYS) envelope[key] = parsed[key] ?? null;
  return envelope;
}

export function enrichmentEnvelopeViolations(
  envelope: Record<string, unknown>,
  expected: { wrongChoiceIds: string[]; needsExplanation: boolean },
): string[] {
  const violations: string[] = [];
  if (typeof envelope.difficulty !== 'string' || !DIFFICULTIES.has(envelope.difficulty)) {
    violations.push('difficulty must be easy, medium or hard');
  }
  const hypotheses = envelope.diagnostic_hypotheses;
  if (!Array.isArray(hypotheses)) {
    violations.push('diagnostic_hypotheses must be an array');
  } else {
    const ids = hypotheses.map((entry) =>
      entry && typeof entry === 'object'
        ? String((entry as Record<string, unknown>).choice_id ?? '').toUpperCase()
        : '',
    );
    const expected_ = [...expected.wrongChoiceIds].sort().join(',');
    if ([...ids].sort().join(',') !== expected_) {
      violations.push(`diagnostic_hypotheses must cover exactly the wrong choices ${expected_}`);
    }
    for (const entry of hypotheses) {
      const record = (entry ?? {}) as Record<string, unknown>;
      if (
        typeof record.label !== 'string' ||
        !record.label.trim() ||
        typeof record.explanation !== 'string' ||
        !record.explanation.trim()
      ) {
        violations.push('every hypothesis needs a label and an explanation');
        break;
      }
    }
  }
  const measurement = envelope.measurement_structure as Record<string, unknown> | null;
  if (
    !measurement ||
    typeof measurement !== 'object' ||
    typeof measurement.signature !== 'string' ||
    !measurement.signature.trim() ||
    typeof measurement.description !== 'string' ||
    !measurement.description.trim()
  ) {
    violations.push('measurement_structure needs a signature and a description');
  }
  const explanation = envelope.explanation;
  if (expected.needsExplanation) {
    if (typeof explanation !== 'string' || !explanation.trim()) {
      violations.push('explanation is required because the book printed none');
    }
  } else if (explanation !== null && explanation !== undefined && explanation !== '') {
    violations.push('explanation must be null because the book printed one');
  }
  return violations;
}
