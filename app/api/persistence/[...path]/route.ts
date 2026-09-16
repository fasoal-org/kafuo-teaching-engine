import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import {
  createStorageHttpHandler,
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  type AssetIndirectByteEgress,
} from '@openmaic/storage/server';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { resolveAssetCollectionGraceMs } from '@/lib/persistence/asset-collection-grace';
import {
  decideDocumentAccess,
  parseDocumentAction,
  type DocumentAccess,
} from '@/lib/persistence/document-access';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import {
  authenticatePersistenceRequest,
  SHARED_ASSET_PRINCIPAL,
} from '@/lib/persistence/server-auth';
import {
  getServerPersistenceProvider,
  type PersistencePoolFactory,
} from '@/lib/persistence/server-provider';
import { readStageMeta } from '@/lib/persistence/stage-meta';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import {
  assertStageWritable,
  teachingPackageStageGuardFence,
} from '@/lib/server/teaching-package/stage-guard';
import { isTeachingPackageStageLockedError } from '@/lib/server/teaching-package/errors';
import {
  deriveDocumentStageId,
  deriveRuntimeScope,
  readEditorGrants,
  type VerifiedEditorGrant,
} from '@/lib/server/teaching-package/editor-grant';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';

export const runtime = 'nodejs';

const ROUTE_PREFIX = '/api/persistence';

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/**
 * ASSET_BYTE_EGRESS: set to `redirect` to answer asset byte GETs with a 302 to
 * a short-lived signed URL, when the byte layer can sign (S3 can; the
 * PostgreSQL byte column cannot, and falls back to direct bytes). Anything
 * else, including unset and `direct`, keeps the default byte-for-byte
 * behavior. The tradeoff this opts into -- the redirect target names the
 * content hash -- is specified in the storage package's asset HTTP contract.
 */
function configuredAssetByteEgress(value: string | undefined): 'redirect' | undefined {
  const raw = value?.trim().toLowerCase();
  if (raw === 'redirect') return 'redirect';
  if (raw === undefined || raw === '' || raw === 'direct') return undefined;
  console.warn(`ASSET_BYTE_EGRESS=${value} is not recognized; using direct byte egress`);
  return undefined;
}

/**
 * Redirect egress and the collection grace must agree: a signed URL that
 * outlives its object turns a valid read into an object-store error. The
 * handler enforces that invariant itself, on the grace passed here, and this
 * grace is resolved by the collector's own parser so both components run on one
 * number.
 *
 * A grace too short for the default lifetime degrades to direct egress with a
 * loud warning rather than failing initialization: the asset backend is
 * optional, and its misconfiguration must never take document and runtime
 * traffic down with it.
 */
function indirectEgressWithinGrace(
  egress: 'redirect' | undefined,
): AssetIndirectByteEgress | undefined {
  if (egress !== 'redirect') return undefined;
  const collectionGraceMs = resolveAssetCollectionGraceMs();
  if (collectionGraceMs < DEFAULT_SIGNED_URL_TTL_SECONDS * 1000 * 10) {
    console.warn(
      `ASSET_BYTE_EGRESS=redirect requires ASSET_COLLECTION_GRACE_MS to be at least ten times ` +
        `the signed URL lifetime (${DEFAULT_SIGNED_URL_TTL_SECONDS}s); got ${collectionGraceMs}ms. ` +
        `Falling back to direct byte egress.`,
    );
    return undefined;
  }
  return { mode: 'redirect', collectionGraceMs };
}

