/**
 * Role-Specific Slide System — real-LLM evaluation over all 17 slide variants.
 *
 * For every approved variant, in Arabic and in English, generates the slide
 * canvas (+ the separately authored assistance where planned) and narration
 * from a fixed outline, runs the deterministic checks that must ALWAYS hold,
 * and writes every sample to a Markdown report for curriculum review.
 *
 * Deterministic checks (a failure is a defect, not a judgement call):
 *   - no internal identifier / unresolved placeholder on the canvas, in the
 *     assistance, or in speech;
 *   - practice/independent: assistance carries hint + explanation and the
 *     explanation did not leak onto the canvas;
 *   - check_understanding / practice: no scoring / attempt language on canvas;
 *   - the planner's description sentinel never appears in learner content.
 *
 * Human review (from the report): role obligations met, richness vs. density,
 * higher-order support that does not state the conclusion, RTL quality.
 *
 * Required env: EVAL_INFERENCE_MODEL (or DEFAULT_MODEL).
 * Usage: EVAL_INFERENCE_MODEL=<provider:model> pnpm eval:slide-roles
 * Output: eval/slide-roles/results/<model>/<timestamp>/report.md
 */
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  explanationLeakedOntoCanvas,
  findInternalLeaks,
  generateSceneActions,
  generateSceneContent,
  visibleCanvasText,
  type AICallFn,
  type GeneratedSlideContent,
  type SceneOutline,
} from '@openmaic/generation';
import { callLLM } from '@/lib/ai/llm';
import { resolveEvalModel } from '../shared/resolve-model';
import { createRunDir } from '../shared/run-dir';

const OUTPUT_DIR = 'eval/slide-roles/results';
const DESCRIPTION_SENTINEL = 'PLANNER-NOTE-7Q4';
const SCORING_LANGUAGE = /\b(score|points?|attempts?|grade[ds]?)\b|الدرجة|المحاولات|نقاط/i;

interface Scenario {
  language: 'ar' | 'en';
  languageDirective: string;
  outline: SceneOutline;
}

function currentDir(): string {
  return typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
}

function loadScenarios(): Scenario[] {
  return JSON.parse(
    readFileSync(join(currentDir(), 'scenarios/variants.json'), 'utf-8'),
  ) as Scenario[];
}

async function main() {
  const modelStr = process.env.EVAL_INFERENCE_MODEL || process.env.DEFAULT_MODEL;
  if (!modelStr) {
    console.error('Error: EVAL_INFERENCE_MODEL (or DEFAULT_MODEL) must be set.');
    process.exit(1);
  }
  const { model, modelInfo } = await resolveEvalModel(
    'EVAL_INFERENCE_MODEL',
    process.env.DEFAULT_MODEL,
  );
  const aiCall: AICallFn = async (system, user) =>
    (
      await callLLM(
        {
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          maxOutputTokens: modelInfo?.outputWindow,
        },
        'eval-slide-roles',
      )
    ).text;

  const runDir = createRunDir(OUTPUT_DIR, modelStr);
  const sections: string[] = [];
  let defects = 0;

  for (const scenario of loadScenarios()) {
    const outline: SceneOutline = {
      ...scenario.outline,
      description: `${scenario.outline.description} ${DESCRIPTION_SENTINEL}`,
    };
    const variant = [outline.contentRole, outline.contentKind].filter(Boolean).join('/');
    const label = `${variant} [${scenario.language}]`;
    const problems: string[] = [];

    const content = (await generateSceneContent(outline, aiCall, {
      languageDirective: scenario.languageDirective,
      textDirection: scenario.language === 'ar' ? 'rtl' : 'ltr',
    })) as GeneratedSlideContent | null;
    if (!content) {
      defects += 1;
      sections.push(`## ${label}\n\n**DEFECT:** generation failed.\n`);
      continue;
    }
    const actions = await generateSceneActions(outline, content, aiCall, {
      languageDirective: scenario.languageDirective,
    });
    const canvas = visibleCanvasText(content.elements);
    const speech = actions.flatMap((action) =>
      action.type === 'speech' && typeof action.text === 'string' ? [action.text] : [],
    );
    const assistance = content.assistance ?? {};

    const leaks = findInternalLeaks([canvas, ...speech, ...Object.values(assistance)]);
    if (leaks.length > 0) problems.push(`internal text exposed: ${leaks.join(', ')}`);
    if ([canvas, ...speech].some((text) => text.includes(DESCRIPTION_SENTINEL))) {
      problems.push('planner description reached learner content');
    }
    if (outline.contentRole === 'practice' && outline.contentKind === 'independent') {
      if (!assistance.hint || !assistance.explanation) problems.push('missing hint/explanation');
      if (assistance.explanation && explanationLeakedOntoCanvas(assistance.explanation, canvas)) {
        problems.push('solution leaked onto the canvas');
      }
    }
    if (
      (outline.contentRole === 'practice' || outline.contentRole === 'check_understanding') &&
      SCORING_LANGUAGE.test(canvas)
    ) {
      problems.push('scoring / attempt language on the canvas');
    }
    defects += problems.length;

    sections.push(
      [
        `## ${label}`,
        problems.length ? `**DEFECTS:** ${problems.join('; ')}` : '**Deterministic checks:** pass',
        `### Canvas text\n\n${canvas || '_(none)_'}`,
        Object.keys(assistance).length
          ? `### Assistance (on demand)\n\n${Object.entries(assistance)
              .map(([tier, html]) => `- **${tier}:** ${html}`)
              .join('\n')}`
          : '',
        `### Narration\n\n${speech.map((text) => `- ${text}`).join('\n') || '_(none)_'}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
    console.log(`${problems.length ? 'DEFECT' : 'ok    '}  ${label}`);
  }

  const report = `# Slide roles eval — ${modelStr}\n\nDeterministic defects: **${defects}**\n\nReview each sample against the FRD role behaviour (RSS-FR-031–072) before sign-off.\n\n${sections.join('\n\n---\n\n')}\n`;
  writeFileSync(join(runDir, 'report.md'), report);
  console.log(`Report: ${join(runDir, 'report.md')} — deterministic defects: ${defects}`);
  if (defects > 0) process.exit(1);
}

void main();
