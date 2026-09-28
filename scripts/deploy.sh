#!/usr/bin/env bash
# Build the app and deploy it to /srv/breakfix/app, then restart breakfix-server.service.
# No root needed: bootstrap.sh gives the developer /srv/breakfix and a sudo rule for the restart.
#
#   scripts/deploy.sh [--public-url http://HOST:8480]
#
# The first run writes /srv/breakfix/server.env (never committed): basic-auth credentials are
# generated there and printed once.
set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET=/srv/breakfix
APP="$TARGET/app"
ENV_FILE="$TARGET/server.env"
PORT=8480
PUBLIC_URL=""

while (($#)); do
  case "$1" in
    --public-url) PUBLIC_URL="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 64 ;;
  esac
done

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ -d "$TARGET" && -w "$TARGET" ]] || die "$TARGET is missing or not writable: run sudo scripts/bootstrap.sh first"
cd "$REPO_DIR"

log "Build"
pnpm install --frozen-lockfile --silent
pnpm --silent -r --filter '@breakfix/server...' --filter @breakfix/web run build

log "Assemble $APP.new"
rm -rf "$APP.new"
pnpm --silent --filter @breakfix/server deploy --prod "$APP.new" >/dev/null
cp -r apps/web/dist "$APP.new/web"
cp -r scenarios "$APP.new/scenarios"
cp -r docs "$APP.new/docs"
chmod -R g+rX,o-rwx "$APP.new"

if [[ ! -f "$ENV_FILE" ]]; then
  log "First deploy: writing $ENV_FILE"
  if [[ -z "$PUBLIC_URL" ]]; then
    ip="$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | head -1)"
    PUBLIC_URL="http://${ip}:${PORT}"
  fi
  password="$(node -e 'console.log(require("node:crypto").randomBytes(18).toString("base64url"))')"
  umask 027
  cat > "$ENV_FILE" <<EOF
# Written by scripts/deploy.sh. Not in git.
HOST=0.0.0.0
PORT=${PORT}
DB_PATH=/var/lib/breakfix/breakfix.db
SCENARIOS_DIR=${APP}/scenarios
WEB_DIST=${APP}/web
PUBLIC_URL=${PUBLIC_URL}
MAX_CONCURRENT_LABS=5
COOKIE_SECURE=false
BASIC_AUTH_USER=review
BASIC_AUTH_PASSWORD=${password}
LOG_LEVEL=info
EOF
  printf '\n  Review login (shown once, also in %s):\n    user: review\n    password: %s\n\n' "$ENV_FILE" "$password"
fi

log "Swap in the new version"
rm -rf "$APP.old"
if [[ -d "$APP" ]]; then mv "$APP" "$APP.old"; fi
mv "$APP.new" "$APP"
sudo -n /usr/bin/systemctl restart breakfix-server.service
rm -rf "$APP.old"

log "Health check"
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    echo "  breakfix-server is up: $(grep '^PUBLIC_URL=' "$ENV_FILE" | cut -d= -f2-)"
    exit 0
  fi
  sleep 0.5
done
sudo -n /usr/bin/journalctl --no-pager -u breakfix-server.service -n 200 | tail -20
die "the server did not come up"