async function createPersistenceHandler(
  connectionString: string,
  ownerId: string,
  access: DocumentAccess,
  poolFactory?: PersistencePoolFactory,
  grantRuntimeLearnerKey?: string,
): Promise<RequestListener> {
  const { pool, runtimeStore, assetStore } = await getServerPersistenceProvider(
    connectionString,
    poolFactory,
  );
  const documentStore = createOwnerBoundDocumentStore({
    pool,
    ownerId,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
    // Teaching package immutability, inside every mutation transaction.
    mutationFence: teachingPackageStageGuardFence(),
  });
  // The asset posture, precisely.
  //
  // Reading an asset and allocating one are open to any caller this deployment
  // lets in, exactly as reading a document and creating one already are: assets
  // live in a single shared partition by design (see the SHARED_ASSET_PRINCIPAL
  // comment in lib/persistence/server-auth.ts), so there is nothing per-caller
  // for the development authenticator to decide about them, and routing them
  // through it made every asset request fail in a production build that had not
  // opted into that authenticator — the build this project's own
  // server-persistence recipe produces.
  //
  // Replacing and deleting are refused outright — to everyone, authenticated or
  // not. Those operations scope by principal key alone, and every caller
  // resolves to the same shared key, so authentication decides nothing here:
  // any signed-in visitor who learned an id, and a document read hands out
  // every id its slides name, could overwrite or destroy another author's
  // media. There is no per-asset ownership to check against yet, and since this
  // application began storing generated media the registry is the only copy a
  // course has, so the answer is no mutations at all. Nothing in the app
  // performs an asset PUT or DELETE; an entry nothing references waits for
  // server-side reclamation rather than being deleted from the browser.
  //
  // What this is NOT: a per-caller access control. The deployment-level fence
  // is the access code. Allocation is bounded by the asset store's per-principal
  // quota, which with one shared principal is a deployment-wide cap.
  //
  // Runtime requests still take their partition key from a client-supplied
  // header, because a runtime session genuinely is per-learner state. Before
  // runtime routes carry production data, their authenticator must be replaced
  // with real session verification.
  // Reclamation is not scheduled from here, and must not be: a route module
  // has no once-per-process guarantee and no shutdown hook. AssetCollector
  // runs from instrumentation.ts instead, over the byte store this same
  // lib/persistence/asset-byte-store selection produces, so the collector
  // always deletes through the layer the request path wrote through.
  const byteEgress = indirectEgressWithinGrace(
    configuredAssetByteEgress(process.env.ASSET_BYTE_EGRESS),
  );
  return createStorageHttpHandler(runtimeStore, documentStore, {
    authenticate: async (request) => {
      if (request.url?.startsWith('/documents')) return { learnerKey: ownerId };
      if (request.url?.startsWith('/assets')) {
        return { key: SHARED_ASSET_PRINCIPAL, learnerKey: ownerId };
      }
      // A delegated runtime request under an Editor grant runs as the grant's
      // own isolated learner identity — never a client-supplied header — so
      // requireLearner pins every touched session to that sandbox.
      if (grantRuntimeLearnerKey) {
        return { key: SHARED_ASSET_PRINCIPAL, learnerKey: grantRuntimeLearnerKey };
      }
      return authenticatePersistenceRequest(request);
    },
    authorizeAssets: async (_principal, request) => {
      const method = (request.method ?? 'GET').toUpperCase();
      // Reads and allocations for everyone; mutations for nobody, because the
      // principal they would be scoped to is shared and therefore proves
      // nothing about who is asking.
      return method !== 'PUT' && method !== 'DELETE';
    },
    authorizeMerge: async () => false,
    authorizeAdmin: async () => false,
    authorizeDocuments: async () => access === 'allow',
    validateScene: validateAppScene,
    validateStage: validateAppStage,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    assetStore,
    ...(byteEgress === undefined ? {} : { byteEgress }),
  });
}

function routeRelativePath(request: Request): string {
  const pathname = new URL(request.url).pathname;
  return pathname.startsWith(ROUTE_PREFIX) ? pathname.slice(ROUTE_PREFIX.length) || '/' : pathname;
}

function nodeRequest(request: Request): IncomingMessage {
  const url = new URL(request.url);
  const pathname = url.pathname.startsWith(ROUTE_PREFIX)
    ? url.pathname.slice(ROUTE_PREFIX.length) || '/'
    : url.pathname;
  const body = request.body
    ? Readable.fromWeb(
        request.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
      )
    : Readable.from([]);
  return Object.assign(body, {
    method: request.method,
    url: `${pathname}${url.search}`,
    headers: Object.fromEntries(request.headers.entries()),
  }) as IncomingMessage;
}

function setHeaders(target: Headers, source: Record<string, string | number | string[]>): void {
  for (const [name, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      for (const item of value) target.append(name, item);
    } else {
      target.set(name, String(value));
    }
  }
}

type ResponseCallback = () => void;

function responseEncoding(encodingOrCallback?: BufferEncoding | ResponseCallback): BufferEncoding {
  const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8';
  if (!Buffer.isEncoding(encoding)) {
    // Let Buffer produce Node's ERR_UNKNOWN_ENCODING TypeError.
    Buffer.from('', encoding);
  }
  return encoding;
}

