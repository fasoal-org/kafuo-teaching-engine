/**
 * In-process Teaching Package generation runner (plan §8.3/§4.3.8), mirroring
 * `lib/server/classroom-job-runner.ts`: an in-memory `Map<string, Promise>`
 * deduplicates concurrent runs of the same attempt, and the execution input
 * lives only inside this closure — never in the database, logs, or progress.
 *
 * Kafuo attempts run a TWO-LAYER execution model:
 *
 *   Layer A (once per attempt): bounded acquisition of the lesson PDF →
 *   normalized source (text + source visuals) reused by every classroom run.
 *
 *   Layer B (bounded configurable runs): `generateClassroom` (with, on
 *   normalized runs, a Stage-1 Content-Unit grounding gate that rejects an
 *   ungrounded outline response before any Stage or Scene exists) → exact-flow
 *   validation → valid: `completeGenerationAttempt` binds the Stage; invalid
 *   or thrown after reservation: compensate (tombstone + media removal) and
 *   retry; exhausted: the attempt fails. Regeneration failure leaves the
 *   previous usable Stage untouched.
 */
import { createHash } from 'node:crypto';
import { createLogger } from '@/lib/logger';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import {
  generateClassroom,
  type ClassroomGenerationProgress,
} from '@/lib/server/classroom-generation';
import {
  claimQueuedAttemptForRun,
  incrementGenerationRuns,
  updateAttempt,
  upsertContentUnits,
  upsertSourceContext,
} from '@/lib/persistence/teaching-package';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import {
  screenSourceImages,
  withheldSourceVisualsNote,
} from '@/lib/server/teaching-package/source-visual-compliance';
import { removeStageMediaDir } from '@/lib/server/classroom-storage';
import { tombstoneStageMeta } from '@/lib/persistence/stage-meta';
import { resolveModel } from '@/lib/server/resolve-model';
import {
  acquireContentResource,
  ContentResourceAcquisitionError,
  recordPdfContentSummary,
} from '@/lib/server/teaching-package/content-resource';
import {
  acquireNormalizedContentResource,
  recordNormalizedContentSummary,
} from '@/lib/server/teaching-package/normalized-content-resource';
import {
  completeGenerationAttempt,
  failGenerationAttempt,
  recordResolvedLlmModel,
  recordSpeechRegister,
  recordSubjectRoute,
} from '@/lib/server/teaching-package/generation';
import { resolveSpeechRegisterPolicy } from '@/lib/server/speech/register-policy';
import { retainableContentUnits } from '@/lib/server/teaching-package/content-units';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import type { KafuoGenerationContext } from '@/lib/server/teaching-package/kafuo-request';
import {
  resolveSubjectModelPolicy,
  type ResolvedSubjectPolicy,
} from '@/lib/server/teaching-model/resolve-policy';
import { readRoutingMode } from '@/lib/server/teaching-model/subject-policy';
import { validateExactTeachingFlow } from '@/lib/server/teaching-package/exact-flow';
import {
  assertKafuoFlowWithoutGames,
  KAFUO_DEFERRED_WIDGET_TYPES,
} from '@/lib/server/teaching-package/kafuo-game-deferral';
import { validateSceneActionStructure } from '@/lib/server/teaching-package/action-validation';
import {
  requireCompleteFlowPolicies,
  resolveFlowSkillPolicies,
} from '@/lib/server/teaching-package/skill-policy';
import { materializeSourceImages } from '@/lib/server/teaching-package/source-images';
import { createTeachingPackagePersistenceSink } from '@/lib/server/teaching-package/stage-persistence-sink';
import { readCheckpointByAttemptId } from '@/lib/persistence/generation-checkpoint';
import { readAttemptById } from '@/lib/persistence/teaching-package';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { manifestContentUnitIds } from '@/lib/server/teaching-package/outline-grounding';
import {
  appOutlineDiagnostics,
  isGenerationCorrectionRequired,
  SCENE_REGENERATION_FIELD,
  type OutlineDiagnosisContext,
} from '@/lib/server/teaching-package/outline-correction';
import {
  flowDigestOf,
  pauseAttemptForCorrection,
} from '@/lib/server/teaching-package/generation-correction';
import type { ExactFlowViolation } from '@/lib/server/teaching-package/exact-flow';
import type { NormalizedSourceImage } from '@/lib/server/teaching-package/source-images';
import type { ScreenedSourceImages } from '@/lib/server/teaching-package/source-visual-compliance';
import type { ComplianceVerdict } from '@/lib/server/visual-compliance/types';
import type { GenerationCorrectionOptions } from '@/lib/server/classroom-generation';
import type { OutlineDiagnostic } from '@openmaic/generation';
import type {
  GenerationCheckpoint,
  GenerationCheckpointSourceRefs,
  SourceVisualManifestEntry,
} from '@/lib/types/teaching-package';
import type { SceneOutline } from '@/lib/types/generation';
import type { GenerationExecutionInput } from '@/lib/types/teaching-package';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

const log = createLogger('TeachingPackageGeneration');
const runningAttempts = new Map<string, Promise<void>>();
// Exactly one full classroom attempt: repeating every Scene/media call for a
// structural model-output error is disproportionately expensive. Repairable
// outline answers still use the cheap pre-Scene correction loop inside it.
const MAX_GENERATION_RUNS = 1;

