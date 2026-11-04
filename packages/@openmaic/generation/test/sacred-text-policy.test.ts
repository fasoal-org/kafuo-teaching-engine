/**
 * Kafuo Q-4 / Q-6 / Q-9 / Q-15 (+ review fixes S-6, S-9): the Quran and hadith
 * policy renders in every learner-text prompt when the caller passes it — the
 * full block with the quotes verbatim, or only the one short line — and leaves
 * every prompt byte-identical when it does not.
 */
import { describe, expect, it } from 'vitest';

import { buildPlannerSystemPrompt } from '../src/pbl/planner-core.js';
import { buildPrompt, PROMPT_IDS, type PromptId } from '../src/prompts/index.js';
import { loadSnippet } from '../src/prompts/loader.js';
import { sacredTextPromptBlocks, sacredTextVars } from '../src/sacred-text-policy.js';
import { pblPlannerInput } from './scene-fixtures.js';

const VERSE = '﴿هُوَ الَّذِي أَنزَلَ عَلَيْكَ الْكِتَابَ﴾';
const context = {
  quotes: [
    {
      kind: 'quran' as const,
      text: VERSE,
      reference: 'سورة آل عمران الآية: 7',
      contentUnitId: '11',
    },
    {
      kind: 'hadith' as const,
      text: '«إنما الأعمال بالنيات»',
      reference: null,
      contentUnitId: '12',
    },
  ],
};
const SHORT_LINE = loadSnippet('sacred-text-short-line');

const LEARNER_TEXT_PROMPTS: PromptId[] = [
  PROMPT_IDS.REQUIREMENTS_TO_OUTLINES,
  PROMPT_IDS.SLIDE_CONTENT,
  PROMPT_IDS.QUIZ_CONTENT,
  PROMPT_IDS.SLIDE_ACTIONS,
  PROMPT_IDS.QUIZ_ACTIONS,
  PROMPT_IDS.INTERACTIVE_ACTIONS,
  PROMPT_IDS.SLIDE_ASSISTANCE,
  // S-6: the interactive widget content templates.
  PROMPT_IDS.SIMULATION_CONTENT,
  PROMPT_IDS.DIAGRAM_CONTENT,
  PROMPT_IDS.CODE_CONTENT,
  PROMPT_IDS.GAME_CONTENT,
  PROMPT_IDS.VISUALIZATION3D_CONTENT,
  PROMPT_IDS.PROCEDURAL_SKILL_CONTENT,
];

describe('sacred text policy block', () => {
  it('renders the bilingual rule and the verbatim quotes in every learner-text prompt', () => {
    for (const id of LEARNER_TEXT_PROMPTS) {
      const prompt = buildPrompt(id, sacredTextVars(context, ['11']))!;
      expect(prompt.system, id).toContain('Quran and hadith (fixed rule)');
      expect(prompt.system, id).toContain('Never paraphrase, translate, summarise, interpret');
      expect(prompt.system, id).toContain('لا تخترع آية أو حديثًا');
      expect(prompt.system, id).toContain('تأمّل الآية المعروضة');
      expect(prompt.system, id).toContain('تأمّل الحديث المعروض');
      expect(prompt.system, id).not.toContain(SHORT_LINE);
      expect(prompt.user, id).toContain(`${VERSE} — سورة آل عمران الآية: 7`);
      // Only the cited unit's quotes reach a scene.
      expect(prompt.user, id).not.toContain('إنما الأعمال');
    }
  });

  it('lists every quote for the outline and says "none" for a scene without one', () => {
    expect(sacredTextVars(context, null).sacredQuotesText).toContain('إنما الأعمال');
    expect(sacredTextVars(context, ['99']).sacredQuotesText).toContain('quote no Quran verse');
    // A source without units (PDF fallback): its quotes reach every scene.
    const unitless = { quotes: [{ kind: 'quran' as const, text: VERSE }] };
    expect(sacredTextVars(unitless, ['99']).sacredQuotesText).toContain(VERSE);
  });

  it('says not to invent a reference the book does not print (S-6)', () => {
    const text = String(sacredTextVars(context, ['12']).sacredQuotesText);
    expect(text).toContain('«إنما الأعمال بالنيات» — (no reference in the book');
    expect(text).toContain('never invent one');
  });

  it('leaves every prompt byte-identical without the context', () => {
    for (const id of LEARNER_TEXT_PROMPTS) {
      const plain = buildPrompt(id, {})!;
      expect(buildPrompt(id, sacredTextVars(undefined, ['11']))).toEqual(plain);
      expect(plain.system).not.toContain('Quran and hadith');
      expect(plain.system).not.toContain(SHORT_LINE);
      expect(plain.user).not.toContain('Protected quotes');
    }
  });

  it('short mode (S-9): one line only; removing it gives the pre-rule prompt byte for byte', () => {
    expect(SHORT_LINE).toContain('Never invent Quran verses or hadith.');
    expect(SHORT_LINE).toContain('لا تؤلّف آياتٍ قرآنية أو أحاديث نبوية، ولا تنسبها لغير مصدرها.');
    const short = { quotes: context.quotes, mode: 'short' as const };
    for (const id of LEARNER_TEXT_PROMPTS) {
      const plain = buildPrompt(id, {})!;
      const prompt = buildPrompt(id, sacredTextVars(short, ['11']))!;
      expect(prompt.system.split(SHORT_LINE).length, id).toBe(2);
      expect(prompt.system.replace(`${SHORT_LINE}\n\n`, ''), id).toBe(plain.system);
      expect(prompt.user, id).toBe(plain.user);
      expect(prompt.system, id).not.toContain('Quran and hadith (fixed rule)');
    }
  });

  it('frames the PBL planner prompt (S-6), unchanged without the context', async () => {
    const input = pblPlannerInput();
    const plain = await buildPlannerSystemPrompt(input, 'intermediate', 'ar-SA', false);
    const outline = { ...input.outline, sourceContentUnitIds: ['11'] };
    const full = await buildPlannerSystemPrompt(
      { ...input, outline, sacredText: context },
      'intermediate',
      'ar-SA',
      false,
    );
    expect(full.startsWith(loadSnippet('sacred-text-policy'))).toBe(true);
    expect(full).toContain(`${VERSE} — سورة آل عمران الآية: 7`);
    expect(full).toContain(plain);
    const short = await buildPlannerSystemPrompt(
      { ...input, sacredText: { quotes: [], mode: 'short' } },
      'intermediate',
      'ar-SA',
      false,
    );
    expect(short).toBe(`${SHORT_LINE}\n\n${plain}`);
    expect(sacredTextPromptBlocks(undefined, null)).toEqual({ system: '', user: '' });
  });
});