function responseCallback(
  encodingOrCallback?: BufferEncoding | ResponseCallback,
  callback?: ResponseCallback,
): ResponseCallback | undefined {
  return typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
}

function suppressesResponseBody(request: Request, status: number): boolean {
  return request.method === 'HEAD' || status === 204 || status === 205 || status === 304;
}

function runNodeHandler(handler: RequestListener, request: Request): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let status = 200;
    const headers = new Headers();
    let headersSent = false;
    // Buffered as bytes rather than as a string. A handler may end with a
    // `Uint8Array`, which `ServerResponse.end` accepts and which is not
    // necessarily valid UTF-8; decoding it would replace every unpaired byte
    // with U+FFFD and silently corrupt the response.
    const body: Buffer[] = [];

    const appendChunk = (chunk: string | Uint8Array, encoding: BufferEncoding) => {
      body.push(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.from(chunk));
    };

    const response = {
      get headersSent() {
        return headersSent;
      },
      writeHead(
        statusCode: number,
        statusMessageOrHeaders?: string | Record<string, string | number | string[]>,
        outgoingHeaders?: Record<string, string | number | string[]>,
      ) {
        status = statusCode;
        headersSent = true;
        const values =
          typeof statusMessageOrHeaders === 'string' ? outgoingHeaders : statusMessageOrHeaders;
        if (values) setHeaders(headers, values);
        return this;
      },
      write(
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ResponseCallback,
        callback?: ResponseCallback,
      ) {
        // `write` is part of the `ServerResponse` surface this object claims to
        // implement. Omitting it made any chunked handler a runtime TypeError
        // that the `as unknown as ServerResponse` cast hid from the compiler.
        headersSent = true;
        appendChunk(chunk, responseEncoding(encodingOrCallback));
        const done = responseCallback(encodingOrCallback, callback);
        if (done) process.nextTick(done);
        return true;
      },
      end(
        chunkOrCallback?: string | Uint8Array | ResponseCallback,
        encodingOrCallback?: BufferEncoding | ResponseCallback,
        callback?: ResponseCallback,
      ) {
        headersSent = true;
        const chunk = typeof chunkOrCallback === 'function' ? undefined : chunkOrCallback;
        const done =
          typeof chunkOrCallback === 'function'
            ? chunkOrCallback
            : responseCallback(encodingOrCallback, callback);
        if (chunk !== undefined) appendChunk(chunk, responseEncoding(encodingOrCallback));
        resolve(
          new Response(
            suppressesResponseBody(request, status) || body.length === 0
              ? undefined
              : Buffer.concat(body),
            {
              status,
              headers,
            },
          ),
        );
        if (done) process.nextTick(done);
        return this;
      },
      destroy(error?: Error) {
        reject(error ?? new Error('Persistence HTTP handler destroyed the response'));
        return this;
      },
    } as unknown as ServerResponse;

    try {
      handler(nodeRequest(request), response);
    } catch (error) {
      reject(error);
    }
  });
}

interface PersistenceRequestDeps {
  poolFactory?: PersistencePoolFactory;
}

/**
 * Editor-grant delegation (plan §12.3). Delegated path families, and only
 * these:
 *
 *   documents  GET/PUT /documents/<stageId>, PUT …/stage, PUT/DELETE …/scenes/<id>,
 *              DELETE /documents/<stageId>   — Stage derived from the path;
 *              read grants forward reads only (mutations answer 403
 *              GRANT_READ_ONLY before any store exists); write grants forward
 *              everything onto the stage guard.
 *   runtime    POST /runtime/sessions (body), session-scoped routes (stored
 *              session), stage-scoped learner routes (path) — delegated only
 *              when the derived Stage AND learner equal the grant's
 *              (tp:<nonce>); anything else answers 403 GRANT_RUNTIME_SCOPE.
 *   assets     /assets/* — any valid grant skips the dev-token gate; the
 *              open-read / no-mutation posture is unchanged.
 *
 * GET /documents (list), learner merges, and admin deletes are never
 * delegated. Without a grant, every pre-existing branch behaves identically.
 */
