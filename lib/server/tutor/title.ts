/**
 * Automatic conversation titles (Kafuo R1 FRD CHAT-02; plan §8.5, TD-10).
 *
 * After the first completed turn, and again after any turn while the title is
 * `pending`:
 *  - confident lesson association → the official lesson title
 *    (`title_source='lesson'`); a second conversation of the same student on
 *    the same lesson gets a short topic suffix (`<lesson> — <topic>`,
 *    `lesson_suffix`), generic numbering only when the topic call fails;
 *  - no lesson → one bounded call (stage `free-chat-title`, capability
 *    `free_chat`, ≤ 300 input tokens, Primary → Fallback through the same
 *    executor and the same assembler entry) producing a ≤ 6-word topic
 *    (`topic`);
 *  - both routes fail → the first content keywords are shown with
 *    `title_source='pending'` and the call is retried after the next turn;
 *    a second failure settles on `fallback`.
 *  - a later confident lesson match may replace a topic/fallback/pending
 *    title with the lesson title without touching subject or history.
 *
 * The associated item is association v2 (a LESSON or SECTION Learning Item)
 * or, while `kafuo_http` can still be rolled back to, the schema-1 lesson.
 * Sibling counts key on the full `(schema, type, id)` tuple (P7).
 *
 * Never on the student's critical path: the runner calls this after `done`.
 */
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { createLogger } from '@/lib/logger';
import {
  associationKey,
  associationTitle,
  countConversationsForLesson,
  readConversation,
  updateConversationTitle,
  type TitleSource,
  type TutorConversation,
} from '@/lib/persistence/tutor-runtime';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import { executeTeachingCall, type TeachingCallOptions } from '@/lib/server/teaching-model/execute';
import type { ResolvedSubjectPolicy } from '@/lib/server/teaching-model/resolve-policy';
import { contentSurfaceWords, detectScript } from '@/lib/server/tutor/arabic-text';
import { assembleTutorPrompt, type AcademicBlockInput } from '@/lib/server/tutor/prompt-assembly';
import { TITLE_PROMPT_TEXT, TITLE_REQUEST_TEXT } from '@/lib/server/tutor/tutor-rules';

const log = createLogger('TutorTitle');

export const TITLE_INPUT_TOKEN_CAP = 300;
export const TITLE_MAX_WORDS = 6;
export const TITLE_MAX_CHARS = 80;
const EXCERPT_LENGTHS = [400, 240, 120, 60] as const;

