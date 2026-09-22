/**
 * Optional conversation compaction (Kafuo R1 FRD BUD-02, CHAT-03; plan §8.1,
 * §8.5 Revision 4, TD-06). `TUTOR_COMPACTION_ENABLED=false` by default.
 *
 * When enabled, after a completed turn and OFF the request path, one call
 * (stage `free-chat-compaction`, capability `free_chat`, the conversation's
 * subject route through the same executor, the same assembler entry)
 * summarises the turns older than the recent window into `context_summary`
 * / `summary_through_seq`. The assembler then sends the summary block plus
 * the turns after it. The conversation itself is never modified — only the
 * model-facing window changes.
 */
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { createLogger } from '@/lib/logger';
import {
  readConversation,
  readMessagesBySeq,
  updateConversationContextSummary,
} from '@/lib/persistence/tutor-runtime';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import { executeTeachingCall, type TeachingCallOptions } from '@/lib/server/teaching-model/execute';
import type { ResolvedSubjectPolicy } from '@/lib/server/teaching-model/resolve-policy';
import { detectScript } from '@/lib/server/tutor/arabic-text';
import { assembleTutorPrompt, type AcademicBlockInput } from '@/lib/server/tutor/prompt-assembly';
import { COMPACTION_PROMPT_TEXT, COMPACTION_REQUEST_TEXT } from '@/lib/server/tutor/tutor-rules';
import { pairHistoryTurns } from '@/lib/server/tutor/turn-runner';

const log = createLogger('TutorCompaction');

/** Turns kept verbatim after the summary. */
export const COMPACTION_KEEP_RECENT_TURNS = 6;
/** Compact only when at least this many uncompacted turns precede the recent window. */
export const COMPACTION_MIN_OLD_TURNS = 8;
export const COMPACTION_SUMMARY_MAX_CHARS = 1200;
export const COMPACTION_INPUT_TOKEN_CAP = 8_000;

export function isCompactionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.TUTOR_COMPACTION_ENABLED?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export interface CompactionInput {
  pool: ConnectableQueryable;
  conversationId: string;
  policy: ResolvedSubjectPolicy;
  academic: AcademicBlockInput | null;
  turnId: string;
  proxyRatio?: number | null;
  executor: TeachingCallOptions;
  /** Epoch seconds. */
  now: number;
}

export interface CompactionOutcome {
  compacted: boolean;
  summaryThroughSeq: number | null;
}

/**
 * Summarise the turns older than the recent window that the current summary
 * does not cover yet. Returns `{ compacted: false }` when there is nothing to
 * do or the model call failed (the next turn simply tries again).
 */
export async function compactConversation(input: CompactionInput): Promise<CompactionOutcome> {
  const conversation = await readConversation(input.pool, input.conversationId);
  if (!conversation) return { compacted: false, summaryThroughSeq: null };

  const { messages } = await readMessagesBySeq(input.pool, {
    parentId: conversation.id,
    limit: 200,
  });
  const afterSummary = messages.filter(
    (message) =>
      conversation.summaryThroughSeq === null || message.seq > conversation.summaryThroughSeq,
  );
  const completedStudents = afterSummary.filter((m) => m.role === 'student' && m.status === 'completed');
  const oldStudents = completedStudents.slice(0, Math.max(0, completedStudents.length - COMPACTION_KEEP_RECENT_TURNS));
  if (oldStudents.length < COMPACTION_MIN_OLD_TURNS) {
    return { compacted: false, summaryThroughSeq: conversation.summaryThroughSeq };
  }
  const boundaryStudent = oldStudents[oldStudents.length - 1]!;
  const reply = afterSummary.find((m) => m.role === 'tutor' && m.turnId === boundaryStudent.turnId);
  const throughSeq = reply ? reply.seq : boundaryStudent.seq;
  const oldWindow = afterSummary.filter((m) => m.seq <= throughSeq);
  const turns = pairHistoryTurns(oldWindow);
  if (turns.length === 0) return { compacted: false, summaryThroughSeq: conversation.summaryThroughSeq };

  let assembled: ReturnType<typeof assembleTutorPrompt>;
  try {
    assembled = assembleTutorPrompt({
      rules: COMPACTION_PROMPT_TEXT,
      academic: input.academic,
      grounding: { mode: 'none' },
      history: { summary: conversation.contextSummary, turns },
      message: COMPACTION_REQUEST_TEXT,
      policy: input.policy,
      counters: { proxyRatio: input.proxyRatio ?? null },
      directives: { responseScript: detectScript(turns[turns.length - 1]!.student) },
      capTokens: COMPACTION_INPUT_TOKEN_CAP,
    });
  } catch (error) {
    log.warn(JSON.stringify({ event: 'tutor.compaction_skipped', conversationId: conversation.id, error: describeErrorSafely(error) }));
    return { compacted: false, summaryThroughSeq: conversation.summaryThroughSeq };
  }

  try {
    const result = await executeTeachingCall(
      input.policy,
      {
        tenantId: conversation.tenantId,
        capability: 'free_chat',
        stage: 'free-chat-compaction',
        origin: 'openmaic_runtime',
        association: {
          kind: 'turn',
          turnId: input.turnId,
          conversationId: conversation.id,
          studentRef: conversation.studentRef,
        },
        budget: {
          estimate: assembled.budget.estimate,
          counterKind: assembled.budget.counterKind,
          effectiveCap: assembled.budget.effectiveCap,
        },
      },
      { messages: assembled.messages, maxOutputTokens: 600 },
      input.executor,
    );
    const summary = result.text.trim().slice(0, COMPACTION_SUMMARY_MAX_CHARS);
    if (!summary) return { compacted: false, summaryThroughSeq: conversation.summaryThroughSeq };
    await updateConversationContextSummary(input.pool, conversation.id, {
      contextSummary: summary,
      summaryThroughSeq: throughSeq,
      now: input.now,
    });
    log.info(JSON.stringify({ event: 'tutor.compaction', conversationId: conversation.id, throughSeq, turns: turns.length }));
    return { compacted: true, summaryThroughSeq: throughSeq };
  } catch (error) {
    log.warn(JSON.stringify({ event: 'tutor.compaction_failed', conversationId: conversation.id, error: describeErrorSafely(error) }));
    return { compacted: false, summaryThroughSeq: conversation.summaryThroughSeq };
  }
}
