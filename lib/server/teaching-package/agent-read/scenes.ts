/**
 * The agent read API's scene projection (Kafuo Agent API plan §1.5, §3.3;
 * spec §5.5). Pure: the route loads the document, the flow and the latest
 * regeneration record per scene, and this module maps them — no I/O here.
 *
 * Reuses the engine's own rules rather than restating them: `scenePlayPositions`
 * (slide numbers), `stripTags` / `slideVisuals` (text), `citedContentUnitIds`
 * (part links, Help's rule), `deriveSceneAlignment`, the Teaching Skills
 * inspection and validators, `NARRATION_AUDIO_ISSUE_CODE`, `isBankQuizScene`
 * and `sceneEditDigest` (the engine review's finding digest).
 */
import { SLIDE_CANVAS_HEIGHT, SLIDE_CANVAS_WIDTH } from '@openmaic/generation';

import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import { deriveSceneAlignment } from '@/lib/server/teaching-package/alignment';
import { isBankQuizScene } from '@/lib/server/teaching-package/bank-quiz-scene';
import { citedContentUnitIds } from '@/lib/server/teaching-package/content-unit-coverage';
import { NARRATION_AUDIO_ISSUE_CODE } from '@/lib/server/teaching-package/narration-audio-issue';
import { sceneEditDigest, slideVisuals } from '@/lib/server/teaching-package/package-review-input';
import { buildStageTeachingSkillsInspection } from '@/lib/server/teaching-package/scene-inspection';
import { scenePlayPositions } from '@/lib/server/teaching-package/scene-position';
import { elementBBox, findLayoutOverlaps, type BBox, type LayoutOverlap } from './layout';
import {
  collectSkillRequirementChecks,
  skillRefString,
  type SkillRequirementCheck,
} from './skills';
import { extractNumbers, htmlToPlainText, latexToPlainText } from './text';
import type { SourceVisualManifestEntry, TeachingFlowEntry } from '@/lib/types/teaching-package';
import type { AppScene, Stage } from '@/lib/types/stage';

type CanvasElement = Record<string, unknown>;
type OutlineEntry = AppDocumentOutline['outlines'][number];

/** The latest regeneration record of one scene (any status), as the route reads it. */
export interface SceneRegenerationSummary {
  sceneId: string;
  status: 'running' | 'succeeded' | 'failed';
  actorRef: string;
  requestedAt: number;
  completedAt: number | null;
  /** The scene as it stood when the regeneration started. */
  previousScene: AppScene | null;
  /** The scene's latest SUCCEEDED regeneration (may be older than this record). */
  lastSucceeded?: { actorRef: string; at: number } | null;
}

/**
 * A bank quiz's question reference. TE stores no bank questions: the classroom
 * fetches them from Kafuo with exactly `{tenantId, learningItemId, versionId,
 * sceneId}` (`bank-quiz-service.ts` `scopeFor` → Kafuo `/quiz-questions`); the
 * scene's flow position and objective refs are what Kafuo scopes them by.
 */
export interface AgentBankQuizRef {
  learning_item_type: string | null;
  learning_item_id: string | null;
  version_id: string;
  scene_id: string;
  teaching_stage: { key: string; flow_index: number } | null;
  objective_refs: string[];
}

export interface AgentSceneElement {
  id: string;
  type: string;
  text: string | null;
  rich: string | null;
  rows: string[][] | null;
  source: 'textbook' | 'generated' | 'icon' | null;
  source_block_ids: string[];
  bbox: BBox;
}

export interface AgentNarrationLine {
  index: number;
  /** The speech Action's id: what `narration-line` addresses (F2.2), never the index. */
  action_id: string | null;
  text: string;
  numbers: number[];
  audio: { status: 'ok' | 'missing' | 'failed' };
}

export interface AgentQuizItem {
  id: string;
  stem: string;
  type: string;
  options: Array<{ id: string; text: string }>;
  correct_option_ids: string[];
  correct_value: string | null;
  /** Every accepted answer of a short answer (the edit op's `correct_values` replaces it). */
  correct_values: string[];
  explanation: string | null;
  points: number | null;
}

