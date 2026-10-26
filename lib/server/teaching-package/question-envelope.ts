/**
 * The `tqs.v1.strict.20260817` role-set envelope, as a checkable schema.
 *
 * Kafuo validates every returned envelope with a strict schema
 * (`_RoleSetEnvelope` in `question_bank/infrastructure/providers/
 * openai_teaching_question_provider.py`): unknown keys are forbidden at every
 * level, enums are closed, and the choice and hypothesis counts are exact.
 * Kafuo's own provider got that shape guaranteed by OpenAI structured outputs.
 * Here the shape is only described in the prompt, so a model that drifts —
 * one extra key, a fifth cognitive level — produced an envelope Kafuo refused
 * whole, with nothing in between to catch it.
 *
 * This mirror exists so the drift is caught where a retry is cheap. Kafuo
 * remains the validator of record; this must never be looser than it on shape,
 * and any change to the Kafuo envelope has to be made here too. It is
 * deliberately stricter on one point: math notation (see `hasBareTex`).
 */
import { z } from 'zod';

const choiceId = z.enum(['A', 'B', 'C', 'D']);

const question = z.strictObject({
  question_text: z.string(),
  question_type: z.literal('multiple_choice'),
  choices: z.array(z.strictObject({ choice_id: choiceId, text: z.string() })).length(4),
  correct_choice_id: choiceId,
  explanation: z.string(),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  concept_name: z.string(),
  skill_tag: z.string(),
  cognitive_level: z.enum(['remember', 'understand', 'apply', 'analyze']),
  measurement_structure: z.strictObject({ signature: z.string(), description: z.string() }),
  diagnostic_hypotheses: z
    .array(z.strictObject({ choice_id: choiceId, label: z.string(), explanation: z.string() }))
    .length(3),
  evidence_anchors: z.array(z.string()).min(1),
  validation_notes: z.strictObject({
    has_exactly_one_correct_answer: z.boolean(),
    answerable_from_approved_evidence: z.boolean(),
    is_original_question: z.boolean(),
  }),
});

const roleSlot = z.strictObject({
  teaching_role: z.enum(['check_understanding', 're_check', 'mastery_check']),
  supported: z.boolean(),
  question: question.nullable().optional(),
  unsupported_reason: z.string().nullable().optional(),
});

export const questionEnvelopeSchema = z.strictObject({
  learning_outcome_id: z.number().int(),
  slots: z.array(roleSlot),
});

export interface EnvelopeViolation {
  /** `$.slots[0].question.difficulty` — the same form Kafuo records. */
  path: string;
  code: string;
}

const DELIMITED_MATH = /\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g;
const TEX_COMMAND = /\\[A-Za-z]/;

/**
 * Whether learner-visible `text` carries TeX the student app cannot render
 * (owner rule, 26 Oct 2026). The app renders math only inside `\( … \)` and
 * `\[ … \]`, so a TeX command (`\` + letters) anywhere else — bare, in plain
 * parentheses, in `$ … $`, or after an unclosed `\(` — reaches the student
 * as raw `\frac{F}{A}`. A form feed or backspace is TeX the JSON parse already
 * ate: `"\frac"` / `"\beta"` with one backslash are valid JSON escapes, so no
 * backslash survives to be seen. Never rewrites; the caller refuses.
 */
export function hasBareTex(text: string): boolean {
  if (text.includes('\f') || text.includes('\b')) return true;
  return TEX_COMMAND.test(text.replace(DELIMITED_MATH, ' '));
}

type QuestionEnvelope = z.infer<typeof questionEnvelopeSchema>;

function bareTexViolations(envelope: QuestionEnvelope): EnvelopeViolation[] {
  const violations: EnvelopeViolation[] = [];
  envelope.slots.forEach((slot, slotIndex) => {
    const question = slot.question;
    if (!question) return;
    const base = `$.slots[${slotIndex}].question`;
    // Path and code only — the offending text is never echoed into logs.
    const check = (path: string, text: string) => {
      if (hasBareTex(text)) violations.push({ path: `${base}${path}`, code: 'bare_tex' });
    };
    check('.question_text', question.question_text);
    question.choices.forEach((choice, i) => check(`.choices[${i}].text`, choice.text));
    check('.explanation', question.explanation);
    question.diagnostic_hypotheses.forEach((hypothesis, i) =>
      check(`.diagnostic_hypotheses[${i}].explanation`, hypothesis.explanation),
    );
  });
  return violations;
}

/**
 * Every way `envelope` departs from the strict shape, plus learner-visible
 * text with bare TeX; empty when it conforms.
 */
export function envelopeViolations(envelope: unknown): EnvelopeViolation[] {
  const result = questionEnvelopeSchema.safeParse(envelope);
  if (result.success) return bareTexViolations(result.data);
  const violations: EnvelopeViolation[] = [];
  for (const issue of result.error.issues) {
    const base = issue.path
      .map((part) => (typeof part === 'number' ? `[${part}]` : `.${String(part)}`))
      .join('');
    // zod reports unknown keys once per object; name each key so the path
    // points at the offending field, as Kafuo's `extra_forbidden` does.
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) violations.push({ path: `$${base}.${key}`, code: issue.code });
    } else {
      violations.push({ path: `$${base}`, code: issue.code });
    }
  }
  return violations;
}