/** Normalise a model title: one line, no quotes, ≤ 6 words, ≤ 80 chars. */
export function sanitizeTitle(raw: string): string | null {
  const line = raw
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return null;
  let stripped = line.replace(/^(title|العنوان)\s*[:：]\s*/i, '').trim();
  // Quotes and trailing punctuation may wrap each other ("…". / «…»؟): peel until stable.
  for (;;) {
    const next = stripped
      .replace(/^["'“”«»‘’`]+|["'“”«»‘’`]+$/g, '')
      .replace(/[.。!؟?،,]+$/g, '')
      .trim();
    if (next === stripped) break;
    stripped = next;
  }
  if (!stripped) return null;
  const words = stripped.split(/\s+/).slice(0, TITLE_MAX_WORDS);
  const title = words.join(' ');
  return title.length > TITLE_MAX_CHARS ? `${title.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…` : title;
}

/**
 * TE-2: a turn whose stored `safety` record is triggered (pre-check) or is
 * the boundary never names the conversation — neither the topic call nor
 * the keyword fallback may read it. The title stays as it is (`pending`)
 * until a normal turn.
 */
export function isSafetyFlaggedTurn(safety: Record<string, unknown> | null | undefined): boolean {
  return safety?.triggered === true || safety?.boundary === true;
}

/** `title_source='fallback'` text: the first content words of the student's message, as written. */
export function keywordTitle(studentText: string, maxWords = 4): string | null {
  const words = contentSurfaceWords(studentText, maxWords);
  return words.length ? words.join(' ') : null;
}

export interface TitleCallInput {
  policy: ResolvedSubjectPolicy;
  tenantId: string;
  conversationId: string;
  turnId: string;
  studentRef: string;
  academic: AcademicBlockInput | null;
  firstTurn: { student: string; tutor: string };
  proxyRatio?: number | null;
  executor: TeachingCallOptions;
}

/**
 * One bounded topic call through the same assembler entry (`capTokens`
 * 300) and the same executor. Excerpts shrink until the request fits;
 * returns `null` when both routes fail or the output is unusable.
 */
export async function generateTopicTitle(input: TitleCallInput): Promise<string | null> {
  const script = detectScript(input.firstTurn.student);
  let assembled: ReturnType<typeof assembleTutorPrompt> | null = null;
  for (const length of EXCERPT_LENGTHS) {
    try {
      assembled = assembleTutorPrompt({
        rules: TITLE_PROMPT_TEXT,
        academic: input.academic,
        grounding: { mode: 'none' },
        history: {
          turns: [
            {
              student: input.firstTurn.student.slice(0, length),
              tutor: input.firstTurn.tutor.slice(0, length),
            },
          ],
        },
        message: TITLE_REQUEST_TEXT,
        policy: input.policy,
        counters: { proxyRatio: input.proxyRatio ?? null },
        directives: { responseScript: script },
        capTokens: TITLE_INPUT_TOKEN_CAP,
      });
      if (assembled.history.turnsIncluded === 1) break;
      assembled = null;
    } catch {
      assembled = null;
    }
  }
  if (!assembled) return null;
  try {
    const result = await executeTeachingCall(
      input.policy,
      {
        tenantId: input.tenantId,
        capability: 'free_chat',
        stage: 'free-chat-title',
        origin: 'openmaic_runtime',
        association: {
          kind: 'turn',
          turnId: input.turnId,
          conversationId: input.conversationId,
          studentRef: input.studentRef,
        },
        budget: {
          estimate: assembled.budget.estimate,
          counterKind: assembled.budget.counterKind,
          effectiveCap: assembled.budget.effectiveCap,
        },
      },
      { messages: assembled.messages, maxOutputTokens: 32 },
      input.executor,
    );
    return sanitizeTitle(result.text);
  } catch (error) {
    log.warn(
      JSON.stringify({
        event: 'tutor.title_failed',
        conversationId: input.conversationId,
        error: describeErrorSafely(error),
      }),
    );
    return null;
  }
}

export interface EnsureTitleInput {
  pool: ConnectableQueryable;
  conversation: TutorConversation;
  policy: ResolvedSubjectPolicy;
  turnId: string;
  firstTurn: { student: string; tutor: string } | null;
  academic: AcademicBlockInput | null;
  proxyRatio?: number | null;
  executor: TeachingCallOptions;
  /** Epoch seconds. */
  now: number;
}

export interface TitleOutcome {
  title: string | null;
  titleSource: TitleSource | null;
  changed: boolean;
}

function needsTitle(conversation: TutorConversation): boolean {
  return conversation.title === null || conversation.titleSource === null || conversation.titleSource === 'pending';
}

/**
 * Decide and persist the conversation's title after a completed turn.
 * Re-reads the row (the turn transaction may have added a lesson
 * association) and writes at most once.
 */
export async function ensureConversationTitle(input: EnsureTitleInput): Promise<TitleOutcome> {
  const fresh = (await readConversation(input.pool, input.conversation.id)) ?? input.conversation;
  const association = fresh.lessonAssociation;
  const unchanged: TitleOutcome = { title: fresh.title, titleSource: fresh.titleSource, changed: false };

  // A confident lesson match names the conversation (possibly replacing a topic).
  if (
    association &&
    associationTitle(association).trim() !== '' &&
    fresh.titleSource !== 'lesson' &&
    fresh.titleSource !== 'lesson_suffix'
  ) {
    const itemTitle = associationTitle(association);
    const siblings = await countConversationsForLesson(
      input.pool,
      { tenantId: fresh.tenantId, studentRef: fresh.studentRef },
      associationKey(association),
      fresh.id,
    );
    let title = itemTitle;
    let source: TitleSource = 'lesson';
    if (siblings > 0) {
      const topic = input.firstTurn
        ? await generateTopicTitle({
            policy: input.policy,
            tenantId: fresh.tenantId,
            conversationId: fresh.id,
            turnId: input.turnId,
            studentRef: fresh.studentRef,
            academic: input.academic,
            firstTurn: input.firstTurn,
            proxyRatio: input.proxyRatio,
            executor: input.executor,
          })
        : null;
      title = topic ? `${itemTitle} — ${topic}` : `${itemTitle} — ${siblings + 1}`;
      source = 'lesson_suffix';
    }
    await updateConversationTitle(input.pool, fresh.id, { title, titleSource: source, now: input.now });
    return { title, titleSource: source, changed: true };
  }

  if (!needsTitle(fresh)) return unchanged;
  if (!input.firstTurn) return unchanged;

  const topic = await generateTopicTitle({
    policy: input.policy,
    tenantId: fresh.tenantId,
    conversationId: fresh.id,
    turnId: input.turnId,
    studentRef: fresh.studentRef,
    academic: input.academic,
    firstTurn: input.firstTurn,
    proxyRatio: input.proxyRatio,
    executor: input.executor,
  });
  if (topic) {
    await updateConversationTitle(input.pool, fresh.id, { title: topic, titleSource: 'topic', now: input.now });
    return { title: topic, titleSource: 'topic', changed: true };
  }
  // Both routes failed: show keywords; `pending` retries after the next turn,
  // a second failure settles on `fallback`. A row created `pending` with no
  // title yet has never been tried — this is its first failure.
  const keywords = keywordTitle(input.firstTurn.student) ?? fresh.title ?? null;
  const source: TitleSource = fresh.titleSource === 'pending' && fresh.title !== null ? 'fallback' : 'pending';
  await updateConversationTitle(input.pool, fresh.id, { title: keywords, titleSource: source, now: input.now });
  return { title: keywords, titleSource: source, changed: true };
}
