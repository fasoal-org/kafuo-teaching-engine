#!/usr/bin/env bash
# Runs a Postgres client tool (pg_dump, psql, ...) against the database named by a URL in an
# environment variable, without putting the password on a command line (where `ps` shows it).
#
#   pg-from-url.sh <VAR> <command> [args...]
#
# <VAR> holds postgresql[+driver]://user:password@host:port/database, the exact shape that
# zakrly-backend deploy/production/db/README.md step B-2 writes (hex password, no query
# string). Used as the entrypoint of the `pgtools` service in compose.yml. The same file lives
# in zakrly-backend deploy/production/; keep the two copies equal.
set -euo pipefail

var="${1:?usage: pg-from-url.sh <VAR> <command> [args...]}"
shift
url="${!var:?$var is not set}"

rest="${url#*://}"
export PGUSER="${rest%%:*}"
rest="${rest#*:}"
export PGPASSWORD="${rest%%@*}"
rest="${rest#*@}"
export PGHOST="${rest%%:*}"
rest="${rest#*:}"
export PGPORT="${rest%%/*}"
export PGDATABASE="${rest#*/}"

exec "$@"