export interface AgentScene {
  scene_id: string;
  slide_number: number;
  kind: string;
  title: string;
  slide_type: string | null;
  content_role: string | null;
  teaching_stage: { key: string; flow_index: number } | null;
  text: string;
  rich: string;
  numbers: number[];
  elements: AgentSceneElement[];
  layout: { overlaps: LayoutOverlap[]; overflow: null };
  textbook_image: { expected: boolean | null; present: boolean } | null;
  narration: { lines: AgentNarrationLine[] };
  quiz: {
    source: 'scene' | 'bank';
    items: AgentQuizItem[] | null;
    /** Bank quizzes only: what Kafuo needs to fetch the questions (TE holds none). */
    bank_ref?: AgentBankQuizRef;
  } | null;
  skills: {
    primary: string | null;
    supporting: string[];
    allowed: string[];
    checks: SkillRequirementCheck[];
  };
  validation: { state: string; needs_alignment_confirmation: boolean };
  /**
   * F2.6: why the slide is stale (`material-change`, `assignment-change`,
   * `classification-change`; null when aligned or never baselined), and whether
   * `alignment-confirm` would accept it (A8: stale only by the agent's own ops).
   */
  alignment: { state: string; reason: string | null; confirmable_by_agent: boolean };
  review_flags: Array<{ code: string; message: string }>;
  part_ids: string[];
  source_block_ids: string[];
  last_changed: { at: string; by: string; how: 'regenerate_slide' } | null;
  reviewed_scene_digest: string;
}

export interface AgentScenesProjection {
  version_id: string;
  version_number: number;
  status: string;
  stage_id: string;
  revision: string;
  slide_width: number;
  slide_height: number;
  /** Every Skill requirement check, including one that names no scene. */
  skills_checks: SkillRequirementCheck[];
  scenes: AgentScene[];
}

