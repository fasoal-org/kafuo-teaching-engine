/**
 * Q-4 / Q-9 / Q-12 / Q-15: the shared Quran and hadith policy block is in every
 * TE-owned learner-text prompt (the generation templates are pinned in the
 * generation package's own `sacred-text-policy.test.ts`).
 */
import { describe, expect, it, vi } from 'vitest';

import {
  BOOK_ENRICHMENT_PROMPT_VERSION,
  BOOK_ENRICHMENT_SYSTEM_PROMPT,
  bookEnrichmentSystemPrompt,
} from '@/lib/server/teaching-package/book-question-enrichment-prompt';
import { planInsertedSlide } from '@/lib/server/teaching-package/plan-inserted-slide';
import {
  QUESTION_GENERATION_PROMPT_VERSION,
  QUESTION_SYSTEM_PROMPT,
  questionSystemPrompt,
} from '@/lib/server/teaching-package/question-generation-prompt';
import { sacredPolicyModeFor } from '@/lib/server/teaching-package/sacred-text';
import {
  SACRED_TEXT_POLICY_TEXT,
  SACRED_TEXT_SHORT_LINE,
} from '@/lib/server/teaching-package/sacred-text-policy';
import type { TeachingFlowEntry } from '@/lib/types/teaching-package';

describe('the shared sacred-text policy block', () => {
  it('states the owner rule in English and Arabic', () => {
    expect(SACRED_TEXT_POLICY_TEXT).toContain('copy it EXACTLY as given');
    expect(SACRED_TEXT_POLICY_TEXT).toContain('inside ﴿ ﴾');
    expect(SACRED_TEXT_POLICY_TEXT).toContain('always with its reference');
    expect(SACRED_TEXT_POLICY_TEXT).toContain(
      'Never paraphrase, translate, summarise, interpret or explain a verse or hadith',
    );
    expect(SACRED_TEXT_POLICY_TEXT).toContain('Never invent');
    expect(SACRED_TEXT_POLICY_TEXT).toContain('only for the purpose the book uses it for');
    expect(SACRED_TEXT_POLICY_TEXT).toContain('تأمّل الآية المعروضة');
    expect(SACRED_TEXT_POLICY_TEXT).toContain('تأمّل الحديث المعروض');
    expect(SACRED_TEXT_POLICY_TEXT).toContain('ولا تفسره ولا تشرحه');
  });

  it('is in the bank-question and book-enrichment system prompts', () => {
    expect(QUESTION_SYSTEM_PROMPT).toContain(SACRED_TEXT_POLICY_TEXT);
    expect(BOOK_ENRICHMENT_SYSTEM_PROMPT).toContain(SACRED_TEXT_POLICY_TEXT);
  });

  it('S-9: short mode carries only the one line, everything else unchanged', () => {
    expect(SACRED_TEXT_SHORT_LINE).toContain('Never invent Quran verses or hadith.');
    for (const build of [questionSystemPrompt, bookEnrichmentSystemPrompt]) {
      const full = build('full');
      const short = build('short');
      expect(short).toContain(SACRED_TEXT_SHORT_LINE);
      expect(short).not.toContain('Quran and hadith (fixed rule)');
      expect(short.replace(SACRED_TEXT_SHORT_LINE, SACRED_TEXT_POLICY_TEXT)).toBe(full);
    }
    expect(QUESTION_GENERATION_PROMPT_VERSION).toBe('te-tqg.v6.20261104');
    expect(BOOK_ENRICHMENT_PROMPT_VERSION).toBe('te-bqe.v4.20261104');
  });

  it('S-9: the mode follows pins, lesson quotes and the ARABIC subject', () => {
    expect(sacredPolicyModeFor({ subjectCode: 'MATH', texts: ['الكسور العشرية'] })).toBe('short');
    expect(sacredPolicyModeFor({ subjectCode: 'ARABIC', texts: [] })).toBe('full');
    expect(sacredPolicyModeFor({ subjectCode: 'MATH', texts: ['قال تعالى: ﴿الم﴾'] })).toBe('full');
    expect(
      sacredPolicyModeFor({ subjectCode: 'BIOLOGY', texts: ['قال النبي ﷺ: «الدين النصيحة»'] }),
    ).toBe('full');
    expect(sacredPolicyModeFor({ subjectCode: 'PHYSICS', pins: [{}] })).toBe('full');
    expect(sacredPolicyModeFor({ subjectCode: null, pins: [], texts: [null] })).toBe('short');
  });

  it.each([
    ['full', undefined],
    ['full', 'full'],
    ['short', 'short'],
  ] as const)(
    'is in the inserted-slide planner system prompt (%s, mode %s)',
    async (want, mode) => {
      const systems: string[] = [];
      const aiCall = vi.fn(async (system: string) => {
        systems.push(system);
        return 'not json';
      });
      await planInsertedSlide({
        ...(mode ? { sacredMode: mode } : {}),
        units: [{ id: 'cu_1', order: 1, role: 'CONCEPT', title: 'T', text: 'unit text' }],
        unitIds: ['cu_1'],
        flowEntry: {
          stage: 'explain',
          instructions: 'explain',
          scenePolicy: { sceneTypes: ['slide'], contentRoles: ['explanation'] },
        } as TeachingFlowEntry,
        teachingStage: { key: 'explain', flowIndex: 0 },
        allowedSkills: null,
        previousTitle: null,
        nextTitle: null,
        language: 'ar',
        languageDirective: '',
        eligibleVisuals: [],
        instruction: '',
        outlineId: 'ins_1',
        order: 1,
        check: (outline) => ({ ok: true, outline, repairs: [] }),
        aiCall: aiCall as never,
      }).catch(() => undefined);
      expect(systems.length).toBeGreaterThan(0);
      if (want === 'full') expect(systems[0]).toContain(SACRED_TEXT_POLICY_TEXT);
      else {
        expect(systems[0]).toContain(SACRED_TEXT_SHORT_LINE);
        expect(systems[0]).not.toContain('Quran and hadith (fixed rule)');
      }
    },
  );
});
