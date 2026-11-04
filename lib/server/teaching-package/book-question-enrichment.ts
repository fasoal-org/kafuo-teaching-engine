/**
 * Book Question enrichment for an APPROVED Teaching Package version (Kafuo
 * plan "Book Question Enrichment and Automatic Role Suitability", decision D1).
 *
 * A question promoted verbatim from the textbook arrives in Kafuo without the
 * teaching metadata a Guided Teaching slot needs. For a Teaching-Engine-backed
 * lesson, TE adds it — with the same approved package's retained source text and
 * the same subject-routed model it generates that lesson's questions with:
 *
 *   difficulty · one rationale per WRONG choice · measurement structure ·
 *   an explanation, only when the book printed none
 *
 * The book's question, choices and answer are read-only context. The envelope
 * has no field for them, and only the four allowed keys are returned.
 * Stateless: Kafuo validates and persists; nothing is stored here.
 */
import { parseJsonResponse } from '@openmaic/generation';
import type { Queryable } from '@openmaic/storage/document/pg';

import { createLogger } from '@/lib/logger';
import { readRetainedVersionContext, readVersion } from '@/lib/persistence/teaching-package';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  BOOK_ENRICHMENT_ENVELOPE_VERSION,
  BOOK_ENRICHMENT_PROMPT_VERSION,
  bookEnrichmentSystemPrompt,
  buildBookEnrichmentUserPrompt,
  enrichmentEnvelopeViolations,
  normalizeEnrichmentEnvelope,
} from '@/lib/server/teaching-package/book-question-enrichment-prompt';
import {
  detectSacredQuotesByParagraph,
  sacredAddedTextFindings,
  sacredPolicyModeFor,
} from '@/lib/server/teaching-package/sacred-text';
import {
  defaultModelPort,
  selectSourceExcerpts,
  type QuestionModelPort,
} from '@/lib/server/teaching-package/question-generation';
import type { LearningItemRef } from '@/lib/types/teaching-package';

const log = createLogger('TeachingPackageBookQuestionEnrichment');

export interface BookQuestionForEnrichment {
  questionId: string;
  questionText: string;
  choices: Array<{ choiceId: string; text: string }>;
  correctChoiceId: string;
  bookExplanation: string | null;
}

export interface BookQuestionEnrichmentRequest {
  versionId: string;
  tenantId: string;
  learningItem: LearningItemRef;
  requestId: string;
  objectiveRef: string;
  language: string;
  findings: string[];
  siblingMeasurements: string[];
  bookQuestion: BookQuestionForEnrichment;
}

export interface BookQuestionEnrichmentResult {
  requestId: string;
  teachingPackageVersionId: string;
  objectiveRef: string;
  envelopeVersion: string;
  promptVersion: string;
  model: string;
  envelope: Record<string, unknown>;
}

