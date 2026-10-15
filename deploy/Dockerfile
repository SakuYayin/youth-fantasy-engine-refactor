# syntax=docker/dockerfile:1
#
# 后端镜像（`@yfe/server`）。
#
# 设计要点见 docs/adr/0005-backend-runtime-and-deployment.md：
# 1. **没有构建步骤**：`bin/serve.mjs` 用 `module.registerHooks` 把 `./x.js` 映射到
#    `./x.ts`，靠 Node 24 的原生类型剥离直接运行 TypeScript 源码。所以镜像里必须
#    带上各 workspace 的 `src/`，而不是 `dist/`。
# 2. **运行时下限 Node 22.15+**（`module.registerHooks`）。启动器内还有一道守卫：
#    版本过低直接 exit 2。**不要**把这个基础镜像换成 node:20 之类。
# 3. 原生依赖 `better-sqlite3` 走包内 N-API 预编译二进制（glibc 镜像即可，无需编译链）。
# 4. 进程以 uid 1000（`node`）运行，`/data` 归它所有；挂进来的秘密文件必须是
#    `chown 1000:1000` + `chmod 600`（服务端对 POSIX 秘密文件强校验 0600）。

FROM node:24-bookworm-slim AS deps

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

WORKDIR /app

# 只先拷清单，让依赖层可缓存。npm workspaces 会校验每个 workspace 的 package.json
# 与 lockfile 一致，所以**所有** workspace 的 package.json 都必须先拷进来。
COPY package.json package-lock.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/domain/package.json ./packages/domain/
COPY packages/persistence-sqlite/package.json ./packages/persistence-sqlite/
COPY packages/plugin-sdk/package.json ./packages/plugin-sdk/
COPY packages/plugin-host/package.json ./packages/plugin-host/
COPY packages/application/package.json ./packages/application/
COPY packages/client-sdk/package.json ./packages/client-sdk/
COPY packages/ui/package.json ./packages/ui/
COPY packages/legacy-import/package.json ./packages/legacy-import/
COPY apps/desktop/package.json ./apps/desktop/
COPY services/server/package.json ./services/server/

# `--ignore-scripts`：better-sqlite3 的 install 脚本是 node-gyp 重建，
# 而它在 glibc x64 上有 N-API 预编译产物，构建镜像不需要 C++ 工具链。
RUN npm ci --omit=dev --ignore-scripts


FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    YFE_DATA_DIR=/data \
    YFE_LISTEN_HOST=0.0.0.0 \
    YFE_LISTEN_PORT=8787

WORKDIR /app

# 依赖（含 node_modules/@yfe/* → 各 workspace 目录的符号链接）
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./

# 源码：服务端 + 它依赖的 packages（@yfe/* 的符号链接靠这些目录解析）
COPY services/server ./services/server
COPY packages ./packages

# 数据目录：命名卷会继承这里的属主，从而让 uid 1000 可写
RUN mkdir -p /data \
 && chown -R node:node /data \
 && chown -R node:node /app

USER node

VOLUME ["/data"]
EXPOSE 8787

# 用 /health/ready（真的查数据库与迁移状态），不是 /health/live：
# 容器"活着但库没打开"对编排来说等于不可用。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.YFE_LISTEN_PORT || '8787') + '/health/ready').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["node", "services/server/bin/serve.mjs"]
