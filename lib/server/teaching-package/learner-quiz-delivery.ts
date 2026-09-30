/**
 * The learner-safe projection of quiz content (no server dependencies, so the
 * persistence route can import it). See `learner-quiz.ts` for the grading half.
 *
 * Every quiz payload a LEARNER grant reads is rebuilt through an ALLOWLIST:
 * `{ type, questions: [{ id, type, question, options: [{ label, value }],
 * points }] }`. Answer keys (`answer`), explanations (`analysis`), rubrics
 * (`commentPrompt`), `hasAnswer` and any field added later are withheld.
 */
// --------------------------------------------------------------------------
// Delivery: the learner-safe projection
// --------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function learnerQuestion(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  const question: Record<string, unknown> = {};
  if (typeof raw.id === 'string') question.id = raw.id;
  if (typeof raw.type === 'string') question.type = raw.type;
  if (typeof raw.question === 'string') question.question = raw.question;
  if (Array.isArray(raw.options)) {
    question.options = raw.options.filter(isRecord).map((option) => ({
      ...(typeof option.label === 'string' ? { label: option.label } : {}),
      ...(typeof option.value === 'string' ? { value: option.value } : {}),
    }));
  }
  if (typeof raw.points === 'number' && Number.isFinite(raw.points)) {
    question.points = raw.points;
  }
  return question;
}

export function isQuizContent(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === 'quiz' && Array.isArray(value.questions);
}

/**
 * Deep-copies [payload], replacing every quiz content object (`{ type: 'quiz',
 * questions }`) with its learner projection. Works on any documents GET shape —
 * a whole document, a single scene, or anything nesting them.
 */
export function sanitizeLearnerDelivery(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(sanitizeLearnerDelivery);
  if (!isRecord(payload)) return payload;
  if (isQuizContent(payload)) {
    return {
      type: 'quiz',
      questions: (payload.questions as unknown[])
        .map(learnerQuestion)
        .filter((question): question is Record<string, unknown> => question !== null),
    };
  }
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) copy[key] = sanitizeLearnerDelivery(value);
  return copy;
}

