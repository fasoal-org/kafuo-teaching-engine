/**
 * W6 one question source: the classroom's bank quiz read and grade, for the
 * current editor grant (status doc "W6 contract" items 3–4).
 *
 * Everything that scopes the Kafuo call comes from the verified grant and the
 * server's own rows — never from the request body: tenant and version from
 * the grant, the learning item from the version, `studentRef` only from a
 * learner grant that carries the student context (preview, edit and
 * context-less learner grants send none, so Kafuo reads the current approved
 * set). A learner grant is re-validated with Kafuo first, as document reads are.
 * The Scene must be a bank quiz of the grant's Stage; any other quiz answers
 * `not_bank` without calling Kafuo.
 */
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { isBankQuizScene } from '@/lib/server/teaching-package/bank-quiz-scene';
import type { VerifiedEditorGrant } from '@/lib/server/teaching-package/editor-grant';
import {
  KafuoIntegrationError,
  isKafuoUnreachableError,
  type BankQuizAnswer,
  type BankQuizGradesResult,
  type BankQuizQuestionsResult,
  type BankQuizScope,
} from '@/lib/server/tutor/kafuo-integration-client';
import type { AppScene } from '@/lib/types/stage';

export const BANK_QUIZ_LIMITS = {
  sceneId: 200,
  answers: 30,
  questionId: 80,
  choices: 10,
  choiceId: 32,
  text: 2000,
} as const;

export interface BankQuizDeps {
  /** The grant's version → its learning item id (null when the version is gone). */
  learningItemIdOf: (tenantId: string, versionId: string) => Promise<string | null>;
  /** The live Scene of the grant's Stage, or null. */
  readScene: (stageId: string, sceneId: string) => Promise<AppScene | null>;
  /** Learner grant re-validation (`evaluateLearnerGrantAccess` + `learnerDeliveryError`). */
  checkLearnerAccess: (grant: VerifiedEditorGrant) => Promise<TeachingPackageError | null>;
  client: {
    quizQuestions(scope: BankQuizScope): Promise<BankQuizQuestionsResult>;
    quizGrades(
      scope: BankQuizScope,
      answers: Record<string, BankQuizAnswer>,
    ): Promise<BankQuizGradesResult>;
  };
}

function invalid(message: string): TeachingPackageError {
  return new TeachingPackageError('INVALID_REQUEST', message);
}

/** A non-empty, bounded scene id (from the query string or the body). */
export function parseBankQuizSceneId(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > BANK_QUIZ_LIMITS.sceneId) {
    throw invalid('sceneId is required');
  }
  return raw;
}

/**
 * The answers map: only `bank:` ids (other ids are TE scene questions and keep
 * today's path), each a choice id, a list of choice ids, or the typed text.
 */
export function parseBankQuizAnswers(raw: unknown): Record<string, BankQuizAnswer> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalid('answers must be an object keyed by question id');
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0 || entries.length > BANK_QUIZ_LIMITS.answers) {
    throw invalid(`answers must hold 1–${BANK_QUIZ_LIMITS.answers} entries`);
  }
  const answers: Record<string, BankQuizAnswer> = {};
  for (const [id, value] of entries) {
    if (!id.startsWith('bank:') || id.length > BANK_QUIZ_LIMITS.questionId) {
      throw invalid('every answered question id must be a bank: id');
    }
    if (typeof value === 'string') {
      if (value.length > BANK_QUIZ_LIMITS.text) throw invalid('an answer is too long');
      answers[id] = value;
      continue;
    }
    if (
      Array.isArray(value) &&
      value.length <= BANK_QUIZ_LIMITS.choices &&
      value.every(
        (choice) => typeof choice === 'string' && choice.length <= BANK_QUIZ_LIMITS.choiceId,
      )
    ) {
      answers[id] = [...(value as string[])];
      continue;
    }
    throw invalid('an answer must be a string or a list of choice ids');
  }
  return answers;
}

function kafuoFailure(error: unknown): TeachingPackageError {
  if (isKafuoUnreachableError(error)) {
    return new TeachingPackageError(
      'BANK_QUIZ_UNAVAILABLE',
      'the question bank could not be reached; try again shortly',
    );
  }
  if (error instanceof KafuoIntegrationError) {
    return new TeachingPackageError('BANK_QUIZ_REFUSED', 'the question bank refused the request', {
      status: error.status,
      ...(error.code ? { reason: error.code } : {}),
    });
  }
  return new TeachingPackageError(
    'BANK_QUIZ_UNAVAILABLE',
    'the question bank could not be reached; try again shortly',
  );
}

/** The grant-derived Kafuo scope, or null when the Scene is not a bank quiz. */
async function scopeFor(
  grant: VerifiedEditorGrant,
  sceneId: string,
  deps: BankQuizDeps,
): Promise<BankQuizScope | null> {
  if (grant.purpose === 'learner') {
    const refusal = await deps.checkLearnerAccess(grant);
    if (refusal) throw refusal;
  }
  const scene = await deps.readScene(grant.stageId, sceneId);
  if (!scene)
    throw new TeachingPackageError('SCENE_NOT_FOUND', 'the quiz is not part of this stage');
  if (scene.type !== 'quiz' || !isBankQuizScene(scene)) return null;
  const learningItemId = await deps.learningItemIdOf(grant.tenantId, grant.versionId);
  if (!learningItemId) {
    throw new TeachingPackageError('SCENE_NOT_FOUND', 'the quiz is not part of this stage');
  }
  const studentRef =
    grant.purpose === 'learner' && grant.student ? grant.student.studentRef : undefined;
  return {
    tenantId: grant.tenantId,
    learningItemId,
    versionId: grant.versionId,
    sceneId,
    ...(studentRef ? { studentRef } : {}),
  };
}

export async function readBankQuizQuestions(
  grant: VerifiedEditorGrant,
  sceneId: string,
  deps: BankQuizDeps,
): Promise<BankQuizQuestionsResult> {
  const scope = await scopeFor(grant, sceneId, deps);
  if (!scope) return { status: 'not_bank', questions: [] };
  try {
    return await deps.client.quizQuestions(scope);
  } catch (error) {
    throw kafuoFailure(error);
  }
}

export async function gradeBankQuiz(
  grant: VerifiedEditorGrant,
  sceneId: string,
  answers: Record<string, BankQuizAnswer>,
  deps: BankQuizDeps,
): Promise<BankQuizGradesResult> {
  const scope = await scopeFor(grant, sceneId, deps);
  if (!scope) {
    throw new TeachingPackageError('INVALID_REQUEST', 'this quiz is not a question-bank quiz');
  }
  try {
    return await deps.client.quizGrades(scope, answers);
  } catch (error) {
    throw kafuoFailure(error);
  }
}
