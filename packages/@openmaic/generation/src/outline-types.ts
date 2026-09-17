import type { WidgetType } from '@openmaic/dsl';

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
  /** Intentional `0..N` supporting Skills (BR-TS-022). */
  supporting?: SceneSkillRef[];
  /** Emitted at outline time; never derived from Skill absence (BR-TS-054). */
  classification?: 'instructional' | 'non-instructional';
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
