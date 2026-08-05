# Railway 部署用。从仓库根目录构建：docker build -f packages/server/Dockerfile .
FROM node:22-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# 先只拷清单，让依赖层能命中缓存。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/

RUN pnpm install --frozen-lockfile --filter @aiero/server... --prod=false

COPY packages/shared packages/shared
COPY packages/server packages/server

ENV NODE_ENV=production
EXPOSE 8080

CMD ["pnpm", "--filter", "@aiero/server", "start"]
