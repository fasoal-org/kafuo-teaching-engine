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
 * and any change to the Kafuo envelope has to be made here too.
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

/** Every way `envelope` departs from the strict shape; empty when it conforms. */
export function envelopeViolations(envelope: unknown): EnvelopeViolation[] {
  const result = questionEnvelopeSchema.safeParse(envelope);
  if (result.success) return [];
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