async function runnerPool() {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  return pool;
}

/** Patch the one runner-writable snapshot key set: pdf/visual summary. */
async function patchSnapshot(
  pool: ConnectableQueryable,
  attemptId: string,
  patch: (snapshot: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const current = await pool.query<{ input_snapshot: Record<string, unknown> }>(
    `SELECT input_snapshot FROM teaching_package_generation_attempts WHERE id = $1`,
    [attemptId],
  );
  const snapshot = current.rows[0]?.input_snapshot;
  if (!snapshot) return;
  await pool.query(
    `UPDATE teaching_package_generation_attempts
        SET input_snapshot = $2::jsonb
      WHERE id = $1`,
    [attemptId, JSON.stringify(patch(snapshot))],
  );
}

/**
 * Compensate an invalid/thrown classroom run: the reserved Stage was never
 * bound to a version, so tombstone its meta (if the sink saved it) and remove
 * its media directory. The previous usable Stage of a regeneration is never
 * touched — only this run's own reserved id is.
 */
async function compensateRun(pool: ConnectableQueryable, stageId: string | null): Promise<void> {
  if (!stageId) return;
  await tombstoneStageMeta(pool, stageId).catch(() => {});
  await removeStageMediaDir(stageId);
}

/**
 * Subject routing for a Kafuo attempt (Kafuo R1 plan §7.4, ROUTE-01): under
 * `TEACHING_SUBJECT_ROUTING=enforced` the policy is resolved ONCE per attempt
 * from `subjectCode`, before Layer A and before any model call, and recorded
 * on the attempt (snapshot + `subject_code`). An unrouted subject — null
 * code, a code outside the policy, or a target the registry cannot resolve —
 * fails the attempt terminally with `SUBJECT_ROUTE_UNAVAILABLE`: no Layer A,
 * no run, no version, and never a fall-through to `DEFAULT_MODEL` (AMB-04).
 * With routing `off` the attempt runs exactly as before (stage routes,
 * `resolvedLlmModel`), and `null` is returned.
 */
async function resolveAttemptSubjectRoute(
  attemptId: string,
  kafuo: KafuoGenerationContext,
  pool: ConnectableQueryable,
): Promise<{ policy: ResolvedSubjectPolicy | null; failed: boolean }> {
  if (readRoutingMode() === 'off') return { policy: null, failed: false };
  let policy: ResolvedSubjectPolicy;
  try {
    policy = await resolveSubjectModelPolicy(kafuo.subjectCode);
  } catch (error) {
    const refusal =
      error instanceof TeachingPackageError && error.code === 'SUBJECT_ROUTE_UNAVAILABLE'
        ? error
        : new TeachingPackageError(
            'SUBJECT_ROUTE_UNAVAILABLE',
            `subject route could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
            { subjectCode: kafuo.subjectCode },
          );
    log.warn(
      `Teaching package attempt ${attemptId} refused: no subject route for ${JSON.stringify(kafuo.subjectCode)}`,
    );
    await failGenerationAttempt(pool, attemptId, refusal.message, {
      code: refusal.code,
      retryable: false,
    });
    return { policy: null, failed: true };
  }
  await recordSubjectRoute(pool, attemptId, {
    subjectCode: policy.subjectCode,
    policyVersion: policy.policyVersion,
    primaryModel: policy.primary.modelString,
    fallbackModel: policy.fallback.modelString,
  });
  return { policy, failed: false };
}

/**
 * Reuse the screening verdicts a checkpoint recorded instead of screening the
 * re-acquired visuals again. Every recorded `(id, sha256)` must resolve to the
 * same bytes; anything else is a different source and the resume fails closed.
 */
function reuseScreeningVerdicts(
  images: NormalizedSourceImage[],
  verdicts: GenerationCheckpointSourceRefs['visualVerdicts'],
): ScreenedSourceImages | null {
  const byId = new Map(images.map((image) => [image.id, image] as const));
  const approved: NormalizedSourceImage[] = [];
  for (const recorded of verdicts.approved) {
    const image = byId.get(recorded.id);
    if (!image || image.sha256 !== recorded.sha256) return null;
    approved.push(image);
  }
  const withheld: ScreenedSourceImages['withheld'] = [];
  for (const recorded of verdicts.withheld) {
    const image = byId.get(recorded.id);
    if (!image || image.sha256 !== recorded.sha256) return null;
    withheld.push({
      image,
      verdict: { verdict: recorded.verdict, checksum: recorded.sha256 } as ComplianceVerdict,
    });
  }
  return { approved, withheld };
}

/**
 * The outline ids a `scenes` checkpoint regenerates for an exact-flow
 * violation: every outline without a Scene, plus the outline of a Scene the
 * violation names individually. Empty ⇒ the violation cannot be scoped.
 *
 * Regenerating Scenes can only repair a violation when the OUTLINE list itself
 * covers the flow exactly: a `scenes` checkpoint locks flow positions and the
 * outline set, so a pause on an outline list that does not cover the flow
 * could never be corrected. Such a violation is not scoped (historical
 * compensate-and-fail).
 */
function pendingForFlowViolation(
  result: {
    scenes: readonly { id: string; outlineId?: string }[];
    outlines: readonly SceneOutline[];
  },
  violation: ExactFlowViolation,
  flow: KafuoGenerationContext['teachingFlow'],
): string[] {
  const outlineFlow = validateExactTeachingFlow(
    result.outlines.map((outline, index) => ({
      id: outline.id,
      order: index + 1,
      outlineId: outline.id,
      ...(outline.teachingStage ? { teachingStage: outline.teachingStage } : {}),
    })) as never,
    flow,
  );
  if (!outlineFlow.valid) return [];
  const withScene = new Set(
    result.scenes.flatMap((scene) => (scene.outlineId ? [scene.outlineId] : [])),
  );
  const pending = new Set(
    result.outlines.filter((outline) => !withScene.has(outline.id)).map((outline) => outline.id),
  );
  const perScene: ExactFlowViolation['reason'][] = [
    'missing_teaching_stage',
    'invalid_flow_index',
    'key_index_mismatch',
    'outline_scene_mismatch',
  ];
  if (perScene.includes(violation.reason)) {
    for (const sceneId of violation.offendingSceneIds) {
      const outlineId = result.scenes.find((scene) => scene.id === sceneId)?.outlineId;
      if (outlineId) pending.add(outlineId);
    }
  }
  return result.outlines.filter((outline) => pending.has(outline.id)).map((outline) => outline.id);
}

/** Scene-level findings a `scenes` resume resolves by regenerating the outline's Scene. */
function sceneRegenerationDiagnostics(
  outlines: readonly SceneOutline[],
  pending: readonly string[],
  code: string,
  message: (outlineId: string) => string,
): OutlineDiagnostic[] {
  return pending.map((outlineId) => {
    const outlineIndex = outlines.findIndex((outline) => outline.id === outlineId);
    const outline = outlines[outlineIndex];
    return {
      code,
      disposition: 'admin_correctable' as const,
      outlineIndex,
      outlineId,
      field: SCENE_REGENERATION_FIELD,
      message: message(outlineId),
      ...(outline?.teachingStage
        ? { flowIndex: outline.teachingStage.flowIndex, stage: outline.teachingStage.key }
        : {}),
    };
  });
}

/** The Kafuo two-layer execution path. */
async function runKafuoAttempt(
  attemptId: string,
  kafuo: KafuoGenerationContext,
  pool: ConnectableQueryable,
  onProgress: (progress: ClassroomGenerationProgress) => Promise<void>,
  resume: GenerationCheckpoint | null = null,
): Promise<void> {
  // Kafuo Release 1 defers generated games. The generate and resume routes
  // refuse a game-bearing flow first; re-asserted here so no path reaches
  // generation with one. A refusal fails the attempt with its own code.
  assertKafuoFlowWithoutGames(
    {
      key: kafuo.teachingModel.key,
      version: kafuo.teachingModel.version,
      flow: kafuo.teachingFlow,
    },
    'run',
  );

  // Subject route FIRST (plan §7.4): resolved once, before Layer A spends a
  // download and before any model call. A refusal has already failed the
  // attempt; nothing below runs for it.
  const route = await resolveAttemptSubjectRoute(attemptId, kafuo, pool);
  if (route.failed) return;

  // The spoken-language register the run is generated under: derived from the
  // same authoritative language + subject code generation receives, and
  // recorded on the attempt before any model call.
  const speechRegister = resolveSpeechRegisterPolicy({
    language: kafuo.language,
    subjectCode: kafuo.subjectCode,
  });
  if (speechRegister) {
    await recordSpeechRegister(pool, attemptId, {
      policyVersion: speechRegister.version,
      register: speechRegister.register,
      directiveDigest: createHash('sha256').update(speechRegister.directive, 'utf8').digest('hex'),
    });
  }

  // Layer A — one bounded acquisition per attempt, shared by every run.
  // Presence is authoritative: normalized failures never enter the PDF fallback.
  // A resumed attempt re-acquires through the FRESH retrieval URL of the re-sent
  // request (presigned URLs are never persisted) and must measure the very
  // source its corrected candidate was planned from.
  const source = kafuo.normalizedContentResource
    ? await acquireNormalizedContentResource(
        kafuo.normalizedContentResource,
        kafuo.aggregate.learningItem,
      )
    : await acquireContentResource(kafuo.contentResource, {});
  const normalizedSource = kafuo.normalizedContentResource
    ? (source as import('@/lib/server/teaching-package/normalized-content-resource').AcquiredNormalizedSource)
    : null;
  if (resume) {
    if (source.measuredSha256 !== resume.sourceRefs.measuredSha256) {
      await failGenerationAttempt(
        pool,
        attemptId,
        'the re-acquired source is not the source the corrected candidate was planned from',
        { code: 'CORRECTION_SOURCE_DRIFT', retryable: false },
      );
      return;
    }
  } else {
    await patchSnapshot(pool, attemptId, (snapshot) =>
      normalizedSource
        ? recordNormalizedContentSummary(snapshot, normalizedSource)
        : recordPdfContentSummary(snapshot, source),
    );
    // B1.2: retain the extracted lesson text for question generation after
    // approval. The presigned URL is transient and never stored; this row holds
    // only the extracted text and the measured resource identity.
    await upsertSourceContext(pool, {
      tenantId: kafuo.aggregate.tenantId,
      attemptId,
      contentResourceId: kafuo.contentResource.id,
      measuredSha256: source.measuredSha256,
      text: source.text,
      ...(kafuo.normalizedContentResource
        ? {
            sourceKind: 'kafuo_normalized' as const,
            normalizedPackageId: kafuo.normalizedContentResource.id,
            normalizedSchemaVersion: kafuo.normalizedContentResource.schemaVersion,
            contentRevisionId: kafuo.normalizedContentResource.contentRevisionId,
            parseRunId: kafuo.normalizedContentResource.parseRunId,
            structureProfile: kafuo.normalizedContentResource.structureProfile,
          }
        : { sourceKind: 'pdf_fallback' as const }),
    });
    // Kafuo R1 plan §5.1 (HLP-01/02): retain the approved Content Units this
    // attempt was grounded in — the same units, under the same skip rule, that
    // `adaptNormalizedText` rendered to the model — so Scene-grounded Help can
    // later resolve `sourceContentUnitIds` through version lineage. A PDF
    // fallback has no units and writes nothing.
    if (normalizedSource && kafuo.normalizedContentResource) {
      await upsertContentUnits(pool, {
        tenantId: kafuo.aggregate.tenantId,
        attemptId,
        units: retainableContentUnits({
          contentUnits: normalizedSource.manifest.contentUnits,
          contentRevisionId:
            normalizedSource.manifest.contentRevisionId ??
            kafuo.normalizedContentResource.contentRevisionId,
        }),
      });
    }
  }

  // RSS 7.5.4 — screen source visuals ONCE per attempt, before they are offered.
  // Only approved visuals reach the outline model, materialisation, or a slide;
  // everything else is withheld (fail closed) and the planner is told so. A
  // resumed attempt reuses the verdicts its checkpoint recorded (same bytes,
  // proven by sha256) instead of screening again.
  let screenedVisuals: ScreenedSourceImages;
  if (resume) {
    const reused = reuseScreeningVerdicts(
      source.normalizedImages,
      resume.sourceRefs.visualVerdicts,
    );
    if (!reused) {
      await failGenerationAttempt(
        pool,
        attemptId,
        'the re-acquired source visuals differ from those the corrected candidate was planned with',
        { code: 'CORRECTION_SOURCE_DRIFT', retryable: false },
      );
      return;
    }
    screenedVisuals = reused;
  } else {
    screenedVisuals = await screenSourceImages(source.normalizedImages);
  }
  const approvedVisualIds = new Set(screenedVisuals.approved.map((image) => image.id));
  const approvedVisionImages = source.visionImages.filter((image) =>
    approvedVisualIds.has(image.id),
  );
  const withheldVisualsNote = withheldSourceVisualsNote(screenedVisuals.withheld);

  // The W6-derived governance mode, consumed as a VALUE (§B.13): the
  // `teachingSkills` marker was parsed once at the single detection point and
  // already lives on this context; nothing below re-tests marker presence.
  const governedByTeachingSkills = kafuo.teachingSkillsContract !== null;

  // Admin correction (plan §3): the one diagnosis context, and the secret-free
  // references a pause pins for its resume. The Content Unit id set is exactly
  // the one the grounding gate uses (every manifest unit), not the retained set.
  const contentUnitIds = normalizedSource
    ? [...manifestContentUnitIds(normalizedSource.manifest)]
    : null;
  const diagnosisContext: OutlineDiagnosisContext = {
    flow: kafuo.teachingFlow,
    contentUnitIds,
    sourceImages: approvedVisionImages,
    governed: governedByTeachingSkills,
  };
  const attemptRow = await readAttemptById(pool, attemptId);
  const sourceRefsFor = (run: number): GenerationCheckpointSourceRefs => ({
    flowDigest: flowDigestOf(kafuo.teachingFlow),
    requestDigest: attemptRow?.requestDigest ?? null,
    generationRun: run,
    sourceKind: normalizedSource ? 'kafuo_normalized' : 'pdf_fallback',
    contentResourceId: kafuo.contentResource.id,
    measuredSha256: source.measuredSha256,
    ...(kafuo.normalizedContentResource
      ? { normalizedPackageId: kafuo.normalizedContentResource.id }
      : {}),
    contentUnitIds,
    contentUnits: normalizedSource
      ? normalizedSource.manifest.contentUnits.map((unit) => ({
          id: String(unit.id),
          order: unit.orderIndex,
          title: unit.title ?? null,
          role: unit.role,
        }))
      : [],
    visualVerdicts: {
      approved: screenedVisuals.approved.map((image) => ({ id: image.id, sha256: image.sha256 })),
      withheld: screenedVisuals.withheld.map(({ image, verdict }) => ({
        id: image.id,
        sha256: image.sha256,
        verdict: verdict.verdict,
      })),
    },
    sourceImages: screenedVisuals.approved.map((image) => ({
      id: image.id,
      sha256: image.sha256,
      pageNumber: image.pageNumber,
      ...(image.sourceContentUnitIds ? { sourceContentUnitIds: image.sourceContentUnitIds } : {}),
      ...(image.caption ? { caption: image.caption } : {}),
      ...(image.figureLabel ? { figureLabel: image.figureLabel } : {}),
      ...(image.description ? { description: image.description } : {}),
      ...(image.width !== undefined ? { width: image.width } : {}),
      ...(image.height !== undefined ? { height: image.height } : {}),
    })),
  });

  // A `scenes` checkpoint resumes on its retained, unbound Stage: every valid
  // Scene is kept and only the pending outlines are generated again.
  let resumeScenes: GenerationCorrectionOptions['resumeScenes'];
  if (resume?.phase === 'scenes') {
    const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
    const retained = resume.reservedStageId
      ? await store.loadDocument(resume.reservedStageId)
      : null;
    if (!retained) {
      await failGenerationAttempt(
        pool,
        attemptId,
        'the retained Stage of the paused attempt is no longer available',
        { code: 'STAGE_NOT_LIVE', retryable: false },
      );
      return;
    }
    const manifest = ((
      retained.outline as { sourceVisuals?: SourceVisualManifestEntry[] } | undefined
    )?.sourceVisuals ?? []) as SourceVisualManifestEntry[];
    resumeScenes = {
      stageId: resume.reservedStageId!,
      stage: retained.stage as never,
      scenes: retained.scenes as never,
      regenerateOutlineIds: resume.pendingOutlineIds ?? [],
      sourceServingMapping: Object.fromEntries(
        manifest.map((entry) => [entry.id, entry.servingPath] as const),
      ),
      sourceManifest: manifest,
    };
  }

  const execution: GenerationExecutionInput = {
    requirement: kafuo.normalizedContentResource
      ? `${kafuo.requirement}\n\nFor every outline, return a non-empty machine-readable sourceContentUnitIds array copied exactly from the [[CONTENT_UNIT]] identifiers in the authoritative normalized source.${withheldVisualsNote}`
      : `${kafuo.requirement}${withheldVisualsNote}`,
    pdfContent: {
      text: source.text,
      images: source.images,
      // Only screened-and-approved source visuals are ever offered.
      pdfImages: approvedVisionImages,
    },
    ...kafuo.generation,
    teachingFlow: kafuo.teachingFlow,
    // Kafuo Release 1 defers generated games: a game the model plans anyway is
    // reported on its outline, and a Scene that would still build one is
    // refused before any widget call — initial, corrected and resumed runs alike.
    prohibitedWidgetTypes: KAFUO_DEFERRED_WIDGET_TYPES,
    // The authoritative lesson language (`learningItem.language`): generation
    // stamps it on the Stage with the base text direction resolved from it.
    language: kafuo.language,
    // The authoritative subject code (`subjectOffering.code`): generation
    // stamps it on the Stage when it is a known code, so narration can later
    // pick subject-aware pronunciation without guessing from text.
    subjectCode: kafuo.subjectCode,
    // The prompt contract itself, not just prose on the requirement: this is
    // what makes the outline templates render `sourceContentUnitIds` into the
    // scene schema, the field table, and the closing reminders.
    ...(kafuo.normalizedContentResource ? { normalizedGrounding: true } : {}),
    // Module 3/4 W1: the governed authority travels as ONE value built here,
    // from the marker alone — `input.governed !== undefined` is the pipeline's
    // single governed-mode predicate (plan §7.1.1). The outline contract
    // boolean and every downstream governance branch derive from it.
    ...(governedByTeachingSkills
      ? {
          governed: {
            contract: kafuo.teachingSkillsContract as string,
            teachingModel: kafuo.teachingModel,
            flow: kafuo.teachingFlow,
          },
        }
      : {}),
    // Kafuo R1 plan §7.4: the subject policy resolved ONCE above travels as a
    // value; `input.modelPolicy !== undefined` is generation's single
    // "subject-routed" predicate, under which every teaching stage runs
    // through the executor and `MODEL_ROUTES` has no effect. The attribution
    // keys every ledger row to this attempt (the run number is stamped per
    // run below); `versionId` stays null because no version is bound yet.
    ...(route.policy
      ? {
          modelPolicy: route.policy,
          attribution: {
            tenantId: kafuo.aggregate.tenantId,
            generationAttemptId: attemptId,
            generationRun: 0,
            learningItemType: kafuo.aggregate.learningItem.type,
            learningItemId: kafuo.aggregate.learningItem.id,
          },
        }
      : {}),
  };

  let lastFailure: { code: string; message: string; retryable: boolean } | null = null;

  // A resume CONTINUES the run its checkpoint belongs to: it is not a new
  // classroom run, so the run counter is not incremented and the ledger keeps
  // the original run number.
  const firstRun = resume ? resume.sourceRefs.generationRun : 1;
  const lastRun = resume ? firstRun : MAX_GENERATION_RUNS;
  for (let run = firstRun; run <= lastRun; run += 1) {
    if (!resume) await incrementGenerationRuns(pool, attemptId);
    let reservedStageId: string | null = resumeScenes?.stageId ?? null;
    const sink = createTeachingPackagePersistenceSink(attemptId);
    const trackingSink = {
      reserve: sink.reserve.bind(sink),
      persist: sink.persist.bind(sink),
      release: sink.release.bind(sink),
    };
    const originalReserve = trackingSink.reserve;
    trackingSink.reserve = async (buildStage) => {
      const reserved = await originalReserve(buildStage);
      reservedStageId = reserved.id;
      return reserved;
    };

    try {
      await onProgress({
        step: resumeScenes ? 'generating_scenes' : 'generating_outlines',
        progress: resumeScenes ? 31 : 15,
        message: resume
          ? `Resuming generation run ${run}/${MAX_GENERATION_RUNS} after admin correction`
          : `Generation run ${run}/${MAX_GENERATION_RUNS}`,
        scenesGenerated: 0,
      });

      const runExecution: GenerationExecutionInput = execution.attribution
        ? { ...execution, attribution: { ...execution.attribution, generationRun: run } }
        : execution;
      const result = await generateClassroom(runExecution, {
        baseUrl: '',
        persistence: trackingSink,
        // Stage-1 AUTHORITY gate — the BR-TS-048 fail-closed point (Module 2 W8).
        // It fires after outlines and BEFORE `sink.reserve`: policy completeness
        // (SKILL_POLICY_REQUIRED) and exact-version resolution of the flow's own
        // Skill Policies (SKILL_NOT_FOUND / SKILL_VERSION_UNRESOLVED) are
        // authority data, so these refusals stay terminal. An invalid policy never
        // reaches this depth — the single parse seam refused it before the attempt
        // existed — and no unrestricted-catalog fallback exists.
        ...(governedByTeachingSkills
          ? {
              validateOutlines: () => {
                requireCompleteFlowPolicies(kafuo.teachingFlow, {
                  stageKeys: kafuo.teachingFlow.map((entry) => entry.stage),
                });
                resolveFlowSkillPolicies(kafuo.teachingFlow);
              },
            }
          : {}),
        // The model's ANSWER checks — Content-Unit grounding and Teaching Skill
        // selections, beside the package's classification/flow analysis — are
        // admin-correctable: a candidate that fails them pauses the attempt
        // (plan §3.2) instead of failing it, still before any reservation.
        correction: {
          collectOutlineIssues: (outlines: SceneOutline[]) =>
            appOutlineDiagnostics(outlines, diagnosisContext),
          ...(resume
            ? {
                resumeOutlines: {
                  outlines: resume.outlines,
                  courseTitle: resume.courseTitle,
                  languageDirective: resume.languageDirective,
                },
              }
            : {}),
          ...(resumeScenes ? { resumeScenes } : {}),
        },
        sourceVisuals: {
          images: approvedVisionImages,
          materialize: async (stageId, selected) => {
            const selectedNormalized = screenedVisuals.approved.filter((image) =>
              selected.some((pdfImage) => pdfImage.id === image.id),
            );
            const { servingMapping, manifest } = await materializeSourceImages(
              selectedNormalized,
              stageId,
              kafuo.contentResource.id,
            );
            await patchSnapshot(pool, attemptId, (snapshot) => ({
              ...snapshot,
              sourceVisualSummary: {
                available: source.normalizedImages.length,
                selected: selected.length,
                materialized: manifest.length,
              },
            }));
            return { servingMapping, manifest, failedIds: [] };
          },
        },
      });

      const flowCheck = validateExactTeachingFlow(
        result.scenes,
        kafuo.teachingFlow,
        result.outlines,
      );
      if (!flowCheck.valid) {
        // Discovered after Scene generation: the Stage is RETAINED and only the
        // Scenes the violation can be scoped to are regenerated on resume
        // (plan §3.5). A violation that cannot be scoped keeps the historical
        // compensate-and-fail behaviour.
        const pending = pendingForFlowViolation(result, flowCheck.violation, kafuo.teachingFlow);
        if (pending.length > 0) {
          const { paused } = await pauseAttemptForCorrection(
            pool,
            attemptId,
            {
              phase: 'scenes',
              outlines: result.outlines,
              courseTitle: result.stage.name ?? null,
              languageDirective: result.stage.languageDirective ?? '',
              diagnostics: sceneRegenerationDiagnostics(
                result.outlines,
                pending,
                'SCENE_FLOW_INCOMPLETE',
                () =>
                  `${flowCheck.violation.message}; this outline's Scene is regenerated on resume`,
              ),
              repairs: [],
              reservedStageId: result.id,
              pendingOutlineIds: pending,
            },
            sourceRefsFor(run),
          );
          if (paused) {
            log.warn(
              `Teaching package attempt ${attemptId} run ${run} paused after exact-flow validation (${flowCheck.violation.reason}); ${pending.length} Scene(s) to regenerate`,
            );
            return;
          }
        }
        lastFailure = {
          code: 'TEACHING_MODEL_FLOW_MISMATCH',
          message: flowCheck.violation.message,
          retryable: true,
        };
        log.warn(
          `Teaching package attempt ${attemptId} run ${run} failed exact-flow validation: ${flowCheck.violation.reason}`,
        );
        await compensateRun(pool, result.id);
        continue;
      }

      // Module 3/4 W3 — the canonical Action gate (plan §7.3/§9.1, point A):
      // an invalid governed artifact never becomes the current output. A
      // malformed Action is a bad model answer in ONE Scene: the Stage is
      // retained and the offending Scenes are regenerated on resume. Governed
      // runs only — the legacy binding path below has no gate.
      if (governedByTeachingSkills) {
        const actionFindings = validateSceneActionStructure(result.scenes, {
          stage: result.stage,
        });
        if (actionFindings.length > 0) {
          const first = actionFindings[0]!;
          const offendingOutlines = new Set(
            actionFindings.flatMap((finding) => {
              const outlineId = result.scenes.find(
                (scene) => scene.id === finding.sceneId,
              )?.outlineId;
              return outlineId ? [outlineId] : [];
            }),
          );
          const pending = result.outlines
            .filter((outline) => offendingOutlines.has(outline.id))
            .map((outline) => outline.id);
          if (pending.length > 0) {
            const { paused } = await pauseAttemptForCorrection(
              pool,
              attemptId,
              {
                phase: 'scenes',
                outlines: result.outlines,
                courseTitle: result.stage.name ?? null,
                languageDirective: result.stage.languageDirective ?? '',
                diagnostics: sceneRegenerationDiagnostics(
                  result.outlines,
                  pending,
                  first.code,
                  (outlineId) => {
                    const sceneIds = result.scenes
                      .filter((scene) => scene.outlineId === outlineId)
                      .map((scene) => scene.id);
                    const findings = actionFindings.filter((finding) =>
                      sceneIds.includes(finding.sceneId),
                    );
                    return `${findings.map((finding) => finding.message).join('; ')}; this outline's Scene is regenerated on resume`;
                  },
                ),
                repairs: [],
                reservedStageId: result.id,
                pendingOutlineIds: pending,
              },
              sourceRefsFor(run),
            );
            if (paused) {
              log.warn(
                `Teaching package attempt ${attemptId} run ${run} paused after Action validation (${first.code}); ${pending.length} Scene(s) to regenerate`,
              );
              return;
            }
          }
          lastFailure = {
            code: first.code,
            message: `${first.message} (+${actionFindings.length - 1} more Action finding(s))`,
            retryable: true,
          };
          log.warn(
            `Teaching package attempt ${attemptId} run ${run} failed Action validation (${first.code}): ${first.message}`,
          );
          await compensateRun(pool, result.id);
          continue;
        }
      }

      // Machine repairs (an incompatible contentKind dropped, the role kept, …)
      // are recorded on the attempt so they stay visible after a clean run.
      const outlineRepairs = result.outlineRepairs ?? [];
      if (outlineRepairs.length > 0) {
        await patchSnapshot(pool, attemptId, (snapshot) => ({
          ...snapshot,
          outlineRepairs: outlineRepairs.map((repair) => ({
            code: repair.code,
            outlineId: repair.outlineId,
            field: repair.field,
            previousValue: repair.previousValue,
            message: repair.message,
          })),
        }));
      }

      // 3 Oct 2026: how many scenes generation kept with a problem marker
      // (`generationIssues`) instead of failing — carried to Kafuo on the
      // succeeded event so the admin card can say "N slides need review".
      // A count only, never the issue messages.
      const scenesNeedingReview = result.scenes.filter(
        (scene) => (scene.generationIssues?.length ?? 0) > 0,
      ).length;
      await patchSnapshot(pool, attemptId, (snapshot) => ({ ...snapshot, scenesNeedingReview }));

      // Valid Stage → the ONLY binding path.
      await completeGenerationAttempt(pool, attemptId, result.id);
      return;
    } catch (error) {
      if (isGenerationCorrectionRequired(error)) {
        // The candidate needs a person, not a re-roll: nothing was reserved, so
        // there is nothing to compensate. The attempt pauses (or, if it is no
        // longer running, was already settled elsewhere).
        const { paused } = await pauseAttemptForCorrection(
          pool,
          attemptId,
          error.candidate,
          sourceRefsFor(run),
        );
        log.warn(
          paused
            ? `Teaching package attempt ${attemptId} run ${run} paused for admin correction: ${error.candidate.diagnostics.length} issue(s)`
            : `Teaching package attempt ${attemptId} run ${run} needed correction but is no longer running`,
        );
        return;
      }
      const isAcquisition = error instanceof ContentResourceAcquisitionError;
      if (isAcquisition) {
        // Layer A already retried within its policy; surface the terminal
        // code and stop the attempt.
        await failGenerationAttempt(pool, attemptId, error.message, {
          code: error.code,
          retryable: error.retryable,
        });
        return;
      }
      const code =
        typeof (error as { code?: string }).code === 'string'
          ? (error as { code: string }).code
          : 'CLASSROOM_GENERATION_FAILED';
      // Both of these are the *model* answering badly, and a re-roll is the remedy for
      // each. This grants no extra attempts: the bound is still the enclosing
      // `for (run …)` loop, and every run still compensates before the next.
      //
      // Module 3/4 W1: `GOVERNED_FLOW_CONTEXT_UNRESOLVED` is deliberately NOT in
      // this set — an unresolvable authoritative context is a bad request, not a
      // bad model answer, so it terminates the attempt after compensation.
      //
      // Module 3/4 W2: `GOVERNED_SCENE_GENERATION_FAILED` and
      // `GOVERNED_ACTION_GENERATION_FAILED` ARE in it — a bad model answer is
      // not a bad package, so both re-roll within the same bounded budget after
      // compensation, never binding a partial or ungoverned Stage.
      //
      // Module 3/4 W3: the three Action-validation codes join them — a
      // malformed Action is the same class of model-answer defect.
      //
      // Kafuo R1 plan §7.4: `TEACHING_MODEL_UNAVAILABLE` — both routes of the
      // subject pair failed for one teaching call — fails THIS run and the
      // existing re-roll applies to the run, never to the individual call
      // (the executor already spent Primary → Fallback). The executor marks a
      // safety refusal or our own bad request non-retryable; those terminate.
      const routeUnavailable =
        code === 'TEACHING_MODEL_UNAVAILABLE' &&
        (error as { retryable?: boolean }).retryable !== false;
      const retryable =
        routeUnavailable ||
        code === 'CLASSROOM_GENERATION_FAILED' ||
        code === 'OUTLINE_CONTENT_UNIT_GROUNDING_INVALID' ||
        code === 'GOVERNED_SCENE_GENERATION_FAILED' ||
        code === 'GOVERNED_ACTION_GENERATION_FAILED' ||
        code === 'ACTION_STRUCTURE_INVALID' ||
        code === 'ACTION_TYPE_UNKNOWN' ||
        code === 'ACTION_REFERENCE_INVALID';
      lastFailure = {
        code,
        message: error instanceof Error ? error.message : String(error),
        retryable,
      };
      log.warn(`Teaching package attempt ${attemptId} run ${run} threw (${code}); compensating`);
      await compensateRun(pool, reservedStageId);
      if (!retryable) break;
    }
  }

  await failGenerationAttempt(pool, attemptId, lastFailure?.message ?? 'generation failed', {
    code: lastFailure?.code ?? 'TEACHING_MODEL_FLOW_MISMATCH',
    retryable: false,
  });
}

