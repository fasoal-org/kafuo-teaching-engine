# AI consumption reporting integration

The dashboard lives in Kafuo Admin. This repository supplies only the service-key protected
`GET /api/teaching-packages/consumption` endpoint. It uses existing `DATABASE_URL` and
`TEACHING_ENGINE_SERVICE_KEY`; browser access-code cookies and student grants do not authorize it.

Required query: `tenant_id`, epoch-second `since` (inclusive), `until` (exclusive, at most
366 days). Modes: `summary`, `records`, `groups`. Records use descending `(occurred_at,id)`
keyset cursors, at most 200 records plus an internal lookahead. Groups are allowlisted,
at most 366 buckets (daily reporting), and the Backend labels bounded group results when truncated.

The `teaching_model_attempts` ledger remains authoritative. Current model policy/rates are
never applied to historical rows. Origin `kafuo_backend` is still a Teaching Engine
provider call and appears once in this ledger. Unique, tenant-qualified lineage joins
recover version/Learning Item identifiers without multiplying events. Learning Item IDs
are never treated as Lesson IDs. Kafuo resolves those identities through its own hierarchy.

`generation_usage_events` is the durable extension of existing quantity observations for
new narration, query embeddings, and package image/video provider attempts. No historical
JSONL import or backfill. `server-provider.ts` ensures its schema using existing boot DDL
conventions. Model calls already owned by `teaching_model_attempts` are never mirrored.
Production media carries tenant/item/generation-attempt scope before generation finishes;
the later attempt→version relation supports historical version reports. Submitted
characters/images are labelled `submitted_quantity`, not billed credits or generated
quantities. Video duration, Cartesia credits and all media prices remain NULL without
authoritative evidence. Failed/retried calls retain separate records. Reused audio makes
no provider attempt/event. Unscoped standalone workbench calls cannot be assigned to a tenant.

Observation writes use the same database/role through a separate pool capped at one
connection per process (150 ms acquisition/statement limit, 200 ms client query timeout).
An idle pool error logs a fixed category. Query embedding observation work is asynchronous,
so it does not extend the existing retrieval deadline; a crash may leave accounting
incomplete or lose that asynchronous observation. This is explicitly partial coverage.

Reporting SELECTs use a read-only transaction and 5-second statement timeout. Initial
provider resolution can run existing schema ensure logic as it already does elsewhere;
no cross-database privileges are introduced. Tables are deployment-owned: no environment
filter can reach another deployment. See the Backend `docs/ai-consumption/investigation.md`
and final implementation report for the full ownership audit and rollout gates.
