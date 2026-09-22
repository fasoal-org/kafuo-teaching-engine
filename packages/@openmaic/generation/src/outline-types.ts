import type { SlideContentKind, SlideContentRole, SlideType, WidgetType } from '@openmaic/dsl';

export type { WidgetType } from '@openmaic/dsl';

/** Image extracted from a source document with metadata used by outline prompts. */
export interface PdfImage {
  id: string;
  src: string;
  pageNumber: number;
  description?: string;
  storageId?: string;
  width?: number;
  height?: number;
  originalId?: string;
  sourceDocumentId?: string;
  sourceDocumentName?: string;
  sourceDocumentOrder?: number;
  visionPriority?: number;
  sourceContentUnitIds?: string[];
  sourceBlockIds?: string[];
  sourceRole?: string;
  caption?: string;
  figureLabel?: string;
  providerVisualId?: string;
}

export type ImageMapping = Record<string, string>;

/** Free-form requirements accepted by outline generation. */
export interface UserRequirements {
  requirement: string;
  userNickname?: string;
  userBio?: string;
  webSearch?: boolean;
  interactiveMode?: boolean;
  taskEngineMode?: boolean;
}

export interface WidgetOutline {
  concept?: string;
  keyVariables?: string[];
  diagramType?: 'flowchart' | 'mindmap' | 'hierarchy' | 'system';
  language?: 'python' | 'javascript' | 'typescript' | 'java' | 'cpp';
  gameType?: 'quiz' | 'puzzle' | 'strategy' | 'card' | 'action';
  visualizationType?: 'molecular' | 'solar' | 'anatomy' | 'geometry' | 'physics' | 'custom';
  objects?: string[];
  interactions?: string[];
  procedureType?: 'repair' | 'assembly' | 'inspection' | 'operation' | 'custom';
  task?: string;
  tools?: string[];
  steps?: string[];
  successCriteria?: string[];
  errorConsequences?: string[];
  challenge?: string;
  playerControls?: string[];
  nodeCount?: number;
  nodes?: Array<{
    id: string;
    label: string;
    parentId?: string;
    icon?: string;
    details?: string;
  }>;
  challengeType?: string;
}

export interface MediaGenerationRequest {
  type: 'image' | 'video';
  prompt: string;
  elementId: string;
  aspectRatio?: '16:9' | '4:3' | '1:1' | '9:16';
  style?: string;
}

/**
 * One entry of the authoritative ordered Teaching Model Flow supplied by the
 * caller. Array order is authoritative; identity is `(array position, stage)`.
 */
export interface TeachingFlowEntry {
  /** Case-sensitive stable machine key, e.g. `lesson_introduction`. */
  stage: string;
  /** Non-empty pedagogical instructions for this flow position. */
  instructions: string;
  /**
   * The Skill Policy this resolved position inherited from its Teaching Model
   * flow definition item (Module 2 W10). Structural twin of the app-layer
   * `TeachingSkillPolicy` — the package cannot import from `lib/`, so the shape
   * is declared here and stays wire-identical. Absent on pre-Module-2 entries;
   * whether a run renders the Skill selection contract is declared by
   * `OutlinePromptContext.skillPolicy`, never inferred from this field.
   */
  skillPolicy?: TeachingSkillPolicy;
}

/**
 * Teaching-stage identity carried by every Kafuo-generated outline and scene.
 * `key` must equal `flow[flowIndex].stage` exactly; never derived from titles,
 * scene types, or order (the exact-flow validator re-checks this after
 * generation and before submit).
 */
export interface TeachingStageRef {
  key: string;
  flowIndex: number;
}

/**
 * An exact canonical Teaching Skill reference: stable id + immutable version
 * (Module 2 W9). Structural twin of the app-layer `TeachingSkillRef` — the
 * package cannot import from `lib/`, so the shape is declared here and stays
 * wire-identical. Keeping BOTH fields lets validators key duplicates on the id
 * while resolution keys on the pair.
 */
export interface SceneSkillRef {
  skillId: string;
  version: string;
}

/**
 * The Scene-level Teaching Skills carrier (Module 2 W9, plan §E/§F): Primary and
 * Supporting assignment plus the instructional classification, on ONE carrier
 * for every Scene type. All members optional and additive — absence is the
 * legacy state (AC-TS-034); nothing populates this until W10's selection.
 */
export interface SceneTeachingSkills {
  /** Exactly one primary on an instructional Scene (BR-TS-021). */
  primary?: SceneSkillRef;
  /** Intentional `0..N` supporting Skills (BR-TS-022 — no arbitrary V1 cap). */
  supporting?: SceneSkillRef[];
  /** Emitted at outline time; never derived from Skill absence (BR-TS-054). */
  classification?: 'instructional' | 'non-instructional';
}

/**
 * A required Skill rule with an EXPLICIT scope and assignment role (Module 2
 * W10). Structural twin of the app-layer `TeachingRequiredSkillRule`; the
 * closed V1 vocabularies are enforced at the app's parse seam, not here.
 */
export interface TeachingRequiredSkillRule {
  skill: SceneSkillRef;
  scope: string;
  role: string;
}

/** An explicitly prohibited unordered pairing on one Scene (BR-TS-055). */
export interface TeachingSkillCombinationRestriction {
  skillA: SceneSkillRef;
  skillB: SceneSkillRef;
}

/**
 * The Teaching Skill Policy for one resolved flow position (Module 2 W10):
 * what the Generation Agent may select at that position. Authored on Kafuo's
 * frozen flow definition item and received already projected — the outline
 * prompt renders it and never re-derives it.
 */
export interface TeachingSkillPolicy {
  required: TeachingRequiredSkillRule[];
  preferred: SceneSkillRef[];
  allowed: SceneSkillRef[];
  combinationRestrictions: TeachingSkillCombinationRestriction[];
}

