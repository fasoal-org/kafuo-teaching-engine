/**
 * Book Question enrichment from an APPROVED Teaching Package (Kafuo plan D1).
 * TE adds only the metadata the book did not print, grounded in its retained
 * source text; the book's question, choices and answer never travel back.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureDocumentSchema } from '@openmaic/storage/document/pg';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import type { AppScene } from '@/lib/types/stage';
import { makeDocument } from '../agent-runtime/_stage-fixtures';

import {
  ensureTeachingPackageSchema,
  insertAttempt,
  insertVersion,
  upsertSourceContext,
} from '@/lib/persistence/teaching-package';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  enrichBookQuestion,
  type BookQuestionEnrichmentRequest,
} from '@/lib/server/teaching-package/book-question-enrichment';
import {
  enrichmentEnvelopeViolations,
  normalizeEnrichmentEnvelope,
} from '@/lib/server/teaching-package/book-question-enrichment-prompt';
import type { QuestionModelPort } from '@/lib/server/teaching-package/question-generation';
import type { TeachingPackageStatus } from '@/lib/types/teaching-package';

class PGlitePool {
  constructor(readonly db: PGlite) {}
  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }
  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }
  async end() {
    await this.db.close();
  }
}

const TENANT = 'tenant-bqe';
const SOURCE_TEXT = [
  'Fractions describe equal parts of a whole.',
  'To compare two proper fractions rewrite them with a common denominator, then compare numerators.',
].join('\n\n');

const GOOD = {
  difficulty: 'easy',
  diagnostic_hypotheses: [
    { choice_id: 'B', label: 'compares numerators only', explanation: 'Looks at the tops.' },
    { choice_id: 'C', label: 'treats unlike fractions as equal', explanation: 'Assumes sameness.' },
  ],
  measurement_structure: {
    signature: 'compare-two-fractions',
    description: 'Compares two proper fractions.',
    cognitive_level: 'apply',
  },
  explanation: 'A common denominator shows 10/15 is larger than 9/15.',
};

describe('book question enrichment from an approved package', () => {
  let pool: PGlitePool;
  let counter = 0;
  const unique = (prefix: string) => `${prefix}-${(counter += 1)}`;
  const generate = vi.fn();
  const port: QuestionModelPort = { generate: (s, p, accept) => generate(s, p, accept) };

  async function seed(status: TeachingPackageStatus = 'approved') {
    const learningItem = { type: 'lesson' as const, id: unique('li') };
    const aggregate = { tenantId: TENANT, learningItem };
    const attemptId = unique('tpa');
    const versionId = unique('tpv');
    const stageId = unique('stage');
    await createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool: pool as never,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    }).saveDocument(makeDocument(stageId, 'Fractions', []));
    await insertVersion(pool as never, {
      id: versionId,
      aggregate,
      version: 1,
      status,
      currentStageId: stageId,
      currentAttemptId: attemptId,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    await insertAttempt(pool as never, {
      id: attemptId,
      aggregate,
      versionId,
      kind: 'initial',
      status: 'succeeded',
      requestedByActorRef: 'kafuo',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      inputSnapshot: {
        learningItem,
        teachingModel: { key: 'g5', version: 'g5.v1' },
        learningObjectives: [
          { objectiveRef: '48', snapshot: { statement: 'Compare two proper fractions.' } },
        ],
        contentUnitRefs: [],
        sourceRefs: [],
        generationContext: {},
        generationOptions: {},
        requirementDigest: '0'.repeat(64),
        requirementPreview: 'p',
        pdfContentSummary: null,
        requestedAt: 1,
        teachingFlow: [],
        contentResource: { id: 'cs-1', mimeType: 'application/pdf', measuredSha256: 'a'.repeat(64) },
      },
      now: 1,
    });
    await upsertSourceContext(pool as never, {
      tenantId: TENANT,
      attemptId,
      contentResourceId: 'cs-1',
      measuredSha256: 'a'.repeat(64),
      text: SOURCE_TEXT,
    });
    return { versionId, learningItem };
  }

  function request(
    seeded: { versionId: string; learningItem: { type: 'lesson'; id: string } },
    overrides: Partial<BookQuestionEnrichmentRequest> = {},
  ): BookQuestionEnrichmentRequest {
    return {
      versionId: seeded.versionId,
      tenantId: TENANT,
      learningItem: seeded.learningItem,
      requestId: 'bqe:1:700:bqe.v1:1',
      objectiveRef: '48',
      language: 'en',
      findings: [],
      siblingMeasurements: [],
      bookQuestion: {
        questionId: '700',
        questionText: 'Which is larger: 2/3 or 3/5?',
        choices: [
          { choiceId: 'A', text: '2/3' },
          { choiceId: 'B', text: '3/5' },
          { choiceId: 'C', text: 'They are equal' },
        ],
        correctChoiceId: 'A',
        bookExplanation: null,
      },
      ...overrides,
    };
  }

  beforeEach(async () => {
    pool = new PGlitePool(new PGlite());
    await ensureDocumentSchema(pool as never);
    await ensureStageMetaSchema(pool as never);
    await ensureTeachingPackageSchema(pool as never);
    generate.mockReset();
    generate.mockResolvedValue({ text: JSON.stringify(GOOD), model: 'openai:test' });
  });

  afterEach(async () => {
    await pool.end();
  });

  it('enriches a three-choice book question from the retained source text', async () => {
    const seeded = await seed();
    const result = await enrichBookQuestion(pool as never, request(seeded), port);

    expect(result.envelopeVersion).toBe('bqe.v1');
    expect(result.envelope).toEqual(GOOD);
    const [, prompt] = generate.mock.calls[0];
    const payload = JSON.parse(prompt as string);
    // Grounded in the approved package's own source text, and told the wrong choices.
    expect(payload.lesson_source_excerpts[0].content).toContain('common denominator');
    expect(payload.wrong_choice_ids).toEqual(['B', 'C']);
    expect(payload.explanation_required).toBe(true);
  });

  it('never returns anything but the four enrichment fields', async () => {
    generate.mockResolvedValue({
      text: JSON.stringify({ ...GOOD, question_text: 'rewritten', correct_choice_id: 'B' }),
      model: 'openai:test',
    });
    const seeded = await seed();
    const result = await enrichBookQuestion(pool as never, request(seeded), port);
    expect(Object.keys(result.envelope).sort()).toEqual(
      ['diagnostic_hypotheses', 'difficulty', 'explanation', 'measurement_structure'].sort(),
    );
  });

  it('refuses a package version that is not approved', async () => {
    const seeded = await seed('draft');
    await expect(enrichBookQuestion(pool as never, request(seeded), port)).rejects.toBeInstanceOf(
      TeachingPackageError,
    );
  });

  it('checks the envelope shape so a drifted response is retried before crossing to Kafuo', () => {
    const expected = { wrongChoiceIds: ['B', 'C'], needsExplanation: false };
    expect(enrichmentEnvelopeViolations(normalizeEnrichmentEnvelope(GOOD), expected)).toContain(
      'explanation must be null because the book printed one',
    );
    const missing = { ...GOOD, diagnostic_hypotheses: GOOD.diagnostic_hypotheses.slice(0, 1) };
    expect(
      enrichmentEnvelopeViolations(normalizeEnrichmentEnvelope(missing), {
        wrongChoiceIds: ['B', 'C'],
        needsExplanation: true,
      }).some((v) => v.includes('wrong choices')),
    ).toBe(true);
  });
});
