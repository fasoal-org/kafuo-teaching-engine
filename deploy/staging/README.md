# Staging deploy (Teaching Engine)

The Teaching Engine runs on the staging server (`109.199.111.88`) next to the backend, with Docker Compose. A merge into this repo's `staging` branch deploys it.

**Staging is private.** Devices reach it only through Tailscale, at `https://kafuo-staging.tailcd4398.ts.net:8443`:
- Tailscale Serve (TLS) → `127.0.0.1:3000` → the `te` container.
- The port is published on loopback only. Docker's port rules bypass ufw, so it must never be `0.0.0.0`.

**Inside Docker,** the backend calls `https://kafuo-staging.tailcd4398.ts.net:8443`, and the TE sends its webhooks to `https://kafuo-staging.tailcd4398.ts.net/...`.
- That name resolves to the backend's internal TLS `edge` container, which holds the real certificate.
- Both apps therefore run exactly the production https checks. See `zakrly-backend/deploy/staging/edge/`.

## How a deploy runs

```
merge into staging ─► GitHub Actions (staging-te.yml) ─► SSH as deploy (TE CI key)
  ─► /srv/kafuo/bin/ci-deploy-app te   accepts only "deploy <40-char SHA>"
  ─► /srv/kafuo/deploy-app.sh te <SHA> fetch; the SHA must be on origin/staging; checkout; lock
  ─► deploy/staging/deploy.sh          build ─► DB backup ─► up ─► /api/health
```

The two `/srv/kafuo` entry points are root-owned. Their reference copies are in `zakrly-backend/deploy/staging/server/`.

## Files

| File | Notes |
| --- | --- |
| `compose.yml` | Project `kafuo-staging-te`, separate from the backend's project. It joins the backend network `kafuo-staging_default` (external), uses volume `te-data` (`/app/data`, uid 1001), and loads secrets from `/srv/kafuo/env/te.env`. |
| `deploy.sh` | The steps above. A failed build leaves the running container untouched. |

## On the server

- **Secrets:** `/srv/kafuo/env/te.env` (600, deploy). It holds:
  - `DATABASE_URL`, for role and database `kafuo_te` in the backend's Postgres;
  - the service key and the webhook secret, which must equal the backend's `TEACHING_ENGINE_SERVICE_KEY` and `TEACHING_ENGINE_WEBHOOK_SECRET`;
  - the webhook and integration URLs;
  - the provider keys.
- **Must stay unset:**
  - `PERSISTENCE_DEV_TOKEN`, `NEXT_PUBLIC_PERSISTENCE_TOKEN` and `TEACHING_ENGINE_ALLOW_INSECURE_LOCAL_WEBHOOK`, which are dev only;
  - `ACCESS_CODE`, because boot fails if it is set together with the service key.
- **Backups:**
  - every deploy dumps `kafuo_te` into `/srv/kafuo/backups/` and keeps the last 10;
  - the nightly `backup.sh` covers every `kafuo_*` database;
  - the `te-data` volume (audio and media) is **not** in the nightly copy yet.

```bash
docker compose -f /srv/kafuo/kafuo-teaching-engine/deploy/staging/compose.yml ps
docker compose -f /srv/kafuo/kafuo-teaching-engine/deploy/staging/compose.yml logs --tail 100 te
cat /srv/kafuo/deploys-te.log
```

**Never run plain `docker compose config`:** it prints every secret. Use `config --services`.
