/**
 * Shared PGlite harness of the wave F2 agent edit-op tests: a package Stage saved through
 * the real owner-bound store and stage guard, a version (optionally governed, with a
 * generation baseline on every classified slide), and the real `agent-ops/[op]` route.
 * Each test file mocks what it needs (`next/server` `after`, TTS) before importing this.
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import type { AppStage } from '@/lib/document-store/persistence-types';
import type { AppScene } from '@/lib/types/stage';
import type { TeachingFlowEntry } from '@/lib/types/teaching-package';
import { makeDocument, makeSlideScene } from '../../agent-runtime/_stage-fixtures';

export class PGlitePool {
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

export const STAGE = 'stage-agent-edit';
export const VERSION = `tpv-${STAGE}`;
export const TENANT = 'tenant-test';
export const SERVICE_KEY = 'agent-edit-pg-key';
export const AGENT = 'agent:5';
export const SKILL = { skillId: 'feynman-learning', version: 'v1' };

const FLOW: TeachingFlowEntry[] = [
  {
    stage: 'explain',
    instructions: 'i',
    skillPolicy: { required: [], preferred: [], allowed: [SKILL], combinationRestrictions: [] },
  },
];

export function textSlide(id: string, order: number, text = 'النص القديم'): AppScene {
  const base = makeSlideScene(id, STAGE, order);
  const content = base.content as { canvas: { elements: unknown[] } };
  content.canvas.elements = [
    {
      id: `${id}-text`,
      type: 'text',
      left: 100,
      top: 100,
      width: 400,
      height: 80,
      rotate: 0,
      content: `<p>${text}</p>`,
      defaultFontName: 'Inter',
      defaultColor: '#111111',
    },
    {
      id: `${id}-shape`,
      type: 'shape',
      left: 10,
      top: 10,
      width: 50,
      height: 50,
      rotate: 0,
      viewBox: [200, 200],
      path: 'M 0 0 L 200 0 L 200 200 L 0 200 Z',
      fixedRatio: false,
      fill: '#ffffff',
    },
  ];
  return {
    ...base,
    teachingStage: { key: 'explain', flowIndex: 0 },
    actions: [
      { id: `${id}-speech-1`, type: 'speech', text: 'طيب خلونا نشوف هذي الفكرة', audioId: 'aud-1' },
      { id: `${id}-speech-2`, type: 'speech', text: 'الحين نكمل', audioId: 'aud-2' },
    ],
  } as unknown as AppScene;
}

export function quizScene(id: string, order: number): AppScene {
  return {
    id,
    stageId: STAGE,
    order,
    title: `Quiz ${order}`,
    type: 'quiz',
    teachingStage: { key: 'explain', flowIndex: 0 },
    createdAt: 1,
    updatedAt: 1,
    content: {
      type: 'quiz',
      questions: [
        {
          id: 'q1',
          type: 'single',
          question: 'ما ناتج 2 + 2؟',
          options: [
            { label: '3', value: 'A' },
            { label: '4', value: 'B' },
            { label: '5', value: 'C' },
          ],
          answer: ['A'],
          analysis: 'لأن',
          points: 1,
        },
        {
          id: 'q2',
          type: 'multiple',
          question: 'اختر الأعداد الزوجية',
          options: [
            { label: '2', value: 'A' },
            { label: '3', value: 'B' },
            { label: '4', value: 'C' },
          ],
          answer: ['A', 'C'],
          points: 1,
        },
        {
          id: 'q3',
          type: 'short_answer',
          question: 'اكتب ناتج 3 × 3',
          answer: ['9'],
          points: 2,
        },
      ],
    },
  } as unknown as AppScene;
}

export interface Harness {
  pool: PGlitePool;
  post(op: string, body: Record<string, unknown>): Promise<Response>;
  read(): Promise<{ scenes: Array<Record<string, unknown>>; revision: string }>;
  revision(): Promise<number>;
  scene(sceneId: string): Promise<AppScene>;
  /** A teacher's own editor write (the generic scene save, no agent row). */
  teacherPut(scene: AppScene): Promise<void>;
  count(sql: string): Promise<number>;
}

