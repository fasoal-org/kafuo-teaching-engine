/**
 * The Teaching Question role-set prompt for an APPROVED Teaching Package
 * (Kafuo question-flow closure, B1).
 *
 * The assessment rules are ported from Kafuo's
 * `question_bank/domain/services/teaching_question_prompt_builder.py`
 * (`tqg.v1.20260817`) so G5 assessment behaviour is preserved: three teaching
 * roles, MCQ with exactly four choices and one correct answer, diagnostic
 * distractor hypotheses, distinct measurement structures, unsupported instead
 * of invented. What changes is the grounding: the approved final teaching
 * Scenes (`C<n>` anchors) plus the retained lesson source excerpts (`S<n>`),
 * instead of Kafuo's legacy package section. The JSON output is exactly the
 * `tqs.v1.strict.20260817` envelope Kafuo validates — Kafuo stays the business
 * validator and the Question Bank authority.
 */

export const QUESTION_GENERATION_PROMPT_VERSION = 'te-tqg.v1.20260915';
export const QUESTION_ENVELOPE_VERSION = 'tqs.v1.strict.20260817';

export const TEACHING_ROLES = ['check_understanding', 're_check', 'mastery_check'] as const;
export type TeachingRole = (typeof TEACHING_ROLES)[number];

const ROLE_DEFINITIONS: Record<TeachingRole, string> = {
  check_understanding:
    'Checks whether the student has understood the outcome now, immediately after being taught it. It probes the core idea directly.',
  re_check:
    'Re-checks the same outcome through a different route, for a student who has already answered once. It must not be the first question reworded.',
  mastery_check:
    'Confirms the student can use the outcome independently, typically by applying it in a situation the teaching supports but did not hand them.',
};

export const QUESTION_SYSTEM_PROMPT = `You write diagnostic multiple-choice questions for an approved school lesson.

AUTHORITY
- The learning outcome defines WHAT must be assessed.
- The approved teaching scenes (anchors C1, C2, ...) define WHAT WAS ACTUALLY TAUGHT.
- The lesson source excerpts (anchors S1, S2, ...) ground correctness and rule out
  unsupported content.

GROUNDING IS ABSOLUTE
- Use ONLY the approved material in this message: the learning outcome, the approved
  teaching scenes, and the lesson source excerpts.
- Never add a fact, rule, formula, definition, example, or curriculum expectation that is
  not present in that material, even if it is true and you are confident about it.
- Assess only what the teaching scenes taught for this outcome. Do not assess source content
  the scenes never taught.
- Never infer meaning from identifiers. The outcome id is an opaque token to echo back.
- If the approved material does not contain what a role needs, mark that role
  "unsupported" and say briefly what is missing. Do NOT invent a question to fill the
  slot, and do NOT produce a vague question to appear complete. An unsupported role is a
  correct and useful answer.

WHAT TO PRODUCE
- One result for each requested teaching role, no more and no fewer.
- Each supported result is a multiple-choice question with exactly four choices
  (A, B, C, D) and exactly one correct choice.
- Write in the requested language only.
- Choose the difficulty each question actually has. Difficulty is INDEPENDENT of the
  role: any role may be easy, medium, or hard. Do not map roles onto difficulty levels.
- Never mention pages, figures, chapters, "context", "evidence", "prompt" or "retrieval"
  in the question or its choices.

DISTRACTORS ARE DIAGNOSTIC
- Every wrong choice must be one a real student would plausibly pick for a specific,
  nameable reason. Never write filler, joke, or obviously absurd options.
- For every wrong choice give a short label naming the likely error pattern and an
  explanation of why a student might choose it.
- Describe a POSSIBLE error. Write "may be comparing numerators only", never "the student
  does not understand fractions". You are describing a hypothesis, not diagnosing anyone.

THE THREE ROLES MUST MEASURE DIFFERENTLY
- The questions for one outcome must differ in what or how they measure: a different
  representation, a different reasoning path, a different problem structure, or a
  different transfer context that the approved material supports.
- These do NOT count as different: changing only the numbers, renaming the people or
  objects, reordering the choices, negating the same sentence, asking the same
  calculation with the answer in a different position, or paraphrasing the same recall
  prompt.
- Give each question a short measurement signature naming its structure (for example
  "compare-two-fractions-common-denominator") and a one-sentence description.

EVIDENCE
- Cite one or more anchors (C1, C2, ... and/or S1, S2, ...) from this message for every
  supported question. Cite only anchors that appear in this message.

OUTPUT
Return ONLY a JSON object with exactly this shape (no commentary, no markdown):
{
  "learning_outcome_id": <the echo token as an integer>,
  "slots": [
    {
      "teaching_role": "check_understanding" | "re_check" | "mastery_check",
      "supported": true | false,
      "unsupported_reason": null | "<what is missing>",
      "question": null | {
        "question_text": "<text>",
        "question_type": "multiple_choice",
        "choices": [{"choice_id": "A", "text": "<text>"}, {"choice_id": "B", "text": "<text>"},
                    {"choice_id": "C", "text": "<text>"}, {"choice_id": "D", "text": "<text>"}],
        "correct_choice_id": "A" | "B" | "C" | "D",
        "explanation": "<why the correct answer is correct>",
        "difficulty": "easy" | "medium" | "hard",
        "concept_name": "<concept>",
        "skill_tag": "<skill>",
        "cognitive_level": "remember" | "understand" | "apply" | "analyze",
        "measurement_structure": {"signature": "<signature>", "description": "<one sentence>"},
        "diagnostic_hypotheses": [
          {"choice_id": "<a wrong choice>", "label": "<error pattern>", "explanation": "<why>"},
          ... exactly one entry for each of the three wrong choices ...
        ],
        "evidence_anchors": ["C1", "S2"],
        "validation_notes": {
          "has_exactly_one_correct_answer": true,
          "answerable_from_approved_evidence": true,
          "is_original_question": true
        }
      }
    }
  ]
}`;