export function runGenerationAttempt(
  attemptId: string,
  execution: GenerationExecutionInput,
  kafuo?: KafuoGenerationContext,
  options: { resume?: boolean } = {},
): Promise<void> {
  const existing = runningAttempts.get(attemptId);
  if (existing) return existing;

  const attemptPromise = (async () => {
    try {
      const pool = await runnerPool();
      // Admission, not a status write. Only a `queued` attempt may start, and
      // only once: the predicate lives in the UPDATE, so a second invocation —
      // an idempotency replay that reached the runner, or a duplicate schedule
      // — claims nothing and returns without touching the row. The in-memory
      // `runningAttempts` map above only dedupes CONCURRENT calls in this
      // process; a sequential second call passes it freely, and this is what
      // stops such a call from resurrecting a terminal attempt (which then
      // died as ATTEMPT_RECLAIMED_STALE).
      const claimed = await claimQueuedAttemptForRun(pool, attemptId, Date.now());
      if (!claimed) {
        log.info(
          `Teaching package attempt ${attemptId} was not claimable (already running or terminal); skipping run`,
        );
        return;
      }

      // Record the resolved LLM model string (the one runner-writable snapshot
      // key) for debugging; resolution failure lets generation fail on its own.
      // A subject-routed Kafuo attempt records its policy pair instead
      // (`recordSubjectRoute` in runKafuoAttempt): the stage route is not an
      // input to it, so recording one would only mislead (ROUTE-01).
      const subjectRouted = kafuo !== undefined && readRoutingMode() === 'enforced';
      if (!subjectRouted) {
        try {
          const { modelString } = await resolveModel({ stage: 'generate-classroom' });
          await recordResolvedLlmModel(pool, attemptId, modelString);
        } catch {
          // resolveModel throws only when no model is configured; the run below
          // surfaces the same failure through the generation pipeline itself.
        }
      }

      const reportProgress = async (progress: unknown) => {
        await updateAttempt(pool, attemptId, { progress: progress as never }).catch(() => {});
      };

      if (kafuo) {
        // A resume continues the SAME attempt from its checkpoint, which the
        // resume transaction marked `resumed` before queueing this run.
        let checkpoint: GenerationCheckpoint | null = null;
        if (options.resume) {
          checkpoint = await readCheckpointByAttemptId(pool, attemptId);
          if (!checkpoint || checkpoint.state !== 'resumed') {
            await failGenerationAttempt(
              pool,
              attemptId,
              'no resumable checkpoint for this attempt',
              {
                code: 'CORRECTION_NOT_AWAITING',
                retryable: false,
              },
            );
            return;
          }
        }
        await runKafuoAttempt(attemptId, kafuo, pool, reportProgress, checkpoint);
        return;
      }

      // Legacy path: `execution` is the caller's generation object passed
      // through unchanged, and `baseUrl = ''` keeps every stored media
      // reference origin-independent.
      const result = await generateClassroom(execution, {
        baseUrl: '',
        onProgress: (progress) => {
          void reportProgress(progress);
        },
        persistence: createTeachingPackagePersistenceSink(attemptId),
      });

      await completeGenerationAttempt(pool, attemptId, result.id);
    } catch (error) {
      const code =
        typeof (error as { code?: string }).code === 'string'
          ? (error as { code: string }).code
          : undefined;
      const message = error instanceof Error ? error.message : String(error);
      log.error(
        `Teaching package generation attempt ${attemptId} failed: ${code ?? 'unknown'}`,
        describeErrorSafely(error),
      );
      try {
        const pool = await runnerPool();
        await failGenerationAttempt(pool, attemptId, message, {
          ...(code !== undefined ? { code } : {}),
        });
      } catch (markFailedError) {
        log.error(`Failed to persist failed status for attempt ${attemptId}:`, markFailedError);
      }
    } finally {
      runningAttempts.delete(attemptId);
    }
  })();

  runningAttempts.set(attemptId, attemptPromise);
  return attemptPromise;
}