/**
 * The planned semantic classification of a `type: 'slide'` outline — decided at
 * outline generation from the slide's pedagogical intent, BEFORE any scene
 * content exists, and never inferred later from titles, descriptions, stage
 * names, or rendered elements.
 *
 * Three concepts, kept apart exactly as in `@openmaic/dsl`'s slide semantics:
 * `slideType` is the intended deck-structural `Slide.type` of the canvas,
 * `contentRole` the pedagogical purpose, `contentKind` the role's
 * specialization. The role/kind vocabulary and pairing table are owned by
 * `@openmaic/dsl` (`SLIDE_CONTENT_KINDS_BY_ROLE`); nothing is restated here.
 * Teaching Model stage names are per-model data and are never values of these
 * fields.
 */
export interface SlideOutlineSemantics {
  /** Intended `Slide.type` of the generated canvas. */
  slideType: SlideType;
  /**
   * Pedagogical purpose of the slide. Required on instructional slides
   * (`cover` / `content`); a purely structural `contents` / `transition` /
   * `end` slide with no teaching purpose omits it rather than inventing one.
   */
  contentRole?: SlideContentRole;
  /**
   * Specialization of `contentRole`. Present exactly when the role defines
   * kinds (`explanation`, `activity`, `practice`); absent on every other role.
   */
  contentKind?: SlideContentKind;
}

/**
 * The planner's hidden plan for a slide's on-demand assistance: WHAT the hint,
 * the help and the full explanation should convey. It is a planning contract
 * only — persisted with outlines, never part of the Stage/Slide schema and
 * never rendered. The solution path lives here and nowhere else on the
 * outline: `description` and `keyPoints` feed student-facing generation and
 * must not carry it. Its sole consumer is the assistance-authoring step, which
 * turns it into `SlideContent.assistance`; see `./slide-generation-inputs.ts`.
 */
export interface AssistancePlan {
  /** What a nudge should point the learner toward. */
  hint?: string;
  /** The approach / partial structure to offer. */
  help?: string;
  /** The full solution path and reasoning. */
  explanation?: string;
}

/**
 * The planner's decision about a slide's visual. A PLANNING contract only —
 * persisted with outlines, never part of the Stage/Slide schema, never rendered
 * or delivered as learner content. Required on the lesson opening (`cover` +
 * `orientation`), where a visual is enforced rather than hoped for:
 *
 * - `image`   — an approved source or generated image carries the visual;
 * - `native`  — the visual is composed from native slide elements (diagram /
 *   chart / illustrative shape group), e.g. when media generation is disabled;
 * - `omitted` — no visual would improve understanding, framing or engagement;
 *   `omissionReason` says why, specifically for this lesson.
 */
export interface VisualPlan {
  mode: 'image' | 'native' | 'omitted';
  omissionReason?: string;
}

/** A generation-ready description of one course scene. */
export interface SceneOutline {
  id: string;
  type: 'slide' | 'quiz' | 'interactive' | 'pbl';
  title: string;
  description: string;
  keyPoints: string[];
  teachingObjective?: string;
  estimatedDuration?: number;
  order: number;
  languageNote?: string;
  /**
   * Planned slide classification ({@link SlideOutlineSemantics}). Every NEWLY
   * generated `type: 'slide'` outline carries `slideType`, and every
   * instructional one (`cover` / `content`) a `contentRole` (plus `contentKind`
   * when the role defines kinds) — the outline generator rejects a response
   * that does not. A purely structural `contents` / `transition` / `end` slide
   * may omit the role. Never present on quiz/interactive/pbl outlines.
   * Optional in the type only so outlines persisted before the classification
   * existed still load: absence there means "unclassified", never a default.
   */
  slideType?: SlideType;
  contentRole?: SlideContentRole;
  contentKind?: SlideContentKind;
  /**
   * Planner-only {@link AssistancePlan}. Slide outlines only, and only beside
   * `contentRole` `practice` / `check_understanding`; required (`hint` +
   * `explanation`) for `practice` / `independent`. The outline gate rejects it
   * anywhere else — it is never silently dropped from a slide outline.
   */
  assistancePlan?: AssistancePlan;
  /** Planner-only {@link VisualPlan}. Slide outlines only; required on `cover` + `orientation`. */
  visualPlan?: VisualPlan;
  /** Kafuo Teaching Model Flow identity; functionally mandatory on Kafuo runs. */
  teachingStage?: TeachingStageRef;
  /**
   * Teaching Skills assignment + instructional classification (Module 2 W9),
   * selected at outline generation (W10) and copied verbatim onto the Scene.
   * Absent on legacy and non-Kafuo runs.
   */
  teachingSkills?: SceneTeachingSkills;
  /** Machine-readable normalized Kafuo grounding; optional for PDF/non-Kafuo runs. */
  sourceContentUnitIds?: string[];
  sourceBlockIds?: string[];
  suggestedImageIds?: string[];
  mediaGenerations?: MediaGenerationRequest[];
  quizConfig?: {
    questionCount: number;
    difficulty: 'easy' | 'medium' | 'hard';
    questionTypes: ('single' | 'multiple' | 'text')[];
  };
  /**
   * @deprecated Use widgetType + widgetOutline instead
   * Legacy interactive config - kept for backward compatibility only
   */
  interactiveConfig?: {
    conceptName: string;
    conceptOverview: string;
    designIdea: string;
    subject?: string;
  };
  pblConfig?: {
    projectTopic: string;
    projectDescription: string;
    targetSkills: string[];
    issueCount?: number;
    scenarioRoleplay?: boolean;
    scenarioBrief?: string;
  };
  widgetType?: WidgetType;
  widgetOutline?: WidgetOutline;
}
