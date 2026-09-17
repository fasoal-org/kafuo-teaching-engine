/**
 * Kafuo → TE structured generation request parsing and the shared canonical
 * digest (FRD §9.2/§11.1, plan §4.3.1).
 *
 * The canonicalization is a SHARED SPECIFICATION with the Kafuo backend
 * (`app/modules/teaching_engine/domain/contracts.py::canonical_request_digest`)
 * and is pinned by the mirrored vector file `tests/fixtures/kafuo-digest-vectors.json`.
 * It covers the authoritative generation inputs and deliberately excludes
 * `contentResource.url` — a regenerated presigned URL for the same resource id
 * with the same integrity metadata is the same semantic request.
 */
import { createHash } from 'node:crypto';

import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import type { StartGenerationAttemptRequest } from '@/lib/server/teaching-package/generation';
import { buildDeterministicKafuoRequirement } from '@/lib/server/teaching-package/kafuo-requirement';
import { computeSkillPolicyDigest } from '@/lib/server/teaching-package/skill-policy';
import type {
  GenerationExecutionInput,
  KafuoContentResource,
  KafuoGenerationRequest,
  KafuoNormalizedContentResource,
  LearningObjectiveRef,
  TeachingFlowEntry,
  TeachingRequiredSkillRule,
  TeachingSkillPolicy,
  TeachingSkillRef,
  TeachingPackageAggregateKey,
} from '@/lib/types/teaching-package';

type StartGenerationAttemptRequestAlias = StartGenerationAttemptRequest;

/**
 * The Teaching Skills governance contract this TE speaks (Module 2 W6, plan §M).
 * Mirrors Kafuo's `TEACHING_SKILLS_CONTRACT_V1` (`contracts.py`); the shared
 * specification both sides pin.
 */
export const TEACHING_SKILLS_CONTRACT_V1 = 'kafuo.teaching-skills.v1';

