# 提示词抓取平台

把原本单文件运行的 Python 抓取脚本改造成前后端分离的内部平台：网页上启停任务、看实时进度、检索抽取到的角色卡提示词。

抓取目标是 aigirlfriend.baby 的角色卡系统提示词，通过站点自己的聊天接口取得。

## 架构

| 层     | 技术                                      | 部署    |
| ------ | ----------------------------------------- | ------- |
| 前端   | React 18 + Vite + Ant Design              | Vercel  |
| 后端   | Fastify + TypeScript（含抓取任务运行器）  | Railway |
| 数据库 | Supabase Postgres 测试库的 `aiero` schema | —       |

后端直连 Postgres 而不走 PostgREST，因为任务领取要用 `FOR UPDATE SKIP LOCKED`。
`aiero` schema 不对 `anon` / `authenticated` 开放，浏览器拿不到数据库直连权限。

登录复用运营平台的 Supabase Auth 账号：前端登录拿到 JWT，后端校验后再查
`admin.admin_users` 确认这个人在管理员白名单里。`viewer` 角色只能看，不能启停任务。

## 与原脚本的对应关系

| 原来                           | 现在                          |
| ------------------------------ | ----------------------------- |
| `queue.jsonl` + `seen_ids.txt` | `aiero.apps`                  |
| `results.jsonl` + `prompts/*`  | `aiero.extractions`           |
| `progress.json`                | `aiero.jobs.stats`            |
| `list_state.json`              | `aiero.list_state`            |
| `run.log`                      | `aiero.job_logs`              |
| 进程内 `claimed` 集合去重      | `FOR UPDATE SKIP LOCKED` 领取 |
| 硬编码账号密码                 | `SCRAPER_ACCOUNTS` 环境变量   |

越狱提示词、SSE 解析、账号轮换、限流退避、模型 × 越狱版本矩阵、启发式判定这些
核心逻辑逐条对齐移植，判定阈值没有改动。

## 本地开发

```powershell
pnpm install
Copy-Item .env.example .env   # 填值

# 建表（只跑一次）
psql $env:DATABASE_URL -f migrations/001_aiero_schema.sql

pnpm dev:server   # http://localhost:8080
pnpm dev:web      # http://localhost:3010
```

本地想跳过登录可以在 `.env` 里设 `AUTH_DISABLED=true`，线上不要开。

## 导入历史数据

原脚本产出的目录可以整个导进来，可重复执行不会重复计数：

```powershell
pnpm import:legacy -- "D:\path\to\aiero_prompt_output"
```

## 部署

线上地址：

| 端     | 地址                                              |
| ------ | ------------------------------------------------- |
| 前端   | https://aiero-prompt-platform.vercel.app          |
| 后端   | https://aiero-server-production.up.railway.app    |
| 数据库 | Supabase 测试项目的 `aiero` schema                |

后端（Railway 项目 `aiero-prompt-platform` / 服务 `aiero-server`）：

```powershell
railway up --service aiero-server --detach
```

构建走 `packages/server/Dockerfile`，路径与健康检查配置在根目录 `railway.json`；
仓库没有接 GitHub 自动部署，改完代码要手动 `railway up`。环境变量见 `.env.example` 的后端部分。

前端（Vercel 项目 `aiero-prompt-platform`）：

```powershell
vercel deploy --prod --yes
```

构建配置在根目录 `vercel.json`。前端的 `VITE_*` 变量是构建时注入的，改完要重新部署。
后端的 `CORS_ORIGINS` 锁在前端正式域名上，加自定义域名时要同步改。

## 注意

抓取会用真实账号访问第三方站点并触发其计费与限流。并发数默认 3，是实测下来比较稳的值；
调高容易触发限流甚至封号。同一时刻只允许一个任务运行，由数据库唯一索引保证。
