#!/usr/bin/env bash
# Kafuo production: the Teaching Engine's deploy steps. Started only by
# /srv/kafuo/bin/deploy-app.sh, after it has checked out <sha> (a commit on origin/main) in
# /srv/kafuo/kafuo-teaching-engine and taken the lock.
#
#   1. build the image kafuo-te:<sha> (NEXT_PUBLIC_* values are compiled in here)
#   2. the database kafuo_te on kafuo-prod-db must answer; back it up before anything changes
#   3. point kafuo-te:production at <sha> and start or replace the container
#   4. /api/health must answer on 127.0.0.1:3000 and through nginx as https://learn.kafuo.me
#
# If the build or the database check fails, the running container is left as it was. If step 3
# or 4 fails, the previous image is started again (the TE only adds tables and columns on boot,
# CREATE ... IF NOT EXISTS, so the previous version still runs on the newer schema; step 2's
# dump is the way back for data).
set -euo pipefail

sha="${1:?usage: deploy.sh <40-char commit SHA>}"
short="${sha:0:8}"
repo=/srv/kafuo/kafuo-teaching-engine
compose="$repo/deploy/production/compose.yml"
backups=/srv/kafuo/backups
health_local=http://127.0.0.1:3000/api/health
health_public=https://learn.kafuo.me/api/health
keep_backups=10
keep_images=3

dc() { docker compose -f "$compose" "$@"; }
pgtool() { dc run --rm -T --no-deps pgtools "$@" </dev/null; }
step() { echo; echo "==> [$(date -u +%H:%M:%S)] $*"; }
fail() { echo "deploy: FAILED: $*" >&2; exit 1; }

for f in /srv/kafuo/env/te.env /srv/kafuo/env/te-db.env; do
  [[ -r "$f" ]] || fail "missing $f (the env files are set up by hand, once)"
done
docker network inspect kafuo-prod_default >/dev/null 2>&1 \
  || fail "the network kafuo-prod_default does not exist; deploy the backend first"

step "1/4 Building kafuo-te:$short"
# Browser-visible build values only. NEXT_PUBLIC_PERSISTENCE_TOKEN stays empty on purpose: it
# would be readable by anyone who loads the page.
docker build --quiet --tag "kafuo-te:$sha" \
  --build-arg NEXT_PUBLIC_PERSISTENCE=1 \
  --build-arg NEXT_PUBLIC_MAIC_EDITOR_ENABLED=true \
  "$repo" >/dev/null

step "2/4 Database kafuo_te and a backup"
[[ "$(pgtool psql -X -At -c 'SELECT 1')" == "1" ]] \
  || fail "the database kafuo_te on kafuo-prod-db (10.10.0.2) does not answer; check WireGuard and Postgres"
mkdir -p "$backups" && chmod 700 "$backups"
dump="$backups/kafuo_te-$(date -u +%Y%m%dT%H%M%SZ)-$short.dump"
pgtool pg_dump --format=custom > "$dump"
echo "saved $dump ($(du -h "$dump" | cut -f1))"
ls -1t "$backups"/kafuo_te-*.dump | tail -n +$((keep_backups + 1)) \
  | while read -r old; do rm -f -- "$old"; done

step "3/4 Starting the Teaching Engine"
previous="$(docker image inspect --format '{{.Id}}' kafuo-te:production 2>/dev/null || true)"
docker tag "kafuo-te:$sha" kafuo-te:production

# Called only from steps 3 and 4.
roll_back() {
  dc ps || true
  if [[ -z "$previous" ]]; then
    fail "$1. This was the first deploy, so there is no earlier version to go back to."
  fi
  echo "==> Rolling back to the previous image"
  docker tag "$previous" kafuo-te:production
  dc up -d --wait --wait-timeout 300 --remove-orphans || true
  fail "$1. Rolled back to the previous image."
}

# The data volume must belong to the app's user (uid 1001, "nextjs"); a new volume is root's.
dc run --rm --no-deps --user 0 --entrypoint sh te \
  -c 'mkdir -p /app/data/classrooms && chown 1001:1001 /app/data /app/data/classrooms' </dev/null \
  || roll_back "could not prepare the data volume"
dc up -d --wait --wait-timeout 300 --remove-orphans \
  || roll_back "the container did not become healthy"

step "4/4 Health checks: $health_local and $health_public"
curl -fsS -o /dev/null --max-time 10 --retry 10 --retry-delay 3 --retry-all-errors "$health_local" \
  || roll_back "the Teaching Engine did not answer at $health_local"
# Through nginx and its certificate, without leaving the server.
curl -fsS -o /dev/null --max-time 10 --retry 5 --retry-delay 3 --retry-all-errors \
  --resolve learn.kafuo.me:443:127.0.0.1 "$health_public" \
  || roll_back "the Teaching Engine did not answer through nginx at $health_public"
echo "ok"

echo "$sha $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /srv/kafuo/deploys-te.log

# Keep the newest few SHA images for a quick rollback; older ones can be rebuilt from git.
docker image ls kafuo-te --format '{{.Tag}}' \
  | grep -E '^[0-9a-f]{40}$' | tail -n +$((keep_images + 1)) \
  | while read -r tag; do docker image rm "kafuo-te:$tag" >/dev/null 2>&1 || true; done

step "Deployed $short"
dc ps --format 'table {{.Service}}\t{{.Status}}'