/** Development-only escape hatch for local HTTP PDF sources. */
function allowInsecureResourceUrl(): boolean {
  return (
    process.env.NODE_ENV !== 'production' && process.env.TEACHING_PACKAGE_ALLOW_HTTP_PDF === 'true'
  );
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TeachingPackageError('INVALID_REQUEST', `${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Mirrors the Teaching Engine's canonical-registry identity syntax and the
 * Kafuo-side authoring guard, so a reference TE accepts as well-formed is one the
 * W1 registry can look up (and vice versa). Format guard, not a versioning scheme.
 */
const SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SKILL_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Closed V1 vocabularies — BR-TS-010: no implicit default scope, explicit role. */
const SKILL_REQUIREMENT_SCOPES = ['flow_position', 'every_instructional_scene'] as const;
const SKILL_ASSIGNMENT_ROLES = ['primary', 'supporting'] as const;

function parseSkillRef(raw: unknown, field: string, where: () => string): TeachingSkillRef {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const skillId = record?.skillId;
  const version = record?.version;
  if (typeof skillId !== 'string' || !SKILL_ID_PATTERN.test(skillId)) {
    throw new TeachingPackageError(
      'SKILL_POLICY_INVALID',
      `${where()}: ${field}.skillId must be a well-formed canonical skill id`,
    );
  }
  if (typeof version !== 'string' || !SKILL_VERSION_PATTERN.test(version)) {
    throw new TeachingPackageError(
      'SKILL_POLICY_INVALID',
      `${where()}: ${field}.version must be a well-formed canonical version (exact, never "latest")`,
    );
  }
  return { skillId, version };
}

function refList(raw: unknown, field: string, where: () => string): TeachingSkillRef[] {
  if (raw === undefined || raw === null) {
    throw new TeachingPackageError('SKILL_POLICY_INVALID', `${where()}: ${field} is required`);
  }
  if (!Array.isArray(raw)) {
    throw new TeachingPackageError('SKILL_POLICY_INVALID', `${where()}: ${field} must be an array`);
  }
  return raw.map((item, i) => parseSkillRef(item, `${field}[${i}]`, where));
}

/**
 * Structurally validate one received flow-entry Skill Policy at the single
 * parsing seam (Module 2 W5). TE re-validates what Kafuo authored — the wire is
 * never trusted (VAL-TS-003/004) — applying the same coherence rules the Kafuo
 * side enforces at authoring: required/preferred sit exactly inside the allowed
 * boundary, one exact version per skill id per set, one required rule per skill
 * id, restrictions name two distinct allowed members once each, and at most one
 * skill required as the Primary of every instructional Scene (FR-TS-074 — two
 * can never be satisfied together, BR-TS-021).
 *
 * Kafuo validated this policy's SHAPE before dispatch; whether each exact
 * (skillId, version) RESOLVES is decided separately, against the W1 canonical
 * registry, by the skill-policy resolution module — never here.
 */
function parseSkillPolicy(raw: unknown, index: number, stage: string): TeachingSkillPolicy {
  const where = () => `teachingModel.flow[${index}] (stage "${stage}").skillPolicy`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TeachingPackageError(
      'SKILL_POLICY_INVALID',
      `${where()} must be an object when present`,
    );
  }
  const record = raw as Record<string, unknown>;

  const requiredRaw = record.required;
  if (!Array.isArray(requiredRaw)) {
    throw new TeachingPackageError('SKILL_POLICY_INVALID', `${where()}: required must be an array`);
  }
  const required: TeachingRequiredSkillRule[] = requiredRaw.map((item, i) => {
    const rule = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
    if (!rule) {
      throw new TeachingPackageError(
        'SKILL_POLICY_INVALID',
        `${where()}: required[${i}] must be an object`,
      );
    }
    const skill = parseSkillRef(rule.skill, `required[${i}].skill`, where);
    if (
      typeof rule.scope !== 'string' ||
      !(SKILL_REQUIREMENT_SCOPES as readonly string[]).includes(rule.scope)
    ) {
      throw new TeachingPackageError(
        'SKILL_POLICY_INVALID',
        `${where()}: required[${i}].scope must be one of ${SKILL_REQUIREMENT_SCOPES.join(' | ')} (BR-TS-010: no implicit default scope)`,
      );
    }
    if (
      typeof rule.role !== 'string' ||
      !(SKILL_ASSIGNMENT_ROLES as readonly string[]).includes(rule.role)
    ) {
      throw new TeachingPackageError(
        'SKILL_POLICY_INVALID',
        `${where()}: required[${i}].role must be one of ${SKILL_ASSIGNMENT_ROLES.join(' | ')}`,
      );
    }
    return { skill, scope: rule.scope, role: rule.role };
  });

  const preferred = refList(record.preferred, 'preferred', where);
  const allowed = refList(record.allowed, 'allowed', where);

  const restrictionsRaw = record.combinationRestrictions;
  if (!Array.isArray(restrictionsRaw)) {
    throw new TeachingPackageError(
      'SKILL_POLICY_INVALID',
      `${where()}: combinationRestrictions must be an array`,
    );
  }
  const combinationRestrictions = restrictionsRaw.map((item, i) => {
    const restriction = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
    if (!restriction) {
      throw new TeachingPackageError(
        'SKILL_POLICY_INVALID',
        `${where()}: combinationRestrictions[${i}] must be an object`,
      );
    }
    return {
      skillA: parseSkillRef(restriction.skillA, `combinationRestrictions[${i}].skillA`, where),
      skillB: parseSkillRef(restriction.skillB, `combinationRestrictions[${i}].skillB`, where),
    };
  });

  // Coherence — the FRD §14.3 rules. A structurally valid but contradictory
  // policy is refused, never repaired (FR-TS-011).
  const allowedPairs = new Set(allowed.map((ref) => `${ref.skillId}\u0000${ref.version}`));
  const uniqueIds = (refs: TeachingSkillRef[], set: string) => {
    const seen = new Set<string>();
    for (const ref of refs) {
      if (seen.has(ref.skillId)) {
        throw new TeachingPackageError(
          'SKILL_POLICY_INVALID',
          `${where()}: ${set} names skill id "${ref.skillId}" more than once (one exact version per skill)`,
        );
      }
      seen.add(ref.skillId);
    }
  };
  uniqueIds(allowed, 'allowed');
  uniqueIds(preferred, 'preferred');
  const requiredIds = new Set<string>();
  for (const rule of required) {
    if (requiredIds.has(rule.skill.skillId)) {
      throw new TeachingPackageError(
        'SKILL_POLICY_INVALID',
        `${where()}: required carries more than one rule for skill id "${rule.skill.skillId}"`,
      );
    }
    requiredIds.add(rule.skill.skillId);
  }
  for (const ref of [...required.map((r) => r.skill), ...preferred]) {
    if (!allowedPairs.has(`${ref.skillId}\u0000${ref.version}`)) {
      throw new TeachingPackageError(
        'SKILL_POLICY_INVALID',
        `${where()}: ${ref.skillId}@${ref.version} is required/preferred but not in the allowed boundary (FRD §14.3)`,
      );
    }
  }
  const seenRestrictions = new Set<string>();
  for (const { skillA, skillB } of combinationRestrictions) {
    for (const endpoint of [skillA, skillB]) {
      if (!allowedPairs.has(`${endpoint.skillId}\u0000${endpoint.version}`)) {
        throw new TeachingPackageError(
          'SKILL_POLICY_INVALID',
          `${where()}: combination restriction names ${endpoint.skillId}@${endpoint.version}, which is not in the allowed boundary`,
        );
      }
    }
    if (skillA.skillId === skillB.skillId && skillA.version === skillB.version) {
      throw new TeachingPackageError(
        'SKILL_POLICY_INVALID',
        `${where()}: combination restriction must name two distinct skills`,
      );
    }
    const key = [
      `${skillA.skillId}\u0000${skillA.version}`,
      `${skillB.skillId}\u0000${skillB.version}`,
    ]
      .sort()
      .join('|');
    if (seenRestrictions.has(key)) {
      throw new TeachingPackageError(
        'SKILL_POLICY_INVALID',
        `${where()}: the same combination restriction is declared twice`,
      );
    }
    seenRestrictions.add(key);
  }
  const everyScenePrimaries = required.filter(
    (rule) => rule.scope === 'every_instructional_scene' && rule.role === 'primary',
  );
  if (everyScenePrimaries.length > 1) {
    throw new TeachingPackageError(
      'SKILL_POLICY_INVALID',
      `${where()}: more than one skill is required as the Primary of every instructional Scene (${everyScenePrimaries
        .map((rule) => `${rule.skill.skillId}@${rule.skill.version}`)
        .join(
          ', ',
        )}); an instructional Scene has exactly one Primary (BR-TS-021), so the configuration is contradictory (FR-TS-074)`,
    );
  }

  return { required, preferred, allowed, combinationRestrictions };
}

function parseFlow(raw: unknown): TeachingFlowEntry[] {
  if (raw === undefined || raw === null) {
    throw new TeachingPackageError('FLOW_REQUIRED', 'teachingModel.flow is required');
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new TeachingPackageError('FLOW_REQUIRED', 'teachingModel.flow must be a non-empty array');
  }
  return raw.map((entry, index) => {
    const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
    if (!record) {
      throw new TeachingPackageError(
        'FLOW_INVALID',
        `teachingModel.flow[${index}] must be an object`,
      );
    }
    const stage = record.stage;
    const instructions = record.instructions;
    if (typeof stage !== 'string' || stage.trim() === '') {
      throw new TeachingPackageError(
        'FLOW_INVALID',
        `teachingModel.flow[${index}].stage must be a non-empty string`,
      );
    }
    if (typeof instructions !== 'string' || instructions.trim() === '') {
      throw new TeachingPackageError(
        'FLOW_INVALID',
        `teachingModel.flow[${index}].instructions must be a non-empty string`,
      );
    }
    // Skill Policy rides through as received — Kafuo's expansion projected it and
    // TE never re-derives it (plan §G). Structural validation happens here, at
    // this single seam; exact-version resolution against the W1 canonical
    // registry happens separately in the skill-policy module.
    if (record.skillPolicy === undefined) return { stage, instructions };
    return {
      stage,
      instructions,
      skillPolicy: parseSkillPolicy(record.skillPolicy, index, stage),
    };
  });
}

function parseContentResource(raw: unknown): KafuoContentResource {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!record) {
    throw new TeachingPackageError(
      'CONTENT_RESOURCE_REQUIRED',
      'contentResource must be an object',
    );
  }
  const id = requireNonEmptyString(record.id, 'contentResource.id');
  const url = requireNonEmptyString(record.url, 'contentResource.url');
  const mimeType = record.mimeType ?? 'application/pdf';
  if (mimeType !== 'application/pdf') {
    throw new TeachingPackageError(
      'CONTENT_RESOURCE_REQUIRED',
      'contentResource.mimeType must resolve to application/pdf',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TeachingPackageError('CONTENT_RESOURCE_REQUIRED', 'contentResource.url is invalid');
  }
  if (parsed.protocol !== 'https:' && !allowInsecureResourceUrl()) {
    throw new TeachingPackageError(
      'CONTENT_RESOURCE_REQUIRED',
      'contentResource.url must use https',
    );
  }
  return {
    id,
    url,
    mimeType: 'application/pdf',
    ...(typeof record.fileName === 'string' && record.fileName
      ? { fileName: record.fileName }
      : {}),
    ...(typeof record.fileSizeBytes === 'number' && Number.isFinite(record.fileSizeBytes)
      ? { fileSizeBytes: record.fileSizeBytes }
      : {}),
    ...(typeof record.checksumSha256 === 'string' && record.checksumSha256
      ? { checksumSha256: record.checksumSha256 }
      : {}),
  };
}

function parseNormalizedContentResource(
  raw: unknown,
  contentResource: KafuoContentResource,
): KafuoNormalizedContentResource | undefined {
  if (raw === undefined || raw === null) return undefined;
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!record) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'normalizedContentResource must be an object',
    );
  }
  const structure = record.structureProfile as Record<string, unknown> | undefined;
  const resource: KafuoNormalizedContentResource = {
    id: requireNonEmptyString(record.id, 'normalizedContentResource.id'),
    url: requireNonEmptyString(record.url, 'normalizedContentResource.url'),
    mimeType: record.mimeType as 'application/zip',
    schemaVersion: record.schemaVersion as 'kafuo.normalized-content.v1',
    contentSourceId: requireNonEmptyString(
      record.contentSourceId,
      'normalizedContentResource.contentSourceId',
    ),
    contentRevisionId: requireNonEmptyString(
      record.contentRevisionId,
      'normalizedContentResource.contentRevisionId',
    ),
    parseRunId: requireNonEmptyString(record.parseRunId, 'normalizedContentResource.parseRunId'),
    structureProfile: {
      id: requireNonEmptyString(structure?.id, 'normalizedContentResource.structureProfile.id'),
      versionId: requireNonEmptyString(
        structure?.versionId,
        'normalizedContentResource.structureProfile.versionId',
      ),
    },
    fileSizeBytes: Number(record.fileSizeBytes),
    checksumSha256: requireNonEmptyString(
      record.checksumSha256,
      'normalizedContentResource.checksumSha256',
    ).toLowerCase(),
  };
  if (resource.mimeType !== 'application/zip') {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'normalizedContentResource.mimeType must be application/zip',
    );
  }
  if (resource.schemaVersion !== 'kafuo.normalized-content.v1') {
    throw new TeachingPackageError(
      'NORMALIZED_CONTENT_SCHEMA_UNSUPPORTED',
      'normalizedContentResource.schemaVersion is unsupported',
    );
  }
  if (resource.contentSourceId !== contentResource.id) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'normalizedContentResource.contentSourceId must equal contentResource.id',
    );
  }
  if (!Number.isSafeInteger(resource.fileSizeBytes) || resource.fileSizeBytes <= 0) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'normalizedContentResource.fileSizeBytes must be a positive integer',
    );
  }
  if (!/^[0-9a-f]{64}$/.test(resource.checksumSha256)) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'normalizedContentResource.checksumSha256 must be SHA-256 hex',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(resource.url);
  } catch {
    throw new TeachingPackageError('INVALID_REQUEST', 'normalizedContentResource.url is invalid');
  }
  if (parsed.protocol !== 'https:' && !allowInsecureResourceUrl()) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'normalizedContentResource.url must use https',
    );
  }
  return resource;
}

/**
 * Parse and validate the structured Kafuo generation request (FRD §9.2).
 * Duplicate stage keys are allowed — identity is `(flowIndex, stage)`.
 * `generation` accepts capability switches ONLY; provider ids, model ids, and
 * credentials are refused (TE owns routing).
 */
export function parseKafuoGenerationRequest(body: Record<string, unknown>): {
  request: KafuoGenerationRequest;
  aggregate: TeachingPackageAggregateKey;
} {
  const requestId = requireNonEmptyString(body.requestId, 'requestId');
  const tenantContext = body.tenantContext as Record<string, unknown> | undefined;
  if (!tenantContext || typeof tenantContext !== 'object') {
    throw new TeachingPackageError('TENANT_REQUIRED', 'tenantContext.tenantId is required');
  }
  const tenantId = requireNonEmptyString(tenantContext.tenantId, 'tenantContext.tenantId');
  const actorRef = requireNonEmptyString(body.actorRef, 'actorRef');

  const learningItem = body.learningItem as Record<string, unknown> | undefined;
  if (!learningItem || typeof learningItem !== 'object') {
    throw new TeachingPackageError('INVALID_REQUEST', 'learningItem must be an object');
  }
  if ('tenantId' in learningItem) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'learningItem must not carry tenantId; use tenantContext.tenantId',
    );
  }
  const itemType = learningItem.type;
  if (itemType !== 'lesson' && itemType !== 'section') {
    throw new TeachingPackageError(
      'UNSUPPORTED_LEARNING_ITEM_TYPE',
      'learningItem.type must be "lesson" or "section"',
    );
  }
  const item: KafuoGenerationRequest['learningItem'] = {
    type: itemType,
    id: requireNonEmptyString(learningItem.id, 'learningItem.id'),
    title: requireNonEmptyString(learningItem.title, 'learningItem.title'),
    ...(typeof learningItem.lessonId === 'string' && learningItem.lessonId
      ? { lessonId: learningItem.lessonId }
      : {}),
    ...(typeof learningItem.logicalSectionId === 'string' && learningItem.logicalSectionId
      ? { logicalSectionId: learningItem.logicalSectionId }
      : {}),
    unit: {
      id: requireNonEmptyString(
        (learningItem.unit as Record<string, unknown> | undefined)?.id,
        'learningItem.unit.id',
      ),
      title: requireNonEmptyString(
        (learningItem.unit as Record<string, unknown> | undefined)?.title,
        'learningItem.unit.title',
      ),
    },
    ...(learningItem.academicPeriod && typeof learningItem.academicPeriod === 'object'
      ? {
          academicPeriod: {
            id: String((learningItem.academicPeriod as Record<string, unknown>).id ?? ''),
            name: String((learningItem.academicPeriod as Record<string, unknown>).name ?? ''),
          },
        }
      : {}),
    ...(learningItem.subjectOffering && typeof learningItem.subjectOffering === 'object'
      ? {
          subjectOffering: {
            id: String((learningItem.subjectOffering as Record<string, unknown>).id ?? ''),
            name: String((learningItem.subjectOffering as Record<string, unknown>).name ?? ''),
          },
        }
      : {}),
    ...(learningItem.level && typeof learningItem.level === 'object'
      ? {
          level: {
            id: String((learningItem.level as Record<string, unknown>).id ?? ''),
            name: String((learningItem.level as Record<string, unknown>).name ?? ''),
          },
        }
      : {}),
    curriculum: {
      id: requireNonEmptyString(
        (learningItem.curriculum as Record<string, unknown> | undefined)?.id,
        'learningItem.curriculum.id',
      ),
      name: requireNonEmptyString(
        (learningItem.curriculum as Record<string, unknown> | undefined)?.name,
        'learningItem.curriculum.name',
      ),
    },
    curriculumVersion: {
      id: requireNonEmptyString(
        (learningItem.curriculumVersion as Record<string, unknown> | undefined)?.id,
        'learningItem.curriculumVersion.id',
      ),
      versionLabel: requireNonEmptyString(
        (learningItem.curriculumVersion as Record<string, unknown> | undefined)?.versionLabel,
        'learningItem.curriculumVersion.versionLabel',
      ),
    },
    language: requireNonEmptyString(learningItem.language, 'learningItem.language'),
    ...(typeof learningItem.estimatedMinutes === 'number' &&
    Number.isFinite(learningItem.estimatedMinutes)
      ? { estimatedMinutes: learningItem.estimatedMinutes }
      : {}),
    ...(Array.isArray(learningItem.concepts)
      ? {
          concepts: learningItem.concepts.map((concept) => {
            const record = concept as Record<string, unknown>;
            return {
              title: String(record.title ?? ''),
              ...(typeof record.description === 'string'
                ? { description: record.description }
                : {}),
              sortOrder: Number(record.sortOrder ?? 0),
            };
          }),
        }
      : {}),
  };

  if (!Array.isArray(body.learningObjectives) || body.learningObjectives.length === 0) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'learningObjectives must be a non-empty array of approved objectives',
    );
  }
  const learningObjectives: LearningObjectiveRef[] = body.learningObjectives.map((entry, index) => {
    const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
    const objectiveRef = record?.objectiveRef;
    const snapshot = record?.snapshot as Record<string, unknown> | undefined;
    if (
      typeof objectiveRef !== 'string' ||
      objectiveRef.trim() === '' ||
      !snapshot ||
      typeof snapshot.statement !== 'string' ||
      snapshot.statement.trim() === ''
    ) {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        `learningObjectives[${index}] requires objectiveRef and snapshot.statement`,
      );
    }
    return { objectiveRef, snapshot: { statement: snapshot.statement } };
  });

  const teachingModelRaw = body.teachingModel as Record<string, unknown> | undefined;
  if (!teachingModelRaw || typeof teachingModelRaw !== 'object') {
    throw new TeachingPackageError('INVALID_REQUEST', 'teachingModel must be an object');
  }
  const teachingModel = {
    key: requireNonEmptyString(teachingModelRaw.key, 'teachingModel.key'),
    version: requireNonEmptyString(teachingModelRaw.version, 'teachingModel.version'),
    flow: parseFlow(teachingModelRaw.flow),
  };

  // The explicit governance marker (Module 2 W6, plan §M). This is the ONE
  // place the mode is detected; everything downstream receives the derived
  // value and never re-tests `teachingSkills` presence per call site. Absent ⇒
  // genuine legacy path. An UNKNOWN contract string is refused here — a
  // contract this TE does not speak must fail closed, mirroring the
  // `schemaVersion` refusal pattern — rather than being silently ignored.
  const teachingSkillsMarker = body.teachingSkills;
  let teachingSkillsContract: string | undefined;
  if (teachingSkillsMarker !== undefined) {
    if (
      typeof teachingSkillsMarker !== 'string' ||
      teachingSkillsMarker !== TEACHING_SKILLS_CONTRACT_V1
    ) {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        `teachingSkills must be the supported contract ${JSON.stringify(TEACHING_SKILLS_CONTRACT_V1)} when present`,
      );
    }
    teachingSkillsContract = TEACHING_SKILLS_CONTRACT_V1;
  }

  const contentResource = parseContentResource(body.contentResource);
  const normalizedContentResource = parseNormalizedContentResource(
    body.normalizedContentResource,
    contentResource,
  );

  const generationRaw = (body.generation ?? {}) as Record<string, unknown>;
  const FORBIDDEN_GENERATION_KEYS = [
    'webSearchProviderId',
    'webSearchApiKey',
    'webSearchModelId',
    'baiduSubSources',
    'providerId',
    'modelId',
  ];
  for (const key of FORBIDDEN_GENERATION_KEYS) {
    if (key in generationRaw) {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        `generation.${key} is not accepted: Kafuo requests capability switches only; provider/model routing belongs to the Teaching Engine`,
      );
    }
  }
  const generation: KafuoGenerationRequest['generation'] = {
    ...(typeof generationRaw.enableWebSearch === 'boolean'
      ? { enableWebSearch: generationRaw.enableWebSearch }
      : {}),
    ...(typeof generationRaw.enableImageGeneration === 'boolean'
      ? { enableImageGeneration: generationRaw.enableImageGeneration }
      : {}),
    ...(typeof generationRaw.enableVideoGeneration === 'boolean'
      ? { enableVideoGeneration: generationRaw.enableVideoGeneration }
      : {}),
    ...(typeof generationRaw.enableTTS === 'boolean' ? { enableTTS: generationRaw.enableTTS } : {}),
    ...(generationRaw.agentMode === 'default' || generationRaw.agentMode === 'generate'
      ? { agentMode: generationRaw.agentMode }
      : {}),
  };

  const request: KafuoGenerationRequest = {
    requestId,
    learningItem: item,
    learningObjectives,
    teachingModel,
    contentResource,
    ...(normalizedContentResource ? { normalizedContentResource } : {}),
    generation,
    tenantContext: { tenantId },
    actorRef,
    ...(typeof body.versionId === 'string' && body.versionId ? { versionId: body.versionId } : {}),
    // Mode derived ONCE at this single detection point (plan §B.13): the
    // marker's presence/absence is settled here and carried as a value.
    ...(teachingSkillsContract ? { teachingSkillsContract } : {}),
  };
  return {
    request,
    aggregate: { tenantId, learningItem: { type: item.type, id: item.id } },
  };
}

/** The semantic payload covered by the digest (never `contentResource.url`). */
export function canonicalRequestPayload(request: KafuoGenerationRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    tenantContext: request.tenantContext,
    learningItem: request.learningItem,
    learningObjectives: request.learningObjectives.map((o) => ({
      objectiveRef: o.objectiveRef,
      snapshot: { statement: o.snapshot.statement },
    })),
    teachingModel: {
      key: request.teachingModel.key,
      version: request.teachingModel.version,
      flow: request.teachingModel.flow.map((e) => ({
        stage: e.stage,
        instructions: e.instructions,
        // Policy participates in the shared canonical digest (Module 2 W4,
        // VAL-TS-022): silent policy drift must surface as a digest change.
        // Absent policy stays absent — the legacy digest is byte-stable.
        ...(e.skillPolicy !== undefined ? { skillPolicy: e.skillPolicy } : {}),
      })),
    },
    contentResource: {
      id: request.contentResource.id,
      mimeType: request.contentResource.mimeType,
      ...(request.contentResource.fileSizeBytes !== undefined
        ? { fileSizeBytes: request.contentResource.fileSizeBytes }
        : {}),
      ...(request.contentResource.checksumSha256 !== undefined
        ? { checksumSha256: request.contentResource.checksumSha256 }
        : {}),
    },
    ...(request.normalizedContentResource
      ? {
          normalizedContentResource: normalizedContentResourceSnapshotFacts(
            request.normalizedContentResource,
          ),
        }
      : {}),
    generation: request.generation,
  };
  if (request.versionId !== undefined) payload.versionId = request.versionId;
  return payload;
}

/**
 * sha256 hex of the sorted-key JSON encoding of the semantic payload.
 * Specification (mirrored in the backend's `canonical_request_digest`):
 * sorted keys at every level, no whitespace, `ensure_ascii=false`, UTF-8.
 */
export function canonicalRequestDigest(request: KafuoGenerationRequest): string {
  const encoded = JSON.stringify(canonicalRequestPayload(request), null, 0);
  // Re-serialize with sorted keys at every level (JSON.stringify only sorts
  // top-level keys via a replacer array; walk manually for full determinism).
  const sorted = sortKeysDeep(JSON.parse(encoded));
  const canonical = jsonCompact(sorted);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function jsonCompact(value: unknown): string {
  return JSON.stringify(value);
}

/** Secret-free resource identity/integrity facts for the attempt snapshot. */
export function contentResourceSnapshotFacts(resource: KafuoContentResource): {
  id: string;
  mimeType: string;
  fileName?: string;
  fileSizeBytes?: number;
  checksumSha256?: string;
} {
  return {
    id: resource.id,
    mimeType: resource.mimeType,
    ...(resource.fileName !== undefined ? { fileName: resource.fileName } : {}),
    ...(resource.fileSizeBytes !== undefined ? { fileSizeBytes: resource.fileSizeBytes } : {}),
    ...(resource.checksumSha256 !== undefined ? { checksumSha256: resource.checksumSha256 } : {}),
  };
}

export function normalizedContentResourceSnapshotFacts(
  resource: KafuoNormalizedContentResource,
): Omit<KafuoNormalizedContentResource, 'url'> {
  const { url: _url, ...stable } = resource;
  return stable;
}

/** Build the deterministic requirement (plan §4.3.3) for a Kafuo request. */
export function buildKafuoRequirement(request: KafuoGenerationRequest): string {
  return buildDeterministicKafuoRequirement({
    learningItem: request.learningItem,
    learningObjectives: request.learningObjectives,
    teachingModel: request.teachingModel,
  });
}

/**
 * The in-memory-only Kafuo execution context the runner consumes. The signed
 * `contentResource.url` lives HERE and nowhere else — never in the snapshot,
 * logs, progress, or responses.
 */
export interface KafuoGenerationContext {
  aggregate: TeachingPackageAggregateKey;
  /** Module-2 mode derived once at parse: the contract marker, or null = legacy. */
  teachingSkillsContract: string | null;
  teachingFlow: TeachingFlowEntry[];
  learningObjectives: LearningObjectiveRef[];
  requirement: string;
  contentResource: KafuoContentResource;
  normalizedContentResource?: KafuoNormalizedContentResource;
  generation: KafuoGenerationRequest['generation'];
  versionId: string | null;
}

/** Assemble the StartGenerationAttemptRequest for a parsed Kafuo request. */
export function buildKafuoStartRequest(
  request: KafuoGenerationRequest,
  aggregate: TeachingPackageAggregateKey,
): { start: StartGenerationAttemptRequestAlias; kafuo: KafuoGenerationContext } {
  const requirement = buildKafuoRequirement(request);
  const digest = canonicalRequestDigest(request);
  const execution: GenerationExecutionInput = {
    requirement,
    ...request.generation,
    teachingFlow: request.teachingModel.flow,
  };
  return {
    start: {
      tenantId: aggregate.tenantId,
      learningItem: aggregate.learningItem,
      teachingModel: {
        key: request.teachingModel.key,
        version: request.teachingModel.version,
      },
      learningObjectives: request.learningObjectives,
      generation: execution,
      ...(request.versionId !== undefined ? { versionId: request.versionId } : {}),
      actorRef: request.actorRef,
      requestId: request.requestId,
      requestDigest: digest,
      teachingSkillsContract: request.teachingSkillsContract ?? null,
      skillPolicyDigest: computeSkillPolicyDigest(request.teachingModel.flow),
      teachingFlow: request.teachingModel.flow,
      contentResource: contentResourceSnapshotFacts(request.contentResource),
      ...(request.normalizedContentResource
        ? {
            normalizedContentResource: normalizedContentResourceSnapshotFacts(
              request.normalizedContentResource,
            ),
          }
        : {}),
    },
    kafuo: {
      aggregate,
      teachingSkillsContract: request.teachingSkillsContract ?? null,
      teachingFlow: request.teachingModel.flow,
      learningObjectives: request.learningObjectives,
      requirement,
      contentResource: request.contentResource,
      ...(request.normalizedContentResource
        ? { normalizedContentResource: request.normalizedContentResource }
        : {}),
      generation: request.generation,
      versionId: request.versionId ?? null,
    },
  };
}
