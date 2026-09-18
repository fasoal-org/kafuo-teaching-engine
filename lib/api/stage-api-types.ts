/**
 * Stage API - Type Definitions
 *
 * Shared types used across all stage-api sub-modules.
 */

import type { Stage, Scene, SceneContent, SceneType, StageMode } from '@/lib/types/stage';
import type { PPTElement } from '@openmaic/dsl';
import type { Action } from '@/lib/types/action';
import type { SceneTeachingSkills, TeachingStageRef } from '@/lib/types/teaching-package';

// ==================== Type Definitions ====================

/**
 * API operation result
 */
export interface APIResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Scene creation parameters
 */
export interface CreateSceneParams {
  type: SceneType;
  title: string;
  content?: Partial<SceneContent>;
  order?: number;
  actions?: Action[];
  /** Stable id of the generation outline this scene was built from (see {@link Scene.outlineId}). */
  outlineId?: string;
  /** Teaching-stage identity copied exactly from the outline (Kafuo packages). */
  teachingStage?: TeachingStageRef;
  /**
   * Teaching Skills assignment + classification copied exactly from the outline
   * (Module 2 W9/W10). Absent — not `undefined`-valued — on carrier-free
   * outlines; that absence is the backward-compatibility mechanism (AC-TS-034).
   */
  teachingSkills?: SceneTeachingSkills;
}

/**
 * Element creation parameters (required fields)
 */
export type CreateElementParams = {
  type: PPTElement['type'];
  left: number;
  top: number;
  width: number;
  height: number;
  rotate?: number;
  [key: string]: unknown; // Allow other element-specific properties
};

/**
 * Highlight options
 */
export interface HighlightOptions {
  duration?: number; // milliseconds
  color?: string;
  style?: 'outline' | 'fill' | 'shadow';
}

/**
 * Spotlight options
 */
export interface SpotlightOptions {
  duration?: number;
  radius?: number;
  dimness?: number; // 0-1, background dimming level
}

// ==================== Store Interface ====================

/**
 * Stage Store interface (for dependency injection)
 */
export interface StageStore {
  getState: () => {
    stage: Stage | null;
    scenes: Scene[];
    currentSceneId: string | null;
    mode: StageMode;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setState: (partial: any) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subscribe: (listener: (state: any, prevState: any) => void) => () => void;
}
