import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildKafuoStartRequest,
  canonicalRequestDigest,
  parseKafuoGenerationRequest,
} from '@/lib/server/teaching-package/kafuo-request';

function body(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'kafuo-req-1',
    tenantContext: { tenantId: 'tenant-1' },
    actorRef: 'user-42',
    learningItem: {
      type: 'lesson',
      id: '901',
      title: 'Photosynthesis',
      unit: { id: '12', title: 'Unit 3' },
      curriculum: { id: '5', name: 'Science 5' },
      curriculumVersion: { id: '8', versionLabel: '2026-A' },
      language: 'ar',
    },
    learningObjectives: [
      { objectiveRef: '7001', snapshot: { statement: 'Explain photosynthesis.' } },
    ],
    teachingModel: {
      key: 'g5',
      version: 'g5.v1',
      flow: [
        { stage: 'lesson_introduction', instructions: 'Introduce the item once.' },
        { stage: 'outcome_teaching_cards', instructions: 'Cards for O1.' },
        { stage: 'outcome_worked_examples', instructions: 'Examples for O1.' },
      ],
    },
    contentResource: {
      id: 'cs-77',
      url: 'https://r2.example.test/lesson.pdf?X-Amz-Signature=abc',
      mimeType: 'application/pdf',
    },
    generation: { enableTTS: true },
    ...overrides,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe('parseKafuoGenerationRequest', () => {
  it('parses a valid request and derives the aggregate scope', () => {
    const { request, aggregate } = parseKafuoGenerationRequest(body());
    expect(aggregate).toEqual({
      tenantId: 'tenant-1',
      learningItem: { type: 'lesson', id: '901' },
    });
    expect(request.teachingModel.flow).toHaveLength(3);
  });

  it('requires tenantContext (TENANT_REQUIRED)', () => {
    const { tenantContext: _drop, ...withoutTenant } = body();
    expect(() => parseKafuoGenerationRequest(withoutTenant)).toThrowError(
      expect.objectContaining({ code: 'TENANT_REQUIRED', status: 400 }),
    );
  });

  it('rejects tenantId smuggled inside learningItem', () => {
    const smuggled = body({
      learningItem: { ...body().learningItem, tenantId: 'tenant-evil' },
    });
    expect(() => parseKafuoGenerationRequest(smuggled)).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
  });

  it('requires a non-empty flow (FLOW_REQUIRED / FLOW_INVALID)', () => {
    expect(() =>
      parseKafuoGenerationRequest(body({ teachingModel: { key: 'g5', version: 'g5.v1' } })),
    ).toThrowError(expect.objectContaining({ code: 'FLOW_REQUIRED' }));
    expect(() =>
      parseKafuoGenerationRequest(
        body({ teachingModel: { key: 'g5', version: 'g5.v1', flow: [] } }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'FLOW_REQUIRED' }));
    expect(() =>
      parseKafuoGenerationRequest(
        body({
          teachingModel: {
            key: 'g5',
            version: 'g5.v1',
            flow: [{ stage: 'lesson_introduction', instructions: '  ' }],
          },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'FLOW_INVALID' }));
  });

  it('allows repeated stage keys — identity is (flowIndex, stage)', () => {
    const request = body({
      teachingModel: {
        key: 'g5',
        version: 'g5.v1',
        flow: [
          { stage: 'lesson_introduction', instructions: 'i' },
          { stage: 'outcome_teaching_cards', instructions: 'a' },
          { stage: 'outcome_teaching_cards', instructions: 'b' },
        ],
      },
    });
    expect(() => parseKafuoGenerationRequest(request)).not.toThrow();
  });

  it('requires the content resource (CONTENT_RESOURCE_REQUIRED)', () => {
    expect(() => parseKafuoGenerationRequest(body({ contentResource: undefined }))).toThrowError(
      expect.objectContaining({ code: 'CONTENT_RESOURCE_REQUIRED' }),
    );
    expect(() =>
      parseKafuoGenerationRequest(
        body({ contentResource: { id: 'cs', url: 'https://x/y', mimeType: 'text/html' } }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'CONTENT_RESOURCE_REQUIRED' }));
  });

  it('requires https resource URLs in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() =>
      parseKafuoGenerationRequest(
        body({ contentResource: { id: 'cs', url: 'http://r2.example.test/lesson.pdf' } }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'CONTENT_RESOURCE_REQUIRED' }));
  });

  it('refuses provider routing fields inside generation', () => {
    expect(() =>
      parseKafuoGenerationRequest(
        body({ generation: { ...body().generation, webSearchProviderId: 'tavily' } }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(() =>
      parseKafuoGenerationRequest(
        body({ generation: { ...body().generation, webSearchApiKey: 'sk-x' } }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it('requires approved objectives in order', () => {
    expect(() => parseKafuoGenerationRequest(body({ learningObjectives: [] }))).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
  });
});

describe('canonicalRequestDigest', () => {
  const vectors = JSON.parse(
    readFileSync(path.join(__dirname, '..', 'fixtures', 'kafuo-digest-vectors.json'), 'utf8'),
  ) as { vectors: Array<{ request: Record<string, unknown>; digest: string }> };

  it('matches the shared pinned vectors', () => {
    for (const vector of vectors.vectors) {
      const { request } = parseKafuoGenerationRequest(vector.request);
      expect(canonicalRequestDigest(request)).toBe(vector.digest);
    }
  });

  it('is independent of the signed retrieval URL', () => {
    const first = parseKafuoGenerationRequest(body()).request;
    const second = parseKafuoGenerationRequest(
      body({
        contentResource: {
          ...body().contentResource,
          url: 'https://r2.example.test/lesson.pdf?X-Amz-Signature=DIFFERENT',
        },
      }),
    ).request;
    expect(canonicalRequestDigest(first)).toBe(canonicalRequestDigest(second));
  });

  it('changes when a semantic input changes', () => {
    const first = parseKafuoGenerationRequest(body()).request;
    const second = parseKafuoGenerationRequest(
      body({
        learningObjectives: [
          { objectiveRef: '7001', snapshot: { statement: 'Explain respiration.' } },
        ],
      }),
    ).request;
    expect(canonicalRequestDigest(first)).not.toBe(canonicalRequestDigest(second));
  });

  it('changes when the regeneration versionId is added', () => {
    const first = parseKafuoGenerationRequest(body()).request;
    const second = parseKafuoGenerationRequest(body({ versionId: 'tpv-1' })).request;
    expect(canonicalRequestDigest(first)).not.toBe(canonicalRequestDigest(second));
  });
});

describe('buildKafuoStartRequest', () => {
  it('builds a digest-bearing start request whose snapshot carries no URL', () => {
    const { request, aggregate } = parseKafuoGenerationRequest(body());
    const { start, kafuo } = buildKafuoStartRequest(request, aggregate);
    expect(start.tenantId).toBe('tenant-1');
    expect(start.requestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(start.contentResource)).not.toContain('X-Amz-Signature');
    expect(JSON.stringify(start.contentResource)).not.toContain('https://');
    expect(start.generation.teachingFlow).toHaveLength(3);
    expect(start.generation.requirement).toContain('lesson_introduction');
    // The signed URL lives ONLY in the in-memory Kafuo context — and appears
    // nowhere in the persisted start request.
    expect(kafuo.contentResource.url).toContain('X-Amz-Signature');
    expect(JSON.stringify(start)).not.toContain('https://');
    expect(JSON.stringify(start)).not.toContain('X-Amz-Signature');
  });
});
