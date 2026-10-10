#!/bin/sh
# Container entrypoint: runs one Kazi service, chosen by KAZI_SERVICE. Railway sets PORT.
set -e
case "$KAZI_SERVICE" in
  api)
    # Schema first (prisma migrate deploy is idempotent), then the idempotent seed when asked.
    pnpm --filter @kazi/db db:deploy
    if [ "$SEED_ON_START" = "true" ]; then pnpm --filter @kazi/db exec tsx prisma/seed.ts; fi
    cd apps/api
    export API_PORT="${PORT:-4000}"
    exec ./node_modules/.bin/tsx src/server.ts
    ;;
  worker)
    cd apps/worker
    exec ./node_modules/.bin/tsx src/main.ts
    ;;
  house-agents)
    cd packages/house-agents
    export HOUSE_AGENTS_PORT="${PORT:-4100}"
    exec ./node_modules/.bin/tsx src/main.ts
    ;;
  web)
    cd apps/web
    exec ./node_modules/.bin/next start -p "${PORT:-3000}"
    ;;
  *)
    echo "KAZI_SERVICE must be one of: api, worker, house-agents, web (got '$KAZI_SERVICE')" >&2
    exit 1
    ;;
esac
