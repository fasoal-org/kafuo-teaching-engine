/**
 * Outbound webhook event enqueueing (plan §4.4.2).
 *
 * `enqueueWebhookEvent` runs INSIDE the domain transaction that caused the
 * event, allocating a per-aggregate sequence under a `pg_advisory_xact_lock`
 * scoped to the webhook namespace — re-entrant within the same transaction
 * (approve enqueues two events), serializing concurrent transactions on one
 * aggregate so later events can never overtake earlier pending ones.
 *
 * A process crash after the domain commit and before the first HTTP delivery
 * loses nothing: the pending row IS the outbox, and the boot/interval sweep
 * delivers it.
 *
 * Exactly the three FRD §9.8 event types exist. `createSuccessor` emits none:
 * successor creation is not a `previousStatus → status` transition, and Kafuo
 * projects it from the synchronous `201 { version }` response.
 */
import { randomBytes } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import {
  insertWebhookDelivery,
  readLatestWebhookSequence,
} from '@/lib/persistence/teaching-package';
import type { TeachingPackageAggregateKey } from '@/lib/types/teaching-package';

/** Namespaced lock key so webhook sequence allocation cannot collide with the item lock. */
function webhookLockKey(aggregate: TeachingPackageAggregateKey): string {
  return `teaching-package-webhook:${aggregate.tenantId}:${aggregate.learningItem.type}:${aggregate.learningItem.id}`;
}

export async function enqueueWebhookEvent(
  tx: Queryable,
  aggregate: TeachingPackageAggregateKey,
  eventType:
    | 'teaching_package.generation_succeeded'
    | 'teaching_package.generation_failed'
    | 'teaching_package.status_changed',
  buildPayload: (sequence: number, eventId: string) => Record<string, unknown>,
): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    webhookLockKey(aggregate),
  ]);
  const latest = await readLatestWebhookSequence(tx, aggregate);
  const sequence = latest + 1;
  const eventId = `tpe-${randomBytes(12).toString('base64url')}`;
  const payload = buildPayload(sequence, eventId);
  const serialized = JSON.stringify(payload);
  if (
    serialized.includes('contentResource') ||
    serialized.includes('normalizedContentResource') ||
    serialized.includes('requirement') ||
    serialized.includes('pdfContent') ||
    /https?:\/\/[^"\s]*[?&](x-amz-signature|sig|token)=/i.test(serialized)
  ) {
    throw new Error('webhook payload must not carry source content or retrieval credentials');
  }
  await insertWebhookDelivery(tx, {
    id: eventId,
    aggregate,
    sequence,
    eventType,
    occurredAt: Date.now(),
    payload,
    now: Date.now(),
  });
}
