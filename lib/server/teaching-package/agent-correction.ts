/**
 * Kafuo Agent API wave E2 (`correction:write`): what the agent's C1 correction routes
 * allow (agent API plan §1.5, §8 E2).
 *
 * - The actor is always `agent:<user id>` (the Backend's `ai_assistant` user), so the
 *   checkpoint's edit log tells an agent's edit from a person's.
 * - The operations are the engine's own five: `set`, `remove`, `move`,
 *   `insert_book_slide`, `ignore_issue`. `review_plan` and `revert_fix` are refused, and
 *   there is no agent route to abandon an attempt.
 * - `dryRun` is a strict boolean (absent = false).
 */
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import type { CorrectionOperation } from '@/lib/server/teaching-package/outline-correction';

export const AGENT_CORRECTION_OPERATIONS = [
  'set',
  'remove',
  'move',
  'insert_book_slide',
  'ignore_issue',
] as const;

const AGENT_ACTOR = /^agent:[1-9][0-9]{0,18}$/;

export function assertAgentActorRef(actorRef: unknown): string {
  if (typeof actorRef !== 'string' || !AGENT_ACTOR.test(actorRef)) {
    throw new TeachingPackageError(
      'AGENT_ACTION_NOT_ALLOWED',
      'the agent correction routes take only an agent:<user id> actor',
    );
  }
  return actorRef;
}

export function assertAgentCorrectionOperations(operations: readonly CorrectionOperation[]): void {
  const refused = operations
    .map((operation, index) => ({ index, op: operation.op }))
    .filter(({ op }) => !(AGENT_CORRECTION_OPERATIONS as readonly string[]).includes(op));
  if (refused.length > 0) {
    throw new TeachingPackageError(
      'AGENT_ACTION_NOT_ALLOWED',
      `the agent may use only ${AGENT_CORRECTION_OPERATIONS.join(', ')}`,
      { operations: refused, allowedOperations: [...AGENT_CORRECTION_OPERATIONS] },
    );
  }
}

export function parseDryRun(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw new TeachingPackageError('INVALID_REQUEST', 'dryRun must be a boolean');
  }
  return value;
}