export async function setupHarness(options: {
  scenes: AppScene[];
  governed?: boolean;
  teachingModel?: { key: string; version: string };
  /** Scenes saved stale: their baseline is built, then their title changes. */
  staleSceneIds?: string[];
  /** The producing attempt's routed subject (governed packages only): the register policy. */
  subjectCode?: string;
}): Promise<Harness> {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('DATABASE_URL', `postgres://agent-edit-${randomUUID()}`);
  vi.stubEnv('ASSET_S3_BUCKET', '');
  vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
  const db = new PGlite();
  await db.waitReady;
  const pool = new PGlitePool(db);
  const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
  await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
  const { insertVersion, insertAttempt } = await import('@/lib/persistence/teaching-package');
  const { TEACHING_PACKAGE_STAGE_OWNER } = await import('@/lib/server/teaching-package/owner');
  const { teachingPackageStageGuardFence } =
    await import('@/lib/server/teaching-package/stage-guard');
  const { buildSceneAlignmentBaseline } = await import('@/lib/server/teaching-package/alignment');
  const makeStore = () =>
    createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
  const governed = options.governed ?? false;
  const scenes = governed
    ? options.scenes.map(
        (scene) =>
          ({
            ...scene,
            teachingSkills: { primary: SKILL, classification: 'instructional' },
          }) as AppScene,
      )
    : options.scenes;
  const document = makeDocument(STAGE, 'Draft package', scenes);
  document.stage = { ...document.stage, language: 'ar-SA' } as never;
  await makeStore().saveDocument(document);
  const item = { type: 'lesson' as const, id: `li-${STAGE}` };
  const model = options.teachingModel ?? { key: 'g5', version: 'g5.v1' };
  const attemptId = governed ? `tpa-${STAGE}` : undefined;
  await insertVersion(pool as never, {
    id: VERSION,
    aggregate: { tenantId: TENANT, learningItem: item },
    version: 1,
    status: 'draft',
    currentStageId: STAGE,
    ...(attemptId ? { currentAttemptId: attemptId } : {}),
    teachingModel: model,
    now: 1,
  });
  if (attemptId) {
    await insertAttempt(
      pool as never,
      {
        id: attemptId,
        aggregate: { tenantId: TENANT, learningItem: item },
        kind: 'initial',
        status: 'succeeded',
        requestedByActorRef: 'actor-1',
        teachingModel: model,
        teachingSkillsContract: 'kafuo.teaching-skills.v1',
        inputSnapshot: {
          learningItem: item,
          teachingModel: model,
          learningObjectives: [],
          contentUnitRefs: [],
          sourceRefs: [],
          generationContext: {},
          generationOptions: {},
          requirementDigest: '0'.repeat(64),
          requirementPreview: 'p',
          pdfContentSummary: null,
          requestedAt: 1,
          teachingFlow: FLOW,
          ...(options.subjectCode ? { subjectCode: options.subjectCode } : {}),
        },
        now: 1,
      } as never,
    );
    // A generation baseline on the STORED (migrated) scenes, as the run stamps it.
    const stored = (await makeStore().loadDocument(STAGE))!;
    for (const scene of stored.scenes) {
      const baseline = buildSceneAlignmentBaseline(scene, { origin: 'generation', now: 1 });
      let next = { ...scene, alignmentBaseline: baseline! } as AppScene;
      if (options.staleSceneIds?.includes(scene.id)) {
        next = { ...next, title: `${scene.title} (changed before the agent)` } as AppScene;
      }
      await makeStore().putScene(STAGE, next);
    }
  }

  const post = async (op: string, body: Record<string, unknown>) => {
    const { POST } = await import('@/app/api/teaching-packages/[id]/agent-ops/[op]/route');
    return POST(
      new NextRequest(`http://localhost/api/teaching-packages/${VERSION}/agent-ops/${op}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tenantContext: { tenantId: TENANT }, actorRef: AGENT, ...body }),
      }),
      { params: Promise.resolve({ id: VERSION, op }) },
    );
  };
  const revision = async () => {
    const { getOwnerScopedDocumentStore } =
      await import('@/lib/server/agent-runtime/owner-scoped-documents');
    const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
    return Number((await store.readFreshnessManifest(STAGE))!.rev);
  };
  const read = async () => {
    const { GET } = await import('@/app/api/teaching-packages/[id]/agent-read/scenes/route');
    const response = await GET(
      new NextRequest(
        `http://localhost/api/teaching-packages/${VERSION}/agent-read/scenes?tenantId=${TENANT}`,
        { headers: { authorization: `Bearer ${SERVICE_KEY}` } },
      ),
      { params: Promise.resolve({ id: VERSION }) },
    );
    return (await response.json()) as { scenes: Array<Record<string, unknown>>; revision: string };
  };
  return {
    pool,
    post,
    read,
    revision,
    scene: async (sceneId) =>
      (await makeStore().loadDocument(STAGE))!.scenes.find((scene) => scene.id === sceneId)!,
    teacherPut: async (scene) => {
      await makeStore().putScene(STAGE, scene);
    },
    count: async (sql) => Number(((await pool.query(sql)).rows[0] as { n: number | string }).n),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only JSON reader
type Json = Record<string, any>;

export async function body(response: Response): Promise<Json> {
  return (await response.json()) as Json;
}