export interface ProjectScenesInput {
  version: {
    id: string;
    version: number;
    status: string;
    currentStageId: string;
    learningItem?: { type: string; id: string };
  };
  revision: number;
  scenes: readonly AppScene[];
  outline: Pick<AppDocumentOutline, 'outlines' | 'sourceVisuals'> | null | undefined;
  /** The Stage, so the Action findings resolve agent bindings exactly as the submit gate does. */
  stage?: Pick<Stage, 'generatedAgentConfigs' | 'agentIds'> | null;
  /** The version's authoritative Teaching Model Flow; null/empty = legacy (no Skill checks). */
  flow: readonly TeachingFlowEntry[] | null;
  /** Governed by Teaching Skills: alignment confirmation applies only then (submit check 10). */
  governed: boolean;
  regenerations?: ReadonlyMap<string, SceneRegenerationSummary>;
  /** F2.6: the scenes the A8 proof accepts (`agent-alignment-proof.ts`); absent = none. */
  agentConfirmable?: ReadonlySet<string>;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function canvasElements(scene: Pick<AppScene, 'content'> | null | undefined): CanvasElement[] {
  const content = scene?.content as { type?: unknown; canvas?: { elements?: unknown } } | undefined;
  if (content?.type !== 'slide') return [];
  const elements = content.canvas?.elements;
  return Array.isArray(elements) ? (elements as CanvasElement[]) : [];
}

/** Manifest entries by serving path: an image is a textbook image when its `src` is one. */
function manifestByPath(
  manifest: readonly SourceVisualManifestEntry[] | undefined,
): Map<string, SourceVisualManifestEntry> {
  return new Map((manifest ?? []).map((entry) => [entry.servingPath, entry]));
}

function hasTextbookImage(
  elements: readonly CanvasElement[],
  byPath: ReadonlyMap<string, SourceVisualManifestEntry>,
): boolean {
  return elements.some(
    (element) => element.type === 'image' && byPath.has(String(element.src ?? '')),
  );
}

/** `icon` = an SVG image (inline data URI or `.svg` file); the rest are generated. */
function imageSource(
  src: string,
  byPath: ReadonlyMap<string, SourceVisualManifestEntry>,
): 'textbook' | 'generated' | 'icon' {
  if (byPath.has(src)) return 'textbook';
  if (/^data:image\/svg/i.test(src) || /\.svg(?:[?#].*)?$/i.test(src)) return 'icon';
  return 'generated';
}

function tableRows(element: CanvasElement, plain: boolean): string[][] {
  const data = Array.isArray(element.data) ? (element.data as unknown[]) : [];
  return data
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) =>
      row.map((cell) => {
        const text = str((cell as { text?: unknown } | null)?.text) ?? '';
        return plain ? htmlToPlainText(text) : text;
      }),
    );
}

/** One canvas element: its plain text, stored markup, rows, source and box. */
export function projectElement(
  element: CanvasElement,
  byPath: ReadonlyMap<string, SourceVisualManifestEntry>,
): AgentSceneElement {
  const type = String(element.type ?? 'unknown');
  let text: string | null = null;
  let rich: string | null = null;
  let rows: string[][] | null = null;
  let source: AgentSceneElement['source'] = null;
  let sourceBlockIds: string[] = [];
  if (type === 'text') {
    rich = str(element.content);
    text = rich === null ? null : htmlToPlainText(rich) || null;
  } else if (type === 'shape') {
    rich = str((element.text as { content?: unknown } | undefined)?.content);
    text = rich === null ? null : htmlToPlainText(rich) || null;
  } else if (type === 'latex') {
    rich = str(element.latex);
    text = rich === null ? null : latexToPlainText(rich) || null;
  } else if (type === 'table') {
    rows = tableRows(element, true);
    const richRows = tableRows(element, false);
    rich = richRows.map((row) => row.join(' | ')).join('\n') || null;
    text =
      rows
        .map((row) => row.filter(Boolean).join(' | '))
        .filter(Boolean)
        .join('\n') || null;
  } else if (type === 'code') {
    const lines = Array.isArray(element.lines) ? (element.lines as unknown[]) : [];
    text =
      lines.map((line) => str((line as { content?: unknown } | null)?.content) ?? '').join('\n') ||
      null;
    rich = text;
  } else if (type === 'chart') {
    text = slideVisuals([element])[0] ?? null;
  } else if (type === 'image') {
    const src = String(element.src ?? '');
    source = imageSource(src, byPath);
    sourceBlockIds = [...(byPath.get(src)?.sourceBlockIds ?? [])];
  }
  return {
    id: String(element.id ?? ''),
    type,
    text,
    rich,
    rows,
    source,
    source_block_ids: sourceBlockIds,
    bbox: elementBBox(element),
  };
}

/**
 * Speech lines, 1-based. `ok` = an audio id that is not invalidated; `failed` = no
 * audio id on a scene marked `NARRATION_AUDIO_FAILED` (the mark counts exactly those
 * lines, `narrationAudioGap`); `missing` = invalidated audio, or no audio without the mark.
 */
export function projectNarration(scene: Pick<AppScene, 'actions' | 'generationIssues'>): {
  lines: AgentNarrationLine[];
} {
  const audioFailed = (scene.generationIssues ?? []).some(
    (issue) => issue.code === NARRATION_AUDIO_ISSUE_CODE,
  );
  const lines = (scene.actions ?? [])
    .map(
      (action) =>
        action as {
          id?: unknown;
          type?: unknown;
          text?: unknown;
          audioId?: unknown;
          audioInvalidated?: unknown;
        },
    )
    .filter((action) => action.type === 'speech' && typeof action.text === 'string' && action.text)
    .map((action, at) => {
      const text = (action.text as string).trim();
      const hasAudio = Boolean(action.audioId);
      const status: AgentNarrationLine['audio']['status'] = !hasAudio
        ? audioFailed
          ? 'failed'
          : 'missing'
        : action.audioInvalidated === true
          ? 'missing'
          : 'ok';
      return {
        index: at + 1,
        action_id: typeof action.id === 'string' ? action.id : null,
        text,
        numbers: extractNumbers(text),
        audio: { status },
      };
    });
  return { lines };
}

/** Quiz items as stored: the key is returned as is, never corrected. */
export function projectQuiz(
  scene: AppScene,
  version?: ProjectScenesInput['version'],
): AgentScene['quiz'] {
  if (scene.type !== 'quiz') return null;
  if (isBankQuizScene(scene)) {
    return {
      source: 'bank',
      items: null,
      bank_ref: {
        learning_item_type: version?.learningItem?.type ?? null,
        learning_item_id: version?.learningItem?.id ?? null,
        version_id: version?.id ?? '',
        scene_id: scene.id,
        teaching_stage: scene.teachingStage
          ? { key: scene.teachingStage.key, flow_index: scene.teachingStage.flowIndex }
          : null,
        objective_refs: (scene.learningObjectives ?? [])
          .map((ref) => ref.objectiveRef)
          .filter((ref): ref is string => typeof ref === 'string' && ref !== ''),
      },
    };
  }
  const questions = ((scene.content as { questions?: unknown }).questions ?? []) as Array<
    Record<string, unknown>
  >;
  return {
    source: 'scene',
    items: questions.map((question, at) => {
      const type = String(question.type ?? 'single');
      const answer = Array.isArray(question.answer) ? question.answer.map(String) : [];
      const options = Array.isArray(question.options)
        ? (question.options as Array<Record<string, unknown>>)
        : [];
      return {
        id: str(question.id) ?? `q${at + 1}`,
        stem: htmlToPlainText(str(question.question) ?? ''),
        type,
        options: options.map((option) => ({
          id: String(option.value ?? ''),
          text: htmlToPlainText(str(option.label) ?? ''),
        })),
        correct_option_ids: type === 'short_answer' ? [] : answer,
        correct_value: type === 'short_answer' ? (answer[0] ?? null) : null,
        correct_values: type === 'short_answer' ? answer : [],
        explanation:
          typeof question.analysis === 'string' ? htmlToPlainText(question.analysis) : null,
        points: typeof question.points === 'number' ? question.points : null,
      };
    }),
  };
}

/**
 * `present` = an image is a textbook visual. `expected` = the outline planned a
 * textbook image (`visualPlan.mode === 'image'` with selected source images — the
 * case `requiredSourceVisualIssue` enforces), or the latest regeneration started
 * from a scene that had one. Null when neither source exists. Slides only.
 */
export function projectTextbookImage(
  scene: AppScene,
  outlineEntry: OutlineEntry | undefined,
  regeneration: SceneRegenerationSummary | undefined,
  byPath: ReadonlyMap<string, SourceVisualManifestEntry>,
): AgentScene['textbook_image'] {
  if (scene.type !== 'slide') return null;
  const present = hasTextbookImage(canvasElements(scene), byPath);
  const fromOutline = outlineEntry
    ? outlineEntry.visualPlan?.mode === 'image' && (outlineEntry.suggestedImageIds?.length ?? 0) > 0
    : undefined;
  const fromRegeneration = regeneration?.previousScene
    ? hasTextbookImage(canvasElements(regeneration.previousScene), byPath)
    : undefined;
  const expected =
    fromOutline === true || fromRegeneration === true
      ? true
      : fromOutline === undefined && fromRegeneration === undefined
        ? null
        : false;
  return { expected, present };
}

function sceneText(scene: AppScene, elements: AgentSceneElement[]): { text: string; rich: string } {
  if (scene.type === 'slide') {
    return {
      text: elements
        .map((element) => element.text)
        .filter(Boolean)
        .join('\n'),
      rich: elements
        .map((element) => element.rich)
        .filter(Boolean)
        .join('\n'),
    };
  }
  if (scene.type === 'quiz') {
    const questions = ((scene.content as { questions?: unknown }).questions ?? []) as Array<
      Record<string, unknown>
    >;
    const raw = questions.flatMap((question) => [
      str(question.question) ?? '',
      ...((question.options as Array<Record<string, unknown>> | undefined) ?? []).map(
        (option) => str(option.label) ?? '',
      ),
    ]);
    return {
      text: raw
        .map((part) => htmlToPlainText(part))
        .filter(Boolean)
        .join('\n'),
      rich: raw.filter(Boolean).join('\n'),
    };
  }
  return { text: '', rich: '' };
}

/** The whole `GET agent-read/scenes` body. */
export function projectAgentScenes(input: ProjectScenesInput): AgentScenesProjection {
  const outlines = input.outline?.outlines ?? [];
  const outlineById = new Map(outlines.map((entry) => [entry.id, entry]));
  const byPath = manifestByPath(input.outline?.sourceVisuals);
  const positions = scenePlayPositions(input.scenes);
  const flow = input.flow && input.flow.length > 0 ? input.flow : null;
  const inspection = flow
    ? new Map(
        buildStageTeachingSkillsInspection(input.scenes, flow, {
          stage: input.stage ?? null,
        }).scenes.map((entry) => [entry.sceneId, entry]),
      )
    : null;
  const requirementChecks = flow ? collectSkillRequirementChecks(input.scenes, flow) : [];
  const ordered = [...input.scenes].sort(
    (a, b) => (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0),
  );

  const scenes = ordered.map((scene): AgentScene => {
    const outlineEntry =
      typeof scene.outlineId === 'string' ? outlineById.get(scene.outlineId) : undefined;
    const regeneration = input.regenerations?.get(scene.id);
    const rawElements = canvasElements(scene);
    const elements = rawElements.map((element) => projectElement(element, byPath));
    const { text, rich } = sceneText(scene, elements);
    const content = scene.content as { contentRole?: unknown; canvas?: { type?: unknown } };
    const skills = scene.teachingSkills;
    const inspected = inspection?.get(scene.id);
    const stageKey = scene.teachingStage?.key ?? null;
    const otherFailures: SkillRequirementCheck[] = (inspected?.failures ?? [])
      .filter((failure) => failure.code !== 'SKILL_REQUIREMENT_UNSATISFIED')
      .map((failure) => ({
        code: failure.code,
        message: failure.message,
        required: null,
        role: null,
        scope: null,
        teaching_stage_key: stageKey,
        flow_index: scene.teachingStage?.flowIndex ?? null,
        failing_scene_ids: [scene.id],
      }));
    const alignment = deriveSceneAlignment(scene);
    const blockIds = new Set<string>(
      (outlineEntry?.sourceBlockIds ?? []).map(String).filter(Boolean),
    );
    for (const element of elements) for (const id of element.source_block_ids) blockIds.add(id);
    // The latest landed change, even when a later attempt is running or failed.
    const succeeded =
      regeneration?.lastSucceeded ??
      (regeneration && regeneration.status === 'succeeded'
        ? {
            actorRef: regeneration.actorRef,
            at: regeneration.completedAt ?? regeneration.requestedAt,
          }
        : null);
    return {
      scene_id: scene.id,
      slide_number: positions.get(scene.id) ?? 0,
      kind: scene.type,
      title: scene.title ?? '',
      slide_type: str(content?.canvas?.type) ?? str(outlineEntry?.slideType) ?? null,
      content_role: str(content?.contentRole),
      teaching_stage: scene.teachingStage
        ? { key: scene.teachingStage.key, flow_index: scene.teachingStage.flowIndex }
        : null,
      text,
      rich,
      numbers: extractNumbers(text),
      elements,
      layout: { overlaps: findLayoutOverlaps(rawElements), overflow: null },
      textbook_image: projectTextbookImage(scene, outlineEntry, regeneration, byPath),
      narration: projectNarration(scene),
      quiz: projectQuiz(scene, input.version),
      skills: {
        primary: skills?.primary ? skillRefString(skills.primary) : null,
        supporting: (skills?.supporting ?? []).map(skillRefString),
        allowed: (inspected?.policy.allowed ?? []).map(skillRefString),
        checks: [
          ...requirementChecks.filter((check) => check.failing_scene_ids.includes(scene.id)),
          ...otherFailures,
        ],
      },
      validation: {
        state: alignment.state,
        needs_alignment_confirmation: input.governed && !alignment.aligned,
      },
      alignment: {
        state: alignment.state,
        reason: alignment.reason ?? null,
        confirmable_by_agent:
          input.governed && !alignment.aligned && (input.agentConfirmable?.has(scene.id) ?? false),
      },
      review_flags: (scene.generationIssues ?? []).map((issue) => ({
        code: issue.code,
        message: issue.message,
      })),
      part_ids: citedContentUnitIds(scene, input.outline ?? null),
      source_block_ids: [...blockIds],
      last_changed: succeeded
        ? {
            at: new Date(succeeded.at).toISOString(),
            by: succeeded.actorRef,
            how: 'regenerate_slide',
          }
        : null,
      // Review of 7d7dddc6 (MEDIUM-1): the digest the review's findings carry
      // (`sceneEditDigest`), so Kafuo's per-finding `stale` compares like with like.
      reviewed_scene_digest: sceneEditDigest(scene),
    };
  });

  return {
    version_id: input.version.id,
    version_number: input.version.version,
    status: input.version.status,
    stage_id: input.version.currentStageId,
    revision: String(input.revision),
    slide_width: SLIDE_CANVAS_WIDTH,
    slide_height: SLIDE_CANVAS_HEIGHT,
    skills_checks: requirementChecks,
    scenes,
  };
}
