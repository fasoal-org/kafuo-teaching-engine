/**
 * The agent read API's send-readiness (Kafuo Agent API plan §1.5, §3.3; spec
 * §5.4 subset). Pure: the route reads the lock facts and `submitBlockers()`.
 *
 * `editor.locked` = the stage guard refuses a content write (the version is
 * not draft/rejected, or the Stage is displaced) OR a paid generation lease is
 * held on the Stage (a running slide regeneration or slide insertion with a
 * valid lease, or the producing attempt still queued/running). `lock_reason`
 * names the first that applies:
 * `stage_locked:<reason>` (the guard's reason, e.g. `stage_locked:in_review`),
 * `slide_regeneration_running`, `slide_insertion_running`, `generation_running`.
 */
import type { SubmitBlocker } from '@/lib/server/teaching-package/lifecycle';
import type { AppScene } from '@/lib/types/stage';

export interface AgentReadiness {
  version_id: string;
  status: string;
  generation_status: string | null;
  editor: { locked: boolean; lock_reason: string | null };
  send_for_approval: {
    allowed: boolean;
    blocked_by: Array<{ code: string; message: string; details: unknown }>;
  };
  counts: { scenes: number; slides: number; quizzes: number };
}

export interface EditorLockFacts {
  /** The stage guard's refusal reason, or null when a content write is allowed. */
  stageLockedReason: string | null;
  runningRegenerations: number;
  runningInsertion: boolean;
  /** The producing attempt's status, when there is one. */
  generationStatus: string | null;
}

export function editorLock(facts: EditorLockFacts): AgentReadiness['editor'] {
  const reason =
    facts.stageLockedReason !== null
      ? `stage_locked:${facts.stageLockedReason}`
      : facts.runningRegenerations > 0
        ? 'slide_regeneration_running'
        : facts.runningInsertion
          ? 'slide_insertion_running'
          : facts.generationStatus === 'queued' || facts.generationStatus === 'running'
            ? 'generation_running'
            : null;
  return { locked: reason !== null, lock_reason: reason };
}

export function buildAgentReadiness(input: {
  version: { id: string; status: string };
  lock: EditorLockFacts;
  blockers: readonly SubmitBlocker[];
  scenes: readonly Pick<AppScene, 'type'>[];
}): AgentReadiness {
  return {
    version_id: input.version.id,
    status: input.version.status,
    generation_status: input.lock.generationStatus,
    editor: editorLock(input.lock),
    send_for_approval: {
      allowed: input.blockers.length === 0,
      blocked_by: input.blockers.map((blocker) => ({
        code: blocker.code,
        message: blocker.message,
        details: blocker.details ?? null,
      })),
    },
    counts: {
      scenes: input.scenes.length,
      slides: input.scenes.filter((scene) => scene.type === 'slide').length,
      quizzes: input.scenes.filter((scene) => scene.type === 'quiz').length,
    },
  };
}