export async function enrichBookQuestion(
  pool: Queryable,
  request: BookQuestionEnrichmentRequest,
  modelPort?: QuestionModelPort,
): Promise<BookQuestionEnrichmentResult> {
  const version = await readVersion(pool, request.versionId, { tenantId: request.tenantId });
  if (
    !version ||
    version.learningItem.type !== request.learningItem.type ||
    version.learningItem.id !== request.learningItem.id
  ) {
    throw new TeachingPackageError(
      'NOT_FOUND',
      `teaching package ${request.versionId} not found for this learning item`,
    );
  }
  if (version.status !== 'approved') {
    throw new TeachingPackageError(
      'TEACHING_PACKAGE_NOT_APPROVED',
      `book question enrichment requires an approved teaching package, not ${version.status}`,
    );
  }
  const context = await readRetainedVersionContext(pool, version.id, {
    tenantId: request.tenantId,
  });
  if (!context || context.sourceText === null) {
    throw new TeachingPackageError(
      'QUESTION_SOURCE_CONTEXT_UNAVAILABLE',
      'this approved version has no retained lesson source context',
    );
  }
  const objective = (context.inputSnapshot.learningObjectives ?? []).find(
    (entry) => entry.objectiveRef === request.objectiveRef,
  );
  if (!objective) {
    throw new TeachingPackageError(
      'OBJECTIVE_NOT_IN_PACKAGE',
      'the learning objective is not one this teaching package was generated for',
    );
  }

  const excerpts = selectSourceExcerpts(
    context.sourceText,
    [objective.snapshot.statement, request.bookQuestion.questionText].join('\n'),
  );
  const wrongChoiceIds = request.bookQuestion.choices
    .map((choice) => choice.choiceId)
    .filter((id) => id !== request.bookQuestion.correctChoiceId);
  const needsExplanation = !(request.bookQuestion.bookExplanation ?? '').trim();

  const port =
    modelPort ??
    (await defaultModelPort({
      pool,
      tenantId: request.tenantId,
      versionId: version.id,
      attemptId: context.attemptId,
      learningItem: version.learningItem,
      questionSetRef: request.requestId,
      subjectCode: context.inputSnapshot.subjectCode,
    }));
  const prompt = buildBookEnrichmentUserPrompt({
    language: request.language,
    outcomeStatement: objective.snapshot.statement,
    sourceExcerpts: excerpts,
    question: request.bookQuestion,
    wrongChoiceIds,
    needsExplanation,
    siblingMeasurements: request.siblingMeasurements,
    findings: request.findings,
  });
  // H-2 (Q-5, Q-12): the book quotes the added texts may show — the lesson
  // source's (per paragraph, N-M2) and the book question's own. The question,
  // choices and book explanation are the book's and read-only, so only the
  // model's own fields are checked (N-M1); whether the item shows a quote, for
  // the explanation rule, comes from the book texts. This path reads no Stage
  // document, so it has no pins to add.
  const bookTexts = [
    request.bookQuestion.questionText,
    ...request.bookQuestion.choices.map((choice) => choice.text),
    ...(request.bookQuestion.bookExplanation ? [request.bookQuestion.bookExplanation] : []),
  ];
  const sacredQuotes = [context.sourceText, ...bookTexts].flatMap(detectSacredQuotesByParagraph);
  const addedSacredFindings = (json: Record<string, unknown>): string[] => {
    const text = (value: unknown) => (typeof value === 'string' ? value : '');
    const hypotheses = Array.isArray(json.diagnostic_hypotheses)
      ? json.diagnostic_hypotheses.filter(
          (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object',
        )
      : [];
    const measurement = json.measurement_structure as Record<string, unknown> | null | undefined;
    const added = [
      text(json.explanation),
      ...hypotheses.flatMap((entry) => [text(entry.label), text(entry.explanation)]),
      measurement && typeof measurement === 'object' ? text(measurement.description) : '',
    ];
    return sacredAddedTextFindings(bookTexts, added, sacredQuotes);
  };
  const conforms = (candidate: string): boolean => {
    const json = parseJsonResponse<Record<string, unknown>>(candidate);
    if (!json || typeof json !== 'object') return false;
    return (
      enrichmentEnvelopeViolations(normalizeEnrichmentEnvelope(json), {
        wrongChoiceIds,
        needsExplanation,
      }).length === 0 && addedSacredFindings(json).length === 0
    );
  };
  // S-9: the full Quran and hadith block when the lesson source or the book
  // question holds a quote, or the subject is ARABIC; the short line otherwise.
  const sacredMode = sacredPolicyModeFor({
    subjectCode: context.inputSnapshot.subjectCode,
    texts: [
      context.sourceText,
      request.bookQuestion.questionText,
      request.bookQuestion.bookExplanation,
      ...request.bookQuestion.choices.map((choice) => choice.text),
    ],
  });
  const { text, model } = await port.generate(
    bookEnrichmentSystemPrompt(sacredMode),
    prompt,
    conforms,
  );
  const parsed = parseJsonResponse<Record<string, unknown>>(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new TeachingPackageError(
      'QUESTION_GENERATION_OUTPUT_INVALID',
      'the model output could not be parsed as JSON',
    );
  }
  // N-H2 (owner-approved): unlike a shape drift, a Quran / hadith finding that
  // survives the retries is never handed to Kafuo. Codes only, never the text.
  const sacredCodes = addedSacredFindings(parsed);
  if (sacredCodes.length > 0) {
    log.warn('book question enrichment stopped by the Quran / hadith check', {
      requestId: request.requestId,
      versionId: version.id,
      codes: sacredCodes,
    });
    throw new TeachingPackageError(
      'SACRED_TEXT_ALTERED',
      `the enrichment changes, invents or explains a Quran verse or hadith (${sacredCodes.join(', ')}); nothing was returned`,
      { codes: sacredCodes },
    );
  }
  const envelope = normalizeEnrichmentEnvelope(parsed);
  // Still off-shape after the port's retries: hand it over anyway. Kafuo is the
  // validator of record and records the refusal against its own enrichment run.
  const violations = enrichmentEnvelopeViolations(envelope, { wrongChoiceIds, needsExplanation });
  if (violations.length > 0) {
    log.warn('book question enrichment envelope does not match the strict shape', {
      requestId: request.requestId,
      versionId: version.id,
      violations: violations.slice(0, 10),
    });
  }
  log.info('book question enriched', {
    requestId: request.requestId,
    versionId: version.id,
    objectiveRef: request.objectiveRef,
    excerpts: excerpts.length,
  });
  return {
    requestId: request.requestId,
    teachingPackageVersionId: version.id,
    objectiveRef: request.objectiveRef,
    envelopeVersion: BOOK_ENRICHMENT_ENVELOPE_VERSION,
    promptVersion: BOOK_ENRICHMENT_PROMPT_VERSION,
    model,
    envelope,
  };
}