type GrantEvaluation =
  | { covered: false }
  | {
      covered: true;
      refusal?: { status: number; code: string; message: string };
      mode: 'documents' | 'runtime' | 'assets';
      grant: VerifiedEditorGrant;
      /** The runtime learner identity a delegated runtime request runs as. */
      runtimeLearnerKey?: string;
    };

async function evaluateEditorGrant(
  request: Request,
  path: string,
  deps: PersistenceRequestDeps,
  connectionString: string,
): Promise<GrantEvaluation> {
  const grants = readEditorGrants(request.headers);
  if (grants.length === 0) return { covered: false };

  if (path === '/documents' || path.startsWith('/documents/')) {
    const stageId = deriveDocumentStageId(parseDocumentAction(request.method, path));
    if (stageId === null) return { covered: false };
    const grant = grants.find((candidate) => candidate.stageId === stageId);
    if (!grant) return { covered: false };
    // The grant must belong to the Stage's tenant (plan §4.4.5): a Stage A
    // grant never authorizes Stage B documents, and a cross-tenant grant
    // behaves exactly like an absent one.
    const { stageBelongsToTenant } = await import('@/lib/persistence/teaching-package');
    const { pool } = await getServerPersistenceProvider(connectionString, deps.poolFactory);
    const belongs = await stageBelongsToTenant(pool, grant.stageId, grant.tenantId).catch(() => false);
    if (!belongs) return { covered: false };
    const method = request.method.toUpperCase();
    const mutating = method !== 'GET' && method !== 'HEAD';
    if (mutating && grant.capability === 'read') {
      return {
        covered: true,
        mode: 'documents',
        grant,
        refusal: {
          status: 403,
          code: 'GRANT_READ_ONLY',
          message: 'this editor grant is read-only; the stage cannot be modified',
        },
      };
    }
    return { covered: true, mode: 'documents', grant };
  }

  if (path === '/runtime' || path.startsWith('/runtime/')) {
    let body: unknown = null;
    if (request.method.toUpperCase() === 'POST') {
      body = await request
        .clone()
        .json()
        .catch(() => null);
    }
    const { runtimeStore } = await getServerPersistenceProvider(connectionString, deps.poolFactory);
    const scope = await deriveRuntimeScope(request.method, path, body, runtimeStore);
    if (scope === null) {
      // Admin/merge routes are never delegated; unknown sessions pass through
      // under the first grant's principal so the handler answers its own 404.
      if (
        (request.method === 'DELETE' &&
          (path === '/runtime' || /^\/runtime\/stages\/[^/]+$/.test(path))) ||
        (request.method === 'POST' && path === '/runtime/learners/merge')
      ) {
        return { covered: false };
      }
      return {
        covered: true,
        mode: 'runtime',
        grant: grants[0]!,
        runtimeLearnerKey: grants[0]!.learnerKey,
      };
    }
    const grant = grants.find((candidate) => candidate.stageId === scope.stageId);
    if (grant) {
      const { stageBelongsToTenant } = await import('@/lib/persistence/teaching-package');
      const { pool } = await getServerPersistenceProvider(connectionString, deps.poolFactory);
      const belongs = await stageBelongsToTenant(pool, grant.stageId, grant.tenantId).catch(() => false);
      if (!belongs) {
        return {
          covered: true,
          mode: 'runtime',
          grant: grants[0]!,
          refusal: {
            status: 403,
            code: 'GRANT_RUNTIME_SCOPE',
            message: 'this editor grant does not cover that stage and learner',
          },
        };
      }
    }
    if (!grant || grant.learnerKey !== scope.learnerKey) {
      return {
        covered: true,
        mode: 'runtime',
        grant: grants[0]!,
        refusal: {
          status: 403,
          code: 'GRANT_RUNTIME_SCOPE',
          message: 'this editor grant does not cover that stage and learner',
        },
      };
    }
    return { covered: true, mode: 'runtime', grant, runtimeLearnerKey: grant.learnerKey };
  }

  if (path === '/assets' || path.startsWith('/assets/')) {
    return { covered: true, mode: 'assets', grant: grants[0]! };
  }
  return { covered: false };
}

