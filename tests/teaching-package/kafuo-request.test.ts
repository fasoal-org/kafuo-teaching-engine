import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertConfiguredGenerationRouteAvailable,
  buildKafuoStartRequest,
  canonicalRequestDigest,
  canonicalRequestPayload,
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

function normalized(url = 'https://r2.example.test/n.zip?X-Amz-Signature=abc') {
  return {
    id: 'ncr-1',
    url,
    mimeType: 'application/zip',
    schemaVersion: 'kafuo.normalized-content.v1',
    contentSourceId: 'cs-77',
    contentRevisionId: 'rev-1',
    parseRunId: 'run-1',
    structureProfile: { id: 'p-1', versionId: 'pv-1' },
    fileSizeBytes: 123,
    checksumSha256: 'a'.repeat(64),
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

  it('validates the normalized resource contract and content-source equality', () => {
    expect(
      parseKafuoGenerationRequest(body({ normalizedContentResource: normalized() })).request
        .normalizedContentResource?.schemaVersion,
    ).toBe('kafuo.normalized-content.v1');
    expect(() =>
      parseKafuoGenerationRequest(
        body({ normalizedContentResource: { ...normalized(), contentSourceId: 'other' } }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(() =>
      parseKafuoGenerationRequest(
        body({ normalizedContentResource: { ...normalized(), schemaVersion: 'v2' } }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'NORMALIZED_CONTENT_SCHEMA_UNSUPPORTED' }));
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

  it('covers the g5.v11 model answers only when sent (vector 7, owner 17 Nov 2026)', () => {
    const vector = vectors.vectors[6]!;
    const guide = vector.request.teacherGuide as {
      items: Array<Record<string, unknown>>;
    };
    expect(guide.items.filter((item) => 'modelAnswer' in item)).toHaveLength(2);
    const { request } = parseKafuoGenerationRequest(vector.request);
    // Kept exactly as sent (multi-line text included), key by key.
    expect(request.teacherGuide?.items[1]?.modelAnswer).toEqual(guide.items[1]!.modelAnswer);
    // The same block without its model answers: another digest, and no `modelAnswer` key.
    const stripped = parseKafuoGenerationRequest({
      ...vector.request,
      teacherGuide: {
        ...guide,
        items: guide.items.map(({ modelAnswer: _modelAnswer, ...item }) => item),
      },
    }).request;
    expect(canonicalRequestDigest(stripped)).not.toBe(vector.digest);
    expect(stripped.teacherGuide?.items.some((item) => 'modelAnswer' in item)).toBe(false);
    // `modelAnswer: null` is the Backend's "absent" (D-20): digested as never sent.
    const nulls = parseKafuoGenerationRequest({
      ...vector.request,
      teacherGuide: {
        ...guide,
        items: guide.items.map(({ modelAnswer: _modelAnswer, ...item }) =>
          item.status === 'reference' ? { ...item, modelAnswer: null } : item,
        ),
      },
    }).request;
    expect(canonicalRequestDigest(nulls)).toBe(canonicalRequestDigest(stripped));
  });

  it('covers a figure model answer without its presigned URL (vector 8, owner 17 Nov 2026)', () => {
    const vector = vectors.vectors[7]!;
    const guide = vector.request.teacherGuide as { items: Array<Record<string, unknown>> };
    const sent = guide.items[0]!.modelAnswer as { image: Record<string, unknown> };
    expect(typeof sent.image.url).toBe('string');
    const { request } = parseKafuoGenerationRequest(vector.request);
    // The request keeps the URL (the runner fetches the drawing from it) ...
    expect(request.teacherGuide?.items[0]?.modelAnswer).toEqual(sent);
    // ... the digest covers exactly the three stable image facts.
    const payload = canonicalRequestPayload(request) as {
      teacherGuide: { items: Array<{ modelAnswer: { kind: string; image: object } }> };
    };
    expect(payload.teacherGuide.items[0]!.modelAnswer).toEqual({
      kind: 'figure',
      image: {
        checksumSha256: sent.image.checksumSha256,
        mimeType: 'image/png',
        sizeBytes: sent.image.sizeBytes,
      },
    });
    expect(JSON.stringify(payload)).not.toContain('X-Amz-Signature=fig');
    // An independent encoding of the shared rules (the Backend's `semantic_payload`: sorted
    // keys, compact, UTF-8; the figure's `url` left out) gives the pinned digest.
    const raw = vector.request as Record<string, Record<string, unknown>> & {
      learningObjectives: Array<{ objectiveRef: string; snapshot: { statement: string } }>;
    };
    const { url: _url, ...stableImage } = sent.image;
    const semantic = {
      tenantContext: raw.tenantContext,
      learningItem: raw.learningItem,
      learningObjectives: raw.learningObjectives.map((objective) => ({
        objectiveRef: objective.objectiveRef,
        snapshot: { statement: objective.snapshot.statement },
      })),
      teachingModel: raw.teachingModel,
      contentResource: { id: raw.contentResource.id, mimeType: raw.contentResource.mimeType },
      generation: raw.generation,
      teacherGuide: {
        guideId: raw.teacherGuide.guideId,
        items: [{ ...guide.items[0], modelAnswer: { kind: 'figure', image: stableImage } }],
      },
    };
    const sorted = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(sorted)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
            )
          : value;
    expect(
      createHash('sha256')
        .update(JSON.stringify(sorted(semantic)), 'utf8')
        .digest('hex'),
    ).toBe(vector.digest);
    const withImage = (image: Record<string, unknown>) =>
      parseKafuoGenerationRequest({
        ...vector.request,
        teacherGuide: {
          ...guide,
          items: [
            { ...guide.items[0], modelAnswer: { ...sent, image: { ...sent.image, ...image } } },
          ],
        },
      }).request;
    // A re-minted URL (a resumed or re-sent request) is the same semantic request.
    expect(
      canonicalRequestDigest(
        withImage({ url: 'https://r2.example.test/teacher-guides/tg-2/answer-15.png?sig=NEW' }),
      ),
    ).toBe(vector.digest);
    // Another drawing is another request.
    expect(canonicalRequestDigest(withImage({ checksumSha256: 'f'.repeat(64) }))).not.toBe(
      vector.digest,
    );
    expect(canonicalRequestDigest(withImage({ sizeBytes: 48_214 }))).not.toBe(vector.digest);
  });

  it('covers the configured generation model route only when sent (vector 9, plan D-9)', () => {
    // teaching-generation-model-admin-config-plan-2026-11-18 D-9: vector 9 is
    // vector 1 plus `modelRoute` (requestId is outside the digest). The plan
    // called it "vector 6"; vectors 6-8 already existed, so it is appended.
    const vector = vectors.vectors[8]!;
    const route = vector.request.modelRoute as Record<string, unknown>;
    expect(route).toEqual({
      primary: { model: 'openai:gpt-6.1-terra', thinking: 'medium' },
      fallback: { model: 'openai:gpt-6-luna', thinking: 'low' },
      settingKey: 'teaching_generation.route.BIOLOGY',
    });
    const { request } = parseKafuoGenerationRequest(vector.request);
    expect(canonicalRequestDigest(request)).toBe(vector.digest);
    expect(vector.digest).not.toBe(vectors.vectors[0]!.digest);
    // Dropping the field gives back vector 1's pinned legacy digest byte for byte.
    const { modelRoute: _route, ...withoutRoute } = JSON.parse(
      JSON.stringify(vector.request),
    ) as Record<string, unknown>;
    expect(canonicalRequestDigest(parseKafuoGenerationRequest(withoutRoute).request)).toBe(
      vectors.vectors[0]!.digest,
    );
    // An independent encoding of the shared rules (sorted keys, compact, UTF-8;
    // requestId, actorRef and contentResource.url left out) gives the pinned digest.
    const raw = vector.request as Record<string, Record<string, unknown>> & {
      learningObjectives: Array<{ objectiveRef: string; snapshot: { statement: string } }>;
    };
    const semantic = {
      tenantContext: raw.tenantContext,
      learningItem: raw.learningItem,
      learningObjectives: raw.learningObjectives,
      teachingModel: raw.teachingModel,
      contentResource: { id: raw.contentResource.id, mimeType: raw.contentResource.mimeType },
      generation: raw.generation,
      modelRoute: route,
    };
    const sorted = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(sorted)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
            )
          : value;
    expect(
      createHash('sha256')
        .update(JSON.stringify(sorted(semantic)), 'utf8')
        .digest('hex'),
    ).toBe(vector.digest);
  });

  it('covers the planning and review route only when sent (vector 10, plan §3c)', () => {
    // package-planner-issue-resolve-plan-2026-11-22 §3c: vector 10 is vector 1
    // plus `planRoute` (requestId is outside the digest). Vector 9 stays as is.
    const vector = vectors.vectors[9]!;
    const route = vector.request.planRoute as Record<string, unknown>;
    expect(route).toEqual({
      primary: { model: 'anthropic:claude-opus-5-5', thinking: 'high' },
      fallback: { model: 'openai:gpt-6.1-terra', thinking: 'medium' },
      settingKey: 'teaching_generation.plan_route.BIOLOGY',
    });
    expect(vector.request).not.toHaveProperty('modelRoute');
    const { request } = parseKafuoGenerationRequest(vector.request);
    expect(canonicalRequestDigest(request)).toBe(vector.digest);
    expect(vector.digest).not.toBe(vectors.vectors[0]!.digest);
    expect(vector.digest).not.toBe(vectors.vectors[8]!.digest);
    // Dropping the field gives back vector 1's pinned legacy digest byte for byte.
    const { planRoute: _route, ...withoutRoute } = JSON.parse(
      JSON.stringify(vector.request),
    ) as Record<string, unknown>;
    expect(canonicalRequestDigest(parseKafuoGenerationRequest(withoutRoute).request)).toBe(
      vectors.vectors[0]!.digest,
    );
  });

  it('covers "regenerate as the original" only when sent (vector 11, plan D-18)', () => {
    // Vector 11 is vector 1 plus `versionId` and `routePin` (requestId is outside the
    // digest). The Backend's `semantic_payload` gives the same pinned digest.
    const vector = vectors.vectors[10]!;
    expect(vector.request.routePin).toBe('original');
    expect(vector.request.versionId).toBe('tpv-11');
    expect(vector.request).not.toHaveProperty('modelRoute');
    expect(vector.request).not.toHaveProperty('planRoute');
    const { request } = parseKafuoGenerationRequest(vector.request);
    expect(request.routePin).toBe('original');
    expect(canonicalRequestPayload(request).routePin).toBe('original');
    expect(canonicalRequestDigest(request)).toBe(vector.digest);
    // Without the pin it is a plain regeneration of the same version: another digest.
    const { routePin: _pin, ...unpinned } = JSON.parse(JSON.stringify(vector.request)) as Record<
      string,
      unknown
    >;
    const plain = parseKafuoGenerationRequest(unpinned).request;
    expect(plain).not.toHaveProperty('routePin');
    expect(canonicalRequestPayload(plain)).not.toHaveProperty('routePin');
    expect(canonicalRequestDigest(plain)).not.toBe(vector.digest);
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

  it('includes stable normalized facts but excludes its refreshed signed URL', () => {
    const first = parseKafuoGenerationRequest(
      body({ normalizedContentResource: normalized() }),
    ).request;
    const refreshed = parseKafuoGenerationRequest(
      body({
        normalizedContentResource: normalized('https://r2.example.test/n.zip?X-Amz-Signature=NEW'),
      }),
    ).request;
    const changed = parseKafuoGenerationRequest(
      body({ normalizedContentResource: { ...normalized(), parseRunId: 'run-2' } }),
    ).request;
    expect(canonicalRequestDigest(first)).toBe(canonicalRequestDigest(refreshed));
    expect(canonicalRequestDigest(first)).not.toBe(canonicalRequestDigest(changed));
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
    // The authoritative lesson language travels as structured data — not only
    // as prose inside the requirement — so generation can stamp the Stage.
    expect(start.generation.language).toBe('ar');
    expect(kafuo.language).toBe('ar');
    // The signed URL lives ONLY in the in-memory Kafuo context — and appears
    // nowhere in the persisted start request.
    expect(kafuo.contentResource.url).toContain('X-Amz-Signature');
    expect(JSON.stringify(start)).not.toContain('https://');
    expect(JSON.stringify(start)).not.toContain('X-Amz-Signature');
  });

  it('keeps the normalized signed URL only in execution memory', () => {
    const { request, aggregate } = parseKafuoGenerationRequest(
      body({ normalizedContentResource: normalized() }),
    );
    const { start, kafuo } = buildKafuoStartRequest(request, aggregate);
    expect(JSON.stringify(start.normalizedContentResource)).not.toContain('https://');
    expect(JSON.stringify(start)).not.toContain('X-Amz-Signature');
    expect(kafuo.normalizedContentResource?.url).toContain('X-Amz-Signature');
  });
});

describe('teachingModel.flow[].scenePolicy (g5.v5+)', () => {
  const POLICY = {
    sceneTypes: ['slide'],
    contentRoles: ['explanation', 'procedure', 'worked_example', 'example', 'activity'],
    visual: 'source_grounded',
    cardinality: 'one_or_more',
  };
  const withPolicy = (scenePolicy: unknown) =>
    body({
      teachingModel: {
        key: 'g5',
        version: 'g5.v5',
        flow: [{ stage: 'outcome_visual_explanations', instructions: 'Teach O1.', scenePolicy }],
      },
    });

  it('parses the policy exactly as received and carries it into the run context', () => {
    const { request, aggregate } = parseKafuoGenerationRequest(withPolicy(POLICY));
    expect(request.teachingModel.flow[0]?.scenePolicy).toEqual(POLICY);
    const { start, kafuo } = buildKafuoStartRequest(request, aggregate);
    expect(kafuo.teachingFlow[0]?.scenePolicy).toEqual(POLICY);
    expect(start.teachingFlow?.[0]?.scenePolicy).toEqual(POLICY);
  });

  it('refuses a malformed policy at the parse seam (FLOW_INVALID)', () => {
    expect(() =>
      parseKafuoGenerationRequest(withPolicy({ ...POLICY, contentRoles: ['lecture'] })),
    ).toThrowError(expect.objectContaining({ code: 'FLOW_INVALID' }));
  });

  it('participates in the digest only when present', () => {
    const plain = parseKafuoGenerationRequest(
      body({
        teachingModel: {
          key: 'g5',
          version: 'g5.v5',
          flow: [{ stage: 'outcome_visual_explanations', instructions: 'Teach O1.' }],
        },
      }),
    ).request;
    const governed = parseKafuoGenerationRequest(withPolicy(POLICY)).request;
    const widened = parseKafuoGenerationRequest(
      withPolicy({ ...POLICY, contentRoles: [...POLICY.contentRoles, 'summary'] }),
    ).request;
    expect(canonicalRequestDigest(plain)).not.toBe(canonicalRequestDigest(governed));
    expect(canonicalRequestDigest(governed)).not.toBe(canonicalRequestDigest(widened));
  });
});

describe('narration.ttsRoute (superadmin-configured route, plan §3.2)', () => {
  const REEM = '92f27ee5-d8b9-4c0a-a0c2-f401f6ab0a72';
  const ROUTE = {
    providerId: 'cartesia-tts',
    voiceId: REEM,
    settingKey: 'teaching_tts.route.MATH',
  };
  const withRoute = (ttsRoute: unknown) => body({ narration: { ttsRoute } });

  it('absent stays absent: no field on the request and no route on the context', () => {
    const { request, aggregate } = parseKafuoGenerationRequest(body());
    expect(request).not.toHaveProperty('narration');
    expect(buildKafuoStartRequest(request, aggregate).kafuo).not.toHaveProperty('ttsRoute');
  });

  it('parses a catalogue voice and freezes model + language from the catalogue on the context', () => {
    const { request, aggregate } = parseKafuoGenerationRequest(withRoute(ROUTE));
    expect(request.narration).toEqual({ ttsRoute: ROUTE });
    expect(buildKafuoStartRequest(request, aggregate).kafuo.ttsRoute).toEqual({
      routeId: 'configured',
      providerId: 'cartesia-tts',
      modelId: 'sonic-3.6',
      voiceId: REEM,
      language: 'ar',
      settingKey: 'teaching_tts.route.MATH',
    });
  });

  it('changes the digest when present, and with every route field', () => {
    const plain = canonicalRequestDigest(parseKafuoGenerationRequest(body()).request);
    const routed = canonicalRequestDigest(parseKafuoGenerationRequest(withRoute(ROUTE)).request);
    const otherKey = canonicalRequestDigest(
      parseKafuoGenerationRequest(withRoute({ ...ROUTE, settingKey: 'teaching_tts.route.PHYSICS' }))
        .request,
    );
    const qwen = canonicalRequestDigest(
      parseKafuoGenerationRequest(
        withRoute({ ...ROUTE, providerId: 'qwen-tts', voiceId: 'longanlufeng' }),
      ).request,
    );
    expect(new Set([plain, routed, otherKey, qwen]).size).toBe(4);
  });

  it.each([
    ['not an object', 'cartesia-tts'],
    ['a missing ttsRoute', undefined],
    ['an unknown provider', { ...ROUTE, providerId: 'elevenlabs-tts' }],
    ['a voice of another provider', { ...ROUTE, voiceId: 'longanlufeng' }],
    [
      'a non-Arabic/English catalogue voice',
      { ...ROUTE, providerId: 'qwen-tts', voiceId: 'Cherry' },
    ],
    ['a malformed setting key', { ...ROUTE, settingKey: 'billing.plan' }],
  ])('refuses %s with TTS_ROUTE_INVALID (400)', (_label, ttsRoute) => {
    expect(() => parseKafuoGenerationRequest(withRoute(ttsRoute))).toThrowError(
      expect.objectContaining({ code: 'TTS_ROUTE_INVALID', status: 400 }),
    );
  });

  it('refuses null narration (only an absent field means the default table)', () => {
    expect(() => parseKafuoGenerationRequest(body({ narration: null }))).toThrowError(
      expect.objectContaining({ code: 'TTS_ROUTE_INVALID' }),
    );
  });

  it('refuses a voice whose language differs from learningItem.language (D-5)', () => {
    const english = body();
    english.learningItem = { ...english.learningItem, language: 'en' };
    expect(() =>
      parseKafuoGenerationRequest({ ...english, narration: { ttsRoute: ROUTE } }),
    ).toThrowError(expect.objectContaining({ code: 'TTS_ROUTE_INVALID' }));
    expect(
      parseKafuoGenerationRequest({
        ...english,
        narration: { ttsRoute: { ...ROUTE, providerId: 'openai-tts', voiceId: 'alloy' } },
      }).request.narration?.ttsRoute.voiceId,
    ).toBe('alloy');
  });
});

describe('modelRoute (superadmin-configured generation route, teaching-generation-model plan D-9)', () => {
  const ROUTE = {
    primary: { model: 'openai:gpt-6.1-terra', thinking: 'medium' },
    fallback: { model: 'qwen:qwen3.7-flash', thinking: 'off' },
    settingKey: 'teaching_generation.route.MATH',
  };
  // A route is a subject's setting, so its request names that subject (MATH).
  const mathBody = (overrides: Record<string, unknown> = {}) => {
    const base = body(overrides);
    return { ...base, learningItem: { ...base.learningItem, subjectOffering: { code: 'MATH' } } };
  };

  it('absent stays absent: no field on the request, no route on the context, digest unchanged', () => {
    const { request, aggregate } = parseKafuoGenerationRequest(body());
    expect(request).not.toHaveProperty('modelRoute');
    expect(canonicalRequestPayload(request)).not.toHaveProperty('modelRoute');
    expect(buildKafuoStartRequest(request, aggregate).kafuo).not.toHaveProperty('modelRoute');
  });

  it('parses a catalogue route onto the request and the run context, and covers it in the digest', () => {
    const { request, aggregate } = parseKafuoGenerationRequest(mathBody({ modelRoute: ROUTE }));
    expect(request.modelRoute).toEqual(ROUTE);
    const { start, kafuo } = buildKafuoStartRequest(request, aggregate);
    expect(kafuo.modelRoute).toEqual(ROUTE);
    // The persisted start snapshot does not carry it: the runner freezes it (D-10).
    expect(start).not.toHaveProperty('modelRoute');
    const payload = canonicalRequestPayload(request);
    expect(Object.keys(payload.modelRoute as object)).toEqual([
      'primary',
      'fallback',
      'settingKey',
    ]);
    expect(payload.modelRoute).toEqual(ROUTE);
  });

  it('changes the digest with every route field', () => {
    const digest = (overrides: Record<string, unknown>) =>
      canonicalRequestDigest(parseKafuoGenerationRequest(mathBody(overrides)).request);
    const all = [
      digest({}),
      digest({ modelRoute: ROUTE }),
      digest({
        modelRoute: { ...ROUTE, primary: { model: 'openai:gpt-6-sol', thinking: 'medium' } },
      }),
      digest({ modelRoute: { ...ROUTE, primary: { ...ROUTE.primary, thinking: 'high' } } }),
      digest({ modelRoute: { ...ROUTE, fallback: { model: 'qwen:qwen4-max', thinking: 'on' } } }),
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it.each([
    ['null (only an absent field means the default table)', null],
    ['not an object', 'openai:gpt-6.1-terra'],
    [
      'a model outside the catalogue',
      { ...ROUTE, primary: { model: 'openai:gpt-5-nano', thinking: 'low' } },
    ],
    [
      'a thinking value the model does not offer',
      { ...ROUTE, primary: { ...ROUTE.primary, thinking: 'on' } },
    ],
    [
      'primary = fallback',
      { ...ROUTE, fallback: { model: 'openai:gpt-6.1-terra', thinking: 'low' } },
    ],
    ['a malformed setting key', { ...ROUTE, settingKey: 'billing.plan' }],
    [
      "another subject's setting key",
      { ...ROUTE, settingKey: 'teaching_generation.route.PHYSICS' },
    ],
  ])('refuses %s with GENERATION_ROUTE_INVALID (400)', (_label, modelRoute) => {
    expect(() => parseKafuoGenerationRequest(mathBody({ modelRoute }))).toThrowError(
      expect.objectContaining({ code: 'GENERATION_ROUTE_INVALID', status: 400 }),
    );
  });

  it('refuses a route sent inside `generation` instead of dropping it', () => {
    expect(() =>
      parseKafuoGenerationRequest(body({ generation: { enableTTS: true, modelRoute: ROUTE } })),
    ).toThrowError(expect.objectContaining({ code: 'GENERATION_ROUTE_INVALID' }));
  });

  it('parses without reading any server key (availability is the route’s check)', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('QWEN_API_KEY', '');
    try {
      expect(
        parseKafuoGenerationRequest(mathBody({ modelRoute: ROUTE })).request.modelRoute,
      ).toEqual(ROUTE);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('planRoute (planning and review model, package-planner-issue-resolve-plan §3c)', () => {
  const PLAN = {
    primary: { model: 'anthropic:claude-opus-5-5', thinking: 'high' },
    fallback: { model: 'openai:gpt-6.1-terra', thinking: 'medium' },
    settingKey: 'teaching_generation.plan_route.MATH',
  };
  const GENERATION = {
    primary: { model: 'openai:gpt-6.1-terra', thinking: 'medium' },
    fallback: { model: 'qwen:qwen3.7-flash', thinking: 'off' },
    settingKey: 'teaching_generation.route.MATH',
  };
  const mathBody = (overrides: Record<string, unknown> = {}) => {
    const base = body(overrides);
    return { ...base, learningItem: { ...base.learningItem, subjectOffering: { code: 'MATH' } } };
  };

  it('absent stays absent: no field on the request, no route on the context, digest unchanged', () => {
    const { request, aggregate } = parseKafuoGenerationRequest(mathBody());
    expect(request).not.toHaveProperty('planRoute');
    expect(canonicalRequestPayload(request)).not.toHaveProperty('planRoute');
    expect(buildKafuoStartRequest(request, aggregate).kafuo).not.toHaveProperty('planRoute');
  });

  it('parses a catalogue route onto the request and the run context, and covers it in the digest', () => {
    const { request, aggregate } = parseKafuoGenerationRequest(mathBody({ planRoute: PLAN }));
    expect(request.planRoute).toEqual(PLAN);
    const { start, kafuo } = buildKafuoStartRequest(request, aggregate);
    expect(kafuo.planRoute).toEqual(PLAN);
    expect(kafuo).not.toHaveProperty('modelRoute');
    // The runner freezes it on the attempt, not the start snapshot.
    expect(start).not.toHaveProperty('planRoute');
    const payload = canonicalRequestPayload(request);
    expect(Object.keys(payload.planRoute as object)).toEqual(['primary', 'fallback', 'settingKey']);
    expect(payload.planRoute).toEqual(PLAN);
  });

  it('is independent of modelRoute: either, both or neither, each a different digest', () => {
    const digest = (overrides: Record<string, unknown>) =>
      canonicalRequestDigest(parseKafuoGenerationRequest(mathBody(overrides)).request);
    const both = parseKafuoGenerationRequest(
      mathBody({ modelRoute: GENERATION, planRoute: PLAN }),
    ).request;
    expect(both.modelRoute).toEqual(GENERATION);
    expect(both.planRoute).toEqual(PLAN);
    const all = [
      digest({}),
      digest({ planRoute: PLAN }),
      digest({ modelRoute: GENERATION }),
      digest({ modelRoute: GENERATION, planRoute: PLAN }),
      digest({ planRoute: { ...PLAN, primary: { ...PLAN.primary, thinking: 'max' } } }),
      digest({ planRoute: { ...PLAN, fallback: { model: 'qwen:qwen4-max', thinking: 'on' } } }),
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it.each([
    ['null (only an absent field means the generation route)', null],
    ['not an object', 'anthropic:claude-opus-5-5'],
    [
      'a model outside the catalogue',
      { ...PLAN, primary: { model: 'openai:gpt-5-nano', thinking: 'low' } },
    ],
    [
      'a thinking value the model does not offer',
      { ...PLAN, primary: { ...PLAN.primary, thinking: 'on' } },
    ],
    [
      'primary = fallback',
      { ...PLAN, fallback: { model: 'anthropic:claude-opus-5-5', thinking: 'low' } },
    ],
    [
      'a generation-route key (the wrong key family)',
      { ...PLAN, settingKey: 'teaching_generation.route.MATH' },
    ],
    [
      "another subject's setting key",
      { ...PLAN, settingKey: 'teaching_generation.plan_route.PHYSICS' },
    ],
  ])('refuses %s with GENERATION_ROUTE_INVALID (400)', (_label, planRoute) => {
    expect(() => parseKafuoGenerationRequest(mathBody({ planRoute }))).toThrowError(
      expect.objectContaining({ code: 'GENERATION_ROUTE_INVALID', status: 400 }),
    );
  });

  it('refuses a plan-route key sent as the generation route (the wrong key family)', () => {
    expect(() =>
      parseKafuoGenerationRequest(
        mathBody({ modelRoute: { ...GENERATION, settingKey: PLAN.settingKey } }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'GENERATION_ROUTE_INVALID' }));
  });

  it('refuses a planRoute sent inside `generation` instead of dropping it', () => {
    expect(() =>
      parseKafuoGenerationRequest(mathBody({ generation: { enableTTS: true, planRoute: PLAN } })),
    ).toThrowError(
      expect.objectContaining({
        code: 'GENERATION_ROUTE_INVALID',
        message: expect.stringContaining('generation.planRoute is not accepted'),
      }),
    );
  });

  it('a plan target without a server key is refused with GENERATION_ROUTE_UNAVAILABLE (409), naming the env var only', () => {
    vi.stubEnv('TEACHING_SUBJECT_ROUTING', 'enforced');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    try {
      const { request, aggregate } = parseKafuoGenerationRequest(mathBody({ planRoute: PLAN }));
      const { kafuo } = buildKafuoStartRequest(request, aggregate);
      expect(() => assertConfiguredGenerationRouteAvailable(kafuo)).toThrowError(
        expect.objectContaining({
          code: 'GENERATION_ROUTE_UNAVAILABLE',
          status: 409,
          details: expect.objectContaining({
            role: 'primary',
            model: 'anthropic:claude-opus-5-5',
            settingKey: 'teaching_generation.plan_route.MATH',
            keyEnvVar: 'ANTHROPIC_API_KEY',
          }),
        }),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('routePin ("regenerate as the original", plan D-18)', () => {
  const ROUTE = {
    primary: { model: 'openai:gpt-6.1-terra', thinking: 'medium' },
    fallback: { model: 'qwen:qwen3.7-flash', thinking: 'off' },
    settingKey: 'teaching_generation.route.MATH',
  };
  const regeneration = (overrides: Record<string, unknown> = {}) => {
    const base = body({ versionId: 'tpv-1', ...overrides });
    return { ...base, learningItem: { ...base.learningItem, subjectOffering: { code: 'MATH' } } };
  };

  it('absent stays absent: no pin on the request, the context or the digest', () => {
    const { request, aggregate } = parseKafuoGenerationRequest(regeneration());
    expect(request).not.toHaveProperty('routePin');
    expect(canonicalRequestPayload(request)).not.toHaveProperty('routePin');
    expect(buildKafuoStartRequest(request, aggregate).kafuo).not.toHaveProperty('routePin');
  });

  it('carries "original" onto the run context; the start snapshot gets it only once resolved', () => {
    const { request, aggregate } = parseKafuoGenerationRequest(
      regeneration({ routePin: 'original' }),
    );
    const { start, kafuo } = buildKafuoStartRequest(request, aggregate);
    expect(kafuo.routePin).toBe('original');
    expect(kafuo).not.toHaveProperty('modelRoute');
    expect(start).not.toHaveProperty('routePin');
  });

  it.each([
    ['another value', { routePin: 'today' }],
    ['null', { routePin: null }],
    ['an initial generation (no versionId)', { routePin: 'original', versionId: undefined }],
    ['a sent modelRoute beside it', { routePin: 'original', modelRoute: ROUTE }],
    [
      'a sent planRoute beside it',
      {
        routePin: 'original',
        planRoute: { ...ROUTE, settingKey: 'teaching_generation.plan_route.MATH' },
      },
    ],
  ])('refuses %s with GENERATION_ROUTE_INVALID (400)', (_label, overrides) => {
    expect(() => parseKafuoGenerationRequest(regeneration(overrides))).toThrowError(
      expect.objectContaining({ code: 'GENERATION_ROUTE_INVALID', status: 400 }),
    );
  });
});
