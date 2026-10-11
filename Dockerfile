# One image for every Kazi service; Railway picks the role with the KAZI_SERVICE variable
# (api | worker | house-agents | web). See docs/runbooks/deploy.md §3 and deploy/README.md.
FROM node:22.12.0-bookworm-slim

# Prisma's migration engine needs OpenSSL; CA certificates for HTTPS (Arc RPC, Anthropic, Supabase).
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NEXT_TELEMETRY_DISABLED=1 CI=true
# pnpm straight from npm, pinned to package.json's packageManager. The corepack bundled with
# Node 22.12 can't verify npm's rotated registry signing keys ("Cannot find matching keyid").
RUN npm install -g pnpm@10.34.6

WORKDIR /app
COPY . .

# Railway passes service variables declared here as build arguments.
ARG KAZI_SERVICE
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
ARG NEXT_PUBLIC_FEATURE_BOND
ENV KAZI_SERVICE=${KAZI_SERVICE}

RUN pnpm install --frozen-lockfile
# The Prisma client is generated (git-ignored), not committed.
RUN pnpm --filter @kazi/db generate
# The web app is compiled at build time (NEXT_PUBLIC_* values are baked in); the TypeScript
# services run from source with tsx, as in development.
RUN if [ "$KAZI_SERVICE" = "web" ]; then pnpm --filter @kazi/web build; fi

ENV NODE_ENV=production
CMD ["sh", "deploy/start.sh"]
