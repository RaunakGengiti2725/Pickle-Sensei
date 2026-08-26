# services/api container. tsx runtime keeps parity with local dev; a compiled
# bundle can replace it once startup latency matters.
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate
WORKDIR /repo

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
COPY services/api ./services/api
RUN pnpm install --frozen-lockfile --filter @pickle/api...

ENV PICKLE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0
EXPOSE 3001
USER node
CMD ["pnpm", "--filter", "@pickle/api", "start"]