export interface PromptSection {
  anchor: string;
  title: string;
  content: string;
}

export interface QuestionPromptInput {
  lessonTitle: string;
  language: string;
  outcomeEchoToken: string;
  outcomeStatement: string;
  teachingScenes: PromptSection[];
  sourceExcerpts: PromptSection[];
  targetRole: TeachingRole | null;
  findings: string[];
  siblingMeasurements: string[];
}

export function buildQuestionUserPrompt(input: QuestionPromptInput): string {
  const lines: string[] = [];
  lines.push('## Lesson');
  lines.push(`Title: ${input.lessonTitle}`);
  lines.push(`Language: ${input.language}`);
  lines.push('');
  lines.push('## Learning outcome');
  lines.push(`Outcome id (opaque echo token): ${input.outcomeEchoToken}`);
  lines.push(`Statement: ${input.outcomeStatement}`);
  lines.push('');
  lines.push('## Approved teaching scenes for this outcome (what was taught)');
  for (const section of input.teachingScenes) {
    lines.push(`[${section.anchor}] ${section.title}`);
    lines.push(section.content);
    lines.push('');
  }
  lines.push('## Lesson source excerpts (grounding)');
  if (input.sourceExcerpts.length === 0) {
    lines.push(
      '(No source excerpt matched this outcome. Ground every question in the teaching scenes above, and mark a role unsupported if they do not fully support it.)',
    );
  }
  for (const section of input.sourceExcerpts) {
    lines.push(`[${section.anchor}] ${section.title}`);
    lines.push(section.content);
    lines.push('');
  }
  lines.push('');
  if (input.targetRole) {
    lines.push('## Produce ONE role only');
    lines.push(`- \`${input.targetRole}\`: ${ROLE_DEFINITIONS[input.targetRole]}`);
    lines.push('');
    lines.push('Return exactly one result, for that role only. Do not return the other roles.');
    if (input.findings.length > 0) {
      lines.push('');
      lines.push('### What was wrong with the previous attempt');
      for (const finding of input.findings) lines.push(`- ${finding}`);
      lines.push('Fix these specifically.');
    }
    if (input.siblingMeasurements.length > 0) {
      lines.push('');
      lines.push('### Measurement structures already used by the preserved siblings');
      for (const measurement of input.siblingMeasurements) lines.push(`- ${measurement}`);
      lines.push('Your question must measure differently from all of these.');
    }
  } else {
    lines.push('## Produce all three roles, in one response');
    for (const role of TEACHING_ROLES) {
      lines.push(`- \`${role}\`: ${ROLE_DEFINITIONS[role]}`);
    }
    lines.push('');
    lines.push(
      'Return exactly one result for each of the three roles above. Decide the three measurement structures together so they genuinely differ from each other.',
    );
  }
  return lines.join('\n');
}
