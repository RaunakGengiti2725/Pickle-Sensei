FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate
WORKDIR /repo

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
COPY services/media-worker ./services/media-worker
RUN pnpm install --frozen-lockfile --filter @pickle/media-worker...

ENV PICKLE_ENV=production
USER node
CMD ["pnpm", "--filter", "@pickle/media-worker", "start"]
