# ADR 0005：后端运行时与部署形态（Node 类型剥离直跑 TypeScript）

- 状态：已接受（2026-10-15）
- 相关：`04-后端与安全.md`（模块化单体、Fastify 5、SQLite）、`09-部署与运维.md`（私有网段 / 镜像部署）、R-27（缺 `dev`/`start` 脚本）、R-37（运行时下限）
- 影响文件：`services/server/bin/serve.mjs`、`services/server/src/cli.ts`、`services/server/package.json`、`deploy/**`

## 背景

`services/server` 的所有 `exports` 都指向 `src/*.ts`，源码里用 `.js` 说明符互相引用（`import { x } from './y.js'`），这是 ESM + TypeScript 的常规写法，**但 Node 原生类型剥离解析不了 `./y.js` → 只有 `y.ts`**。于是：

- `npm run dev -w @yfe/server` 起不来（没有 `dev` 脚本，也没有 `tsx`）；
- 生产镜像里没有 `dist/` 可交付；
- 桌面端 `apps/desktop` 与 `packages/*` 的测试早就绕过了这个问题（Vitest 有自己的解析器），但**真实进程**没有。

## 决策

**用 `module.registerHooks` 在入口处把 `./x.js` 映射到 `./x.ts`，让 Node 24 的类型剥离直接运行 TypeScript 源码，不引入构建步骤。**

具体：

1. `services/server/bin/serve.mjs`（唯一的 `.mjs` 入口）先注册解析钩子，再 `import('./cli.js')`；
2. `src/cli.ts` 负责参数、配置合流、体检与启动，**不依赖任何全局状态**（`io`/`env`/`cwd`/`listen`/`waitForShutdown` 全部可注入，因此可以用真实文件库做完整用例）；
3. `package.json` 提供 `dev`/`start`/`preflight` 三个脚本，`bin.yfe-server` 指向同一入口；
4. 启动器内置**版本守卫**：`typeof module.registerHooks !== 'function'` 时打印"Node 版本过低"并 `exit 2`，绝不静默降级成"跑一半报语法错"。

## 为什么不选其它方案

| 方案 | 否决理由 |
| --- | --- |
| `tsc` 产出 `dist/` 再跑 JS | 多一份构建产物与 sourcemap 漂移风险；`src` 与 `dist` 两份"真相"会让"改了源码忘了构建"变成部署事故；设计文档 04 要的是**模块化单体**而不是要打包 |
| 引入 `tsx` | 新增运行时依赖，且它自带一层解析器行为（与探针/测试里的解析规则不必一致）；Node 24 已经内置同样能力 |
| 直接给 `.ts` 写 `.ts` 扩展名 import | 需要改几百处 import 说明符，且破坏"编译/测试/IDE 都按 `.js` 解析"的既有约定 |
| bundler（esbuild/rollup）打包成单文件 | 原生依赖（`better-sqlite3`）不能打进 bundle；`--data-dir` 与迁移脚本路径推断会变脆 |

## 代价与约束（必须写进部署）

1. **运行时下限 Node 22.15+/24+**（`module.registerHooks` 的可用版本）。Docker 基础镜像必须 ≥ `node:22.15`，本仓用 `node:24-bookworm-slim`。已登记为 R-37。
2. 镜像里**没有** `dist/`，因此镜像必须带上 `services/server/src/**` 与它依赖的 `packages/*/src/**`（`@yfe/*` 在镜像里是指向 workspace 目录的符号链接）。`deploy/Dockerfile` 显式 `COPY packages ./packages`。
3. 启动前体检与启动**共用同一条代码路径**：`--check` 会真的开库、跑迁移、核对表清单，因此"体检通过但启动失败"几乎只可能是端口或权限问题。运维与编排都应把 `--check` 当作**前置门**（`compose.yaml` 的 `preflight` 服务就是这么用的）。
4. 秘密文件在 POSIX 上要求 `mode & 0o077 === 0`（即 `chmod 600`），并且进程以 uid 1000（`node`）运行 ⇒ **宿主机上的秘密文件必须 `chown 1000:1000` + `chmod 600`**。用 Compose 的 `secrets:` 挂载（默认 `0444`）会直接被权限校验拒绝，因此 `deploy/compose.yaml` 用 bind mount。

## 验收证据

- `node services/server/bin/serve.mjs --check --data-dir=…` → exit 0，`{"event":"server.preflight","ok":true,"schemaVersion":3,"tableCount":20,"missingTables":[]}`；
- 真实监听进程：`/health/live` 200、`/health/ready` 200（`journalMode:"wal"`、`migrations.current:3`）、`POST /api/v1/setup` 400（AJV 生效）、`GET /api/v1/capabilities` 401（鉴权生效）；
- `services/server/tests/cli.test.ts` 15 例（含"库版本 99 → exit 1 且提示拒绝打开"）。
