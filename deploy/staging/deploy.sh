#!/usr/bin/env bash
# Kafuo staging: the Teaching Engine's deploy steps. Started only by /srv/kafuo/deploy-app.sh,
# after it has checked out <sha> in /srv/kafuo/kafuo-teaching-engine and taken the lock.
#
#   1. build the image kafuo-te:<sha> (NEXT_PUBLIC_* values are compiled in here)
#   2. the database must exist; back it up before anything changes
#   3. point kafuo-te:staging at <sha> and start or replace the container
#   4. /api/health must answer on 127.0.0.1:3000 (the path Tailscale Serve :8443 uses)
#
# If the build fails, the running container is left as it was. The TE creates and evolves its
# own tables on boot (CREATE TABLE IF NOT EXISTS); step 2's dump is the way back.
set -euo pipefail

sha="${1:?usage: deploy.sh <40-char commit SHA>}"
short="${sha:0:8}"
repo=/srv/kafuo/kafuo-teaching-engine
compose="$repo/deploy/staging/compose.yml"
backend_compose=/srv/kafuo/zakrly-backend/deploy/staging/compose.yml
backups=/srv/kafuo/backups
health_url=http://127.0.0.1:3000/api/health
keep_backups=10
keep_images=3

dc() { docker compose -f "$compose" "$@"; }
pg() { docker compose -f "$backend_compose" exec -T postgres "$@"; }
step() { echo; echo "==> [$(date -u +%H:%M:%S)] $*"; }
fail() { echo "deploy: FAILED: $*" >&2; exit 1; }

[[ -r /srv/kafuo/env/te.env ]] || fail "missing /srv/kafuo/env/te.env (the secrets file is set up by hand, once)"

step "1/4 Building kafuo-te:$short"
# Browser-visible build values only. NEXT_PUBLIC_PERSISTENCE_TOKEN stays empty on purpose: it
# would be readable by anyone who loads the page.
docker build --quiet --tag "kafuo-te:$sha" \
  --build-arg NEXT_PUBLIC_PERSISTENCE=1 \
  --build-arg NEXT_PUBLIC_MAIC_EDITOR_ENABLED=true \
  "$repo" >/dev/null

step "2/4 Database kafuo_te and a backup"
db_exists=$(pg psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'kafuo_te'" </dev/null)
[[ "$db_exists" == "1" ]] || fail "database kafuo_te does not exist yet; do the one-time database setup first"
mkdir -p "$backups" && chmod 700 "$backups"
stamp="$(date -u +%Y%m%dT%H%M%SZ)-$short"
pg pg_dump -U postgres --format=custom kafuo_te </dev/null > "$backups/kafuo_te-$stamp.dump"
echo "saved $backups/kafuo_te-$stamp.dump ($(du -h "$backups/kafuo_te-$stamp.dump" | cut -f1))"
ls -1t "$backups"/kafuo_te-*.dump | tail -n +$((keep_backups + 1)) | while read -r old; do rm -f -- "$old"; done

step "3/4 Starting the Teaching Engine"
docker tag "kafuo-te:$sha" kafuo-te:staging
# The data volume must belong to the app's user (uid 1001, "nextjs"); a new volume is root's.
dc run --rm --user 0 --entrypoint sh te \
  -c 'mkdir -p /app/data/classrooms && chown 1001:1001 /app/data /app/data/classrooms' </dev/null
dc up -d --wait --wait-timeout 300 --remove-orphans

step "4/4 Health check: $health_url"
if ! curl -fsS -o /dev/null --max-time 10 --retry 10 --retry-delay 3 --retry-all-errors "$health_url"; then
  dc ps
  fail "the Teaching Engine did not answer at $health_url"
fi
echo "ok"

echo "$sha $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /srv/kafuo/deploys-te.log

# Keep the newest few SHA images for a quick rollback; older ones can be rebuilt from git.
docker image ls kafuo-te --format '{{.Tag}}' \
  | grep -E '^[0-9a-f]{40}$' | tail -n +$((keep_images + 1)) \
  | while read -r tag; do docker image rm "kafuo-te:$tag" >/dev/null 2>&1 || true; done

step "Deployed $short"
dc ps --format 'table {{.Service}}\t{{.Status}}'