export async function handlePersistenceRequest(
  request: Request,
  deps: PersistenceRequestDeps = {},
): Promise<Response> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return jsonError(404, 'PERSISTENCE_NOT_CONFIGURED', 'server persistence not configured');
  }

  const path = routeRelativePath(request);
  const grantEvaluation = await evaluateEditorGrant(request, path, deps, connectionString);

  if (!process.env.PERSISTENCE_DEV_TOKEN && !grantEvaluation.covered) {
    return jsonError(
      503,
      'PERSISTENCE_DEV_TOKEN_MISSING',
      'server persistence requires PERSISTENCE_DEV_TOKEN (development auth only)',
    );
  }

  return withRequestOwnerId(request, async (ownerId, responseHeaders) => {
    try {
      const action = parseDocumentAction(request.method, path);
      // Delegation to the service owner exists only inside this request, and
      // only when a grant covered it; the service owner is never persisted in
      // a cookie or response.
      const delegated =
        grantEvaluation.covered &&
        !grantEvaluation.refusal &&
        (grantEvaluation.mode === 'documents' || grantEvaluation.mode === 'runtime');
      const effectiveOwnerId = delegated ? TEACHING_PACKAGE_STAGE_OWNER : ownerId;
      let access: DocumentAccess = 'allow';
      if (path === '/documents' || path.startsWith('/documents/')) {
        if (grantEvaluation.covered && grantEvaluation.refusal) {
          const refusal = grantEvaluation.refusal;
          const response = jsonError(refusal.status, refusal.code, refusal.message);
          for (const [name, value] of responseHeaders.entries()) {
            response.headers.append(name, value);
          }
          return response;
        }
        const { pool } = await getServerPersistenceProvider(connectionString, deps.poolFactory);
        const queryable = pool;
        access = await decideDocumentAccess(
          action,
          effectiveOwnerId,
          (stageId) => readStageMeta(queryable, stageId),
          (stageId) =>
            pool
              .query('SELECT 1 FROM document_stages WHERE id = $1', [stageId])
              .then((result) => result.rows.length > 0),
          (stageId) => readStageMeta(queryable, stageId),
        );
        // Teaching package pre-check (the in-tx fence is authoritative; this
        // supplies the status code for the common case). Runs after the access
        // decision, only for mutating document actions it allowed.
        if (
          access === 'allow' &&
          (action.kind === 'create' || action.kind === 'write' || action.kind === 'delete')
        ) {
          try {
            await assertStageWritable(queryable, {
              stageId: action.stageId,
              mode: action.kind === 'write' ? 'mutate' : action.kind,
            });
          } catch (error) {
            if (isTeachingPackageStageLockedError(error)) {
              const response = jsonError(423, 'STAGE_LOCKED', error.message);
              for (const [name, value] of responseHeaders.entries()) {
                response.headers.append(name, value);
              }
              return response;
            }
            throw error;
          }
        }
      } else if (grantEvaluation.covered && grantEvaluation.refusal) {
        const refusal = grantEvaluation.refusal;
        const response = jsonError(refusal.status, refusal.code, refusal.message);
        for (const [name, value] of responseHeaders.entries()) {
          response.headers.append(name, value);
        }
        return response;
      }

      const response =
        access === 'not-found'
          ? jsonError(404, 'DOCUMENT_NOT_FOUND', '@openmaic/storage: document not found')
          : await runNodeHandler(
              await createPersistenceHandler(
                connectionString,
                effectiveOwnerId,
                access,
                deps.poolFactory,
                grantEvaluation.covered &&
                  grantEvaluation.mode === 'runtime' &&
                  !grantEvaluation.refusal
                  ? grantEvaluation.runtimeLearnerKey
                  : undefined,
              ),
              request,
            );
      for (const [name, value] of responseHeaders.entries()) response.headers.append(name, value);
      return response;
    } catch (error) {
      console.error('Embedded persistence route initialization failed', error);
      const response = jsonError(
        500,
        'PERSISTENCE_INIT_FAILED',
        'server persistence initialization failed',
      );
      for (const [name, value] of responseHeaders.entries()) response.headers.append(name, value);
      return response;
    }
  });
}

export const GET = (request: Request) => handlePersistenceRequest(request);
export const POST = (request: Request) => handlePersistenceRequest(request);
export const PUT = (request: Request) => handlePersistenceRequest(request);
export const PATCH = (request: Request) => handlePersistenceRequest(request);
export const DELETE = (request: Request) => handlePersistenceRequest(request);
