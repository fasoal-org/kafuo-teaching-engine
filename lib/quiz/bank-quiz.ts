/**
 * W6 one question source — the browser side of a bank quiz Scene: the
 * questions and grades the TE route `/api/stages/:id/bank-quiz` returns, and
 * the answer rules (one answer per question; a list for multiple answer).
 * The route reads the grant cookie; nothing here carries a key or a scope.
 */

export type BankQuestionType = 'single_choice' | 'true_false' | 'multiple_answer' | 'short_answer';

export interface BankQuestion {
  id: string;
  questionType: BankQuestionType;
  text: string;
  choices: { id: string; text: string }[];
  assets: { url: string; alt: string | null }[];
  points: number;
}

export type BankQuestionsStatus = 'ready' | 'pending_approval' | 'not_bank';

export interface BankQuestionsResponse {
  status: BankQuestionsStatus;
  questions: BankQuestion[];
}

export interface BankGradeResult {
  questionId: string;
  status: string;
  earned: number;
  possible: number;
  correctAnswer: string[] | null;
  explanation: string | null;
}

export interface BankGradesResponse {
  results: BankGradeResult[];
  earned: number;
  possible: number;
}

export type BankAnswer = string | string[];

export class BankQuizRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null) {
    super(`bank quiz request failed (HTTP ${status}${code ? `, ${code}` : ''})`);
    this.name = 'BankQuizRequestError';
    this.status = status;
    this.code = code;
  }
}

/** Whether [answer] answers [question]: one choice, ≥1 choice, or non-blank text. */
export function isBankAnswerComplete(
  question: BankQuestion,
  answer: BankAnswer | undefined,
): boolean {
  if (answer === undefined) return false;
  if (question.questionType === 'multiple_answer')
    return Array.isArray(answer) && answer.length > 0;
  return typeof answer === 'string' && answer.trim() !== '';
}

/** The grade request's answers: only answered questions, in the contract's per-type shape. */
export function bankAnswersPayload(
  questions: readonly BankQuestion[],
  answers: Readonly<Record<string, BankAnswer>>,
): Record<string, BankAnswer> {
  const payload: Record<string, BankAnswer> = {};
  for (const question of questions) {
    const answer = answers[question.id];
    if (!isBankAnswerComplete(question, answer)) continue;
    payload[question.id] = Array.isArray(answer) ? [...answer] : (answer as string).trim();
  }
  return payload;
}

async function errorOf(response: Response): Promise<BankQuizRequestError> {
  let code: string | null = null;
  try {
    const body = (await response.json()) as { error?: { code?: unknown } } | null;
    code = typeof body?.error?.code === 'string' ? body.error.code : null;
  } catch {
    code = null;
  }
  return new BankQuizRequestError(response.status, code);
}

function routeOf(stageId: string): string {
  return `/api/stages/${encodeURIComponent(stageId)}/bank-quiz`;
}

export async function fetchBankQuestions(
  stageId: string,
  sceneId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BankQuestionsResponse> {
  const response = await fetchImpl(`${routeOf(stageId)}?sceneId=${encodeURIComponent(sceneId)}`, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) throw await errorOf(response);
  return (await response.json()) as BankQuestionsResponse;
}

export async function submitBankAnswers(
  stageId: string,
  sceneId: string,
  answers: Record<string, BankAnswer>,
  fetchImpl: typeof fetch = fetch,
): Promise<BankGradesResponse> {
  const response = await fetchImpl(routeOf(stageId), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneId, answers }),
  });
  if (!response.ok) throw await errorOf(response);
  return (await response.json()) as BankGradesResponse;
}
