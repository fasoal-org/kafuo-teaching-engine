/**
 * The checks of a resume request body, shared by the administrator's resume route
 * (`generation-attempts/[attemptId]/resume`) and the Kafuo Agent API's
 * (`generation-attempts/[attemptId]/agent-resume`, wave E2). Moved verbatim from the
 * administrator's route, in the same order, so both refuse the same request the same
 * way before any state changes.
 *
 * `request` is the attempt's own Kafuo generation request re-sent with FRESH presigned
 * URLs — the same shape POST /api/teaching-packages/generate accepts, parsed with the
 * same parser.
 */
import {
  assertConfiguredGenerationRouteAvailable,
  assertConfiguredTtsRouteAvailable,
  buildKafuoStartRequest,
  parseKafuoGenerationRequest,
} from '@/lib/server/teaching-package/kafuo-request';
import { assertKafuoFlowWithoutGames } from '@/lib/server/teaching-package/kafuo-game-deferral';
import { parseTenantContext } from '@/lib/server/teaching-package/route-helpers';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  isSubjectCode,
  POLICY_VERSION,
  readRoutingMode,
} from '@/lib/server/teaching-model/subject-policy';

export function parseCorrectionResumeBody(body: Record<string, unknown> | null) {
  if (!body) {
    throw new TeachingPackageError('INVALID_REQUEST', 'request body must be a JSON object');
  }
  if (typeof body.actorRef !== 'string') {
    throw new TeachingPackageError('ACTOR_REQUIRED', 'actorRef must be a string');
  }
  const tenantId = parseTenantContext(body);
  const expectedRevision = body.expectedRevision;
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 1
  ) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'expectedRevision must be a positive integer',
    );
  }
  if (!body.request || typeof body.request !== 'object' || Array.isArray(body.request)) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'request must be the Kafuo generation request object',
    );
  }

  const { request, aggregate } = parseKafuoGenerationRequest(
    body.request as Record<string, unknown>,
  );
  // The tenant is server-scoped exactly once per call: the re-sent request
  // must name the tenant the resume is addressed to.
  if (aggregate.tenantId !== tenantId) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'request.tenantContext.tenantId must equal tenantContext.tenantId',
    );
  }
  const { start, kafuo } = buildKafuoStartRequest(request, aggregate);
  // The same subject-routing refusal the generate route applies (Kafuo R1
  // contracts §6, AMB-04): under TEACHING_SUBJECT_ROUTING=enforced an
  // unrouted subject is refused on the request, before any state changes.
  if (readRoutingMode() === 'enforced' && !isSubjectCode(kafuo.subjectCode)) {
    throw new TeachingPackageError(
      'SUBJECT_ROUTE_UNAVAILABLE',
      kafuo.subjectCode === null
        ? 'learningItem.subjectOffering.code is required: the subject has no routing key, so no teaching model route exists for it'
        : `learningItem.subjectOffering.code ${JSON.stringify(kafuo.subjectCode)} is not in the routing policy ${POLICY_VERSION}`,
      { subjectCode: kafuo.subjectCode, subjectOffering: kafuo.subjectOffering },
    );
  }

  // Kafuo Release 1 defers generated games: an attempt started under a flow
  // that requires or allows a game (g5.v2–v5) is refused before its state
  // changes. Its retained snapshot is not rewritten; abandon still works.
  assertKafuoFlowWithoutGames(request.teachingModel, 'resume');
  // A configured narration route's provider must still be usable (plan
  // D-7): refused before the attempt's state changes, never a silent lesson.
  assertConfiguredTtsRouteAvailable(kafuo);
  // The same for a configured generation model route (teaching-generation-
  // model-admin-config-plan-2026-11-18 D-11): the re-sent request carries the
  // attempt's own route (its digest must match), and both models must still
  // be keyed, or the resume is refused before the attempt's state changes.
  assertConfiguredGenerationRouteAvailable(kafuo);

  return {
    tenantId,
    actorRef: body.actorRef as string,
    expectedRevision,
    start,
    kafuo,
    aggregate,
  };
}
